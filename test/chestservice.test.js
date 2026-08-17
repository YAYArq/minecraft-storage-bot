'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { isContainerBlock } = require('../src/bot/ChestService');

test('容器类型识别：箱子/木桶/潜影盒/漏斗/发射器/投掷器均可存放', () => {
  assert.strictEqual(isContainerBlock({ name: 'chest' }), true);
  assert.strictEqual(isContainerBlock({ name: 'barrel' }), true);
  assert.strictEqual(isContainerBlock({ name: 'shulker_box' }), true);
  assert.strictEqual(isContainerBlock({ name: 'white_shulker_box' }), true);
  assert.strictEqual(isContainerBlock({ name: 'hopper' }), true);
  assert.strictEqual(isContainerBlock({ name: 'dispenser' }), true);
  assert.strictEqual(isContainerBlock({ name: 'dropper' }), true);
  // 非容器
  assert.strictEqual(isContainerBlock({ name: 'stone' }), false);
  assert.strictEqual(isContainerBlock({ name: 'oak_planks' }), false);
  assert.strictEqual(isContainerBlock(null), false);
  assert.strictEqual(isContainerBlock(undefined), false);
});
