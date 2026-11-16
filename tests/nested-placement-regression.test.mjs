import assert from 'node:assert/strict';
import { fillPolygonSheet } from '../polygon-nesting.mjs';
import { shapesOverlap } from './fixtures/polygon-geometry-reference.mjs';
import { optimizeCuttingPlan } from '../engine.mjs';
const circle=(r,x=50,y=50)=>Array.from({length:80},(_,i)=>[x+r*Math.cos(i*Math.PI/40),y+r*Math.sin(i*Math.PI/40)]);
const frame={outer:[[0,0],[100,0],[100,100],[0,100]],holes:[[[20,20],[80,20],[80,80],[20,80]]]};
const part=(id,extra)=>({instanceId:id,rotationAngles:[0],...extra});
const settings={polygonPlacementStrategy:'bottomLeft',maxShapeVertices:256};
function verify(result,gap=0){for(let i=0;i<result.placements.length;i++)for(let j=i+1;j<result.placements.length;j++)assert.equal(shapesOverlap(result.placements[i].placedShape,result.placements[j].placedShape,gap),false)}
{
 const stock={length:100,width:100,material:'MDF',thickness:18,cost:100,weight:20};
 const project={settings:{...settings,optimizationLevel:'quick',sawWidth:0,panelMarginX:0,panelMarginY:0},panels:[stock],parts:[
  {id:'thin-frame',quantity:1,material:'MDF',thickness:18,shape:{outer:circle(50),holes:[circle(49)]},rotationAngles:[0]},
  {id:'insert',quantity:1,material:'MDF',thickness:18,shape:{outer:circle(48,48,48),holes:[]},rotationAngles:[0]}
 ]};
 const result=optimizeCuttingPlan(project);
 assert.equal(result.stats.usedPanels,1,'薄壁框净面积小，也必须先放外框再套入大零件');
 assert.equal(result.stats.placedCount,2);assert.equal(result.layouts[0].placements[0].id,'thin-frame');
 assert.equal(result.stats.partsArea,10000);assert.equal(result.stats.totalWeight,20);verify(result.layouts[0]);
}
{
 const result=fillPolygonSheet({length:220,width:100},[part('frame',{shape:frame}),part('inside',{length:60,width:60})],settings);
 assert.equal(result.placements.length,2);assert.equal(result.placements[1].x,20);assert.equal(result.placements[1].y,20,'有外部空间时也应优先利用内孔');verify(result);
}
for(const gap of [0,2]) {
 const radius=gap?27.9:30;
 const result=fillPolygonSheet({length:100,width:100},[part('round-frame',{shape:{outer:circle(50),holes:[circle(30)]}}),part('inside',{shape:{outer:circle(radius,radius,radius),holes:[]}})],{...settings,sawWidth:gap});
 assert.equal(result.placements.length,2,'NFP降级后仍必须生成圆孔中央的套排候选');
 assert.ok(result.diagnostics.fallbacks>0);assert.ok(Math.abs(result.placements[1].x-(50-radius))<1e-6);verify(result,gap);
}
{
 const result=fillPolygonSheet({length:100,width:100},[part('round-frame',{shape:{outer:circle(50),holes:[circle(30)]}}),part('too-large',{shape:{outer:circle(29,29,29),holes:[]}})],{...settings,sawWidth:2});
 assert.equal(result.placements.length,1,'孔内尺寸不足以保留锯缝时不能强行套排');
}
{
 const vertices=[[0,0],[100,0],[100,40],[40,40],[40,100],[0,100]];
 const dense=vertices.flatMap((p,i)=>Array.from({length:16},(_,j)=>[p[0]+(vertices[(i+1)%6][0]-p[0])*j/16,p[1]+(vertices[(i+1)%6][1]-p[1])*j/16]));
 const result=fillPolygonSheet({length:220,width:100},[part('L',{shape:{outer:dense,holes:[]}}),part('notch',{length:60,width:60})],{...settings,maxNfpTrianglePairs:1});
 assert.equal(result.placements.length,2);assert.equal(result.placements[1].x,40);assert.equal(result.placements[1].y,40,'凹槽转角不能被前段顶点预算挤掉');verify(result);
}
{
 const result=fillPolygonSheet({length:220,width:100},[part('frame',{shape:frame}),part('a',{length:30,width:60}),part('b',{length:30,width:60})],settings);
 assert.equal(result.placements.length,3);assert.ok(result.placements.slice(1).every(p=>p.x>=20&&p.x+p.placedLength<=80&&p.y===20));verify(result);
}
{
 const twoHoles={outer:[[0,0],[220,0],[220,100],[0,100]],holes:[frame.holes[0],[[140,20],[200,20],[200,80],[140,80]]]};
 const result=fillPolygonSheet({length:340,width:100},[part('two-holes',{shape:twoHoles}),part('a',{length:60,width:60}),part('b',{length:60,width:60})],{...settings,maxNfpTrianglePairs:1});
 assert.equal(result.placements.length,3);assert.deepEqual(result.placements.slice(1).map(p=>[p.x,p.y]),[[20,20],[140,20]],'第一个孔用满后必须继续检查后续内孔');verify(result);
}
{
 const result=fillPolygonSheet({length:200,width:200},[part('rotated-frame',{shape:frame,rotationAngles:[23.7]}),part('rotated-inner',{length:60,width:60,rotationAngles:[23.7]})],{...settings,maxNfpTrianglePairs:1});
 assert.equal(result.placements.length,2,'小数角旋转后的恰好内孔配合也必须能套排');verify(result);
}
console.log('Nested placement regressions passed: hole priority, dense curved holes with NFP fallback, dense L notch, repeated hole filling, gaps and 23.7° rotation.');
