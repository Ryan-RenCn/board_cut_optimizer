import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { app, BrowserWindow } from 'electron';
import { createBoardCutServer } from '../server.mjs';
app.whenReady().then(async()=>{
 let server,window;
 try {
  const project=JSON.parse(readFileSync(new URL('./fixtures/nesting-spare-space.json',import.meta.url)));
  server=createBoardCutServer({databasePath:':memory:',port:0,...(process.env.OPTIMIZATION_STATIC_ROOT?{staticRoot:process.env.OPTIMIZATION_STATIC_ROOT}:{})});const {url}=await server.start();
  const put=(path,body)=>fetch(url+path,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  await put('/api/global-settings',{globalSettings:{panels:project.panels,settings:project.settings}});
  await put('/api/draft',{project:{name:'余量补排与实时预览验收',parts:project.parts}});
  window=new BrowserWindow({show:false,width:1440,height:1100,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});await window.loadURL(url);
  const js=source=>window.webContents.executeJavaScript(source);
  const wait=condition=>js(`new Promise((resolve,reject)=>{const start=Date.now(),timer=setInterval(()=>{if(${condition}){clearInterval(timer);resolve()}else if(Date.now()-start>15000){clearInterval(timer);reject(Error('live preview timeout'))}},20)})`);
  await wait(`document.querySelector('[data-part-thumbnail="0"]')`);
  await js(`window.liveEvents=[];window.cancelOnPreview=false;new MutationObserver(()=>{const cards=document.querySelectorAll('.live-layout-card');if(cards.length){const n=document.querySelectorAll('.live-layout-card .part-rect').length;liveEvents.push({n,working:document.getElementById('optimizeButton').disabled});if(cancelOnPreview&&n){cancelOnPreview=false;document.getElementById('cancelLayoutOptimizeButton').click()}}}).observe(document.getElementById('layoutsContainer'),{childList:true,subtree:true});document.getElementById('optimizeButton').click()`);
  await wait(`!document.getElementById('optimizeButton').disabled`);
  const events=await js('liveEvents');
  assert.ok(events.some(e=>e.n>0&&e.n<12&&e.working),'应在计算未结束时实际绘制部分零件');
  assert.ok(events.some(e=>e.n===12&&e.working));
  assert.equal(await js(`document.querySelectorAll('#layoutsContainer .layout-card').length`),1);
  assert.equal(await js(`document.querySelectorAll('#layoutsContainer .part-rect').length`),12);
  assert.equal(await js(`document.getElementById('optimizationLiveStatus').classList.contains('hidden')`),true);
  assert.equal(await js(`document.querySelectorAll('#toastRegion .toast.error').length`),0);
  await window.webContents.insertCSS('.view {animation:none!important}');await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  writeFileSync(new URL('../reverse/se2dnest/spare-space-fixed-ui.png',import.meta.url),(await window.webContents.capturePage()).toPNG());
  await js(`window.cancelOnPreview=true;document.getElementById('optimizeButton').click()`);
  await wait(`!document.getElementById('optimizeButton').disabled`);
  assert.match(await js(`document.getElementById('toastRegion').textContent`),/已停止优化/);
  assert.equal(await js(`document.querySelectorAll('#layoutsContainer .part-rect').length`),0,'中止后不能把试排当成最终方案');
  console.log('Live preview Electron passed: real intermediate placements before completion, screenshot case 12 parts/1 sheet, final replacement and cancel from the layout view.');
 }catch(e){console.error(e);process.exitCode=1}finally{window?.destroy();await server?.close();app.exit(process.exitCode??0)}
});
