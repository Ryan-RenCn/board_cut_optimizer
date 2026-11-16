import assert from 'node:assert/strict';
import {app,BrowserWindow} from 'electron';
import {createBoardCutServer} from '../server.mjs';
app.whenReady().then(async()=>{
 let server,window;
 try{
  server=createBoardCutServer({databasePath:':memory:',port:0,...(process.env.OPTIMIZATION_STATIC_ROOT?{staticRoot:process.env.OPTIMIZATION_STATIC_ROOT}:{})});const{url}=await server.start();
  const put=(path,body)=>fetch(url+path,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  await put('/api/global-settings',{globalSettings:{panels:[{id:'p',length:1220,width:2440,material:'MDF',thickness:18,cost:100,weight:40}],settings:{maxShapeVertices:512}}});
  await put('/api/draft',{project:{name:'自动解析验收',parts:[{id:'blank',length:0,width:0,quantity:1,material:'MDF',thickness:18}]}});
  window=new BrowserWindow({show:false,width:1440,height:1100,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});await window.loadURL(url);
  const js=s=>window.webContents.executeJavaScript(s);
  const wait=c=>js(`new Promise((resolve,reject)=>{const t=Date.now(),id=setInterval(()=>{if(${c}){clearInterval(id);resolve()}else if(Date.now()-t>15000){clearInterval(id);reject(Error('auto preview timeout'))}},25)})`);
  await wait(`document.querySelector('[data-part-thumbnail="0"]')`);
  const dxf='0\nSECTION\n2\nENTITIES\n0\nLWPOLYLINE\n90\n4\n70\n1\n10\n0\n20\n0\n10\n100\n20\n0\n10\n100\n20\n60\n10\n0\n20\n60\n0\nLINE\n10\n200\n20\n0\n11\n230\n21\n30\n0\nREGION\n10\n300\n20\n0\n11\n340\n21\n20\n0\nENDSEC\n0\nEOF\n';
  await js(`(()=>{document.getElementById('importCadButton').click();const dt=new DataTransfer();dt.items.add(new File([${JSON.stringify(dxf)}],'mixed.dxf'));dt.items.add(new File(['broken'],'bad.dxf'));document.getElementById('cadFileInput').files=dt.files;document.getElementById('cadFileInput').dispatchEvent(new Event('change'))})()`);
  await wait(`document.querySelector('[data-cad-drawing]')`);
  assert.equal(await js(`document.querySelectorAll('.cad-preview-item').length`),4);
  assert.equal(await js(`document.querySelectorAll('.cad-preview-item.is-unresolved').length`),3);
  assert.equal(await js(`document.querySelectorAll('[data-cad-select]:disabled').length`),3);
  assert.equal(await js(`document.querySelectorAll('[data-cad-drawing] .is-unresolved').length`),2);
  await js(`document.querySelector('[data-cad-action="select-visible"]').click()`);
  assert.equal(await js(`document.querySelectorAll('[data-cad-select]:checked').length`),1);
  await js(`document.getElementById('cadQuantity').value='2';document.getElementById('cadQuantity').dispatchEvent(new Event('input'))`);
  await wait(`document.querySelector('[data-cad-quantity="0"]')?.value==='2'`);
  assert.equal(await js(`document.querySelectorAll('[data-part-thumbnail]').length`),1);
  await js(`document.getElementById('commitCadButton').click()`);await new Promise(r=>setTimeout(r,500));
  const saved=(await(await fetch(url+'/api/draft')).json()).project;
  assert.equal(saved.parts.length,1);assert.equal(saved.parts[0].quantity,2);assert.equal(saved.parts[0].length,100);assert.equal(saved.parts[0].previewDisabled,undefined);
  console.log('Automatic CAD preview Electron passed: file-change-only parsing, gray failed objects/files, nonselectable gray items, automatic parameter refresh and valid-only import.');
 }catch(e){console.error(e);process.exitCode=1}finally{window?.destroy();await server?.close();app.exit(process.exitCode??0)}
});
