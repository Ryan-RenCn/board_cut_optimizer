import assert from 'node:assert/strict';
import { formatQuotationText } from '../quotation.mjs';

const text = formatQuotationText({
  parts: [
    { length: 100, width: 200, thickness: 4, quantity: 2, description: '门板' },
    { length: 200, width: 1200, thickness: 12, quantity: 2, description: '' },
  ],
  panelTotal: 300,
  taxRate: 13,
  taxedPanelTotal: 339,
  cuttingTotal: 70,
  packagingTotal: 20,
  totalWeight: 25.5,
  logisticsTotal: 59,
  finalTotal: 449,
  taxedFinalTotal: 488,
});

assert.equal(text, [
  '明细',
  '--------------------------------------------------',
  '100*200*4mm 2张 [门板]',
  '200*1200*12mm 2张',
  '--------------------------------------------------',
  '板材报价：¥300.00',
  '材料税率：13%',
  '材料税后价：¥339.00',
  '油漆费用：¥0.00',
  '切割费用：¥70.00',
  '打包费用：¥20.00',
  '  总重量：25.5 kg',
  '物流费用：¥59.00',
  '--------------------------------------------------',
  '未税合计：¥449.00',
  '税后合计：¥488.00',
].join('\n'));

const customText = formatQuotationText({
  template: '{{工程名称}} | {{发货目的地}}\n{{零件明细}}\n合计 {{最终合计}}\n{{未知字段}}',
  projectName: '柜体工程',
  shippingDestination: '江苏/浙江/上海',
  parts: [{ length: 600, width: 400, thickness: 18, quantity: 3, description: '层板' }],
  finalTotal: 520,
});

assert.equal(customText, [
  '柜体工程 | 江苏/浙江/上海',
  '600*400*18mm 3张 [层板]',
  '合计 ¥520.00',
  '{{未知字段}}',
].join('\n'), '自定义模板应替换已知占位符并保留未知占位符');

console.log('quotation tests passed');
