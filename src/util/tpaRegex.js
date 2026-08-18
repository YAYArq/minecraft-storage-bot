'use strict';

/**
 * tpa 结果识别 —— 用正则判断服务器返回的消息是否表示 tpa 已被同意 / 被拒绝。
 *
 * 覆盖常见插件消息（EssentialsX / CMI / 各类汉化插件的中英文文案）。
 * 若服务器插件的消息文案不在覆盖范围内，可在此追加正则。
 * 注意：只匹配与「传送 / tpa」相关的消息，避免误判玩家聊天。
 */

// 与 tpa/传送 无关的消息直接忽略（relevance 过滤，降低误判）
const RELEVANT_RE = /tpa|传送|瞬移|teleport|tp\s*accept/i;

// 拒绝 / 失败类（先匹配：如「拒绝了你的传送请求」同时含「拒绝」与「传送」）
const REJECT_RE = [
  /拒绝|不同意|已取消|取消请求/,
  /不在线|未在线|离线|不存在|找不到(该)?(玩家|目标)/,
  /超时|已过期|已超时|expired|timed?\s*out/i,
  /denied|declined|rejected|refused|cancelled|canceled/i,
  /not online|offline|not found|no longer/i
];

// 同意 / 成功类
const ACCEPT_RE = [
  /传送(请求)?(已|被|获|已经)?(接受|同意)|(接受|同意)(了)?(你(的)?)?(传送|tp|tpa)(请求)?/i,
  /(传送|瞬移)(成功|完成|已开始|开始|进行中)/,
  /teleporting|teleported/i,
  /request accepted|accepts your|accepted your|teleport request accepted/i
];

/**
 * 分类一条游戏消息的 tpa 结果。
 * @param {string|object} raw 消息文本（或 mineflayer ChatMessage，取其文本）
 * @returns {'accepted'|'rejected'|null} accepted=已同意可传送；rejected=被拒绝/失败；null=无关消息
 */
function classifyTpaMessage(raw) {
  let text = raw;
  if (raw && typeof raw === 'object') {
    try { text = typeof raw.toAnsi === 'function' ? raw.toAnsi() : String(raw); } catch (e) { text = String(raw); }
  }
  text = String(text || '')
    .replace(/[§\u00a7][0-9a-fk-or]/gi, '') // 剥颜色码
    .trim();
  if (!text) return null;
  // 拒绝/失败类：直接匹配（插件拒绝文案常不含「传送」字样，如「该玩家不在线」）
  for (const re of REJECT_RE) if (re.test(text)) return 'rejected';
  // 同意/成功类：要求与传送相关，避免误判普通聊天
  if (!RELEVANT_RE.test(text)) return null;
  for (const re of ACCEPT_RE) if (re.test(text)) return 'accepted';
  return null;
}

module.exports = { classifyTpaMessage, RELEVANT_RE, REJECT_RE, ACCEPT_RE };
