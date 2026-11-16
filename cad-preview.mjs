import { shapeBounds } from './polygon-geometry.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const rectangle = part => ({outer:[[0,0],[Number(part.length),0],[Number(part.length),Number(part.width)],[0,Number(part.width)]],holes:[]});
const pathFor = shape => [shape.outer,...(shape.holes ?? [])].map(ring => ring.map((p,index)=>`${index?'L':'M'}${p[0]},${p[1]}`).join(' ')+' Z').join(' ');

export function buildCadPreviewScene(parts) {
  const cursors = new Map();
  return parts.map((part,index)=>{
    const shape=part.shape??(part.previewDisabled?{outer:[[0,0],[1,0],[1,1]],holes:[]}:rectangle(part));
    const rings=[shape.outer,...(shape.holes??[])];
    if(rings.some(ring=>!Array.isArray(ring)||ring.some(p=>!Array.isArray(p)||p.length!==2||!p.every(finite))))throw new Error('CAD预览坐标无效');
    const bounds=shapeBounds(shape.outer.length<3?{outer:[shape.outer[0],shape.outer.at(-1),shape.outer.at(-1)]}:shape);
    const fileName=String(part.cadSource?.fileName??'导入图纸');
    const fileId=String(part.cadSource?.previewFileId??fileName);
    const sourceOrigin=part.cadSource?.origin;
    const origin=Array.isArray(sourceOrigin)&&sourceOrigin.length===2&&sourceOrigin.every(finite)?[...sourceOrigin]:[cursors.get(fileId)??0,0];
    cursors.set(fileId,Math.max(cursors.get(fileId)??0,origin[0]+bounds.width+Math.max(10,bounds.width*.06)));
    const layers=Array.isArray(part.cadSource?.layers)&&part.cadSource.layers.length?part.cadSource.layers.map(String):['0'];
    return {index,part,fileId,fileName,layers,origin,drawable:part.previewLocated!==false,path:part.previewDisabled&&part.previewClosed!==true?pathFor(shape).replace(/ Z/g,''):pathFor(shape),bounds:{minX:bounds.minX+origin[0],minY:bounds.minY+origin[1],maxX:bounds.maxX+origin[0],maxY:bounds.maxY+origin[1],width:bounds.width,height:bounds.height}};
  });
}

