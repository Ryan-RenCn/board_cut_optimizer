import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function parseProject(value) {
  return value ? JSON.parse(value) : null;
}

function withoutGlobalConfig(project) {
  if (!project || typeof project !== 'object') return project;
  const { panels: _panels, settings: _settings, ...scopedProject } = project;
  return scopedProject;
}

function globalConfigFrom(project) {
  if (!project || typeof project !== 'object') return null;
  if (!Array.isArray(project.panels) && (!project.settings || typeof project.settings !== 'object')) return null;
  return {
    panels: Array.isArray(project.panels) ? project.panels : [],
    settings: project.settings && typeof project.settings === 'object' ? project.settings : {},
  };
}

function globalConfigScore(config) {
  if (!config) return -1;
  const panelCount = Array.isArray(config.panels) ? config.panels.length : 0;
  const settingCount = config.settings && typeof config.settings === 'object'
    ? Object.keys(config.settings).length
    : 0;
  return panelCount * 1000 + settingCount;
}

function richestGlobalConfig(configs) {
  return configs.filter(Boolean).reduce(
    (richest, candidate) => globalConfigScore(candidate) > globalConfigScore(richest) ? candidate : richest,
    null,
  );
}

function projectRow(project) {
  if (!project || typeof project !== 'object' || !String(project.id ?? '').trim()) {
    throw new TypeError('工程必须包含有效的 id');
  }
  const scopedProject = withoutGlobalConfig(project);
  return {
    id: String(scopedProject.id),
    name: String(scopedProject.name ?? '未命名工程'),
    description: String(scopedProject.description ?? ''),
    payload: JSON.stringify(scopedProject),
    updatedAt: String(scopedProject.updatedAt ?? new Date().toISOString()),
  };
}

export function createProjectStore(databasePath) {
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS projects_updated_at_idx
      ON projects(updated_at DESC);
  `);

  const selectDraft = database.prepare("SELECT payload FROM app_state WHERE key = 'draft'");
  const selectGlobalSettings = database.prepare("SELECT payload FROM app_state WHERE key = 'global_settings'");
  const upsertDraft = database.prepare(`
    INSERT INTO app_state (key, payload, updated_at) VALUES ('draft', ?, ?)
    ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `);
  const insertDraft = database.prepare(`
    INSERT OR IGNORE INTO app_state (key, payload, updated_at) VALUES ('draft', ?, ?)
  `);
  const upsertGlobalSettings = database.prepare(`
    INSERT INTO app_state (key, payload, updated_at) VALUES ('global_settings', ?, ?)
    ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `);
  const insertGlobalSettings = database.prepare(`
    INSERT OR IGNORE INTO app_state (key, payload, updated_at) VALUES ('global_settings', ?, ?)
  `);
  const insertMigrationBackup = database.prepare(`
    INSERT OR IGNORE INTO app_state (key, payload, updated_at)
    VALUES ('global_config_migration_backup_v1', ?, ?)
  `);
  const listProjectRows = database.prepare('SELECT payload FROM projects ORDER BY updated_at DESC');
  const listProjectPayloadRows = database.prepare('SELECT id, payload FROM projects');
  const updateProjectPayload = database.prepare('UPDATE projects SET payload = ? WHERE id = ?');
  const upsertProject = database.prepare(`
    INSERT INTO projects (id, name, description, payload, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `);
  const insertProject = database.prepare(`
    INSERT OR IGNORE INTO projects (id, name, description, payload, updated_at) VALUES (?, ?, ?, ?, ?)
  `);
  const deleteProjectStatement = database.prepare('DELETE FROM projects WHERE id = ?');

  function saveProjectWith(statement, project) {
    const row = projectRow(project);
    statement.run(row.id, row.name, row.description, row.payload, row.updatedAt);
  }

  function migrateEmbeddedGlobalConfig() {
    const draft = parseProject(selectDraft.get()?.payload);
    const projectRows = listProjectPayloadRows.all();
    const projectPayloads = projectRows.map((row) => ({ ...row, project: parseProject(row.payload) }));
    const embeddedConfigs = [globalConfigFrom(draft), ...projectPayloads.map((row) => globalConfigFrom(row.project))].filter(Boolean);
    if (!embeddedConfigs.length) return;

    const now = new Date().toISOString();
    const savedGlobalConfig = parseProject(selectGlobalSettings.get()?.payload);
    const candidate = richestGlobalConfig([savedGlobalConfig, ...embeddedConfigs]);
    database.exec('BEGIN IMMEDIATE');
    try {
      insertMigrationBackup.run(JSON.stringify({
        draft,
        projects: projectPayloads.map((row) => row.project),
      }), now);
      if (candidate && globalConfigScore(candidate) > globalConfigScore(savedGlobalConfig)) {
        upsertGlobalSettings.run(JSON.stringify(candidate), now);
      }
      if (draft && globalConfigFrom(draft)) {
        upsertDraft.run(JSON.stringify(withoutGlobalConfig(draft)), now);
      }
      for (const row of projectPayloads) {
        if (globalConfigFrom(row.project)) updateProjectPayload.run(JSON.stringify(withoutGlobalConfig(row.project)), row.id);
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  migrateEmbeddedGlobalConfig();

  return {
    getDraft() {
      return parseProject(selectDraft.get()?.payload);
    },

    saveDraft(project) {
      const scopedProject = withoutGlobalConfig(project);
      upsertDraft.run(JSON.stringify(scopedProject), new Date().toISOString());
      return scopedProject;
    },

    getGlobalSettings() {
      return parseProject(selectGlobalSettings.get()?.payload);
    },

    saveGlobalSettings(globalSettings) {
      if (!globalSettings || typeof globalSettings !== 'object') throw new TypeError('全局设置必须是对象');
      const normalized = {
        panels: Array.isArray(globalSettings.panels) ? globalSettings.panels : [],
        settings: globalSettings.settings && typeof globalSettings.settings === 'object' ? globalSettings.settings : {},
      };
      upsertGlobalSettings.run(JSON.stringify(normalized), new Date().toISOString());
      return normalized;
    },

    listProjects() {
      return listProjectRows.all().map((row) => parseProject(row.payload));
    },

    saveProject(project) {
      saveProjectWith(upsertProject, project);
      return project;
    },

    deleteProject(id) {
      return deleteProjectStatement.run(String(id)).changes > 0;
    },

    migrateLegacy({ draft = null, projects = [] } = {}) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const legacyGlobal = richestGlobalConfig([
          globalConfigFrom(draft),
          ...(Array.isArray(projects) ? projects.map(globalConfigFrom) : []),
        ]);
        if (legacyGlobal) insertGlobalSettings.run(JSON.stringify(legacyGlobal), new Date().toISOString());
        if (draft && typeof draft === 'object') {
          insertDraft.run(JSON.stringify(withoutGlobalConfig(draft)), new Date().toISOString());
        }
        for (const project of Array.isArray(projects) ? projects : []) {
          try {
            saveProjectWith(insertProject, project);
          } catch (error) {
            if (!(error instanceof TypeError)) throw error;
          }
        }
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      return {
        draft: parseProject(selectDraft.get()?.payload),
        projects: listProjectRows.all().map((row) => parseProject(row.payload)),
        globalSettings: parseProject(selectGlobalSettings.get()?.payload),
      };
    },

    close() {
      database.close();
    },
  };
}
