// Run explicitly with Electron: electron tests/ui-trace-smoke.mjs
// Uses an isolated in-memory database; never opens the user's data directory.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { createBoardCutServer } from '../server.mjs';

let server;
let window;
const pageErrors = [];
async function run() {
try {
  server = createBoardCutServer({ databasePath: ':memory:', port: 0 });
  const { url } = await server.start();
  window = new BrowserWindow({ show: false, width: 1440, height: 1100, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on('console-message', (event) => { if (event.level === 'error') pageErrors.push(event.message); });
  await window.loadURL(`${url}/?demo=1`);
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (!document.getElementById('optimizeButton').disabled && document.querySelectorAll('#layoutsContainer .part-rect').length>0) { clearInterval(timer); resolve(); }
      else if (Date.now() - started > 15000) { clearInterval(timer); reject(new Error('排版演示未出现')); }
    }, 30);
  })`);
  assert.equal(await window.webContents.executeJavaScript("document.getElementById('layoutTrace')===null"),true);
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await new Promise((resolve) => setTimeout(resolve, 200));
  const screenshot = await window.webContents.capturePage();
  writeFileSync(fileURLToPath(new URL('../reverse/se2dnest/beam-ui-preview.png', import.meta.url)), screenshot.toPNG());
  const cleared = await window.webContents.executeJavaScript(`(() => {
    window.confirm = () => false; document.getElementById('clearPartsButton').click();
    const before = document.querySelectorAll('#partsBody tr').length;
    window.confirm = () => true; document.getElementById('clearPartsButton').click();
    return { before, after: document.querySelectorAll('#partsBody tr').length,
      hidden: document.querySelectorAll('#layoutsContainer .part-rect').length===0,
      length: document.querySelector('#partsBody [data-field="length"]').value };
  })()`);
  assert.ok(cleared.before > 1);
  assert.equal(cleared.after, 1);
  assert.equal(cleared.length, '0');
  assert.equal(cleared.hidden, true);
  assert.deepEqual(pageErrors, []);
  console.log('Electron UI smoke passed: demo, removed replay controls, clear confirmation, and isolated database.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  window?.destroy();
  await server?.close();
  app.exit(process.exitCode ?? 0);
}
}

app.whenReady().then(run);
