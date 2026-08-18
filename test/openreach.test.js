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
  const file = path.join(os.tmpdir(), `reach-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
  return file;
}

const BASE = {
  batchSize: 64,
  sourceBoxes: [{ x: 100, y: 64, z: 200 }],
  targetBoxes: [{ x: 120, y: 64, z: 200, category: '钻石', items: ['钻石'] }],
  overflowBox: { x: 130, y: 64, z: 200 }
};

test('ConfigStore: openReach 默认 2.9', () => {
  const store = new ConfigStore(tmpConfig(BASE), classifier);
  store.load();
  assert.strictEqual(store.openReach, 2.9);
});

test('ConfigStore: 加载已有 openReach 配置', () => {
  const store = new ConfigStore(tmpConfig({ ...BASE, openReach: 3.5 }), classifier);
  store.load();
  assert.strictEqual(store.openReach, 3.5);
});

test('ConfigStore: openReach 越界 clamp（1~8），非法回退默认', () => {
  const s1 = new ConfigStore(tmpConfig({ ...BASE, openReach: 10 }), classifier);
  s1.load();
  assert.strictEqual(s1.openReach, 8);
  const s2 = new ConfigStore(tmpConfig({ ...BASE, openReach: 0.2 }), classifier);
  s2.load();
  assert.strictEqual(s2.openReach, 1);
  const s3 = new ConfigStore(tmpConfig({ ...BASE, openReach: 'abc' }), classifier);
  s3.load();
  assert.strictEqual(s3.openReach, 2.9);
  // 快照中也包含 openReach
  assert.strictEqual(s3.toJSON().openReach, 2.9);
});
