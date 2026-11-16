import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { convertDwg } from '../dwg-convert.mjs';
import { importCadText } from '../cad-import.mjs';
import { createBoardCutServer } from '../server.mjs';
if(process.platform === 'win32') {
  for(const year of [2000,2010,2018]) {
    const source=readFileSync(new URL(`./fixtures/dwg/circle-${year}.dwg`,import.meta.url));
    const result=await convertDwg(source);
    const parsed=importCadText(result.dxf);
    assert.equal(parsed.parts.length,1);
    assert.ok(Math.abs(parsed.parts[0].length-687.3450233722128)<1e-5);
    assert.ok(Math.abs(parsed.parts[0].width-parsed.parts[0].length)<1e-6);
    assert.match(result.signature,/^AC10/);
  }
  await assert.rejects(convertDwg(Buffer.alloc(64)),/不是受支持的DWG/);
  await assert.rejects(convertDwg(readFileSync(new URL('./fixtures/dwg/circle-2007.dwg',import.meta.url))),/解码存在错误/);
  const server=createBoardCutServer({databasePath:':memory:',port:0});
  try {
    const {url}=await server.start();
    const body=readFileSync(new URL('./fixtures/dwg/circle-2018.dwg',import.meta.url));
    const response=await fetch(`${url}/api/cad/convert-dwg`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body});
    assert.equal(response.status,200);assert.equal(importCadText((await response.json()).dxf).parts.length,1);
    assert.equal((await fetch(`${url}/api/cad/convert-dwg`,{method:'POST',headers:{'Content-Type':'application/octet-stream',Origin:'https://unrelated.example'},body})).status,403);
    assert.equal((await fetch(`${url}/api/cad/convert-dwg`,{method:'POST',body:'not-dwg'})).status,415);
  } finally {await server.close()}
  console.log('DWG conversion tests passed: real R2000/R2010/R2018 files, precise dimensions, API and invalid/error rejection.');
} else console.log('DWG native conversion tests skipped: Windows required.');
