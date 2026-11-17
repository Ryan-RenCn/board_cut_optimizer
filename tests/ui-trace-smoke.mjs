// Run explicitly with Electron: electron tests/ui-trace-smoke.mjs
// Uses an isolated in-memory database; never opens the user's data directory.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
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
  const js = source => window.webContents.executeJavaScript(source);
  const wait = condition => js(`new Promise((resolve,reject)=>{const started=Date.now(),timer=setInterval(()=>{if(${condition}){clearInterval(timer);resolve()}else if(Date.now()-started>15000){clearInterval(timer);reject(Error('Rectangle UI timeout'))}},20)})`);
  assert.equal(await js(`document.querySelector('#importCadButton, #importShapesButton, #exportShapesButton, #shapeFileInput, #cadDialog, #shapeDialog, [data-setting="rotationStep"], [data-setting="maxShapeVertices"], [data-edit-shape]')`), null);
  assert.equal(await js(`document.querySelectorAll('#partsBody tr:first-child td').length`), 11);
  assert.equal(await js(`document.querySelectorAll('#layoutsContainer path.part-rect').length`), 0);
  assert.ok(await js(`document.querySelectorAll('#partsBody .part-thumbnail rect').length > 0`));
  // Stop on the first real worker preview, then verify that a fresh run completes.
  await js(`window.previewCancellation=new MutationObserver(()=>{if(document.querySelector('.live-layout-card .part-rect')){previewCancellation.disconnect();document.getElementById('cancelLayoutOptimizeButton').click()}});previewCancellation.observe(document.getElementById('layoutsContainer'),{childList:true,subtree:true});document.getElementById('optimizeButton').click()`);
  await wait(`!document.getElementById('optimizeButton').disabled`);
  assert.match(await js(`document.getElementById('toastRegion').textContent`), /已停止优化/);
  assert.equal(await js(`document.querySelectorAll('#layoutsContainer .part-rect').length`), 0);
  await js(`document.getElementById('optimizeButton').click()`);
  await wait(`!document.getElementById('optimizeButton').disabled && document.querySelectorAll('#layoutsContainer .part-rect').length>0`);
  assert.equal(await window.webContents.executeJavaScript("document.getElementById('layoutTrace')===null"),true);
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await new Promise((resolve) => setTimeout(resolve, 200));
  const screenshot = await window.webContents.capturePage();
  const screenshotDirectory = new URL('../.test-output/', import.meta.url);
  mkdirSync(screenshotDirectory, { recursive: true });
  writeFileSync(new URL('rectangle-ui-preview.png', screenshotDirectory), screenshot.toPNG());
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
  const legacyPart = { id: 'legacy', quantity: 1, length: 100, width: 100, material: '胡桃木', thickness: 18, shape: { outer: [[0, 0], [100, 0], [0, 100]], holes: [] } };
  await fetch(`${url}/api/draft`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: { name: '旧工程', parts: [legacyPart] } }) });
  await window.loadURL(url);
  await wait(`document.getElementById('unsupportedPartsNotice').textContent.includes('1 行旧版轮廓')`);
  assert.equal(await js(`document.querySelector('#partsBody [data-field="length"]').readOnly`), true);
  assert.equal(await js(`document.querySelector('#partsBody .part-thumbnail').textContent`), '不支持');
  await js(`document.getElementById('optimizeButton').click()`);
  await wait(`!document.getElementById('optimizeButton').disabled`);
  assert.match(await js(`document.getElementById('toastRegion').textContent`), /不再支持.*重新录入矩形零件/);
  await js(`document.getElementById('saveProjectButton').click()`);
  await wait(`document.getElementById('toastRegion').textContent.includes('工程已保存')`);
  const saved = await (await fetch(`${url}/api/draft`)).json();
  assert.deepEqual(saved.project.parts[0], legacyPart, '旧轮廓不得因加载或保存被改成矩形');
  await js(`document.querySelector('[data-delete-part="0"]').click()`);
  assert.equal(await js(`document.getElementById('unsupportedPartsNotice').classList.contains('hidden')`), true);
  await js(`const transfer=new DataTransfer();transfer.items.add(new File(['数量,长度,宽度,厚度\\n2,100,200,18'],'parts.csv',{type:'text/csv'}));const fileInput=document.getElementById('fileInput');fileInput.files=transfer.files;fileInput.dispatchEvent(new Event('change',{bubbles:true}))`);
  await wait(`document.querySelector('#partsBody [data-field="quantity"]')?.value==='2'`);
  await js(`document.getElementById('optimizeButton').click()`);
  await wait(`!document.getElementById('optimizeButton').disabled && document.querySelectorAll('#layoutsContainer .part-rect').length===2`);
  assert.match(await js(`document.getElementById('quotationText').value`), /100\*200\*18mm 2张/);
  assert.equal(await js(`document.getElementById('copyQuotationTextButton').disabled`), false);
  assert.deepEqual(pageErrors, []);
  console.log('Rectangle Electron UI passed: removed CAD/shape controls, demo, live preview cancellation/restart, legacy preservation/rejection/deletion, CSV import and quotation.');
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
