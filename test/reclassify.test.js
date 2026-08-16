'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { ReclassifyTask } = require('../src/bot/ReclassifyTask');
const { keyOf, eq, normalize } = require('../src/util/vec3util');

// ReclassifyTask 需要 owner，但 _planBatch 是纯函数，可用最小 mock 测试
function makeTask() {
  return new ReclassifyTask({
    logger: { info() {}, warn() {}, error() {} },
    connectionState: 'online',
    store: { parsed: true, sourceBoxes: [{ x: 1, y: 64, z: 1 }], batchSize: 64 },
    emitStatus() {},
    autoStore: false
  });
}

test('_planBatch 按 batch_size 分批，且种类不超过背包空位', () => {
  const task = makeTask();
  const items = [
    { type: 1, count: 64, name: 'a' },
    { type: 2, count: 64, name: 'b' },
    { type: 3, count: 64, name: 'c' }
  ];
  // 配额 64：第一类物品 64 个即凑满一批（逐类累计）
  const plan1 = task._planBatch(items, 64, 3);
  assert.strictEqual(plan1.reduce((s, p) => s + p.count, 0), 64);
  assert.strictEqual(plan1.length, 1);
  assert.strictEqual(plan1[0].type, 1);

  // 配额 32：第一类取 32 个；配额 192 且空位 3 时取满 3 类
  const plan2 = task._planBatch(items, 32, 1);
  assert.strictEqual(plan2.length, 1);
  assert.strictEqual(plan2[0].count, 32);
  const plan3 = task._planBatch(items, 192, 3);
  assert.strictEqual(plan3.length, 3);
  assert.strictEqual(plan3.reduce((s, p) => s + p.count, 0), 192); // 64*3=192
});

test('_planBatch 空容器返回空计划', () => {
  const task = makeTask();
  assert.deepStrictEqual(task._planBatch([], 64, 5), []);
});

test('vec3util 坐标工具', () => {
  assert.strictEqual(keyOf(120, 64, 200), '120,64,200');
  assert.ok(eq({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3 }));
  assert.ok(!eq({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 4 }));
  const n = normalize({ x: 120.7, y: 64.2, z: 200.9 });
  assert.deepStrictEqual(n, { x: 120, y: 64, z: 200 });
});

test('_checkpoint 在全局暂停时可被 cancel 打断（回归：暂停后任务永久挂起）', async () => {
  const owner = { paused: true };
  const task = new ReclassifyTask(owner);
  const p = task._checkpoint();
  await new Promise(r => setTimeout(r, 30));
  task.cancel(); // 设置 _cancelled + _wake
  await assert.rejects(p, /任务已取消/);
});

test('_checkpoint 在全局暂停解除后继续（回归：resume/unpause 恢复任务）', async () => {
  const owner = { paused: true };
  const task = new ReclassifyTask(owner);
  const p = task._checkpoint();
  await new Promise(r => setTimeout(r, 30));
  owner.paused = false; // 模拟 unpauseAll
  task._wake();
  await p; // 正常返回，不抛异常
  assert.strictEqual(task.state, 'idle');
});
