'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { ItemClassifier } = require('../src/bot/ItemClassifier');

// 使用 1.21.1（minecraft-data 稳定版本）
const classifier = new ItemClassifier('1.21.1');

// 注意：minecraft-data >=3.105 的物品 id 编号已随版本升级（如 diamond=805），
// 数字 id 以当前安装的 minecraft-data 数据为准，配置中建议优先使用名称。

test('数字 id 解析（以 minecraft-data 实际数据为准）', () => {
  const item = classifier.resolveRef(805);
  assert.ok(item);
  assert.strictEqual(item.name, 'diamond');
});

test('minecraft:name 解析', () => {
  const item = classifier.resolveRef('minecraft:iron_ingot');
  assert.strictEqual(item.name, 'iron_ingot');
});

test('英文名解析', () => {
  const item = classifier.resolveRef('gold_ingot');
  assert.strictEqual(item.name, 'gold_ingot');
});

test('中文名解析（内置词典）', () => {
  const diamond = classifier.resolveRef('钻石');
  assert.strictEqual(diamond.name, 'diamond');
  const bread = classifier.resolveRef('面包');
  assert.strictEqual(bread.name, 'bread');
});

test('displayName 解析', () => {
  const item = classifier.resolveRef('Iron Ingot');
  assert.strictEqual(item.name, 'iron_ingot');
});

test('未知引用返回 null', () => {
  assert.strictEqual(classifier.resolveRef('不存在的东西'), null);
  assert.strictEqual(classifier.resolveRef(999999), null);
});

test('中文名回退与 itemOf 转换', () => {
  assert.strictEqual(classifier.nameToZh('diamond'), '钻石');
  const slot = classifier.itemOf({ name: 'bread', type: 297, count: 5 });
  assert.strictEqual(slot.zhName, '面包');
  assert.strictEqual(slot.name, 'bread');
});
