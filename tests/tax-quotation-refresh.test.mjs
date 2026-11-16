import assert from 'node:assert/strict';
import { formatQuotationText } from '../quotation.mjs';

const baseQuote = {
  template: '最终合计：{{最终合计}}',
  panelTotal: 100,
  finalTotal: 120,
};

const beforeTax = formatQuotationText({
  ...baseQuote,
  taxRate: 0,
  taxedPanelTotal: 100,
  taxedFinalTotal: 120,
});
const afterTax = formatQuotationText({
  ...baseQuote,
  taxRate: 13,
  taxedPanelTotal: 113,
  taxedFinalTotal: 133,
});

assert.notEqual(afterTax, beforeTax, '老工程报价模板也必须在税率更新后刷新报价文本');
assert.match(afterTax, /^最终合计：¥120\.00/m, '最终合计应保持原有的未税总价逻辑');
assert.match(afterTax, /材料税率：13%/, '老模板应自动补充材料税率');
assert.match(afterTax, /材料税后价：¥113\.00/, '老模板应自动补充材料税后价');
assert.match(afterTax, /税后合计：¥133\.00/, '老模板应自动补充税后总价');

console.log('tax quotation refresh tests passed');
