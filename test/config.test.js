'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ConfigStore } = require('../src/config/ConfigStore');
const { ItemClassifier } = require('../src/bot/ItemClassifier');

const classifier = new ItemClassifier('1.21.1');

function tmpConfig(json) {
  const file = path.join(os.tmpdir(), `storage-box-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
  return file;
}

const VALID = {
  batchSize: 64,
  sourceBoxes: [{ x: 100, y: 64, z: 200 }],
  targetBoxes: [
    { x: 120, y: 64, z: 200, category: '钻石', items: ['钻石', 'diamond'] },
    { x: 121, y: 64, z: 200, category: '铁锭', items: ['铁锭', 'iron_ingot'] }
  ],
  overflowBox: { x: 130, y: 64, z: 200 }
};

test('合法配置加载与查询', () => {
  const store = new ConfigStore(tmpConfig(VALID), classifier);
  const parsed = store.load();
  assert.strictEqual(parsed.targetBoxes.length, 2);
  assert.strictEqual(parsed.sourceBoxes.length, 1);
  assert.strictEqual(parsed.overflowBoxes.length, 1);
  assert.strictEqual(parsed.overflowBoxes[0].key, '130,64,200');
  // 兼容旧单数引用
  assert.strictEqual(store.overflowBox.key, '130,64,200');

  // 中文名 / 英文名 / id 三种写法归一化后都能匹配
  const diamond = classifier.resolveRef('钻石');
  const tb = store.matchTargetBox(diamond);
  assert.ok(tb);
  assert.strictEqual(tb.key, '120,64,200');
  assert.strictEqual(store.matchTargetBox(classifier.resolveRef('iron_ingot')).key, '121,64,200');
  assert.strictEqual(store.matchTargetBox(classifier.resolveRef('bread')), null);
});

test('多个溢出箱配置', () => {
  const multi = JSON.parse(JSON.stringify(VALID));
  multi.overflowBoxes = [
    { x: -11, y: 69, z: -5 },
    { x: -11, y: 70, z: -5 }
  ];
  delete multi.overflowBox;
  const store = new ConfigStore(tmpConfig(multi), classifier);
  const parsed = store.load();
  assert.strictEqual(parsed.overflowBoxes.length, 2);
  assert.strictEqual(parsed.overflowBoxes[0].key, '-11,69,-5');
  assert.strictEqual(parsed.overflowBoxes[1].key, '-11,70,-5');
  assert.strictEqual(store.overflowBox.key, '-11,69,-5');
});

test('目标箱坐标重复报错', () => {
  const bad = JSON.parse(JSON.stringify(VALID));
  bad.targetBoxes.push({ x: 120, y: 64, z: 200, category: '重复', items: ['bread'] });
  const store = new ConfigStore(tmpConfig(bad), classifier);
  assert.throws(() => store.load(), /坐标重复/);
});

test('缺少溢出箱报错', () => {
  const bad = JSON.parse(JSON.stringify(VALID));
  delete bad.overflowBox;
  const store = new ConfigStore(tmpConfig(bad), classifier);
  assert.throws(() => store.load(), /overflowBox/);
});

test('items 无法解析全部时报错', () => {
  const bad = JSON.parse(JSON.stringify(VALID));
  bad.targetBoxes[0].items = ['不存在的物品'];
  const store = new ConfigStore(tmpConfig(bad), classifier);
  assert.throws(() => store.load(), /无法解析/);
});

test('重载失败时保留上一次成功配置', () => {
  const file = tmpConfig(VALID);
  const store = new ConfigStore(file, classifier);
  store.load();
  // 写入损坏配置
  fs.writeFileSync(file, '{ broken json');
  const res = store.reload();
  assert.strictEqual(res.ok, false);
  assert.ok(res.error);
  // 旧配置仍可用
  assert.strictEqual(store.matchTargetBox(classifier.resolveRef('钻石')).key, '120,64,200');
});
