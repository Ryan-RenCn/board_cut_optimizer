import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createProjectStore } from '../storage.mjs';

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'board-cut-optimizer-storage-test-'));
const databasePath = join(temporaryDirectory, 'board_cut_optimizer.sqlite');
const legacyDatabasePath = join(temporaryDirectory, 'legacy.sqlite');
const embeddedMigrationDatabasePath = join(temporaryDirectory, 'embedded-migration.sqlite');
const firstProject = {
  id: 'project-1',
  name: '测试工程',
  description: 'SQLite 持久化测试',
  shippingDestination: '浙江',
  lossRate: 7,
  taxRate: 13,
  panels: [{ id: 'panel-1', length: 2440, width: 1220, thickness: 18, cost: 328, weight: 39.5 }],
  parts: [{ id: 'part-1', quantity: 2, length: 600, width: 400, thickness: 18 }],
  settings: { sawWidth: 3, profitRate: 120, cuttingFee: 60, packagingFee: 80, logisticsProvider: 'shanghai-kuta', partEntryKey: 'enter', quotationTemplate: '报价：{{最终合计}}' },
  quotationAdjustment: { signature: 'test-layout', rows: [{ panelCharge: 262.4, taxedPanelCharge: 296.51, cuttingFee: 55 }] },
  updatedAt: '2026-08-19T08:00:00.000Z',
};
const globalSettings = { panels: firstProject.panels, settings: firstProject.settings };
const { panels: _panels, settings: _settings, ...scopedProject } = firstProject;

try {
  let store = createProjectStore(databasePath);
  assert.equal(store.getDraft(), null);
  assert.equal(store.getGlobalSettings(), null);
  assert.deepEqual(store.saveGlobalSettings(globalSettings), globalSettings);
  store.saveDraft(firstProject);
  store.saveProject(firstProject);
  assert.deepEqual(store.getDraft(), scopedProject, '草稿不得保存全局板材和设置');
  assert.deepEqual(store.listProjects(), [scopedProject], '工程不得保存全局板材和设置');
  store.close();

  store = createProjectStore(databasePath);
  assert.deepEqual(store.getGlobalSettings(), globalSettings, '重新打开数据库后全局设置应独立保留');
  assert.deepEqual(store.getDraft(), scopedProject, '重新打开数据库后草稿应保留');
  assert.deepEqual(store.listProjects(), [scopedProject], '重新打开数据库后工程库应保留');

  const updatedProject = { ...firstProject, name: '更新后的工程', updatedAt: '2026-08-19T09:00:00.000Z' };
  const updatedScopedProject = { ...scopedProject, name: '更新后的工程', updatedAt: '2026-08-19T09:00:00.000Z' };
  store.saveProject(updatedProject);
  assert.deepEqual(store.listProjects(), [updatedScopedProject]);
  assert.equal(store.deleteProject(firstProject.id), true);
  assert.deepEqual(store.listProjects(), []);
  store.close();

  store = createProjectStore(legacyDatabasePath);
  const legacyProject = { ...firstProject, id: 'legacy-project' };
  const legacyScopedProject = { ...scopedProject, id: 'legacy-project' };
  const migration = store.migrateLegacy({ draft: legacyProject, projects: [legacyProject, { name: '无 ID 工程' }] });
  assert.deepEqual(migration.globalSettings, globalSettings, '旧工程内嵌设置应迁移为全局设置');
  assert.deepEqual(migration.draft, legacyScopedProject, '迁移后的草稿不得保留全局设置');
  assert.deepEqual(migration.projects, [legacyScopedProject], '迁移后的工程不得保留全局设置');
  store.close();

  const migrationDatabase = new DatabaseSync(embeddedMigrationDatabasePath);
  migrationDatabase.exec(`
    CREATE TABLE app_state (key TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  migrationDatabase.prepare('INSERT INTO app_state VALUES (?, ?, ?)').run(
    'draft',
    JSON.stringify({ ...legacyProject, panels: [], settings: firstProject.settings }),
    firstProject.updatedAt,
  );
  migrationDatabase.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)').run(
    legacyProject.id,
    legacyProject.name,
    legacyProject.description,
    JSON.stringify(legacyProject),
    legacyProject.updatedAt,
  );
  migrationDatabase.close();

  store = createProjectStore(embeddedMigrationDatabasePath);
  assert.deepEqual(
    store.getGlobalSettings(),
    globalSettings,
    '启动迁移应优先采用含库存的配置，不能让空草稿覆盖工程中的板材库存',
  );
  assert.deepEqual(store.getDraft(), legacyScopedProject);
  assert.deepEqual(store.listProjects(), [legacyScopedProject]);
  store.close();
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

console.log('storage tests passed');
