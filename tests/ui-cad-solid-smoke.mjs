import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { createBoardCutServer } from '../server.mjs';
app.whenReady().then(async()=>{
 let server,window;
 try {
  server=createBoardCutServer({databasePath:':memory:',port:0,...(process.env.OPTIMIZATION_STATIC_ROOT?{staticRoot:process.env.OPTIMIZATION_STATIC_ROOT}:{})});const {url}=await server.start();
  const put=(path,body)=>fetch(url+path,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  await put('/api/global-settings',{globalSettings:{panels:[{id:'p',length:500,width:400,material:'MDF',thickness:18,cost:100,weight:40}],settings:{maxShapeVertices:512}}});
  await put('/api/draft',{project:{name:'SOLID导入验收',parts:[{id:'blank',quantity:1,length:0,width:0,material:'MDF',thickness:18,allowRotate:true}]}});
  window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});await window.loadURL(url);
  const js=source=>window.webContents.executeJavaScript(source);
  const wait=condition=>js(`new Promise((resolve,reject)=>{const start=Date.now(),timer=setInterval(()=>{if(${condition}){clearInterval(timer);resolve()}else if(Date.now()-start>10000){clearInterval(timer);reject(Error('SOLID UI timeout'))}},25)})`);
  await wait(`document.querySelector('[data-part-thumbnail="0"]')`);
  const solid='0\nSOLID\n10\n10\n20\n10\n11\n30\n21\n10\n12\n10\n22\n30\n13\n30\n23\n30\n';
  const rectangle='0\nLWPOLYLINE\n90\n4\n70\n1\n10\n0\n20\n0\n10\n100\n20\n0\n10\n100\n20\n60\n10\n0\n20\n60\n';
  const drawing=entities=>`0\nSECTION\n2\nENTITIES\n${entities}0\nENDSEC\n0\nEOF\n`;
  const load=async text=>{await js(`(()=>{const dt=new DataTransfer();dt.items.add(new File([${JSON.stringify(text)}],'solid.dxf'));document.getElementById('cadFileInput').files=dt.files;document.getElementById('cadFileInput').dispatchEvent(new Event('change'));document.getElementById('cadImportForm').requestSubmit()})()`);await wait(`!document.getElementById('parseCadButton').disabled`)};
  await js(`document.getElementById('importCadButton').click()`);
  await load(drawing(rectangle+solid));
  assert.equal(await js(`document.getElementById('cadImportError').textContent`),'');
  assert.equal(await js(`document.querySelectorAll('.cad-preview-item:not(.is-unresolved)').length`),1);
  assert.match(await js(`document.getElementById('cadImportPreview').textContent`),/0 个内孔/);
  assert.match(await js(`document.getElementById('cadImportPreview').textContent`),/忽略SOLID/);
  await load(drawing(solid));
  assert.equal(await js(`document.querySelectorAll('.cad-preview-item.is-unresolved').length`),1);
  assert.equal(await js(`document.getElementById('commitCadButton').disabled`),true);
  await js(`document.getElementById('cadSolidMode').value='outline';document.getElementById('cadSolidMode').dispatchEvent(new Event('change'))`);
  await js(`document.getElementById('cadImportForm').requestSubmit()`);await wait(`!document.getElementById('parseCadButton').disabled`);
  assert.equal(await js(`document.getElementById('cadImportError').textContent`),'');
  assert.equal(await js(`document.querySelectorAll('.cad-preview-item').length`),1);
  await js(`document.getElementById('commitCadButton').click()`);
  await new Promise(r=>setTimeout(r,500));
  const saved=(await(await fetch(url+'/api/draft')).json()).project;
  assert.equal(saved.parts.length,1);assert.equal(saved.parts[0].length,20);assert.equal(saved.parts[0].width,20);assert.equal(saved.parts[0].cadSource.solidMode,'outline');
  assert.equal(await js(`document.querySelectorAll('[data-part-thumbnail] svg').length`),1);
  console.log('CAD SOLID Electron passed: ignore annotation fill without false holes, fill-only guidance, explicit boundary preview, thumbnail and SQLite source preservation.');
 }catch(e){console.error(e);process.exitCode=1}finally{window?.destroy();await server?.close();app.exit(process.exitCode??0)}
});
