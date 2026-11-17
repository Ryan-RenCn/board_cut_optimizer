import { groupIdenticalLayouts, optimizeCuttingPlan, repriceCuttingPlan } from './engine.mjs';
import { calculateLogisticsFee, LOGISTICS_DESTINATIONS, LOGISTICS_PROVIDER, LOGISTICS_PROVIDER_LABEL, normalizeLogisticsDestination } from './logistics.mjs';
import { partsFromCsv, serializePartsCsv } from './parts-csv.mjs';
import { DEFAULT_QUOTATION_TEMPLATE, LEGACY_DEFAULT_QUOTATION_TEMPLATE, PREVIOUS_TAX_DEFAULT_QUOTATION_TEMPLATE, formatQuotationText } from './quotation.mjs';
import { calculateMaterialAfterTax, normalizeTaxRate } from './tax-pricing.mjs';
import { startOptimization } from './optimization-client.mjs';

const STORAGE_KEY = 'smartcut-web:draft:v1'; // 旧版迁移键，不能改名。
const LIBRARY_KEY = 'smartcut-web:projects:v1'; // 旧版迁移键，不能改名。
const palette = ['#BFD1FF', '#FFBE9D', '#C9E7D8', '#FFE49C', '#D5C7F5', '#A9E2E7', '#F3BDD3', '#D8E2A5'];
const makeId = () => globalThis.crypto?.randomUUID?.() ?? `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const clone = (value) => JSON.parse(JSON.stringify(value));
const materialKey = (value) => String(value ?? '').trim().toLocaleLowerCase();

function inventoryGroupsFrom(panels = []) {
  const groups = new Map();
  panels.forEach((panel, index) => {
    const key = materialKey(panel.material);
    const group = groups.get(key) ?? {
      key,
      material: String(panel.material ?? '').trim(),
      label: String(panel.material ?? '').trim() || '默认材质',
      rows: [],
    };
    group.rows.push({ panel, index });
    groups.set(key, group);
  });
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
}

function inventoryThicknessesFrom(panels = [], material = '') {
  return [...new Set(panels
    .filter((panel) => materialKey(panel.material) === materialKey(material))
    .map((panel) => Number(panel.thickness))
    .filter((thickness) => Number.isFinite(thickness) && thickness > 0))]
    .sort((a, b) => a - b);
}

const defaults = {
  id: null,
  name: '未命名工程',
  description: '',
  shippingDestination: '',
  lossRate: 0,
  taxRate: 0,
  panels: [],
  parts: [],
  settings: {
    sawWidth: 3,
    panelMarginX: 10,
    panelMarginY: 10,
    profitRate: 100,
    cuttingFee: 0,
    packagingFee: 0,
    logisticsProvider: 'none',
    allowRotation: true,
    optimizationLevel: 'full',
    partEntryKey: 'tab',
    quotationTemplate: DEFAULT_QUOTATION_TEMPLATE,
  },
  updatedAt: null,
};

const sampleProject = {
  ...defaults,
  name: '演示工程 · 胡桃木柜体',
  description: '18 mm 柜体板开料示例',
  shippingDestination: '浙江',
  settings: { ...defaults.settings, cuttingFee: 60, logisticsProvider: LOGISTICS_PROVIDER },
  panels: [
    { id: makeId(), length: 2440, width: 1220, thickness: 18, cost: 328, weight: 39.5, material: '胡桃木', description: '整板' },
    { id: makeId(), length: 1800, width: 900, thickness: 18, cost: 168, weight: 21.5, material: '白色 MDF', description: '备用板材' },
  ],
  parts: [
    { id: makeId(), quantity: 2, length: 720, width: 560, thickness: 18, material: '胡桃木', allowRotate: true, code: 'SIDE-01', description: '侧板' },
    { id: makeId(), quantity: 2, length: 1160, width: 540, thickness: 18, material: '胡桃木', allowRotate: true, code: 'TOP-02', description: '顶/底板' },
    { id: makeId(), quantity: 4, length: 560, width: 320, thickness: 18, material: '胡桃木', allowRotate: true, code: 'SHELF-03', description: '层板' },
    { id: makeId(), quantity: 2, length: 1120, width: 420, thickness: 18, material: '胡桃木', allowRotate: false, code: 'DOOR-04', description: '门板（纹理）' },
    { id: makeId(), quantity: 3, length: 580, width: 380, thickness: 18, material: '白色 MDF', allowRotate: true, code: 'DRAWER-05', description: '抽屉板' },
  ],
};

let project = mergedProject(defaults);
let globalConfig = null;
let result = null;
let optimizationJob = null;
let saveTimer = null;
let activeInventoryMaterialKey = null;
let projectLibrary = [];
let storageErrorShown = false;
let draftSaveChain = Promise.resolve();
let quoteAdjustments = [];
let quoteSignature = null;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const formatNumber = (value, decimals = 0) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: decimals }).format(value);
const formatPercent = (value) => `${(value * 100).toFixed(1)}%`;
const formatArea = (value) => `${(value / 1_000_000).toFixed(2)} m²`;
const formatWeight = (value) => `${formatNumber(number(value), 2)} kg`;
const formatCurrency = (value) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(number(value));
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));

function mergedProject(value, activeGlobal = null) {
  const panelSource = activeGlobal?.panels ?? value?.panels ?? [];
  const settings = { ...(activeGlobal?.settings ?? value?.settings ?? {}) };
  if (settings.cuttingFee === undefined) {
    const legacyCuttingFee = panelSource
      .map((panel) => Number(panel.cuttingFee))
      .find((fee) => Number.isFinite(fee) && fee >= 0);
    if (legacyCuttingFee !== undefined) settings.cuttingFee = legacyCuttingFee;
  }
  const cuttingFee = Number(settings.cuttingFee);
  settings.cuttingFee = Number.isFinite(cuttingFee) && cuttingFee >= 0 ? cuttingFee : 0;
  const packagingFee = Number(settings.packagingFee);
  settings.packagingFee = Number.isFinite(packagingFee) && packagingFee >= 0 ? packagingFee : 0;
  const profitRate = Number(settings.profitRate);
  settings.profitRate = Number.isFinite(profitRate) && profitRate >= 0 ? profitRate : 100;
  settings.logisticsProvider = settings.logisticsProvider === LOGISTICS_PROVIDER ? LOGISTICS_PROVIDER : 'none';
  settings.partEntryKey = settings.partEntryKey === 'enter' ? 'enter' : 'tab';
  delete settings.rotationStep;
  delete settings.maxShapeVertices;
  settings.quotationTemplate = typeof settings.quotationTemplate === 'string'
    ? [LEGACY_DEFAULT_QUOTATION_TEMPLATE, PREVIOUS_TAX_DEFAULT_QUOTATION_TEMPLATE].includes(settings.quotationTemplate)
      ? DEFAULT_QUOTATION_TEMPLATE
      : settings.quotationTemplate
    : DEFAULT_QUOTATION_TEMPLATE;
  delete settings.minOffcutLength;
  delete settings.minOffcutWidth;
  const merged = {
    ...clone(defaults),
    ...(value ?? {}),
    settings: { ...defaults.settings, ...settings },
    panels: Array.isArray(panelSource) ? panelSource.map(({ quantity: _quantity, cuttingFee: _legacyCuttingFee, price: legacyPrice, ...panel }) => {
      const cost = Number(panel.cost ?? legacyPrice);
      const weight = Number(panel.weight);
      return {
        ...panel,
        cost: Number.isFinite(cost) && cost >= 0 ? cost : 0,
        weight: Number.isFinite(weight) && weight >= 0 ? weight : 0,
      };
    }) : [],
    parts: Array.isArray(value?.parts) ? value.parts : [],
  };
  const lossRate = Number(merged.lossRate);
  merged.lossRate = Number.isFinite(lossRate) ? Math.min(100, Math.max(0, lossRate)) : 0;
  merged.taxRate = normalizeTaxRate(merged.taxRate);
  merged.shippingDestination = normalizeLogisticsDestination(merged.shippingDestination);
  merged.parts = merged.parts.map((part) => {
    const thickness = Number(part.thickness);
    const available = inventoryThicknessesFrom(merged.panels, part.material);
    return {
      ...part,
      thickness: Number.isFinite(thickness) && thickness > 0
        ? thickness
        : part.thickness === undefined
          ? (available[0] ?? '')
          : '',
    };
  });
  return merged;
}

function globalConfigFromProject(value) {
  const normalized = mergedProject({ panels: value?.panels ?? [], settings: value?.settings ?? {}, parts: [] });
  return { panels: clone(normalized.panels), settings: clone(normalized.settings) };
}

function projectWithoutGlobalConfig(value) {
  const { panels: _panels, settings: _settings, ...scopedProject } = clone(value);
  return scopedProject;
}

async function requestJson(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `数据请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function migrateLegacyStorage() {
  let draft;
  let library;
  try {
    draft = JSON.parse(localStorage.getItem(STORAGE_KEY));
    library = JSON.parse(localStorage.getItem(LIBRARY_KEY));
  } catch {
    return;
  }
  if (!draft && (!library || !Object.keys(library).length)) return;
  try {
    await requestJson('/api/migrate-local-storage', {
      method: 'POST',
      body: { draft, projects: Object.values(library ?? {}) },
    });
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LIBRARY_KEY);
  } catch (error) {
    toast(`旧版浏览器数据迁移失败：${error.message}`, 'error');
  }
}

