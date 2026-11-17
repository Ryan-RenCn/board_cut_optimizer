import { Worker } from 'node:worker_threads';
const cases=[{quantity:30,optimizationLevel:'quick'},{quantity:30,optimizationLevel:'full'},{quantity:200,optimizationLevel:'quick'}];
for(const data of cases) {
  const outcome=await new Promise(resolve=>{
    const worker=new Worker(new URL('./benchmark-nesting-worker.mjs',import.meta.url),{workerData:{...data,enginePath:process.env.BENCHMARK_ENGINE_PATH}});
    const timer=setTimeout(()=>{worker.terminate();resolve({timeoutMs:10000})},10000);
    worker.once('message',result=>{clearTimeout(timer);worker.terminate();resolve(result)});
    worker.once('error',error=>{clearTimeout(timer);worker.terminate();resolve({error:error.message})});
  });
  console.log(JSON.stringify({...data,...outcome}));
}
