import { normalizeShape, shapeBounds } from './polygon-geometry.mjs';

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const formatNumber = (value, decimals = 1) => new Intl.NumberFormat('zh-CN', { useGrouping: false, maximumFractionDigits: decimals }).format(number(value));
const formatCurrency = (value) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(number(value));
const formatWeight = (value) => `${formatNumber(value, 2)} kg`;

export const LEGACY_DEFAULT_QUOTATION_TEMPLATE = `明细
{{分隔线}}
{{零件明细}}
{{分隔线}}
板材报价：{{板材报价}}
油漆费用：{{油漆费用}}
切割费用：{{切割费用}}
打包费用：{{打包费用}}
  总重量：{{总重量}}
物流费用：{{物流费用}}
{{分隔线}}
最终合计：{{最终合计}}`;

export const PREVIOUS_TAX_DEFAULT_QUOTATION_TEMPLATE = `明细
{{分隔线}}
{{零件明细}}
{{分隔线}}
板材报价：{{板材报价}}
材料税率：{{材料税率}}
材料税后价：{{材料税后价格}}
油漆费用：{{油漆费用}}
切割费用：{{切割费用}}
打包费用：{{打包费用}}
  总重量：{{总重量}}
物流费用：{{物流费用}}
{{分隔线}}
未税合计：{{最终合计}}
税后合计：{{税后合计}}`;

export const DEFAULT_QUOTATION_TEMPLATE = `明细
{{分隔线}}
{{零件明细}}
{{分隔线}}
板材报价：{{板材报价}}
材料税率：{{材料税率}}
材料税后价：{{材料税后价格}}
油漆费用：{{油漆费用}}
切割费用：{{切割费用}}
打包费用：{{打包费用}}
  总重量：{{总重量}}
物流费用：{{物流费用}}
{{分隔线}}
未税合计：{{未税合计}}
税后合计：{{税后合计}}`;

function partDetailLine(part, maxShapeVertices) {
  const description = String(part?.description ?? '').replace(/\s+/g, ' ').trim();
  if (part?.shape) {
    const shape = normalizeShape(part.shape, { maxVertices: maxShapeVertices });
    const bounds = shapeBounds(shape);
    return `${formatNumber(bounds.width)}*${formatNumber(bounds.height)}*${formatNumber(part.thickness)}mm ${formatNumber(part.quantity, 0)}张${description ? ` [${description}]` : ''}`;
  }
  const dimensions = [part?.length, part?.width, part?.thickness].map((value) => formatNumber(value));
  return `${dimensions.join('*')}mm ${formatNumber(part?.quantity, 0)}张${description ? ` [${description}]` : ''}`;
}

export function formatQuotationText({
  template = DEFAULT_QUOTATION_TEMPLATE,
  projectName = '',
  projectDescription = '',
  shippingDestination = '',
  parts = [],
  maxShapeVertices = 256,
  panelTotal = 0,
  taxRate = 0,
  taxedPanelTotal = panelTotal,
  paintTotal = 0,
  cuttingTotal = 0,
  packagingTotal = 0,
  totalWeight = 0,
  logisticsTotal = 0,
  finalTotal = 0,
  taxedFinalTotal = finalTotal,
} = {}) {
  const separator = '-'.repeat(50);
  const sourceTemplate = String(template ?? DEFAULT_QUOTATION_TEMPLATE);
  const fields = {
    '工程名称': String(projectName ?? ''),
    '工程说明': String(projectDescription ?? ''),
    '发货目的地': String(shippingDestination ?? ''),
    '分隔线': separator,
    '零件明细': parts.map((part) => partDetailLine(part, maxShapeVertices)).join('\n'),
    '板材报价': formatCurrency(panelTotal),
    '材料税率': `${formatNumber(taxRate, 2)}%`,
    '材料税后价格': formatCurrency(taxedPanelTotal),
    '油漆费用': formatCurrency(paintTotal),
    '切割费用': formatCurrency(cuttingTotal),
    '打包费用': formatCurrency(packagingTotal),
    '总重量': formatWeight(totalWeight),
    '物流费用': formatCurrency(logisticsTotal),
    '未税合计': formatCurrency(finalTotal),
    '最终合计': formatCurrency(finalTotal),
    '税后合计': formatCurrency(taxedFinalTotal),
  };
  const rendered = Object.entries(fields).reduce(
    (text, [field, value]) => text.split(`{{${field}}}`).join(value),
    sourceTemplate,
  );
  const hasTaxPlaceholder = ['材料税率', '材料税后价格', '税后合计']
    .some((field) => sourceTemplate.includes(`{{${field}}}`));
  const hasTaxDifference = number(taxRate) > 0
    || Math.abs(number(taxedPanelTotal) - number(panelTotal)) >= 0.005
    || Math.abs(number(taxedFinalTotal) - number(finalTotal)) >= 0.005;
  if (hasTaxPlaceholder || !hasTaxDifference) return rendered;
  return `${rendered}\n材料税率：${fields['材料税率']}\n材料税后价：${fields['材料税后价格']}\n税后合计：${fields['税后合计']}`;
}
