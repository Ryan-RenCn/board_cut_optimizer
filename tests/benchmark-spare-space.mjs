import { readFileSync, writeFileSync } from 'node:fs';
import { optimizeCuttingPlan } from '../engine.mjs';
const project=JSON.parse(readFileSync(new URL('./fixtures/nesting-spare-space.json',import.meta.url)));
const started=performance.now();
const result=optimizeCuttingPlan(project);
console.log(JSON.stringify({ms:Math.round(performance.now()-started),placed:result.stats.placedCount,panels:result.stats.usedPanels,layouts:result.layouts.map(l=>({placements:l.placements.map(p=>({id:p.id,x:p.x,y:p.y,w:p.placedLength,h:p.placedWidth})),diagnostics:l.diagnostics}))},null,2));
if(process.argv[2])writeFileSync(process.argv[2],JSON.stringify(result));
