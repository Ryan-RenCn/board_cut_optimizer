export function normalizeTaxRate(value) {
  const rate = Number(value);
  return Number.isFinite(rate) ? Math.min(100, Math.max(0, rate)) : 0;
}

export function calculateMaterialAfterTax(materialPrice, taxRate) {
  const price = Number(materialPrice);
  const normalizedPrice = Number.isFinite(price) ? Math.max(0, price) : 0;
  const taxedPrice = normalizedPrice * (1 + normalizeTaxRate(taxRate) / 100);
  return Math.round((taxedPrice + Number.EPSILON) * 100) / 100;
}
