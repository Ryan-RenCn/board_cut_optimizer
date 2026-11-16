import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { app, BrowserWindow } from 'electron';
import { createBoardCutServer } from '../server.mjs';
app.whenReady().then(async()=>{
  let server,window;
  try {
    server=createBoardCutServer({databasePath:':memory:',port:0,...(process.env.DWG_CONVERTER_PATH ? {dwgConverterPath:process.env.DWG_CONVERTER_PATH} : {})}); const {url}=await server.start();
    const put=(path,body)=>fetch(url+path,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    await put('/api/global-settings',{globalSettings:{panels:[{id:'p',length:1220,width:2440,material:'MDF',thickness:18,cost:100,weight:40}],settings:{sawWidth:3,panelMarginX:10,panelMarginY:10,rotationStep:90,allowRotation:true,optimizationLevel:'quick'}}});
    await put('/api/draft',{project:{name:'DWG验收',parts:[{id:'blank',quantity:1,length:0,width:0,material:'MDF',thickness:18,allowRotate:true,code:'',description:''}]}});
    window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});await window.loadURL(url);
    const js=source=>window.webContents.executeJavaScript(source);
    const wait=condition=>js(`new Promise((resolve,reject)=>{const start=Date.now(),timer=setInterval(()=>{if(${condition}){clearInterval(timer);resolve()}else if(Date.now()-start>40000){clearInterval(timer);reject(Error('DWG UI timeout'))}},30)})`);
    await wait(`document.querySelector('[data-part-thumbnail="0"]')`);
    const data=[...readFileSync(new URL('./fixtures/dwg/circle-2018.dwg',import.meta.url))];
    await js(`document.getElementById('importCadButton').click();const dt=new DataTransfer();dt.items.add(new File([new Uint8Array(${JSON.stringify(data)})],'circle.dwg'));document.getElementById('cadFileInput').files=dt.files;document.getElementById('cadFileInput').dispatchEvent(new Event('change'));document.getElementById('cadImportForm').requestSubmit()`);
    await wait(`!document.getElementById('commitCadButton').disabled || document.getElementById('cadImportError').textContent`);
    assert.equal(await js(`document.getElementById('cadImportError').textContent`),'');
    assert.equal(await js(`document.querySelectorAll('.cad-preview-item').length`),1);
    await js(`document.getElementById('commitCadButton').click()`);
    assert.equal(await js(`document.querySelectorAll('[data-part-thumbnail] svg').length`),1);
    await new Promise(r=>setTimeout(r,800));
    const project=(await(await fetch(url+'/api/draft')).json()).project;
    assert.equal(project.parts[0].cadSource.format,'DWG');assert.equal(project.parts[0].cadSource.fileName,'circle.dwg');assert.equal(project.parts[0].shape.holes.length,0);
    await js(`document.getElementById('optimizeButton').click()`);await wait(`document.querySelectorAll('#layoutsContainer .part-rect').length===1`);
    console.log('DWG Electron UI passed: binary upload, offline conversion, preview, row thumbnail, CAD source persistence and nesting.');
  }catch(e){console.error(e);process.exitCode=1}finally{window?.destroy();await server?.close();app.exit(process.exitCode??0)}
});
