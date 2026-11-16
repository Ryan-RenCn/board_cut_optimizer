import assert from 'node:assert/strict';
import { calculateLogisticsFee, LOGISTICS_DESTINATIONS, LOGISTICS_PROVIDER, normalizeLogisticsDestination } from '../logistics.mjs';

assert.deepEqual(LOGISTICS_DESTINATIONS, [
  '江苏/浙江/上海',
  '崇明岛/象山/舟山',
  '安徽',
  '山东/福建/江西/广东/湖南/湖北/河南',
  '北京/河北/天津',
  '四川/重庆',
  '山西/陕西/广西',
  '贵州/云南/辽宁/吉林/黑龙江',
  '海南/甘肃/内蒙古/宁夏/青海',
  '香港/新疆/西藏/澳门',
]);
assert.equal(normalizeLogisticsDestination('浙江'), '江苏/浙江/上海', '旧工程的单地区值应迁移为组合选项');
assert.equal(normalizeLogisticsDestination('香港/新疆/西藏/澳门'), '香港/新疆/西藏/澳门');
assert.equal(normalizeLogisticsDestination('未知地区'), '');

assert.equal(calculateLogisticsFee({ provider: 'none', destination: '山东', weight: 40 }).fee, 0);
assert.equal(calculateLogisticsFee({ provider: LOGISTICS_PROVIDER, destination: '', weight: 40 }).fee, 0);
assert.equal(calculateLogisticsFee({ provider: LOGISTICS_PROVIDER, destination: '山东', weight: 10 }).fee, 30);
assert.equal(calculateLogisticsFee({ provider: LOGISTICS_PROVIDER, destination: '山东', weight: 40 }).fee, 80);
assert.equal(calculateLogisticsFee({ provider: LOGISTICS_PROVIDER, destination: '山东/福建/江西/广东/湖南/湖北/河南', weight: 40 }).fee, 80);
assert.equal(calculateLogisticsFee({ provider: LOGISTICS_PROVIDER, destination: '北京', weight: 100 }).fee, 160);
assert.equal(calculateLogisticsFee({ provider: LOGISTICS_PROVIDER, destination: '浙江', weight: 600 }).fee, 310);
assert.equal(calculateLogisticsFee({ provider: LOGISTICS_PROVIDER, destination: '新疆', weight: 20 }).transitDays, 5);
assert.equal(calculateLogisticsFee({ provider: LOGISTICS_PROVIDER, destination: '新疆', weight: 20 }).destination, '香港/新疆/西藏/澳门');

console.log('logistics tests passed');
