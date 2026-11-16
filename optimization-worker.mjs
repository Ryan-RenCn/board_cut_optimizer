import { optimizeCuttingPlan } from './engine.mjs';
self.onmessage = ({ data }) => {
  let last=0,sequence=0;
  const onProgress=progress=>{
    const now=Date.now();sequence++;
    if(sequence<=25 || now-last>=50){last=now;self.postMessage({progress:{...progress,sequence}});}
  };
  try { self.postMessage({ result: optimizeCuttingPlan(data,{onProgress}) }); }
  catch (error) { self.postMessage({ error: error.message || '无法生成排版' }); }
};
