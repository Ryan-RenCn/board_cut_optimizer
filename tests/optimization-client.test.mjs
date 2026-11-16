import assert from 'node:assert/strict';
import { startOptimization } from '../optimization-client.mjs';
function mock() {return {terminated:0,postMessage(data){this.data=data},terminate(){this.terminated++}}}
{
  const worker=mock(),job=startOptimization({parts:[]},{workerFactory:()=>worker});
  worker.onmessage({data:{result:{ok:true}}});
  assert.deepEqual(await job.promise,{ok:true});assert.equal(worker.terminated,1);
}
{
  const events=[],worker=mock(),job=startOptimization({},{workerFactory:()=>worker,onProgress:p=>events.push(p)});
  worker.onmessage({data:{progress:{sequence:1}}});assert.equal(worker.terminated,0);assert.equal(events.length,1);
  worker.onmessage({data:{result:{ok:true}}});assert.deepEqual(await job.promise,{ok:true});
  worker.onmessage({data:{progress:{sequence:2}}});assert.equal(events.length,1,'完成后的迟到预览不得覆盖结果');
}
{
  const worker=mock(),job=startOptimization({},{workerFactory:()=>worker});
  job.cancel();worker.onmessage({data:{result:{stale:true}}});
  await assert.rejects(job.promise,{name:'AbortError'});assert.equal(worker.terminated,1);
}
{
  const worker=mock(),job=startOptimization({},{timeoutMs:5,workerFactory:()=>worker});
  await assert.rejects(job.promise,/已停止/);assert.equal(worker.terminated,1);
}
console.log('Optimization worker client tests passed: completion, cancellation, stale messages and timeout cleanup.');
