// Keep placement work off the UI thread; terminating the worker interrupts
// synchronous search when the user cancels or the time budget expires.
export function startOptimization(project, { timeoutMs = 60000, onProgress, workerFactory = () => new Worker(new URL('./optimization-worker.mjs', import.meta.url), { type: 'module' }) } = {}) {
  const worker = workerFactory();
  let finish;
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      error ? reject(error) : resolve(result);
    };
    worker.onmessage = ({ data }) => {
      if(settled)return;
      if(data.progress){try{onProgress?.(data.progress)}catch(error){finish(error)}return;}
      finish(data.error ? new Error(data.error) : null, data.result);
    };
    worker.onerror = () => finish(new Error('优化计算异常，请减少零件数量或使用快速模式后重试'));
    worker.onmessageerror = () => finish(new Error('无法读取优化结果，请重试'));
    timer = setTimeout(() => finish(new Error('优化超过60秒，已停止。请尝试快速模式或减少零件数量后重试')), timeoutMs);
    try { worker.postMessage(project); } catch (error) { finish(error); }
  });
  return { promise, cancel() { const error = new Error('已停止优化'); error.name = 'AbortError'; finish(error); } };
}
