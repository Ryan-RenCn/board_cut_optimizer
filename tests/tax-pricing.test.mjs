import assert from 'node:assert/strict';
import { calculateMaterialAfterTax, normalizeTaxRate } from '../tax-pricing.mjs';

assert.equal(normalizeTaxRate(13), 13);
assert.equal(normalizeTaxRate(-5), 0);
assert.equal(normalizeTaxRate(120), 100);
assert.equal(normalizeTaxRate('invalid'), 0);

assert.equal(calculateMaterialAfterTax(100, 13), 113);
assert.equal(calculateMaterialAfterTax(262.4, 13), 296.51, '材料税后价格应按分币四舍五入');
assert.equal(calculateMaterialAfterTax(100, 0), 100);

console.log('tax pricing tests passed');
