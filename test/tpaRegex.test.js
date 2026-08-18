'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { classifyTpaMessage } = require('../src/util/tpaRegex');

test('tpaRegex: 同意/成功类消息', () => {
  assert.strictEqual(classifyTpaMessage('§a[传送] 玩家 Steve 已接受你的传送请求'), 'accepted');
  assert.strictEqual(classifyTpaMessage('传送请求已接受'), 'accepted');
  assert.strictEqual(classifyTpaMessage('§dSteve 同意传送'), 'accepted');
  assert.strictEqual(classifyTpaMessage('Teleporting...'), 'accepted');
  assert.strictEqual(classifyTpaMessage('Teleport request accepted'), 'accepted');
  assert.strictEqual(classifyTpaMessage('传送成功，已到达目的地'), 'accepted');
});

test('tpaRegex: 拒绝/失败类消息', () => {
  assert.strictEqual(classifyTpaMessage('§c玩家 Steve 拒绝了你的传送请求'), 'rejected');
  assert.strictEqual(classifyTpaMessage('该玩家不在线'), 'rejected');
  assert.strictEqual(classifyTpaMessage('That player is not online'), 'rejected');
  assert.strictEqual(classifyTpaMessage('Teleport request denied'), 'rejected');
  assert.strictEqual(classifyTpaMessage('传送请求已超时'), 'rejected');
  assert.strictEqual(classifyTpaMessage('找不到该玩家'), 'rejected');
  assert.strictEqual(classifyTpaMessage('Request timed out'), 'rejected');
});

test('tpaRegex: 无关消息返回 null（不误判）', () => {
  assert.strictEqual(classifyTpaMessage('Teleport request sending to player'), null);
  assert.strictEqual(classifyTpaMessage('你好，我同意这个方案'), null); // 无传送关键词
  assert.strictEqual(classifyTpaMessage('hello world'), null);
  assert.strictEqual(classifyTpaMessage(''), null);
  assert.strictEqual(classifyTpaMessage(null), null);
});
