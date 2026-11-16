import { Worker } from 'node:worker_threads';
const cases=[{vertices:300,quantity:8,holes:false},{vertices:150,quantity:6,holes:true},...(process.argv.includes('--auto')?[{vertices:300,quantity:8,holes:false,autoRotate:true}]:[])];
for(const data of cases) {
  const outcome=await new Promise(resolve=>{
    const worker=new Worker(new URL('./benchmark-nesting-worker.mjs',import.meta.url),{workerData:{...data,enginePath:process.env.BENCHMARK_ENGINE_PATH}});
    const timer=setTimeout(()=>{worker.terminate();resolve({timeoutMs:10000})},10000);
    worker.once('message',result=>{clearTimeout(timer);worker.terminate();resolve(result)});
    worker.once('error',error=>{clearTimeout(timer);worker.terminate();resolve({error:error.message})});
  });
  console.log(JSON.stringify({...data,...outcome}));
}
