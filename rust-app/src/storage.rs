//! SQLite wire/schema compatibility with the original local application.
use crate::model::{rows, string};
use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

type Result<T> = std::result::Result<T, String>;
fn error(value: impl std::fmt::Display) -> String {
    value.to_string()
}
fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn resolve_database_path(base: &Path, environment: &HashMap<String, String>) -> PathBuf {
    for key in ["BOARD_CUT_OPTIMIZER_DB_PATH", "SMARTCUT_DB_PATH"] {
        if let Some(value) = environment.get(key).filter(|v| !v.is_empty()) {
            return PathBuf::from(value);
        }
    }
    let preferred = base.join("data/board_cut_optimizer.sqlite");
    let legacy = base.join("data/smartcut.sqlite");
    if preferred.exists() || !legacy.exists() {
        preferred
    } else {
        legacy
    }
}

pub fn without_global_config(project: &Value) -> Result<Value> {
    let mut project = project.as_object().cloned().ok_or("工程数据必须为对象")?;
    project.shift_remove("panels");
    project.shift_remove("settings");
    Ok(Value::Object(project))
}
fn global_from(project: &Value) -> Option<Value> {
    if !project["panels"].is_array() && !project["settings"].is_object() {
        return None;
    }
    Some(
        json!({"panels":if project["panels"].is_array(){project["panels"].clone()}else{json!([])},"settings":if project["settings"].is_object(){project["settings"].clone()}else{json!({})}}),
    )
}
fn score(config: &Value) -> usize {
    rows(config, "panels").len() * 1000 + config["settings"].as_object().map_or(0, |v| v.len())
}
fn richest(configs: impl IntoIterator<Item = Value>) -> Option<Value> {
    let mut winner: Option<Value> = None;
    for config in configs {
        if winner
            .as_ref()
            .is_none_or(|old| score(&config) > score(old))
        {
            winner = Some(config);
        }
    }
    winner
}
fn decode(payload: &str) -> Result<Value> {
    let value: Value = serde_json::from_str(payload).map_err(error)?;
    if !value.is_object() {
        return Err("数据库记录不是有效对象；已保留原始数据，禁止自动覆盖".into());
    }
    for key in ["panels", "parts"] {
        if let Some(rows) = value.get(key).filter(|v| !v.is_null())
            && (!rows.is_array()
                || rows
                    .as_array()
                    .is_some_and(|rows| rows.iter().any(|row| !row.is_object())))
        {
            return Err(format!(
                "数据库的 {key} 数据格式损坏；已保留原始记录，禁止自动覆盖"
            ));
        }
    }
    if value
        .get("settings")
        .is_some_and(|v| !v.is_null() && !v.is_object())
    {
        return Err("数据库全局设置格式损坏；已保留原始记录，禁止自动覆盖".into());
    }
    Ok(value)
}
fn state(connection: &Connection, key: &str) -> Result<Option<Value>> {
    connection
        .query_row("SELECT payload FROM app_state WHERE key=?", [key], |row| {
            row.get::<_, String>(0)
        })
        .optional()
        .map_err(error)?
        .map(|text| decode(&text))
        .transpose()
}
fn put_state(connection: &Connection, key: &str, value: &Value, insert_only: bool) -> Result<()> {
    let sql = if insert_only {
        "INSERT OR IGNORE INTO app_state(key,payload,updated_at) VALUES(?,?,?)"
    } else {
        "INSERT INTO app_state(key,payload,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at"
    };
    connection
        .execute(sql, params![key, value.to_string(), now()])
        .map_err(error)?;
    Ok(())
}
fn project_id(project: &Value) -> Result<String> {
    if !project.is_object() {
        return Err("工程必须包含有效的 id".into());
    }
    let id = string(&project["id"]);
    if id.trim().is_empty() {
        return Err("工程必须包含有效的 id".into());
    }
    Ok(id)
}
fn put_project(connection: &Connection, project: &Value, insert_only: bool) -> Result<()> {
    let id = project_id(project)?;
    let scoped = without_global_config(project)?;
    let sql = if insert_only {
        "INSERT OR IGNORE INTO projects(id,name,description,payload,updated_at) VALUES(?,?,?,?,?)"
    } else {
        "INSERT INTO projects(id,name,description,payload,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,payload=excluded.payload,updated_at=excluded.updated_at"
    };
    let name = project
        .get("name")
        .filter(|v| !v.is_null())
        .map(string)
        .unwrap_or_else(|| "未命名工程".into());
    let updated = project
        .get("updatedAt")
        .filter(|v| !v.is_null())
        .map(string)
        .unwrap_or_else(now);
    connection
        .execute(
            sql,
            params![
                id,
                name,
                string(&project["description"]),
                scoped.to_string(),
                updated
            ],
        )
        .map_err(error)?;
    Ok(())
}