async function loadDraft() {
  const { project: savedProject } = await requestJson('/api/draft');
  return savedProject ?? null;
}

async function loadGlobalSettings(seedProject) {
  let savedGlobalSettings;
  try {
    ({ globalSettings: savedGlobalSettings } = await requestJson('/api/global-settings'));
  } catch (error) {
    if (error.status !== 404) throw error;
    toast('服务端版本较旧，请重启服务；当前工程数据仍会完整保留。', 'error');
    return globalConfigFromProject(seedProject ?? defaults);
  }
  const nextGlobalConfig = savedGlobalSettings
    ? globalConfigFromProject(savedGlobalSettings)
    : globalConfigFromProject(seedProject ?? defaults);
  if (!savedGlobalSettings) {
    await requestJson('/api/global-settings', { method: 'PUT', body: { globalSettings: nextGlobalConfig } });
  }
  return nextGlobalConfig;
}

function persistDraft(snapshot) {
  const compatibleSnapshot = clone(snapshot);
  const save = draftSaveChain
    .catch(() => { })
    .then(() => requestJson('/api/draft', { method: 'PUT', body: { project: compatibleSnapshot } }));
  draftSaveChain = save;
  return save;
}

function queueDraftSave() {
  clearTimeout(saveTimer);
  const snapshot = clone(project);
  saveTimer = setTimeout(async () => {
    try {
      await persistDraft(snapshot);
      storageErrorShown = false;
    } catch (error) {
      if (!storageErrorShown) toast(`自动保存失败：${error.message}`, 'error');
      storageErrorShown = true;
    }
  }, 180);
}

