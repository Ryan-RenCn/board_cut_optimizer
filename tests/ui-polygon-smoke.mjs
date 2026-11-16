// Explicit Electron check with isolated in-memory data and real browser rendering.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { createBoardCutServer } from '../server.mjs';

const outer = [[0, 0], [400, 0], [400, 300], [0, 300]];
const holes = [[[50, 50], [50, 250], [350, 250], [350, 50]]];
const project = { name: '异形与小数角验收', lossRate: 0, parts: [
  { id: 'frame', quantity: 1, length: 400, width: 300, material: 'MDF', thickness: 18, allowRotate: true, shape: { outer, holes }, rotationAngles: [0], code: 'FRAME' },
  { id: 'slanted', quantity: 1, length: 150, width: 100, material: 'MDF', thickness: 18, allowRotate: true, rotationAngles: [17.3], code: 'ANGLE-17.3' },
] };

app.whenReady().then(async () => {
  let server, window;
  const errors = [];
  try {
    server = createBoardCutServer({ databasePath: ':memory:', port: 0, ...(process.env.OPTIMIZATION_STATIC_ROOT ? { staticRoot: process.env.OPTIMIZATION_STATIC_ROOT } : {}) });
    const { url } = await server.start();
    const put = async (path, body) => {
      const response = await fetch(`${url}${path}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.ok, true);
    };
    await put('/api/global-settings', { globalSettings: { panels: [{ id: 'p', length: 500, width: 400, material: 'MDF', thickness: 18, cost: 100, weight: 40 }], settings: { sawWidth: 3, panelMarginX: 10, panelMarginY: 10, rotationStep: 15, allowRotation: true, optimizationLevel: 'quick' } } });
    await put('/api/draft', { project });
    window = new BrowserWindow({ show: false, width: 1440, height: 1100, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    window.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
    await window.loadURL(url);
    await window.webContents.insertCSS('.view { animation: none !important; }');
    await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
      const start=Date.now(); const timer=setInterval(()=>{
        if(document.querySelector('[data-edit-shape="0"]')){clearInterval(timer);resolve();}
        else if(Date.now()-start>10000){clearInterval(timer);reject(new Error('零件未加载'));}
      },30);
    })`);
    const editor = await window.webContents.executeJavaScript(`(() => {
      document.querySelector('[data-edit-shape="0"]').click();
      const get=id=>document.getElementById(id);
      const original=get('shapeOuterInput').value;
      const holeCount=get('shapeHolesInput').value.trim().split(/\\n\\s*\\n/).length;
      get('shapeOuterInput').value='0,0\\n100,100\\n0,100\\n100,0';
      get('shapePreviewButton').click();
      const rejected=get('shapeEditorError').textContent.length>0;
      get('shapeOuterInput').value=original;
      get('shapeAnglesInput').value='0';
      get('shapeForm').requestSubmit();
      return {rejected,holeCount,closed:!get('shapeDialog').open,
        readOnly:document.querySelector('#partsBody [data-field="length"]').readOnly};
    })()`);
    assert.deepEqual(editor, { rejected: true, holeCount: 1, closed: true, readOnly: true });
    await window.webContents.executeJavaScript(`document.getElementById('optimizeButton').click()`);
    await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
      const start=Date.now(); const timer=setInterval(()=>{
        if(!document.getElementById('optimizeButton').disabled && document.querySelectorAll('#layoutsContainer .part-rect').length===2){clearInterval(timer);resolve();}
        else if(Date.now()-start>20000){clearInterval(timer);reject(new Error('异形优化未生成'));}
      },30);
    })`);
    const drawing = await window.webContents.executeJavaScript(`(() => {
      const get=id=>document.getElementById(id);
      const shapes=[...get('layoutsContainer').querySelectorAll('.part-rect')];
      return {count:shapes.length, paths:shapes.every(p=>p.tagName.toLowerCase()==='path'),
        hole:shapes.some(p=>(p.getAttribute('d').match(/M/g)||[]).length===2),
        evenodd:shapes.every(p=>p.getAttribute('fill-rule')==='evenodd'),
        angle:shapes.some(p=>p.textContent.includes('17.3°')),
        nested:shapes.filter(p=>p.textContent.includes('17.3°')).every(p=>{const b=p.getBBox();return b.x>=60-1e-6&&b.y>=60-1e-6&&b.x+b.width<=360+1e-6&&b.y+b.height<=260+1e-6}),
        stats:get('layoutStats').textContent};
    })()`);
    assert.equal(drawing.count, 2);
    assert.equal(drawing.paths, true);
    assert.equal(drawing.hole, true);
    assert.equal(drawing.evenodd, true);
    assert.equal(drawing.angle, true);
    assert.equal(drawing.nested, true, '17.3度零件必须实际放在框的内孔中');
    assert.match(drawing.stats, /67\.5%/);
    assert.match(drawing.stats, /27 kg/);
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await new Promise((resolve) => setTimeout(resolve, 650));
    const screenshot = await window.webContents.capturePage();
    writeFileSync(fileURLToPath(new URL('../reverse/se2dnest/polygon-ui-preview.png', import.meta.url)), screenshot.toPNG());
    const saved = (await (await fetch(`${url}/api/draft`)).json()).project;
    assert.deepEqual(saved.parts[0].shape.holes, holes);
    assert.deepEqual(saved.parts[1].rotationAngles, [17.3]);
    assert.deepEqual(errors, []);
    console.log('Polygon Electron UI passed: editor validation, hole paths, 17.3° display, trace, original 67.5% / 27 kg accounting, and saved contours.');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { window?.destroy(); await server?.close(); app.exit(process.exitCode ?? 0); }
});
