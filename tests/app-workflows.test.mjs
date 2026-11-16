import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as engine from '../engine.mjs';
import * as quotation from '../quotation.mjs';
import * as tax from '../tax-pricing.mjs';
import * as logistics from '../logistics.mjs';
import { createProjectStore } from '../storage.mjs';

// Exercise the actual app handlers without bootstrapping a browser. Keep real
// calculation/storage functions and control the worker and debounce clock.
const source = readFileSync(new URL('../app.mjs', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/\ninit\(\);\s*$/, '');

function harness(project) {
  const store = createProjectStore(':memory:');
  const timers = new Map();
  const nodes = new Map();
  const messages = [];
  let nextTimer = 0, resolveWorker, workerProject;
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: '', classList: { add() {}, remove() {}, toggle() {} }, listeners: {},
      addEventListener(type, listener) { this.listeners[type] = listener; },
    });
    return nodes.get(selector);
  };
  const context = vm.createContext({
    ...engine, ...quotation, ...tax, ...logistics,
    document: { querySelector: node, querySelectorAll: () => [] },
    window: { scrollTo() {} },
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() {}, clearInterval() {},
    startOptimization(snapshot) {
      workerProject = snapshot;
      return { promise: new Promise(resolve => { resolveWorker = resolve; }), cancel() {} };
    },
    fetch: async (path, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : {};
      if (path === '/api/draft') store.saveDraft(body.project);
      else if (path === '/api/projects') store.saveProject(body.project);
      else throw new Error(`Unexpected request: ${path}`);
      return { ok: true, json: async () => ({}) };
    },
    notify: message => messages.push(message),
  });
  vm.runInContext(`${source}\nrenderProjectHeader=()=>{};renderRows=()=>{};renderCounters=()=>{};renderResult=()=>{};updateQuoteSummary=()=>{};toast=notify;`, context);
  const run = code => vm.runInContext(code, context);
  run(`project=mergedProject(${JSON.stringify(project)});`);
  return {
    run, node, store, messages,
    read: code => JSON.parse(run(`JSON.stringify(${code})`)),
    finishWorker() { resolveWorker(engine.optimizeCuttingPlan(workerProject)); },
    async flushSaves() {
      for (const [id, fn] of [...timers]) { timers.delete(id); await fn(); }
      await run('draftSaveChain');
    },
    close() { store.close(); },
  };
}

const base = {
  name: '回归工程',
  panels: [{ id: 'panel', length: 1000, width: 1000, thickness: 18, cost: 100 }],
  parts: [{ id: 'part', length: 500, width: 500, thickness: 18, quantity: 1 }],
  settings: { sawWidth: 0, panelMarginX: 0, panelMarginY: 0, optimizationLevel: 'quick' },
};

{
  const h = harness(base);
  try {
    h.run('queueDraftSave()');
    await h.run('saveProject()');
    await h.flushSaves();
    const saved = h.store.listProjects()[0];
    assert.ok(saved.id);
    assert.equal(h.store.getDraft().id, saved.id, '旧定时草稿不得覆盖手动保存分配的工程ID');
    // Simulate reopening and saving again, then editing during a later save.
    h.run(`project=mergedProject(${JSON.stringify(h.store.getDraft())},globalConfigFromProject(project));`);
    const saving = h.run('saveProject()');
    h.run("project.name='后续编辑';queueDraftSave();");
    await saving;
    await h.flushSaves();
    assert.equal(h.store.listProjects().length, 1, '重新打开保存不得产生重复工程');
    assert.equal(h.store.getDraft().name, '后续编辑', '保存期间的新编辑仍须自动保存');
    assert.equal(h.store.getDraft().id, saved.id);
  } finally { h.close(); }
}

{
  const h = harness(base);
  try {
    h.run('bindEvents()');
    const optimizing = h.run('optimize()');
    h.node('#lossRate').value = '20';
    h.node('#lossRate').listeners.input({ target: h.node('#lossRate') });
    h.finishWorker();
    await optimizing;
    assert.equal(h.read('result.stats.lossRate'), 20);
    assert.equal(h.read('result.layouts[0].billingUsage'), 0.45);
    assert.equal(h.read('quoteAdjustments[0].panelCharge'), 50, '完成时须按最新损耗率计价');
    assert.equal(h.read('result.stats.finalQuote'), 50);
  } finally { h.close(); }
}

for (const parts of [
  [...base.parts, { id: 'oversize', length: 1500, width: 100, thickness: 18, quantity: 1 }],
  [{ id: 'oversize', length: 1500, width: 100, thickness: 18, quantity: 1 }],
]) {
  const h = harness({ ...base, parts });
  try {
    h.run('result=optimizeCuttingPlan(project);initializeQuoteAdjustments();renderReport();');
    assert.match(h.run('buildQuotationText()'), /尚有 1 件零件未排入/);
    assert.doesNotMatch(h.run('buildQuotationText()'), /1500\*100|最终合计|未税合计|税后合计/);
    assert.match(h.node('#reportContent').innerHTML, /id="copyQuotationTextButton"[^>]*disabled/);
    assert.match(h.node('#reportContent').innerHTML, /已排入部分报价明细/);
    await h.run('copyQuotationText()');
    assert.match(h.messages.at(-1), /存在未排入的零件/);
    // Resolve the oversized item and verify that normal quotations recover.
    h.run('project.parts=project.parts.map(part=>({...part,length:500,width:500}));result=optimizeCuttingPlan(project);initializeQuoteAdjustments();renderReport();');
    assert.match(h.run('buildQuotationText()'), /500\*500\*18mm 1张/);
    assert.match(h.run('buildQuotationText()'), /税后合计/);
    assert.doesNotMatch(h.node('#reportContent').innerHTML, /id="copyQuotationTextButton"[^>]*disabled/);
  } finally { h.close(); }
}

{
  const h = harness(base);
  try {
    const input = { value: '1.5', dataset: { field: 'quantity', index: '0' }, closest() { return this; } };
    h.run('bindEvents()');
    h.node('#partsBody').listeners.input({ target: input, type: 'input' });
    assert.equal(h.read('project.parts[0].quantity'), 1, '无效的输入过程不得改写业务数量');
    h.node('#partsBody').listeners.change({ target: input, type: 'change' });
    assert.equal(Number(input.value), 1, '离开无效数量输入框须恢复原值');
    assert.match(h.messages.at(-1), /数量.*整数/);
    input.value = '2';
    h.node('#partsBody').listeners.input({ target: input, type: 'input' });
    assert.equal(h.read('project.parts[0].quantity'), 2);
  } finally { h.close(); }
}

console.log('App workflow regressions passed: save ordering, current-loss repricing, incomplete quotations and integer quantity entry.');
