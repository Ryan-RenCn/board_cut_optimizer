import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { createBoardCutServer } from '../server.mjs';
app.whenReady().then(async()=>{
  let server,window;
  try {
    server=createBoardCutServer({databasePath:':memory:',port:0,...(process.env.OPTIMIZATION_STATIC_ROOT ? {staticRoot:process.env.OPTIMIZATION_STATIC_ROOT} : {})});const {url}=await server.start();
    const put=(path,body)=>fetch(url+path,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const shape={outer:Array.from({length:800},(_,i)=>[100+100*Math.cos(i*Math.PI/400),100+100*Math.sin(i*Math.PI/400)]),holes:[]};
    await put('/api/global-settings',{globalSettings:{panels:[{id:'p',length:1220,width:2440,material:'MDF',thickness:18,cost:100,weight:40}],settings:{maxShapeVertices:1024,sawWidth:3,panelMarginX:10,panelMarginY:10,rotationStep:15,allowRotation:true,optimizationLevel:'full'}}});
    await put('/api/draft',{project:{name:'后台优化验收',parts:[{id:'large',quantity:200,length:200,width:200,shape,material:'MDF',thickness:18,allowRotate:true}]}});
    window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});await window.loadURL(url);
    const js=source=>window.webContents.executeJavaScript(source);
    const wait=condition=>js(`new Promise((resolve,reject)=>{const start=Date.now(),timer=setInterval(()=>{if(${condition}){clearInterval(timer);resolve()}else if(Date.now()-start>20000){clearInterval(timer);reject(Error('worker UI timeout'))}},25)})`);
    await wait(`document.querySelector('[data-part-thumbnail="0"]')`);
    await js(`document.getElementById('optimizeButton').click()`);
    const response=await js(`new Promise(resolve=>{let ticks=0;const interval=setInterval(()=>ticks++,10);setTimeout(()=>{clearInterval(interval);const active=!document.getElementById('cancelOptimizeButton').hidden;document.getElementById('cancelOptimizeButton').click();resolve({ticks,active})},250)})`);
    assert.equal(response.active,true);assert.ok(response.ticks>=5,'计算期间界面计时器必须正常运行');
    await wait(`!document.getElementById('optimizeButton').disabled`);
    assert.equal(await js(`document.getElementById('cancelOptimizeButton').hidden`),true);
    assert.match(await js(`document.getElementById('toastRegion').textContent`),/已停止优化/);
    assert.equal(await js(`document.querySelectorAll('#layoutsContainer .part-rect').length`),0);
    await js(`const q=document.querySelector('#partsBody [data-field="quantity"]');q.value=1;q.dispatchEvent(new Event('input',{bubbles:true}));const rotation=document.querySelector('[data-setting="allowRotation"]');rotation.checked=false;rotation.dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('optimizeButton').click()`);
    await wait(`!document.getElementById('optimizeButton').disabled`);
    assert.equal(await js(`document.querySelectorAll('#layoutsContainer .part-rect').length`),1);
    assert.match(await js(`document.getElementById('reportContent').textContent`),/200\*200\*18mm/);
    const timeout=await js(`(async()=>{const {startOptimization}=await import('./optimization-client.mjs');const project={settings:{maxShapeVertices:1024},parts:[{shape:${JSON.stringify(shape)},quantity:20,length:200,width:200,material:'MDF',thickness:18}],panels:[{length:1220,width:2440,material:'MDF',thickness:18}]};try{await startOptimization(project,{timeoutMs:20}).promise;return false}catch(e){return e.message.includes('已停止')}})()`);
    assert.equal(timeout,true);
    console.log('Optimization Electron UI passed: 800-vertex busy worker, responsive UI heartbeat, real cancellation, restart/result/quote and real worker timeout.');
  }catch(e){console.error(e);process.exitCode=1}finally{window?.destroy();await server?.close();app.exit(process.exitCode??0)}
});
