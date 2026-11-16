// 费率来源：项目根目录《上海库沓物流价格表.xlsx》。
export const LOGISTICS_PROVIDER = 'shanghai-kuta';
export const LOGISTICS_PROVIDER_LABEL = '上海库沓物流（上海始发）';
export const LOGISTICS_PRICE_RATE = 1.2;

export const LOGISTICS_ROUTES = [
  { destinations: ['江苏', '浙江', '上海'], transitDays: 1, firstWeightPrice: 15, rates: [0.8, 0.7, 0.6, 0.55, 0.5, 0.4] },
  { destinations: ['崇明岛', '象山', '舟山'], transitDays: 1, firstWeightPrice: 45, rates: [1, 0.9, 0.9, 0.9, 0.8, 0.6] },
  { destinations: ['安徽'], transitDays: 1, firstWeightPrice: 20, rates: [1, 0.8, 0.7, 0.65, 0.6, 0.4] },
  { destinations: ['山东', '福建', '江西', '广东', '湖南', '湖北', '河南'], transitDays: 1, firstWeightPrice: 20, rates: [1.3, 1, 0.9, 0.85, 0.8, 0.6] },
  { destinations: ['北京', '河北', '天津'], transitDays: 2, firstWeightPrice: 25, rates: [1.4, 1.2, 1.1, 1, 1, 0.8] },
  { destinations: ['四川', '重庆'], transitDays: 3, firstWeightPrice: 25, rates: [1.8, 1.7, 1.6, 1.5, 1.4, 1.2] },
  { destinations: ['山西', '陕西', '广西'], transitDays: 3, firstWeightPrice: 25, rates: [2, 1.8, 1.6, 1.5, 1.3, 1.1] },
  { destinations: ['贵州', '云南', '辽宁', '吉林', '黑龙江'], transitDays: 3, firstWeightPrice: 25, rates: [2.4, 1.7, 1.6, 1.4, 1.4, 1.3] },
  { destinations: ['海南', '甘肃', '内蒙古', '宁夏', '青海'], transitDays: 3, firstWeightPrice: 50, rates: [3, 2.7, 2.6, 2.5, 2.3, 2.1] },
  { destinations: ['香港', '新疆', '西藏', '澳门'], transitDays: 5, firstWeightPrice: 100, rates: [5.5, 5.3, 5, 4.8, 4.6, 4.3] },
];

const routeLabel = (route) => route.destinations.join('/');

export const LOGISTICS_DESTINATIONS = LOGISTICS_ROUTES.map(routeLabel);

export function normalizeLogisticsDestination(destination) {
  const value = String(destination ?? '').trim();
  const route = LOGISTICS_ROUTES.find((item) => routeLabel(item) === value || item.destinations.includes(value));
  return route ? routeLabel(route) : '';
}

function rateForWeight(route, weight) {
  if (weight <= 70) return route.rates[0];
  if (weight <= 100) return route.rates[1];
  if (weight <= 200) return route.rates[2];
  if (weight <= 300) return route.rates[3];
  if (weight <= 500) return route.rates[4];
  return route.rates[5];
}

export function calculateLogisticsFee({ provider, destination, weight }) {
  const normalizedWeight = Math.max(0, Number.isFinite(Number(weight)) ? Number(weight) : 0);
  const normalizedDestination = normalizeLogisticsDestination(destination);
  const route = LOGISTICS_ROUTES.find((item) => routeLabel(item) === normalizedDestination);
  const enabled = provider === LOGISTICS_PROVIDER;
  if (!enabled || !route || normalizedWeight <= 0) {
    return {
      enabled,
      available: Boolean(enabled && route),
      providerLabel: enabled ? LOGISTICS_PROVIDER_LABEL : '不计算物流',
      origin: '上海',
      destination: normalizedDestination,
      transitDays: route?.transitDays ?? null,
      weight: normalizedWeight,
      fee: 0,
    };
  }

  const baseFee = normalizedWeight <= 10
    ? route.firstWeightPrice
    : route.firstWeightPrice + (normalizedWeight - 10) * rateForWeight(route, normalizedWeight);
  const fee = Math.ceil(baseFee * LOGISTICS_PRICE_RATE / 10) * 10;
  return {
    enabled: true,
    available: true,
    providerLabel: LOGISTICS_PROVIDER_LABEL,
    origin: '上海',
    destination: normalizedDestination,
    transitDays: route.transitDays,
    weight: normalizedWeight,
    fee,
  };
}
