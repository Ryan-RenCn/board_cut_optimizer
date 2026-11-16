import assert from 'node:assert/strict';
import { normalizeShape, transformShape, shapesOverlap, prepareShapeCollision } from '../polygon-geometry.mjs';
import { shapesOverlap as referenceOverlap } from './fixtures/polygon-geometry-reference.mjs';
const fixtures=[
 {outer:[[0,0],[100,0],[100,70],[0,70]],holes:[]},
 {outer:[[0,0],[100,0],[100,20],[25,20],[25,80],[0,80]],holes:[]},
 {outer:[[0,0],[120,0],[120,100],[0,100]],holes:[[[20,20],[100,20],[100,80],[20,80]]]},
 {outer:Array.from({length:100},(_,i)=>[50+50*Math.cos(i*Math.PI/50),35+35*Math.sin(i*Math.PI/50)]),holes:[]}
].map(s=>normalizeShape(s));
let seed=73421;
const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296};
for(let i=0;i<180;i++) {
 const first=transformShape(fixtures[i%fixtures.length],random()*360,random()*40,random()*40);
 const local=transformShape(fixtures[(i+1)%fixtures.length],random()*360);
 const x=random()*180-40,y=random()*150-40,gap=[0,.1,3][i%3];
 const translated={outer:local.outer.map(([a,b])=>[a+x,b+y]),holes:local.holes.map(r=>r.map(([a,b])=>[a+x,b+y]))};
 const expected=referenceOverlap(first,translated,gap);
 assert.equal(shapesOverlap(first,translated,gap),expected,`indexed collision ${i}`);
 assert.equal(shapesOverlap(first,local,gap,prepareShapeCollision(first),prepareShapeCollision(local),x,y),expected,`translated index ${i}`);
}
console.log('Polygon collision index tests passed: 180 seeded comparisons with previous exact checker, holes, arbitrary angles, gaps and translated indices.');