export function createCadPreview(root, parts, { thumbnail = () => '', formatNumber = value => String(value), onSelectionChange = () => {} } = {}) {
  const entries=buildCadPreviewScene(parts);
  const selected=new Set(entries.filter(e=>!e.part.previewDisabled).map(entry=>entry.index));
  let focused=entries[0]?.index??-1,fileFilter='',layerFilter='',drag=null,suppressClick=false,destroyed=false,clickResetTimer;
  const invalidQuantities=new Set();
  const quantityDrafts=new Map();
  let view={x:0,y:0,w:100,h:100},fitView={...view};
  const cleanup=new AbortController(),signal=cleanup.signal;
  const files=[...new Map(entries.map(entry=>[entry.fileId,entry.fileName])).entries()];
  root.innerHTML=`<div class="cad-drawing-toolbar">
    <label>图纸<select data-cad-file aria-label="预览图纸"><option value="">全部图纸</option>${files.map(([id,name])=>`<option value="${escape(id)}">${escape(name)}</option>`).join('')}</select></label>
    <label>图层<select data-cad-layer aria-label="预览图层"></select></label>
    <button class="button small" type="button" data-cad-action="zoom-in" aria-label="放大图纸">＋</button><button class="button small" type="button" data-cad-action="zoom-out" aria-label="缩小图纸">−</button><button class="button small" type="button" data-cad-action="fit">适合窗口</button>
    <span class="cad-zoom-label" data-cad-zoom></span>
  </div>
  <div class="cad-drawing-workspace"><div class="cad-drawing-pane"><svg class="cad-drawing-svg" data-cad-drawing role="img" aria-label="CAD整图预览" tabindex="0"><g data-cad-paths></g></svg><p class="cad-drawing-hint">滚轮缩放 · 右键或空白处拖动平移 · 点击轮廓查看对应零件</p><div class="cad-drawing-empty" data-cad-empty hidden>当前图纸或图层没有可显示的零件</div></div>
  <div class="cad-parts-pane"><div class="cad-selection-toolbar"><b data-cad-count></b><div><button class="button small" type="button" data-cad-action="select-visible">全选可见</button><button class="button small" type="button" data-cad-action="clear-visible">取消可见</button></div></div><div class="cad-preview-grid" data-cad-list></div><p class="cad-list-limit" data-cad-limit></p></div></div><p class="cad-preview-detail" data-cad-detail></p>`;
  const get=selector=>root.querySelector(selector),svg=get('[data-cad-drawing]');
  // Across several files, use separate drawing offsets to avoid overlapping
  // independent coordinate systems; each file's internal positions stay intact.
  const fileOffsets=new Map();
  let offsetCursor=0;
  for(const [id]of files){const group=entries.filter(e=>e.fileId===id);const min=Math.min(...group.map(e=>e.bounds.minX));const max=Math.max(...group.map(e=>e.bounds.maxX));fileOffsets.set(id,offsetCursor-min);offsetCursor+=max-min+Math.max(20,(max-min)*.08);}
  const displayOffset=entry=>fileFilter?0:fileOffsets.get(entry.fileId)??0;
  const visible=()=>entries.filter(entry=>(!fileFilter||entry.fileId===fileFilter)&&(!layerFilter||entry.layers.includes(layerFilter)));
  const updateView=()=>{svg.setAttribute('viewBox',`${view.x} ${view.y} ${view.w} ${view.h}`);get('[data-cad-zoom]').textContent=`${Math.round(fitView.w/view.w*100)}%`;};
  const fit=()=>{
    const shown=visible().filter(e=>e.drawable!==false);
    if(!shown.length){view={x:0,y:0,w:100,h:100};fitView={...view};updateView();return;}
    const minX=Math.min(...shown.map(e=>e.bounds.minX+displayOffset(e))),maxX=Math.max(...shown.map(e=>e.bounds.maxX+displayOffset(e)));
    const minY=Math.min(...shown.map(e=>e.bounds.minY)),maxY=Math.max(...shown.map(e=>e.bounds.maxY));
    const pad=Math.max(2,Math.max(maxX-minX,maxY-minY)*.06);
    fitView={x:minX-pad,y:minY-pad,w:Math.max(1,maxX-minX+pad*2),h:Math.max(1,maxY-minY+pad*2)};view={...fitView};updateView();
  };
  const updateSelection=()=>{
    const total=entries.filter(e=>selected.has(e.index)).reduce((sum,e)=>sum+Number(e.part.quantity||0),0);
    get('[data-cad-count]').textContent=`已选 ${selected.size} / ${entries.filter(e=>!e.part.previewDisabled).length} 种 · ${formatNumber(total)} 件`;
    get('[data-cad-detail]').textContent=focused<0?'':(()=>{const entry=entries[focused];return `${entry.part.code||`零件 ${focused+1}`} · ${entry.fileName} · 图层 ${entry.layers.join('/')} · ${formatNumber(entry.part.length,2)} × ${formatNumber(entry.part.width,2)} mm · ${entry.part.shape?.holes?.length??0} 个内孔${entry.part.previewDisabled?' · 不可导入：'+entry.part.previewReason:''}`;})();
    root.querySelectorAll('[data-cad-part]').forEach(element=>{const index=Number(element.dataset.cadPart);element.classList.toggle('is-unresolved',Boolean(parts[index]?.previewDisabled));element.classList.toggle('is-focused',index===focused);element.classList.toggle('is-excluded',!selected.has(index));element.setAttribute('aria-selected',String(index===focused));});
    root.querySelectorAll('[data-cad-select]').forEach(input=>{input.checked=selected.has(Number(input.dataset.cadSelect));});
    const invalid=[...invalidQuantities].find(index=>selected.has(index));
    onSelectionChange([...selected].sort((a,b)=>a-b).map(index=>parts[index]),{error:invalid===undefined?'':`零件 ${invalid+1} 的数量须为1–10000的整数`});
  };
  const renderList=()=>{
    const shown=visible(),limited=shown.slice(0,200),focus=shown.find(e=>e.index===focused);
    if(focus&&!limited.includes(focus))limited.push(focus);
    get('[data-cad-list]').innerHTML=limited.map(entry=>`<article class="cad-preview-item" data-cad-part="${entry.index}" tabindex="0" role="option" aria-label="${escape(entry.part.code||`零件 ${entry.index+1}`)}"><label class="cad-preview-check"><input type="checkbox" data-cad-select="${entry.index}" aria-label="导入${escape(entry.part.code||`零件 ${entry.index+1}`)}" ${selected.has(entry.index)?'checked':''} ${entry.part.previewDisabled?'disabled':''} /></label><div class="cad-preview-thumb">${thumbnail(entry.part,`${entry.part.code||entry.index+1} 导入预览`)}</div><div class="cad-preview-fields"><b>${escape(entry.part.code||`零件 ${entry.index+1}`)}</b><span>${formatNumber(entry.part.length,2)} × ${formatNumber(entry.part.width,2)} mm</span><small>${entry.part.previewDisabled?escape(entry.part.previewReason):`${entry.part.shape?.holes?.length??0} 个内孔`} · 图层 ${escape(entry.layers.join('/'))}</small><label class="cad-preview-quantity">数量 <input type="number" min="1" max="10000" step="1" value="${escape(quantityDrafts.get(entry.index)??Number(entry.part.quantity))}" ${entry.part.previewDisabled?'disabled':''} data-cad-quantity="${entry.index}" aria-label="${escape(entry.part.code||`零件 ${entry.index+1}`)}数量" /></label></div></article>`).join('');
    get('[data-cad-limit]').textContent=shown.length>200?`图中显示全部 ${shown.length} 种轮廓；列表先显示前200种，点击图中轮廓可定位其他零件。`:'';
  };
  const render=()=>{
    const shown=visible();
    if(!shown.some(entry=>entry.index===focused))focused=shown[0]?.index??-1;
    get('[data-cad-paths]').innerHTML=shown.filter(e=>e.drawable!==false).map(entry=>`<path class="cad-drawing-part" data-cad-part="${entry.index}" transform="translate(${entry.origin[0]+displayOffset(entry)},${entry.origin[1]})" d="${entry.path}" fill-rule="evenodd" vector-effect="non-scaling-stroke" tabindex="0" role="button" aria-label="${escape(entry.part.code||`零件 ${entry.index+1}`)}"><title>${escape(entry.part.code||`零件 ${entry.index+1}`)} · ${escape(entry.fileName)} · 图层 ${escape(entry.layers.join('/'))}</title></path>`).join('');
    get('[data-cad-empty]').hidden=shown.some(e=>e.drawable!==false);
    renderList();updateSelection();fit();
  };
  const updateLayers=()=>{
    const values=[...new Set(entries.filter(e=>!fileFilter||e.fileId===fileFilter).flatMap(e=>e.layers))].sort((a,b)=>a.localeCompare(b));
    if(!values.includes(layerFilter))layerFilter='';
    get('[data-cad-layer]').innerHTML=`<option value="">全部图层</option>${values.map(layer=>`<option value="${escape(layer)}">${escape(layer)}</option>`).join('')}`;get('[data-cad-layer]').value=layerFilter;
  };
  const focusPart=index=>{
    if(!Number.isInteger(index)||!entries[index])return;
    focused=index;renderList();updateSelection();get(`[data-cad-list] [data-cad-part="${index}"]`)?.scrollIntoView({block:'nearest'});
  };
  const pointAt=(clientX,clientY)=>{
    const matrix=svg.getScreenCTM();
    if(matrix){const point=svg.createSVGPoint();point.x=clientX;point.y=clientY;const result=point.matrixTransform(matrix.inverse());return {x:result.x,y:result.y};}
    return {x:view.x+view.w/2,y:view.y+view.h/2};
  };
  const zoom=(factor,point={x:view.x+view.w/2,y:view.y+view.h/2})=>{
    const width=Math.min(fitView.w*50,Math.max(fitView.w/200,view.w*factor));factor=width/view.w;
    view={x:point.x-(point.x-view.x)*factor,y:point.y-(point.y-view.y)*factor,w:width,h:view.h*factor};updateView();
  };
  root.addEventListener('click',event=>{
    if(suppressClick){suppressClick=false;return;}
    const button=event.target.closest('[data-cad-action]');
    if(button){const action=button.dataset.cadAction;if(action==='fit')fit();else if(action==='zoom-in')zoom(.8);else if(action==='zoom-out')zoom(1.25);else{for(const entry of visible().filter(e=>!e.part.previewDisabled))action==='select-visible'?selected.add(entry.index):selected.delete(entry.index);updateSelection();}return;}
    if(event.target.matches('input,select,textarea')||event.target.closest('.cad-preview-check,.cad-preview-quantity'))return;
    const entry=event.target.closest('[data-cad-part]');if(entry)focusPart(Number(entry.dataset.cadPart));
  },{signal});
  const editQuantity=input=>{
    const index=Number(input.dataset.cadQuantity),value=Number(input.value);
    quantityDrafts.set(index,input.value);
    if(!Number.isInteger(value)||value<1||value>10000){invalidQuantities.add(index);input.setCustomValidity('数量须为1–10000的整数');}
    else{invalidQuantities.delete(index);input.setCustomValidity('');parts[index].quantity=value;}
    updateSelection();
  };
  root.addEventListener('change',event=>{
    if(event.target.matches('[data-cad-quantity]'))editQuantity(event.target);
    else if(event.target.matches('[data-cad-select]')){const index=Number(event.target.dataset.cadSelect);if(parts[index]?.previewDisabled)return;event.target.checked?selected.add(index):selected.delete(index);focused=index;updateSelection();}
    else if(event.target.matches('[data-cad-file]')){fileFilter=event.target.value;updateLayers();render();}
    else if(event.target.matches('[data-cad-layer]')){layerFilter=event.target.value;render();}
  },{signal});
  root.addEventListener('input',event=>{
    if(!event.target.matches('[data-cad-quantity]'))return;
    editQuantity(event.target);
  },{signal});
  root.addEventListener('keydown',event=>{
    if(event.target.matches('input,select,textarea,button')){if(event.key==='Enter'&&event.target.matches('[data-cad-quantity],[data-cad-select]'))event.preventDefault();return;}
    const item=event.target.closest('[data-cad-part]');
    if(item&&(event.key==='Enter'||event.key===' ')){event.preventDefault();focusPart(Number(item.dataset.cadPart));}
  },{signal});
  svg.addEventListener('wheel',event=>{event.preventDefault();zoom(event.deltaY<0?.85:1/.85,pointAt(event.clientX,event.clientY));},{signal,passive:false});
  svg.addEventListener('contextmenu',event=>event.preventDefault(),{signal});
  svg.addEventListener('pointerdown',event=>{
    if(event.button!==2&&event.button!==1&&!(event.button===0&&!event.target.closest('[data-cad-part]')))return;
    event.preventDefault();drag={id:event.pointerId,start:pointAt(event.clientX,event.clientY),x:event.clientX,y:event.clientY,view:{...view},moved:false};svg.setPointerCapture(event.pointerId);svg.classList.add('is-panning');
  },{signal});
  svg.addEventListener('pointermove',event=>{
    if(!drag||drag.id!==event.pointerId)return;
    const current=pointAt(event.clientX,event.clientY);view.x+=drag.start.x-current.x;view.y+=drag.start.y-current.y;drag.moved ||= Math.hypot(event.clientX-drag.x,event.clientY-drag.y)>3;updateView();
  },{signal});
  const endDrag=event=>{if(!drag||drag.id!==event.pointerId)return;suppressClick=drag.moved&&event.button===0;clearTimeout(clickResetTimer);if(suppressClick)clickResetTimer=setTimeout(()=>{suppressClick=false;},0);drag=null;svg.classList.remove('is-panning');if(svg.hasPointerCapture(event.pointerId))svg.releasePointerCapture(event.pointerId);};
  svg.addEventListener('pointerup',endDrag,{signal});svg.addEventListener('pointercancel',endDrag,{signal});svg.addEventListener('lostpointercapture',()=>{drag=null;svg.classList.remove('is-panning');},{signal});
  updateLayers();render();
  return {getSelectedParts:()=>{if([...invalidQuantities].some(index=>selected.has(index)))throw new Error('所选零件存在无效数量，请修正后添加');return entries.filter(e=>selected.has(e.index)&&!e.part.previewDisabled).map(e=>e.part);},destroy(){if(destroyed)return;destroyed=true;clearTimeout(clickResetTimer);if(drag&&svg.hasPointerCapture(drag.id))svg.releasePointerCapture(drag.id);drag=null;cleanup.abort();}};
}
