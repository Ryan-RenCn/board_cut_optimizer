use board_cut_optimizer::{
    model::rows,
    storage::{self, Store},
};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::{collections::HashMap, fs, path::PathBuf};
struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("board-cut-rust-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        Self(p)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn legacy() -> Value {
    json!({"id":"legacy","name":"旧工程","updatedAt":"2026-01-01T00:00:00.000Z","panels":[{"id":"panel","length":"2440","width":"1220","thickness":"18","price":328,"cuttingFee":60}],"settings":{"sawWidth":3},"parts":[{"id":"old-part","quantity":2,"length":100,"width":100,"thickness":18,"shape":{"outer":[[0,0],[100,0],[0,100]]},"rotationAngles":[17.3],"cadSource":{"fileName":"old.dxf"}}],"quotationAdjustment":{"signature":"test","rows":[{"panelCharge":200,"taxedPanelCharge":226,"cuttingFee":30}]},"unknownData":{"mustPreserve":true}})
}
fn create_legacy_db(path: &PathBuf, project: &Value, fail_draft: bool) {
    let c = Connection::open(path).unwrap();
    c.execute_batch("CREATE TABLE app_state(key TEXT PRIMARY KEY,payload TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',payload TEXT NOT NULL,updated_at TEXT NOT NULL);").unwrap();
    c.execute(
        "INSERT INTO app_state VALUES('draft',?,'old')",
        [project.to_string()],
    )
    .unwrap();
    c.execute(
        "INSERT INTO projects VALUES('legacy','旧工程','',?,'old')",
        [project.to_string()],
    )
    .unwrap();
    if fail_draft {
        c.execute_batch("CREATE TRIGGER reject_draft BEFORE UPDATE ON app_state WHEN NEW.key='draft' BEGIN SELECT RAISE(ABORT,'test migration failure'); END;").unwrap();
    }
}
#[test]
fn paths_match_original_precedence() {
    let d = Directory::new();
    let env = HashMap::new();
    let preferred = d.0.join("data/board_cut_optimizer.sqlite");
    let legacy = d.0.join("data/smartcut.sqlite");
    assert_eq!(storage::resolve_database_path(&d.0, &env), preferred);
    fs::create_dir_all(legacy.parent().unwrap()).unwrap();
    fs::write(&legacy, []).unwrap();
    assert_eq!(storage::resolve_database_path(&d.0, &env), legacy);
    fs::write(&preferred, []).unwrap();
    assert_eq!(storage::resolve_database_path(&d.0, &env), preferred);
    let env = HashMap::from([
        ("SMARTCUT_DB_PATH".into(), "legacy-custom.sqlite".into()),
        (
            "BOARD_CUT_OPTIMIZER_DB_PATH".into(),
            "D:\\用户指定\\custom.sqlite".into(),
        ),
    ]);
    assert_eq!(
        storage::resolve_database_path(&d.0, &env),
        PathBuf::from("D:\\用户指定\\custom.sqlite")
    );
}
#[test]
fn opens_a_database_written_by_actual_node_store() {
    let d = Directory::new();
    let path = d.0.join("node-written.sqlite");
    fs::write(&path, include_bytes!("fixtures/js-store.sqlite")).unwrap();
    let store = Store::open(&path).unwrap();
    let draft = store.draft().unwrap().unwrap();
    assert_eq!(draft["id"], "js-store-project");
    assert!(draft.get("panels").is_none());
    assert!(draft.get("settings").is_none());
    assert_eq!(draft["customLegacyField"]["preserved"], true);
    assert_eq!(store.list_projects().unwrap()[0], draft);
    assert!(!rows(&store.global_settings().unwrap().unwrap(), "panels").is_empty());
    assert!(store.migration_backup.is_none());
    store.save_draft(&draft).unwrap();
    assert_eq!(store.draft().unwrap().unwrap(), draft);
}
#[test]
fn crud_and_legacy_fields_round_trip() {
    let d = Directory::new();
    let path = d.0.join("db.sqlite");
    let project = legacy();
    let scoped = storage::without_global_config(&project).unwrap();
    {
        let mut store = Store::open(&path).unwrap();
        let global = json!({"panels":project["panels"],"settings":project["settings"]});
        store.save_global_settings(&global).unwrap();
        store.save_draft(&project).unwrap();
        store.save_project(&project).unwrap();
        assert_eq!(store.draft().unwrap().unwrap(), scoped);
        assert_eq!(store.list_projects().unwrap(), vec![scoped.clone()]);
        let migration = store
            .migrate_legacy(
                Some(&json!({"name":"不应覆盖"})),
                &[project.clone(), json!({"name":"无 ID"})],
            )
            .unwrap();
        assert_eq!(migration["draft"], scoped);
        assert_eq!(migration["projects"].as_array().unwrap().len(), 1);
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(store.draft().unwrap().unwrap(), scoped);
    assert_eq!(store.list_projects().unwrap()[0]["parts"], project["parts"]);
    assert!(store.delete_project("legacy").unwrap());
    assert!(!store.delete_project("legacy").unwrap());
}
#[test]
fn embedded_global_migration_has_consistent_backup_and_is_idempotent() {
    let d = Directory::new();
    let path = d.0.join("old.sqlite");
    let project = legacy();
    create_legacy_db(&path, &project, false);
    let store = Store::open(&path).unwrap();
    assert_eq!(
        store.draft().unwrap().unwrap(),
        storage::without_global_config(&project).unwrap()
    );
    assert_eq!(
        store.global_settings().unwrap().unwrap(),
        json!({"panels":project["panels"],"settings":project["settings"]})
    );
    let backup = Connection::open(store.migration_backup.as_ref().unwrap()).unwrap();
    let original: String = backup
        .query_row("SELECT payload FROM app_state WHERE key='draft'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&original).unwrap(), project);
    drop(backup);
    drop(store);
    let reopened = Store::open(&path).unwrap();
    assert!(reopened.migration_backup.is_none());
}
#[test]
fn failed_migration_rolls_back_all_business_changes() {
    let d = Directory::new();
    let path = d.0.join("failure.sqlite");
    let project = legacy();
    create_legacy_db(&path, &project, true);
    assert!(Store::open(&path).is_err());
    let connection = Connection::open(&path).unwrap();
    let original: String = connection
        .query_row("SELECT payload FROM app_state WHERE key='draft'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&original).unwrap(), project);
    let states: i64 = connection
        .query_row("SELECT count(*) FROM app_state", [], |r| r.get(0))
        .unwrap();
    assert_eq!(states, 1);
}
#[test]
fn backup_reads_committed_wal_data_not_just_the_main_file() {
    let d = Directory::new();
    let path = d.0.join("wal.sqlite");
    let mut project = legacy();
    create_legacy_db(&path, &project, false);
    let writer = Connection::open(&path).unwrap();
    writer
        .execute_batch("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;")
        .unwrap();
    project["walOnlyField"] = json!("committed in WAL");
    writer
        .execute(
            "UPDATE app_state SET payload=? WHERE key='draft'",
            [project.to_string()],
        )
        .unwrap();
    let store = Store::open(&path).unwrap();
    let backup = Connection::open(store.migration_backup.as_ref().unwrap()).unwrap();
    let text: String = backup
        .query_row(
            "SELECT payload FROM app_state WHERE key='draft'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap()["walOnlyField"],
        "committed in WAL"
    );
}
#[test]
fn malformed_rows_are_not_replaced_with_empty_defaults() {
    let d = Directory::new();
    let path = d.0.join("bad-rows.sqlite");
    let project = json!({"id":"bad","parts":[null,"invalid"]});
    create_legacy_db(&path, &project, false);
    assert!(Store::open(&path).is_err());
    let c = Connection::open(&path).unwrap();
    let text: String = c
        .query_row(
            "SELECT payload FROM app_state WHERE key='draft'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), project);
}
#[test]
fn corrupt_payload_is_not_overwritten() {
    let d = Directory::new();
    let path = d.0.join("corrupt.sqlite");
    create_legacy_db(&path, &legacy(), false);
    let c = Connection::open(&path).unwrap();
    c.execute(
        "UPDATE app_state SET payload=? WHERE key='draft'",
        params!["invalid-json"],
    )
    .unwrap();
    drop(c);
    assert!(Store::open(&path).is_err());
    let c = Connection::open(&path).unwrap();
    let value: String = c
        .query_row("SELECT payload FROM app_state WHERE key='draft'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(value, "invalid-json");
}
