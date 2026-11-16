import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveDatabasePath } from '../server.mjs';

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'board-cut-optimizer-server-test-'));
const dataDirectory = join(temporaryDirectory, 'data');
const preferredPath = join(dataDirectory, 'board_cut_optimizer.sqlite');
const legacyPath = join(dataDirectory, 'smartcut.sqlite');

try {
  assert.equal(resolveDatabasePath(temporaryDirectory, {}), preferredPath, '新应用应在程序目录的 data 文件夹创建数据库');

  mkdirSync(dataDirectory, { recursive: true });
  new DatabaseSync(legacyPath).close();
  assert.equal(resolveDatabasePath(temporaryDirectory, {}), legacyPath, '程序目录存在旧数据库时应继续使用');

  new DatabaseSync(preferredPath).close();
  assert.equal(resolveDatabasePath(temporaryDirectory, {}), preferredPath, '新旧数据库并存时应优先使用新名称');
  assert.equal(
    resolveDatabasePath(temporaryDirectory, { BOARD_CUT_OPTIMIZER_DB_PATH: 'D:\\板优排\\custom.sqlite' }),
    'D:\\板优排\\custom.sqlite',
    '显式数据库路径应保持最高优先级',
  );
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

console.log('server tests passed');
