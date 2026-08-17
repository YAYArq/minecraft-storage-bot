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

test('中文名词典覆盖木材/活板门/菌核/装备（盘点与日志展示用中文名）', () => {
  assert.strictEqual(classifier.nameToZh('spruce_planks'), '云杉木板');
  assert.strictEqual(classifier.nameToZh('birch_planks'), '白桦木板');
  assert.strictEqual(classifier.nameToZh('oak_trapdoor'), '橡木活板门');
  assert.strictEqual(classifier.nameToZh('warped_hyphae'), '诡异菌核');
  assert.strictEqual(classifier.nameToZh('stripped_birch_log'), '去皮白桦原木');
  assert.strictEqual(classifier.nameToZh('birch_slab'), '白桦台阶');
  assert.strictEqual(classifier.nameToZh('diorite_slab'), '闪长岩台阶');
  assert.strictEqual(classifier.nameToZh('golden_chestplate'), '金胸甲');
  // 反向：配置里写中文也能解析成物品（展示用中文、配置仍可中文输入，保存时 normalize 为 minecraft:name）
  const birch = classifier.resolveRef('白桦木板');
  assert.strictEqual(birch.name, 'birch_planks');
  assert.strictEqual(birch.zhName, '白桦木板');
});

test('中文名词典覆盖树叶/树苗/矿物块等常见物品', () => {
  assert.strictEqual(classifier.nameToZh('oak_leaves'), '橡树树叶');
  assert.strictEqual(classifier.nameToZh('birch_leaves'), '白桦树叶');
  assert.strictEqual(classifier.nameToZh('dark_oak_leaves'), '深色橡树树叶');
  assert.strictEqual(classifier.nameToZh('oak_sapling'), '橡树树苗');
  assert.strictEqual(classifier.nameToZh('diamond_block'), '钻石块');
  assert.strictEqual(classifier.nameToZh('raw_iron_block'), '粗铁块');
  assert.strictEqual(classifier.nameToZh('honeycomb_block'), '蜜脾块');
  assert.strictEqual(classifier.nameToZh('stone_pressure_plate'), '石头压力板');
  assert.strictEqual(classifier.nameToZh('iron_door'), '铁门');
});