async function saveSettings(buttonSelector = '#saveSettingsButton', successMessage = '全局设置已保存到 SQLite 数据库') {
  clearTimeout(saveTimer);
  const button = $(buttonSelector);
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = '正在保存…';
  try {
    const snapshot = globalConfigFromProject(project);
    const [response] = await Promise.all([
      requestJson('/api/global-settings', { method: 'PUT', body: { globalSettings: snapshot } }),
      persistDraft(project),
    ]);
    globalConfig = globalConfigFromProject(response.globalSettings);
    storageErrorShown = false;
    toast(successMessage);
  } catch (error) {
    toast(`设置保存失败：${error.message}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function invalidateResult({ clearQuotation = true } = {}) {
  optimizationJob?.cancel();
  result = null;
  quoteAdjustments = [];
  quoteSignature = null;
  if (clearQuotation) delete project.quotationAdjustment;
  $('#layoutSubtitle').textContent = '数据已修改，请重新执行优化。';
  $('#layoutStats').innerHTML = '';
  $('#unplacedNotice').classList.add('hidden');
  $('#layoutsContainer').innerHTML = emptyState('排版结果待更新', '点击“开始优化”按当前数据重新计算。');
  $('#reportContent').innerHTML = emptyState('统计结果待更新', '重新生成排版后，这里会显示最新报告。', true);
}

function commitChange({ invalidate = true } = {}) {
  if (invalidate) invalidateResult();
  queueDraftSave();
}

function toast(message, type = 'success') {
  const element = document.createElement('div');
  element.className = `toast ${type === 'error' ? 'error' : ''}`;
  element.textContent = message;
  $('#toastRegion').append(element);
  setTimeout(() => element.remove(), 3200);
}

function emptyState(title, copy, compact = false) {
  return `<div class="empty-state ${compact ? 'compact' : ''}"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(copy)}</p></div>`;
}

function showView(name) {
  $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === `${name}View`));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderProjectHeader() {
  $('#jobName').value = project.name;
  $('#jobDescription').value = project.description;
  $('#lossRate').value = project.lossRate;
}

function inputCell({ type = 'text', value = '', field, index, min, step, placeholder = '', partCell = false, readOnly = false }) {
  return `<input type="${type}" value="${escapeHtml(value)}" data-field="${field}" data-index="${index}" ${partCell ? 'data-part-cell' : ''} ${min !== undefined ? `min="${min}"` : ''} ${step !== undefined ? `step="${step}"` : ''} ${readOnly ? 'readonly title="不再支持此零件，请删除后重新录入矩形零件"' : ''} placeholder="${escapeHtml(placeholder)}" />`;
}

function renderPanels() {
  const groups = inventoryGroupsFrom(project.panels);
  if (!groups.length) {
    activeInventoryMaterialKey = null;
    $('#panelInventoryCards').innerHTML = emptyState('暂无板材库存', '点击“添加材质”创建第一个材质标签页。', true);
    return;
  }

  if (!groups.some((group) => group.key === activeInventoryMaterialKey)) activeInventoryMaterialKey = groups[0].key;
  const activeGroup = groups.find((group) => group.key === activeInventoryMaterialKey);
  const thicknessCount = inventoryThicknessesFrom(project.panels, activeGroup.material).length;
  const tabs = groups.map((group) => `<button class="inventory-tab ${group.key === activeGroup.key ? 'active' : ''}" type="button" role="tab" aria-selected="${group.key === activeGroup.key}" data-inventory-tab="${escapeHtml(group.key)}">${escapeHtml(group.label)}</button>`).join('');
  const rows = activeGroup.rows.map(({ panel, index }) => `
      <tr>
        <td><span class="row-handle">••</span></td>
        <td>${inputCell({ type: 'number', value: panel.length, field: 'length', index, min: 0, step: .1 })}</td>
        <td>${inputCell({ type: 'number', value: panel.width, field: 'width', index, min: 0, step: .1 })}</td>
        <td><span class="inventory-material-value">${escapeHtml(activeGroup.label)}</span></td>
        <td>${inputCell({ type: 'number', value: panel.thickness ?? '', field: 'thickness', index, min: 0, step: .1, placeholder: '必填' })}</td>
        <td>${inputCell({ type: 'number', value: panel.cost ?? 0, field: 'cost', index, min: 0, step: .01, placeholder: '0.00' })}</td>
        <td>${inputCell({ type: 'number', value: panel.weight ?? 0, field: 'weight', index, min: 0, step: .01, placeholder: '0.00' })}</td>
        <td>${inputCell({ value: panel.description, field: 'description', index, placeholder: '可选' })}</td>
        <td><button class="delete-row" data-delete-panel="${index}" aria-label="删除板材">×</button></td>
      </tr>`).join('');

  $('#panelInventoryCards').innerHTML = `<article class="data-card inventory-stock-card">
      <div class="inventory-tabs" role="tablist" aria-label="库存材质">${tabs}</div>
      <div class="card-header inventory-card-toolbar">
        <label class="inventory-name-field"><span>材质名称</span><input value="${escapeHtml(activeGroup.material)}" placeholder="默认材质" data-material-name="${escapeHtml(activeGroup.key)}" /></label>
        <div class="card-actions"><span class="row-counter">${thicknessCount} 种厚度 · ${activeGroup.rows.length} 种规格 · 无限库存</span><button class="button small" type="button" data-add-panel-spec>＋ 添加厚度规格</button></div>
      </div>
      <div class="table-wrap"><table class="data-table inventory-table"><thead><tr><th class="handle-col"></th><th>长度 (mm)</th><th>宽度 (mm)</th><th>材质</th><th>厚度 (mm)</th><th>成本价 (元/张)</th><th>重量 (kg/张)</th><th>备注</th><th class="action-col"></th></tr></thead><tbody>${rows}</tbody></table></div>
    </article>`;
}

function materialSelectCell(part, index) {
  const groups = inventoryGroupsFrom(project.panels);
  if (!groups.length) return '<select disabled><option>请先添加板材库存</option></select>';
  const selectedGroup = groups.find((group) => group.key === materialKey(part.material));
  const unavailable = selectedGroup ? '' : `<option value="" selected disabled>${escapeHtml(part.material ? `${part.material}（库存中不可用）` : '请选择库存材质')}</option>`;
  const options = groups.map((group) => `<option value="${escapeHtml(group.material)}" ${selectedGroup?.key === group.key ? 'selected' : ''}>${escapeHtml(group.label)}</option>`).join('');
  return `<select data-field="material" data-index="${index}" data-part-cell>${unavailable}${options}</select>`;
}

function thicknessSelectCell(part, index) {
  const thicknesses = inventoryThicknessesFrom(project.panels, part.material);
  if (!thicknesses.length) return '<select disabled><option>暂无可用厚度</option></select>';
  const selected = Number(part.thickness);
  const hasSelected = thicknesses.some((thickness) => Math.abs(thickness - selected) < .0001);
  const unavailable = hasSelected
    ? ''
    : Number.isFinite(selected) && selected > 0
      ? `<option value="${selected}" selected disabled>${formatNumber(selected, 1)}（库存中不可用）</option>`
      : '<option value="" selected disabled>请选择库存厚度</option>';
  const options = thicknesses.map((thickness) => `<option value="${thickness}" ${hasSelected && Math.abs(thickness - selected) < .0001 ? 'selected' : ''}>${formatNumber(thickness, 1)}</option>`).join('');
  return `<select data-field="thickness" data-index="${index}" data-part-cell>${unavailable}${options}</select>`;
}

const hasUnsupportedPartGeometry = part => Boolean(part.shape) || part.rotationAngles !== undefined;

function partThumbnail(part, label = '零件小图') {
  if (hasUnsupportedPartGeometry(part)) return '<span class="part-thumbnail-empty">不支持</span>';
  const length = number(part.length), width = number(part.width);
  if (length <= 0 || width <= 0) return '<span class="part-thumbnail-empty">待录入</span>';
  const padding = Math.max(length, width) * .05;
  return `<svg viewBox="${-padding} ${-padding} ${length + padding * 2} ${width + padding * 2}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeHtml(label)}"><rect width="${length}" height="${width}" fill="#bfd1ff" stroke="#344fb8" stroke-width="${Math.max(length, width) * .015}" /></svg>`;
}

function refreshPartThumbnail(index) {
  const cell = $(`[data-part-thumbnail="${index}"]`);
  const part = project.parts[index];
  if (cell && part) cell.innerHTML = partThumbnail(part, `${part.code || `P${index + 1}`} 零件小图`);
}

function renderParts() {
  const unsupportedCount = project.parts.filter(hasUnsupportedPartGeometry).length;
  const notice = $('#unsupportedPartsNotice');
  notice.classList.toggle('hidden', unsupportedCount === 0);
  notice.textContent = unsupportedCount ? `当前仅支持矩形零件；有 ${unsupportedCount} 行旧版轮廓或指定角度数据不再支持，请删除后重新录入矩形零件。` : '';
  $('#partsBody').innerHTML = project.parts.map((part, index) => `
    <tr>
      <td><span class="row-handle">••</span></td>
      <td class="part-thumbnail-cell"><div class="part-thumbnail" data-part-thumbnail="${index}">${partThumbnail(part, `${part.code || `P${index + 1}`} 零件小图`)}</div></td>
      <td>${inputCell({ type: 'number', value: part.length, field: 'length', index, min: 0, step: .1, partCell: true, readOnly: hasUnsupportedPartGeometry(part) })}</td>
      <td>${inputCell({ type: 'number', value: part.width, field: 'width', index, min: 0, step: .1, partCell: true, readOnly: hasUnsupportedPartGeometry(part) })}</td>
      <td>${materialSelectCell(part, index)}</td>
      <td>${thicknessSelectCell(part, index)}</td>
      <td>${inputCell({ type: 'number', value: part.quantity, field: 'quantity', index, min: 0, step: 1, partCell: true })}</td>
      <td><label class="table-checkbox"><input type="checkbox" data-field="allowRotate" data-index="${index}" data-part-cell aria-label="允许旋转" ${part.allowRotate !== false ? 'checked' : ''} /></label></td>
      <td>${inputCell({ value: part.description, field: 'description', index, placeholder: '可选', partCell: true })}</td>
      <td>${inputCell({ value: part.code, field: 'code', index, placeholder: `P-${String(index + 1).padStart(2, '0')}`, partCell: true })}</td>
      <td><button class="delete-row" data-delete-part="${index}" aria-label="删除零件" tabindex="-1">×</button></td>
    </tr>`).join('') || `<tr><td colspan="11"><div class="empty-table">还没有零件，点击右上角添加</div></td></tr>`;
}

function renderShippingDestination() {
  const select = $('#shippingDestination');
  if (!select) return;
  select.innerHTML = `<option value="">请选择发货目的地</option>${LOGISTICS_DESTINATIONS.map((destination) => `<option value="${escapeHtml(destination)}">${escapeHtml(destination)}</option>`).join('')}`;
  select.value = project.shippingDestination || '';
  const hint = $('#shippingDestinationHint');
  if (hint) hint.textContent = project.settings.logisticsProvider === LOGISTICS_PROVIDER
    ? `${LOGISTICS_PROVIDER_LABEL}，运费按排版后的板材总重量计算，乘以 120% 后向上取整到整十元。`
    : '请先在全局设置中启用物流计算。';
}

function renderRows() {
  renderPanels();
  renderParts();
  renderShippingDestination();
  $('#panelCount').textContent = `${inventoryGroupsFrom(project.panels).length} 种材质 / ${project.panels.length} 种规格 / 无限库存`;
  $('#partCount').textContent = `${project.parts.length} 种 / ${project.parts.reduce((sum, row) => sum + number(row.quantity), 0)} 件`;
}

function renderSettings() {
  $$('[data-setting]').forEach((input) => {
    const value = project.settings[input.dataset.setting];
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else if (input.type === 'radio') input.checked = input.value === value;
    else input.value = value;
  });
  renderPartEntryHint();
}

function renderPartEntryHint() {
  const hint = $('#partEntryHint');
  if (!hint) return;
  const keyLabel = project.settings.partEntryKey === 'enter' ? '回车' : 'Tab';
  hint.textContent = `方向键切换单元格，${keyLabel}键连续录入`;
}

function setProject(nextProject) {
  const activeGlobal = project ? globalConfigFromProject(project) : globalConfig;
  project = mergedProject(nextProject, activeGlobal);
  result = null;
  activeInventoryMaterialKey = null;
  renderProjectHeader();
  renderRows();
  renderSettings();
  invalidateResult({ clearQuotation: false });
  queueDraftSave();
}

function addMaterial() {
  const existingKeys = new Set(inventoryGroupsFrom(project.panels).map((group) => group.key));
  let suffix = 1;
  while (existingKeys.has(materialKey(`新材质 ${suffix}`))) suffix += 1;
  const material = `新材质 ${suffix}`;
  project.panels.push({ id: makeId(), length: 2440, width: 1220, thickness: 18, cost: 0, weight: 0, material, description: '' });
  activeInventoryMaterialKey = materialKey(material);
  renderRows();
  commitChange();
}

function addPanelSpec() {
  const group = inventoryGroupsFrom(project.panels).find((item) => item.key === activeInventoryMaterialKey);
  if (!group) return;
  const base = group.rows.at(-1)?.panel;
  project.panels.push({ id: makeId(), length: base?.length ?? 2440, width: base?.width ?? 1220, thickness: '', cost: base?.cost ?? 0, weight: base?.weight ?? 0, material: group.material, description: '' });
  renderRows();
  commitChange();
}

function renameMaterial(oldKey, value) {
  const nextMaterial = String(value ?? '').trim();
  const nextKey = materialKey(nextMaterial);
  const groups = inventoryGroupsFrom(project.panels);
  const group = groups.find((item) => item.key === oldKey);
  if (!group) return;
  if (nextKey !== oldKey && groups.some((item) => item.key === nextKey)) {
    toast('该材质名称已经存在，请使用其他名称', 'error');
    renderPanels();
    return;
  }
  group.rows.forEach(({ panel }) => { panel.material = nextMaterial; });
  project.parts.forEach((part) => {
    if (materialKey(part.material) === oldKey) part.material = nextMaterial;
  });
  activeInventoryMaterialKey = nextKey;
  renderRows();
  commitChange();
  toast('材质名称已更新');
}

function addPart({ focusFirstCell = false } = {}) {
  const [firstGroup] = inventoryGroupsFrom(project.panels);
  const material = firstGroup?.material ?? '';
  const previousPart = project.parts.at(-1);
  const [defaultThickness = ''] = inventoryThicknessesFrom(project.panels, material);
  const thickness = previousPart?.thickness ?? defaultThickness;
  const allowRotate = previousPart ? previousPart.allowRotate !== false : true;
  project.parts.push({ id: makeId(), quantity: 1, length: 0, width: 0, material, thickness, allowRotate, code: '', description: '' });
  renderRows();
  commitChange();
  if (focusFirstCell) focusPartCell($('#partsBody tr:last-child [data-part-cell]:not(:disabled)'));
}

function clearParts() {
  if (!confirm('确定清空零件清单吗？清空后将保留一行空白数据。')) return;
  project.parts = [];
  addPart({ focusFirstCell: true });
}

function partAngle(part) {
  return part.rotated ? 90 : 0;
}

function focusPartCell(cell) {
  if (!cell) return;
  cell.focus();
  if (cell.matches('input:not([type="checkbox"])')) {
    try { cell.select(); } catch { /* 某些浏览器不支持选中数字输入框，保持聚焦即可。 */ }
  }
}

function handlePartsKeyboardNavigation(event) {
  if (event.isComposing) return;
  const currentCell = event.target.closest('[data-part-cell]');
  if (!currentCell) return;

  if (event.key.startsWith('Arrow') && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    event.preventDefault();
    const currentRow = currentCell.closest('tr');
    const rows = $$('#partsBody tr').filter((row) => row.querySelector('[data-part-cell]'));
    const rowIndex = rows.indexOf(currentRow);
    let target = null;

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const rowCells = [...currentRow.querySelectorAll('[data-part-cell]:not(:disabled)')];
      const cellIndex = rowCells.indexOf(currentCell);
      const offset = event.key === 'ArrowLeft' ? -1 : 1;
      target = rowCells[cellIndex + offset] ?? null;
    } else {
      const offset = event.key === 'ArrowUp' ? -1 : 1;
      const field = currentCell.dataset.field;
      for (let nextRowIndex = rowIndex + offset; nextRowIndex >= 0 && nextRowIndex < rows.length; nextRowIndex += offset) {
        target = [...rows[nextRowIndex].querySelectorAll('[data-part-cell]:not(:disabled)')]
          .find((cell) => cell.dataset.field === field) ?? null;
        if (target) break;
      }
    }

    if (target) focusPartCell(target);
    return;
  }

  const configuredKey = project.settings.partEntryKey === 'enter' ? 'Enter' : 'Tab';
  if (event.key !== configuredKey) return;
  const cells = $$('#partsBody [data-part-cell]:not(:disabled)');
  const currentIndex = cells.indexOf(currentCell);
  if (currentIndex < 0 || !cells.length) return;

  event.preventDefault();
  if (event.shiftKey) {
    focusPartCell(cells[(currentIndex - 1 + cells.length) % cells.length]);
  } else if (currentIndex === cells.length - 1) {
    addPart({ focusFirstCell: true });
  } else {
    focusPartCell(cells[currentIndex + 1]);
  }
}

function selectPartCellContent(event) {
  const cell = event.target.closest('td');
  const input = cell?.querySelector('input:not([type="checkbox"])');
  if (input) focusPartCell(input);
}

function handleTableInput(event, collection) {
  const input = event.target.closest('[data-field]');
  if (!input) return;
  const row = project[collection][Number(input.dataset.index)];
  if (!row) return;
  const numericFields = new Set(['quantity', 'length', 'width', 'thickness', 'cost', 'weight']);
  const field = input.dataset.field;
  if (collection === 'parts' && field === 'quantity'
    && (!input.value.trim() || !Number.isSafeInteger(Number(input.value)) || Number(input.value) < 0)) {
    if (event.type === 'change') {
      input.value = row.quantity;
      toast('零件数量必须为有效的非负整数', 'error');
    }
    return;
  }
  if (collection === 'parts' && hasUnsupportedPartGeometry(row) && (field === 'length' || field === 'width')) return;
  row[field] = field === 'allowRotate' ? input.checked : numericFields.has(field) ? number(input.value) : input.value;
  if (collection === 'parts' && field === 'material') {
    [row.thickness = ''] = inventoryThicknessesFrom(project.panels, row.material);
    renderParts();
  }
  if (collection === 'panels' && event.type === 'change' && field === 'thickness') {
    renderPanels();
    renderParts();
  }
  renderCounters();
  if (collection === 'parts' && ['length', 'width', 'code'].includes(field)) refreshPartThumbnail(Number(input.dataset.index));
  commitChange();
}

function renderCounters() {
  $('#panelCount').textContent = `${inventoryGroupsFrom(project.panels).length} 种材质 / ${project.panels.length} 种规格 / 无限库存`;
  $('#partCount').textContent = `${project.parts.length} 种 / ${project.parts.reduce((sum, row) => sum + number(row.quantity), 0)} 件`;
}

function renderLiveOptimization(update) {
  const layouts=update.layouts??[];
  const count=layouts.reduce((sum,layout)=>sum+layout.placements.length,0);
  $('#optimizationLiveText').textContent=`正在试排：本轮已放入 ${count} / ${update.totalCount} 件 · 当前 ${layouts.length} 张板；预览尚非最终方案`;
  $('#layoutSubtitle').textContent='计算中实时更新；正在检查余量和可用放置位置。';
  $('#layoutsContainer').innerHTML=layouts.map((layout,index)=>{
    const height=Math.max(220,Math.min(560,850*layout.height/layout.width));
    const rectangles = layout.placements.map((part, i) => `<rect class="part-rect${i === layout.placements.length - 1 ? ' trace-current-part' : ''}" fill="${palette[(part.sourceIndex ?? i) % palette.length]}" x="${part.x}" y="${part.y}" width="${part.placedLength}" height="${part.placedWidth}" />`).join('');
    return `<article class="layout-card live-layout-card"><div class="layout-card-header"><h3>第 ${index+1} 张 · ${escapeHtml(layout.panel.material||'默认材质')} · ${formatNumber(layout.panel.thickness,1)} mm</h3><span>试排中 · ${layout.placements.length} 件</span></div><div class="layout-canvas-wrap"><svg class="layout-svg" viewBox="0 0 ${layout.width} ${layout.height}" style="height:${height}px" aria-label="计算中的第${index+1}张排版"><rect class="panel-bg" width="${layout.width}" height="${layout.height}" />${rectangles}</svg></div></article>`;
  }).join('');
}

async function optimize() {
  if (optimizationJob) return;
  let job, progress;
  try {
    $('#optimizeButton').disabled = true;
    $('#optimizeButton').textContent = '正在计算…';
    $('#cancelOptimizeButton').hidden = false;
    result=null;
    $('#layoutStats').innerHTML='';
    $('#unplacedNotice').classList.add('hidden');
    $('#optimizationLiveStatus').classList.remove('hidden');
    $('#optimizationLiveText').textContent='正在准备板材和零件，预览将随计算更新…';
    $('#layoutsContainer').innerHTML=emptyState('正在开始试排','计算中会逐步显示零件和当前板材。');
    $('#reportContent').innerHTML=emptyState('优化进行中','最终报价将在排版完成后生成。');
    $('#printButton').disabled=true;
    showView('layout');
    const started = Date.now();
    progress = setInterval(() => { $('#optimizeButton').textContent = `正在计算… ${Math.floor((Date.now() - started) / 1000)}秒`; }, 1000);
    job = startOptimization(clone(project),{onProgress:update=>{if(optimizationJob===job)renderLiveOptimization(update);}});
    optimizationJob = job;
    result = await job.promise;
    repriceCuttingPlan(result, project);
    initializeQuoteAdjustments();
    renderResult();
    showView('layout');
    const oversizedCount = result.unplaced.filter((part) => part.reason === '零件尺寸超出板材尺寸').length;
    toast(
      oversizedCount
        ? `排版完成，但有 ${oversizedCount} 件零件尺寸超出板材尺寸`
        : `优化完成：${result.stats.placedCount} 件零件，使用 ${result.stats.usedPanels} 张板材`,
      oversizedCount ? 'error' : 'success',
    );
  } catch (error) {
    if(!result){const heading=error.name==='AbortError'?'优化已停止':'优化未完成';$('#layoutsContainer').innerHTML=emptyState(heading,'当前试排未作为最终方案保存，请重新优化。');$('#reportContent').innerHTML=emptyState(heading,'尚未生成最终报价。');$('#layoutSubtitle').textContent='尚未生成最终排版。';}
    toast(error.message || '无法生成排版', error.name === 'AbortError' ? 'success' : 'error');
  } finally {
    clearInterval(progress);
    if (optimizationJob === job) optimizationJob = null;
    $('#cancelOptimizeButton').hidden = true;
    $('#optimizationLiveStatus').classList.add('hidden');
    $('#printButton').disabled=false;
    $('#optimizeButton').disabled = false;
    $('#optimizeButton').innerHTML = '重新优化 <span>→</span>';
  }
}

function statCard(label, value, note, accent = false, key = '') {
  return `<article class="stat-card ${accent ? 'accent' : ''}" ${key ? `data-stat-card="${key}"` : ''}><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${escapeHtml(value)}</div><div class="stat-note">${escapeHtml(note)}</div></article>`;
}

function quotationSignatureFor(plan) {
  return plan.layouts.map((layout) => [
    layout.panel.sourceIndex,
    layout.isFullSheet ? 'full-sheet' : 'cut-layout',
    layout.usage.toFixed(6),
    layout.panelCharge.toFixed(6),
    layout.cuttingFee.toFixed(6),
    layout.placements.map((part) => part.instanceId).sort().join(','),
  ].join(':')).join('|');
}

function initializeQuoteAdjustments() {
  quoteSignature = quotationSignatureFor(result);
  const saved = project.quotationAdjustment;
  quoteAdjustments = result.layouts.map((layout, index) => {
    const savedRow = saved?.signature === quoteSignature ? saved.rows?.[index] : null;
    const panelCharge = Number(savedRow?.panelCharge);
    const cuttingFee = Number(savedRow?.cuttingFee);
    const resolvedPanelCharge = Number.isFinite(panelCharge) && panelCharge >= 0 ? panelCharge : layout.panelCharge;
    const taxedPanelCharge = Number(savedRow?.taxedPanelCharge);
    return {
      panelCharge: resolvedPanelCharge,
      taxedPanelCharge: Number.isFinite(taxedPanelCharge) && taxedPanelCharge >= 0
        ? taxedPanelCharge
        : calculateMaterialAfterTax(resolvedPanelCharge, project.taxRate),
      cuttingFee: layout.isFullSheet ? 0 : Number.isFinite(cuttingFee) && cuttingFee >= 0 ? cuttingFee : layout.cuttingFee,
    };
  });
}

function adjustedQuoteTotals() {
  const panelTotal = quoteAdjustments.reduce((sum, row) => sum + row.panelCharge, 0);
  const taxedPanelTotal = quoteAdjustments.reduce((sum, row) => sum + row.taxedPanelCharge, 0);
  const cuttingTotal = quoteAdjustments.reduce((sum, row) => sum + row.cuttingFee, 0);
  const packagingTotal = Math.max(0, number(project.settings.packagingFee));
  const logistics = calculateLogisticsFee({
    provider: project.settings.logisticsProvider,
    destination: project.shippingDestination,
    weight: result?.stats.totalWeight ?? 0,
  });
  return {
    panelTotal,
    taxedPanelTotal,
    cuttingTotal,
    packagingTotal,
    logistics,
    logisticsTotal: logistics.fee,
    finalTotal: panelTotal + cuttingTotal + packagingTotal + logistics.fee,
    taxedFinalTotal: taxedPanelTotal + cuttingTotal + packagingTotal + logistics.fee,
  };
}

function logisticsDescription(logistics) {
  if (!logistics.enabled) return '未启用物流';
  if (!logistics.available) return '待选择发货目的地';
  return `${logistics.origin} → ${logistics.destination} · 预计 ${logistics.transitDays} 天左右`;
}

function buildQuotationText() {
  if (!result) return '';
  if (result.unplaced.length) {
    return `尚有 ${result.unplaced.length} 件零件未排入，暂不能生成正式报价。请调整零件或板材并重新优化；当前费用仅覆盖已排入部分。`;
  }
  const totals = adjustedQuoteTotals();
  return formatQuotationText({
    template: project.settings.quotationTemplate,
    projectName: project.name,
    projectDescription: project.description,
    shippingDestination: project.shippingDestination,
    parts: project.parts,
    panelTotal: totals.panelTotal,
    taxRate: project.taxRate,
    taxedPanelTotal: totals.taxedPanelTotal,
    paintTotal: 0,
    cuttingTotal: totals.cuttingTotal,
    packagingTotal: totals.packagingTotal,
    totalWeight: result.stats.totalWeight,
    logisticsTotal: totals.logisticsTotal,
    finalTotal: totals.finalTotal,
    taxedFinalTotal: totals.taxedFinalTotal,
  });
}

function updateQuoteSummary() {
  const totals = adjustedQuoteTotals();
  const stat = $('[data-stat-card="finalQuote"]');
  if (stat) {
    stat.querySelector('.stat-value').textContent = formatCurrency(totals.taxedFinalTotal);
    stat.querySelector('.stat-note').textContent = `未税 ${formatCurrency(totals.finalTotal)} · 材料税率 ${formatNumber(project.taxRate, 2)}%`;
  }
  $$('[data-quote-panel-total]').forEach((element) => { element.textContent = formatCurrency(totals.panelTotal); });
  $$('[data-quote-taxed-panel-total]').forEach((element) => { element.textContent = formatCurrency(totals.taxedPanelTotal); });
  $$('[data-quote-cutting-total]').forEach((element) => { element.textContent = formatCurrency(totals.cuttingTotal); });
  $$('[data-quote-packaging-total]').forEach((element) => { element.textContent = formatCurrency(totals.packagingTotal); });
  $$('[data-quote-logistics-total]').forEach((element) => { element.textContent = formatCurrency(totals.logisticsTotal); });
  $$('[data-quote-final-total]').forEach((element) => { element.textContent = formatCurrency(totals.finalTotal); });
  $$('[data-quote-taxed-final-total]').forEach((element) => { element.textContent = formatCurrency(totals.taxedFinalTotal); });
  $$('[data-quote-tax-rate-label]').forEach((element) => { element.textContent = `${formatNumber(project.taxRate, 2)}%`; });
  quoteAdjustments.forEach((row, index) => {
    const subtotal = $(`[data-quote-subtotal="${index}"]`);
    if (subtotal) subtotal.textContent = formatCurrency(row.taxedPanelCharge + row.cuttingFee);
  });
  const quotationText = $('#quotationText');
  if (quotationText) quotationText.value = buildQuotationText();
}

function updateQuoteAdjustment(input) {
  const index = Number(input.dataset.quoteIndex);
  const field = input.dataset.quoteField;
  if (!quoteAdjustments[index] || !['panelCharge', 'taxedPanelCharge', 'cuttingFee'].includes(field)) return;
  if (field === 'cuttingFee' && result.layouts[index]?.isFullSheet) return;
  quoteAdjustments[index][field] = Math.max(0, number(input.value));
  if (field === 'panelCharge') {
    quoteAdjustments[index].taxedPanelCharge = calculateMaterialAfterTax(quoteAdjustments[index].panelCharge, project.taxRate);
    const taxedInput = $(`[data-quote-index="${index}"][data-quote-field="taxedPanelCharge"]`);
    if (taxedInput) taxedInput.value = quoteAdjustments[index].taxedPanelCharge.toFixed(2);
  }
  project.quotationAdjustment = { signature: quoteSignature, rows: clone(quoteAdjustments) };
  updateQuoteSummary();
  queueDraftSave();
}

function updateQuoteTaxRate(input) {
  const rawRate = Number(input.value);
  project.taxRate = normalizeTaxRate(rawRate);
  if (Number.isFinite(rawRate) && rawRate !== project.taxRate) input.value = project.taxRate;
  quoteAdjustments.forEach((row, index) => {
    row.taxedPanelCharge = calculateMaterialAfterTax(row.panelCharge, project.taxRate);
    const taxedInput = $(`[data-quote-index="${index}"][data-quote-field="taxedPanelCharge"]`);
    if (taxedInput) taxedInput.value = row.taxedPanelCharge.toFixed(2);
  });
  project.quotationAdjustment = { signature: quoteSignature, rows: clone(quoteAdjustments) };
  updateQuoteSummary();
  queueDraftSave();
}

async function copyQuotationText() {
  if (result?.unplaced.length) return toast('存在未排入的零件，请完成排版后再复制正式报价', 'error');
  const quotationText = $('#quotationText');
  if (!quotationText) return;
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(quotationText.value);
      copied = true;
    }
  } catch {
    copied = false;
  }
  if (!copied) {
    quotationText.focus();
    quotationText.select();
    try {
      copied = document.execCommand?.('copy') ?? false;
    } catch {
      copied = false;
    }
  }
  toast(copied ? '报价明细文本已复制' : '复制失败，请手动选择文本复制', copied ? 'success' : 'error');
}

function renderResult() {
  if (!result) return;
  const stats = result.stats;
  const totals = adjustedQuoteTotals();
  const displayLayouts = groupIdenticalLayouts(result.layouts);
  $('#layoutSubtitle').textContent = `${project.name} · 使用 ${stats.usedPanels} 张板材，共 ${displayLayouts.length} 种排版`;
  $('#layoutStats').innerHTML = [
    statCard('平均利用率', formatPercent(stats.averageUsage), `含损耗计价利用率 ${formatPercent(stats.averageBillingUsage)} · 本单损耗 ${formatNumber(project.lossRate, 1)}%`, true),
    statCard('使用板材', `${stats.usedPanels} 张`, `总面积 ${formatArea(stats.usedPanelArea)} · 总重量 ${formatWeight(stats.totalWeight)}`),
    statCard(result.unplaced.length ? '已排入部分税后价' : '税后报价', formatCurrency(totals.taxedFinalTotal), `未税 ${formatCurrency(totals.finalTotal)} · 材料税率 ${formatNumber(project.taxRate, 2)}%`, false, 'finalQuote'),
    statCard('完成零件', `${stats.placedCount} / ${stats.requestedCount}`, result.unplaced.length ? `${result.unplaced.length} 件未排入` : '全部排入'),
  ].join('');

  const notice = $('#unplacedNotice');
  if (result.unplaced.length) {
    const reasonCounts = result.unplaced.reduce((counts, part) => counts.set(part.reason, (counts.get(part.reason) ?? 0) + 1), new Map());
    notice.textContent = `有 ${result.unplaced.length} 件零件未能排入：${[...reasonCounts].map(([reason, count]) => `${reason} ${count} 件`).join('；')}。`;
    notice.classList.remove('hidden');
  } else notice.classList.add('hidden');

  $('#layoutsContainer').innerHTML = displayLayouts.map(({ layout, count }, index) => renderLayoutCard(layout, index, count)).join('') || emptyState('没有生成可用排版', '请检查板材、零件尺寸与材质。');
  renderReport();
}

function renderLayoutCard(layout, index, count = 1, previewStep = null) {
  const labels = new Map();
  const materials = new Map();
  layout.placements.forEach((part) => {
    const key = part.id ?? part.sourceIndex;
    if (!labels.has(key)) labels.set(key, palette[labels.size % palette.length]);
    materials.set(part.material || '默认材质', labels.get(key));
  });
  const minDimension = Math.min(layout.width, layout.height);
  const labelSize = Math.max(20, minDimension * .018);
  const visiblePlacements = previewStep === null ? layout.placements : layout.placements.slice(0, previewStep);
  const svgParts = visiblePlacements.map((part, placementIndex) => {
    const color = labels.get(part.id ?? part.sourceIndex);
    const code = layout.isFullSheet ? '整板件' : part.code || `P${part.sourceIndex + 1}`;
    const sizeText = `${formatNumber(part.length, 1)} × ${formatNumber(part.width, 1)}${partAngle(part) ? ` · ${formatNumber(partAngle(part), 2)}°` : ''}`;
    const label = part.placedLength > minDimension * .09 && part.placedWidth > minDimension * .055
      ? { x: part.x + part.placedLength / 2, y: part.y + part.placedWidth / 2, size: labelSize } : null;
    const attributes = `class="part-rect${previewStep !== null && placementIndex === previewStep - 1 ? ' trace-current-part' : ''}" fill="${color}"`;
    const title = `${escapeHtml(code)} · ${part.length} × ${part.width} mm${partAngle(part) ? ` · ${formatNumber(partAngle(part), 3)}°` : ''}`;
    const geometry = `<rect ${attributes} x="${part.x}" y="${part.y}" width="${part.placedLength}" height="${part.placedWidth}"><title>${title}</title></rect>`;
    return `<g>${geometry}${label ? `<text class="part-label" x="${label.x}" y="${label.y - label.size * .18}" font-size="${label.size}">${escapeHtml(code)}</text><text class="part-size" x="${label.x}" y="${label.y + label.size * .65}" font-size="${label.size * .68}">${escapeHtml(sizeText)}</text>` : ''}</g>`;
  }).join('');
  const unusedPatternId = `unusedPattern-${previewStep === null ? 'final' : 'trace'}-${index}`;
  const visibleFreeRects = previewStep === null || previewStep === layout.placements.length ? (layout.freeRects ?? []) : [];
  const svgUnusedAreas = visibleFreeRects.map((rect) => `<rect class="unused-area-rect" x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}" fill="url(#${unusedPatternId})"><title>余料区域 ${formatNumber(rect.w, 1)} × ${formatNumber(rect.h, 1)} mm</title></rect>`).join('');
  const aspect = layout.width / layout.height;
  const displayHeight = Math.max(260, Math.min(610, 850 / aspect));

  return `<article class="layout-card">
    <div class="layout-card-header">
      <div class="layout-title"><span class="layout-number">${String(index + 1).padStart(2, '0')}</span><div><h3>${escapeHtml(layout.panel.description || '板材')} · ${escapeHtml(layout.panel.material || '默认材质')} · ${formatNumber(layout.panel.thickness, 1)} mm</h3><p>${formatNumber(layout.width, 1)} × ${formatNumber(layout.height, 1)} mm · 实际重量 ${formatWeight(layout.actualWeight)} · ${layout.isFullSheet ? '整板计价' : `实际利用率 ${formatPercent(layout.usage)} + 损耗 ${formatNumber(project.lossRate, 1)}% = 计价利用率 ${formatPercent(layout.billingUsage)}`} · 计费 ${formatPercent(layout.billingRate)} · 利润 ${formatNumber(project.settings.profitRate, 1)}% = 板材报价 ${formatCurrency(layout.panelCharge)} + 切割费 ${formatCurrency(layout.cuttingFee)}${layout.isFullSheet ? ' · 整板件无需切割' : ''}</p></div></div>
      <div class="layout-badges"><span class="usage-badge">${layout.isFullSheet ? '整板计费' : `利用率 ${formatPercent(layout.usage)}`}</span>${count > 1 ? `<span class="layout-quantity">数量 × ${count} 张</span>` : ''}</div>
    </div>
    <div class="layout-canvas-wrap">
      <svg class="layout-svg" viewBox="0 0 ${layout.width} ${layout.height}" style="height:${displayHeight}px" role="img" aria-label="第 ${index + 1} 张板材${previewStep === null ? '排版图' : `排版第 ${previewStep} 步`}">
        <defs><pattern id="${unusedPatternId}" width="18" height="18" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="18" height="18" fill="#eef1ee"></rect><line x1="0" y1="0" x2="0" y2="18" stroke="#d7dcd8" stroke-width="4"></line></pattern></defs>
        <rect class="panel-bg" x="0" y="0" width="${layout.width}" height="${layout.height}" />
        ${svgUnusedAreas}${svgParts}
        ${layout.isFullSheet ? '' : `<rect class="margin-zone" x="${project.settings.panelMarginX}" y="${project.settings.panelMarginY}" width="${layout.usableWidth}" height="${layout.usableHeight}" />`}
      </svg>
    </div>
    <div class="layout-legend">${layout.isFullSheet ? '<span>整板件直接发货，不计切割费</span>' : `<span><i class="legend-swatch"></i>余料区域</span><span>锯缝 ${formatNumber(project.settings.sawWidth, 1)} mm</span><span>边距 ${formatNumber(project.settings.panelMarginX, 1)} / ${formatNumber(project.settings.panelMarginY, 1)} mm</span>`}</div>
  </article>`;
}

function renderReport() {
  if (!result) return;
  const completed = result.stats.requestedCount - result.unplaced.length;
  const completionRate = result.stats.requestedCount ? completed / result.stats.requestedCount : 0;
  const totals = adjustedQuoteTotals();
  const quotationRows = result.layouts.map((layout, index) => `<tr>
    <td>#${String(index + 1).padStart(2, '0')}</td>
    <td>${escapeHtml(layout.panel.material || '默认材质')} · ${formatNumber(layout.panel.thickness, 1)} mm<br><small>${formatNumber(layout.panel.length, 1)} × ${formatNumber(layout.panel.width, 1)} mm${layout.isFullSheet ? ' · 整板件' : ''}</small></td>
    <td>${formatPercent(layout.usage)}</td>
    <td>${formatPercent(layout.billingUsage)}</td>
    <td>${formatPercent(layout.billingRate)}</td>
    <td>${formatCurrency(layout.panel.cost)}</td>
    <td>${formatNumber(project.settings.profitRate, 1)}%</td>
    <td>${formatWeight(layout.actualWeight)}</td>
    <td><input class="quote-input" type="number" min="0" step="0.01" value="${quoteAdjustments[index].panelCharge.toFixed(2)}" data-quote-index="${index}" data-quote-field="panelCharge" aria-label="第 ${index + 1} 张未税板材报价"></td>
    <td><input class="quote-input taxed-quote-input" type="number" min="0" step="0.01" value="${quoteAdjustments[index].taxedPanelCharge.toFixed(2)}" data-quote-index="${index}" data-quote-field="taxedPanelCharge" aria-label="第 ${index + 1} 张材料税后价格"></td>
    <td><input class="quote-input" type="number" min="0" step="0.01" value="${quoteAdjustments[index].cuttingFee.toFixed(2)}" data-quote-index="${index}" data-quote-field="cuttingFee" aria-label="第 ${index + 1} 张板材按使用率计算的切割费" ${layout.isFullSheet ? 'disabled title="整板件不计切割费"' : ''}></td>
    <td><b data-quote-subtotal="${index}">${formatCurrency(quoteAdjustments[index].taxedPanelCharge + quoteAdjustments[index].cuttingFee)}</b></td>
  </tr>`).join('');

  $('#reportContent').innerHTML = `
    <div class="report-overview">
      <div class="report-summary">
        <article class="report-hero"><p class="eyebrow">MATERIAL UTILIZATION</p><div class="report-big-number">${(result.stats.averageUsage * 100).toFixed(1)}<span>%</span></div><p>本单损耗率 ${formatNumber(project.lossRate, 1)}%，含损耗计价利用率 ${formatPercent(result.stats.averageBillingUsage)}；使用 ${result.stats.usedPanels} 张板材，总重量 ${formatWeight(result.stats.totalWeight)}，净零件面积 ${formatArea(result.stats.partsArea)}；利润比例 ${formatNumber(project.settings.profitRate, 1)}%，未税板材报价 <span data-quote-panel-total>${formatCurrency(totals.panelTotal)}</span>，材料税后价 <span data-quote-taxed-panel-total>${formatCurrency(totals.taxedPanelTotal)}</span>，切割费 <span data-quote-cutting-total>${formatCurrency(totals.cuttingTotal)}</span>，打包费 <span data-quote-packaging-total>${formatCurrency(totals.packagingTotal)}</span>，物流费 <span data-quote-logistics-total>${formatCurrency(totals.logisticsTotal)}</span>。</p></article>
        <div class="report-side"><article class="report-kpi quote-kpi"><span class="stat-label">${result.unplaced.length ? '已排入部分税后价' : '税后报价'}</span><b data-quote-taxed-final-total>${formatCurrency(totals.taxedFinalTotal)}</b><small>未税 <span data-quote-final-total>${formatCurrency(totals.finalTotal)}</span> · 材料税率 <span data-quote-tax-rate-label>${formatNumber(project.taxRate, 2)}%</span></small></article><article class="report-kpi"><span class="stat-label">物流费</span><b data-quote-logistics-total>${formatCurrency(totals.logisticsTotal)}</b><small>${escapeHtml(logisticsDescription(totals.logistics))}</small></article><article class="report-kpi"><span class="stat-label">零件完成率</span><b>${formatPercent(completionRate)}</b></article></div>
      </div>
      <article class="quotation-text-card quotation-text-card-compact"><div class="quotation-text-header"><div><h2>报价明细文本</h2><p>${result.unplaced.length ? '全部零件排入后可生成正式报价' : '随报价调整自动更新'}</p></div><button class="button small copy-quotation-button" id="copyQuotationTextButton" type="button" ${result.unplaced.length ? 'disabled' : ''}>复制文本</button></div><textarea id="quotationText" class="quotation-textarea" rows="7" readonly aria-label="报价明细文本">${escapeHtml(buildQuotationText())}</textarea></article>
    </div>
    <article class="report-table-card quotation-card"><div class="report-table-heading"><div><h2>${result.unplaced.length ? '已排入部分报价明细' : '最终报价明细'}</h2><p>税率仅应用于材料报价；切割费、打包费和物流费不含税率加成。</p></div><label class="tax-rate-control"><span>材料税率</span><div><input type="number" min="0" max="100" step="0.01" value="${project.taxRate}" data-quote-tax-rate aria-label="材料税率"><b>%</b></div></label></div><div class="table-wrap"><table class="report-table"><thead><tr><th>排版</th><th>板材规格</th><th>实际利用率</th><th>计价利用率</th><th>计费比例</th><th>整张成本价</th><th>利润比例</th><th>实际用量重量</th><th>板材报价（未税）</th><th>材料税后价</th><th>切割费</th><th>税后小计</th></tr></thead><tbody>${quotationRows}</tbody><tfoot><tr class="packaging-total"><td colspan="11">全局打包费 · 每个工程计费一次</td><td data-quote-packaging-total>${formatCurrency(totals.packagingTotal)}</td></tr><tr class="logistics-total"><td colspan="11">物流费 · ${escapeHtml(logisticsDescription(totals.logistics))} · 总重量 ${formatWeight(result.stats.totalWeight)}</td><td data-quote-logistics-total>${formatCurrency(totals.logisticsTotal)}</td></tr><tr class="quote-total"><td colspan="7">未税报价 / 税后报价 / 总重量</td><td>${formatWeight(result.stats.totalWeight)}</td><td data-quote-panel-total>${formatCurrency(totals.panelTotal)}</td><td data-quote-taxed-panel-total>${formatCurrency(totals.taxedPanelTotal)}</td><td data-quote-cutting-total>${formatCurrency(totals.cuttingTotal)}</td><td><small>未税 <span data-quote-final-total>${formatCurrency(totals.finalTotal)}</span></small><br><b data-quote-taxed-final-total>${formatCurrency(totals.taxedFinalTotal)}</b></td></tr></tfoot></table></div></article>`;
  updateQuoteSummary();
}

async function getLibrary() {
  const response = await requestJson('/api/projects');
  projectLibrary = response.projects ?? [];
  return projectLibrary;
}

async function saveProject() {
  clearTimeout(saveTimer);
  project.id ||= makeId();
  project.name = project.name.trim() || '未命名工程';
  project.updatedAt = new Date().toISOString();
  try {
    await Promise.all([
      requestJson('/api/projects', { method: 'POST', body: { project } }),
      persistDraft(project),
    ]);
    renderProjectHeader();
    toast('工程已保存到 SQLite 数据库');
  } catch (error) {
    toast(`保存失败：${error.message}`, 'error');
  }
}

async function renderProjectLibrary() {
  $('#projectList').innerHTML = emptyState('正在加载工程库…', '正在从 SQLite 数据库读取工程。', true);
  let library;
  try {
    library = await getLibrary();
  } catch (error) {
    $('#projectList').innerHTML = emptyState('工程库加载失败', error.message, true);
    return;
  }
  $('#projectList').innerHTML = library.length ? library.map((item) => `<article class="project-item"><div><h3>${escapeHtml(item.name)}</h3><p>${item.parts?.length ?? 0} 种零件 · 使用全局板材库存 · ${item.updatedAt ? new Date(item.updatedAt).toLocaleString('zh-CN') : '未记录时间'}</p></div><div class="project-item-actions"><button class="button small" value="cancel" data-load-project="${item.id}">打开</button><button class="button small danger" type="button" data-delete-project="${item.id}">删除</button></div></article>`).join('') : emptyState('工程库为空', '保存当前工程后会出现在这里。', true);
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportPartsCsv() {
  if (!project.parts.length) return toast('请先添加零件再导出 CSV', 'error');
  if (project.parts.some(hasUnsupportedPartGeometry)) return toast('清单含不支持的旧版轮廓或指定角度，请删除后再导出矩形 CSV', 'error');
  const safeName = (project.name || '板优排工程').replace(/[\\/:*?"<>|]/g, '-');
  download(`${safeName}-零件清单.csv`, serializePartsCsv(project.parts), 'text/csv;charset=utf-8');
  toast('CSV 零件清单已导出');
}

function exportReport() {
  if (!result) return toast('请先生成排版', 'error');
  const totals = adjustedQuoteTotals();
  const rows = [['排版号', '板材材质', '板材厚度(mm)', '板材长度(mm)', '板材宽度(mm)', '实际用量重量(kg)', '整板件', '实际利用率', '本单损耗率(%)', '计价利用率', '计费比例', '整张成本价(元)', '利润比例(%)', '板材报价未税(元)', '材料税率(%)', '材料税后价格(元)', '调整后切割费(元)', '未税单张报价(元)', '税后单张报价(元)', '打包费合计(元)', '物流公司', '发货目的地', '物流时效(天)', '物流费合计(元)', '未税最终报价(元)', '税后最终报价(元)', '零件编号', '零件说明', '零件材质', '零件厚度(mm)', '零件长度(mm)', '零件宽度(mm)', 'X(mm)', 'Y(mm)', '旋转角度(°)', '计量面积(mm²)']];
  result.layouts.forEach((layout, layoutIndex) => layout.placements.forEach((part) => rows.push([
    layoutIndex + 1, layout.panel.material || '默认材质', layout.panel.thickness, layout.width, layout.height, layout.actualWeight, layout.isFullSheet ? '是' : '否', layout.usage, project.lossRate, layout.billingUsage, layout.billingRate, layout.panel.cost, project.settings.profitRate, quoteAdjustments[layoutIndex].panelCharge, project.taxRate, quoteAdjustments[layoutIndex].taxedPanelCharge, quoteAdjustments[layoutIndex].cuttingFee, quoteAdjustments[layoutIndex].panelCharge + quoteAdjustments[layoutIndex].cuttingFee, quoteAdjustments[layoutIndex].taxedPanelCharge + quoteAdjustments[layoutIndex].cuttingFee, totals.packagingTotal, totals.logistics.providerLabel, totals.logistics.destination, totals.logistics.transitDays ?? '', totals.logisticsTotal, totals.finalTotal, totals.taxedFinalTotal, part.code || `P${part.sourceIndex + 1}`, part.description || '', part.material || '默认材质', part.thickness, part.length, part.width, part.x, part.y, partAngle(part), part.length * part.width,
  ])));
  download(`${project.name || '板优排'}-开料报告.csv`, `\uFEFF${rows.map((row) => row.map(csvEscape).join(',')).join('\r\n')}`, 'text/csv;charset=utf-8');
  toast('CSV 报告已导出');
}

async function importPartsFile(file) {
  if (!file.name.toLowerCase().endsWith('.csv')) throw new Error('请选择 CSV 文件');
  const text = await file.text();
  const [firstGroup] = inventoryGroupsFrom(project.panels);
  const material = firstGroup?.material ?? '';
  project.parts = partsFromCsv(text, {
    material,
    thicknesses: inventoryThicknessesFrom(project.panels, material),
    makeId,
  });
  renderRows();
  commitChange();
  toast(`已导入 ${project.parts.length} 种零件`);
}

function bindEvents() {
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
  $('#addPanelButton').addEventListener('click', addMaterial);
  $('#addPartButton').addEventListener('click', addPart);
  $('#clearPartsButton').addEventListener('click', clearParts);
  $('#panelInventoryCards').addEventListener('input', (event) => handleTableInput(event, 'panels'));
  $('#panelInventoryCards').addEventListener('change', (event) => {
    const nameInput = event.target.closest('[data-material-name]');
    if (nameInput) renameMaterial(nameInput.dataset.materialName, nameInput.value);
    else handleTableInput(event, 'panels');
  });
  $('#panelInventoryCards').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.matches('[data-material-name]')) event.target.blur();
  });
  $('#partsBody').addEventListener('input', (event) => handleTableInput(event, 'parts'));
  $('#partsBody').addEventListener('change', (event) => handleTableInput(event, 'parts'));
  $('#partsBody').addEventListener('keydown', handlePartsKeyboardNavigation);
  $('#shippingDestination').addEventListener('change', (event) => {
    project.shippingDestination = event.target.value;
    commitChange({ invalidate: false });
    renderShippingDestination();
    if (result) renderResult();
  });
  $('#panelInventoryCards').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-inventory-tab]');
    if (tab) {
      activeInventoryMaterialKey = tab.dataset.inventoryTab;
      renderPanels();
      return;
    }
    if (event.target.closest('[data-add-panel-spec]')) {
      addPanelSpec();
      return;
    }
    const button = event.target.closest('[data-delete-panel]');
    if (!button) return;
    project.panels.splice(Number(button.dataset.deletePanel), 1);
    renderRows();
    commitChange();
  });
  $('#partsBody').addEventListener('click', (event) => {
    selectPartCellContent(event);
    const button = event.target.closest('[data-delete-part]'); if (!button) return;
    project.parts.splice(Number(button.dataset.deletePart), 1); renderRows(); commitChange();
  });
  $('#jobName').addEventListener('input', (event) => {
    project.name = event.target.value;
    commitChange({ invalidate: false });
    if (result) updateQuoteSummary();
  });
  $('#jobDescription').addEventListener('input', (event) => {
    project.description = event.target.value;
    commitChange({ invalidate: false });
    if (result) updateQuoteSummary();
  });
  $('#newProjectButton').addEventListener('click', () => { if (confirm('新建工程会清空当前未保存的数据，是否继续？')) setProject(defaults); });
  $('#saveProjectButton').addEventListener('click', () => saveProject());
  $('#exportPartsButton').addEventListener('click', exportPartsCsv);
  $('#optimizeButton').addEventListener('click', optimize);
  $('#cancelOptimizeButton').addEventListener('click', () => optimizationJob?.cancel());
  $('#cancelLayoutOptimizeButton').addEventListener('click', () => optimizationJob?.cancel());
  $('#lossRate').addEventListener('input', (event) => {
    const rawValue = Number(event.target.value);
    if (!Number.isFinite(rawValue)) return;
    const nextLossRate = Math.min(100, Math.max(0, rawValue));
    project.lossRate = nextLossRate;
    if (nextLossRate !== rawValue) event.target.value = nextLossRate;
    delete project.quotationAdjustment;
    if (result) {
      repriceCuttingPlan(result, project);
      initializeQuoteAdjustments();
      renderResult();
    }
    queueDraftSave();
  });
  $('#printButton').addEventListener('click', () => window.print());
  $('#reportPrintButton').addEventListener('click', () => window.print());
  $('#exportReportButton').addEventListener('click', exportReport);
  $('#reportContent').addEventListener('input', (event) => {
    const taxRateInput = event.target.closest('[data-quote-tax-rate]');
    if (taxRateInput) {
      updateQuoteTaxRate(taxRateInput);
      return;
    }
    const input = event.target.closest('[data-quote-field]');
    if (input) updateQuoteAdjustment(input);
  });
  $('#reportContent').addEventListener('click', (event) => {
    if (event.target.closest('#copyQuotationTextButton')) copyQuotationText();
  });
  $('[data-setting="quotationTemplate"]').addEventListener('input', (event) => {
    project.settings.quotationTemplate = event.target.value;
    if (result) updateQuoteSummary();
  });
  $('#importButton').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', async (event) => {
    const [file] = event.target.files;
    if (!file) return;
    try { await importPartsFile(file); } catch (error) { toast(`导入失败：${error.message}`, 'error'); }
    event.target.value = '';
  });
  $$('[data-setting]').forEach((input) => input.addEventListener('change', () => {
    const field = input.dataset.setting;
    project.settings[field] = input.type === 'checkbox'
      ? input.checked
      : input.type === 'radio' || input.tagName === 'SELECT' || field === 'quotationTemplate'
        ? input.value
        : number(input.value);
    const quoteOnly = field === 'logisticsProvider' || field === 'packagingFee' || field === 'quotationTemplate';
    const withoutLayoutImpact = quoteOnly || field === 'partEntryKey';
    commitChange({ invalidate: !withoutLayoutImpact });
    if (field === 'partEntryKey') renderPartEntryHint();
    if (quoteOnly) {
      renderShippingDestination();
      if (result) renderResult();
    }
  }));
  $('#resetQuotationTemplateButton').addEventListener('click', () => {
    project.settings.quotationTemplate = DEFAULT_QUOTATION_TEMPLATE;
    renderSettings();
    commitChange({ invalidate: false });
    if (result) renderResult();
    toast('已恢复默认报价明细模板');
  });
  $('#resetSettingsButton').addEventListener('click', () => { project.settings = clone(defaults.settings); renderSettings(); renderShippingDestination(); commitChange(); toast('已恢复默认设置'); });
  $('#saveSettingsButton').addEventListener('click', () => saveSettings());
  $('#saveInventoryButton').addEventListener('click', () => saveSettings('#saveInventoryButton', '板材库存已保存到 SQLite 数据库'));
  $('#loadProjectButton').addEventListener('click', () => { $('#projectDialog').showModal(); renderProjectLibrary(); });
  $('#projectList').addEventListener('click', async (event) => {
    const loadButton = event.target.closest('[data-load-project]');
    const deleteButton = event.target.closest('[data-delete-project]');
    if (loadButton) {
      const item = projectLibrary.find((entry) => entry.id === loadButton.dataset.loadProject);
      if (item) { setProject(item); $('#projectDialog').close(); toast('工程已打开'); }
    }
    if (deleteButton) {
      try {
        await requestJson(`/api/projects/${encodeURIComponent(deleteButton.dataset.deleteProject)}`, { method: 'DELETE' });
        await renderProjectLibrary();
        toast('工程已删除');
      } catch (error) {
        toast(`删除失败：${error.message}`, 'error');
      }
    }
  });
}

async function init() {
  const demoMode = new URLSearchParams(window.location.search).get('demo') === '1';
  try {
    await migrateLegacyStorage();
    const savedDraft = await loadDraft();
    globalConfig = await loadGlobalSettings(savedDraft ?? (demoMode ? sampleProject : defaults));
    const projectSource = demoMode
      ? { ...projectWithoutGlobalConfig(sampleProject), id: null }
      : savedDraft ?? defaults;
    project = mergedProject(projectSource, globalConfig);
  } catch (error) {
    globalConfig = globalConfigFromProject(defaults);
    project = mergedProject(defaults, globalConfig);
    toast(`数据库加载失败：${error.message}`, 'error');
  }
  renderProjectHeader();
  renderRows();
  renderSettings();
  $('#layoutsContainer').innerHTML = emptyState('尚未生成排版', '先录入板材和零件，然后开始优化。');
  bindEvents();
  if (demoMode) setTimeout(optimize, 0);
}

init();