pub struct Store {
    connection: Connection,
    pub path: PathBuf,
    pub migration_backup: Option<PathBuf>,
}
impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if path != Path::new(":memory:")
            && let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty())
        {
            fs::create_dir_all(parent).map_err(error)?;
        }
        let connection = Connection::open(path).map_err(error)?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(error)?;
        connection.execute_batch("PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS app_state(key TEXT PRIMARY KEY,payload TEXT NOT NULL,updated_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',payload TEXT NOT NULL,updated_at TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS projects_updated_at_idx ON projects(updated_at DESC);").map_err(error)?;
        let mut store = Self {
            connection,
            path: path.into(),
            migration_backup: None,
        };
        store.migrate_embedded_global()?;
        // Validate all business payloads before the UI is allowed to save anything.
        store.draft()?;
        store.global_settings()?;
        store.list_projects()?;
        Ok(store)
    }
    pub fn draft(&self) -> Result<Option<Value>> {
        state(&self.connection, "draft")
    }
    pub fn global_settings(&self) -> Result<Option<Value>> {
        state(&self.connection, "global_settings")
    }
    pub fn save_draft(&self, project: &Value) -> Result<Value> {
        let scoped = without_global_config(project)?;
        put_state(&self.connection, "draft", &scoped, false)?;
        Ok(scoped)
    }
    pub fn save_global_settings(&self, config: &Value) -> Result<Value> {
        if !config.is_object() {
            return Err("全局设置必须是对象".into());
        }
        let normalized = json!({"panels":if config["panels"].is_array(){config["panels"].clone()}else{json!([])},"settings":if config["settings"].is_object(){config["settings"].clone()}else{json!({})}});
        put_state(&self.connection, "global_settings", &normalized, false)?;
        Ok(normalized)
    }
    pub fn save_project(&self, project: &Value) -> Result<Value> {
        put_project(&self.connection, project, false)?;
        Ok(project.clone())
    }
    pub fn delete_project(&self, id: &str) -> Result<bool> {
        Ok(self
            .connection
            .execute("DELETE FROM projects WHERE id=?", [id])
            .map_err(error)?
            > 0)
    }
    pub fn list_projects(&self) -> Result<Vec<Value>> {
        let mut query = self
            .connection
            .prepare("SELECT payload FROM projects ORDER BY updated_at DESC")
            .map_err(error)?;
        query
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(error)?
            .map(|r| r.map_err(error).and_then(|s| decode(&s)))
            .collect()
    }
    fn consistent_backup(&mut self) -> Result<()> {
        if self.path == Path::new(":memory:") {
            return Ok(());
        }
        let stamp = Utc::now().format("%Y%m%d-%H%M%S%.3f");
        let name = self.path.file_name().unwrap_or_default().to_string_lossy();
        let mut counter = 0;
        let destination = loop {
            let path = self
                .path
                .with_file_name(format!("{name}.rust-migration-{stamp}-{counter}.sqlite"));
            if !path.exists() {
                break path;
            }
            counter += 1;
        };
        let mut destination_connection = Connection::open(&destination).map_err(error)?;
        let backup = rusqlite::backup::Backup::new(&self.connection, &mut destination_connection)
            .map_err(error)?;
        backup
            .run_to_completion(100, Duration::from_millis(10), None)
            .map_err(error)?;
        drop(backup);
        drop(destination_connection);
        self.migration_backup = Some(destination);
        Ok(())
    }
    fn migrate_embedded_global(&mut self) -> Result<()> {
        let draft = self.draft()?;
        let mut query = self
            .connection
            .prepare("SELECT id,payload FROM projects")
            .map_err(error)?;
        let projects: Vec<(String, Value)> = query
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(error)?
            .map(|row| {
                let (id, text) = row.map_err(error)?;
                Ok((id, decode(&text)?))
            })
            .collect::<Result<_>>()?;
        drop(query);
        let embedded: Vec<_> = draft
            .iter()
            .chain(projects.iter().map(|(_, p)| p))
            .filter_map(global_from)
            .collect();
        if embedded.is_empty() {
            return Ok(());
        }
        let saved = self.global_settings()?;
        let candidate = richest(saved.iter().cloned().chain(embedded));
        self.consistent_backup()?;
        let transaction = self.connection.transaction().map_err(error)?;
        put_state(
            &transaction,
            "global_config_migration_backup_v1",
            &json!({"draft":draft,"projects":projects.iter().map(|(_,p)|p).collect::<Vec<_>>()}),
            true,
        )?;
        if let Some(candidate) =
            candidate.filter(|c| saved.as_ref().is_none_or(|s| score(c) > score(s)))
        {
            put_state(&transaction, "global_settings", &candidate, false)?;
        }
        if let Some(draft) = draft.filter(|d| global_from(d).is_some()) {
            put_state(
                &transaction,
                "draft",
                &without_global_config(&draft)?,
                false,
            )?;
        }
        for (id, project) in projects {
            if global_from(&project).is_some() {
                transaction
                    .execute(
                        "UPDATE projects SET payload=? WHERE id=?",
                        params![without_global_config(&project)?.to_string(), id],
                    )
                    .map_err(error)?;
            }
        }
        transaction.commit().map_err(error)?;
        Ok(())
    }
    pub fn migrate_legacy(&mut self, draft: Option<&Value>, projects: &[Value]) -> Result<Value> {
        let transaction = self.connection.transaction().map_err(error)?;
        let global = richest(
            draft
                .into_iter()
                .chain(projects.iter())
                .filter_map(global_from),
        );
        if let Some(global) = global {
            put_state(&transaction, "global_settings", &global, true)?;
        }
        if let Some(draft) = draft.filter(|v| v.is_object()) {
            put_state(&transaction, "draft", &without_global_config(draft)?, true)?;
        }
        for project in projects {
            if project_id(project).is_ok() {
                put_project(&transaction, project, true)?;
            }
        }
        transaction.commit().map_err(error)?;
        Ok(
            json!({"draft":self.draft()?,"projects":self.list_projects()?,"globalSettings":self.global_settings()?}),
        )
    }
}
