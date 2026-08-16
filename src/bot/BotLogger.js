'use strict';

/**
 * BotLogger —— 单 bot 日志器
 *
 * 参考 MULTIBOT 的 BotLogger / RingBuffer 设计：
 *   - 内存环形缓冲保留最近 N 条日志（面板/API 可随时拉取历史）；
 *   - 每条日志同步回调 listeners（用于 WebSocket 实时推送）。
 *
 * 日志级别：debug < info < warn < error。
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

class BotLogger {
  /**
   * @param {string} botId
   * @param {object} [options]
   * @param {number} [options.bufferSize=500] 环形缓冲容量
   * @param {number} [options.minLevel='info'] 最低输出级别
   * @param {(entry:object)=>void} [options.listener] 每条日志的推送回调
   */
  constructor(botId, options = {}) {
    this.botId = botId;
    this.bufferSize = options.bufferSize || 500;
    this.minLevel = options.minLevel || 'info';
    this.buffer = [];
    this.listeners = new Set();
    if (typeof options.listener === 'function') this.listeners.add(options.listener);
  }

  /** 追加一条日志并广播给监听者 */
  log(level, message, extra) {
    if (LEVELS[level] < LEVELS[this.minLevel]) return;
    const entry = {
      ts: Date.now(),
      botId: this.botId,
      level,
      message: String(message),
      ...(extra || {})
    };
    this.buffer.push(entry);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
    for (const fn of this.listeners) {
      try { fn(entry); } catch (e) { /* 广播失败不影响主流程 */ }
    }
  }

  debug(msg) { this.log('debug', msg); }
  info(msg) { this.log('info', msg); }
  warn(msg) { this.log('warn', msg); }
  error(msg) { this.log('error', msg); }

  /** 追加推送监听 */
  onLog(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** 拉取历史日志（面板初始快照用） */
  history(limit) {
    const n = Math.min(limit || this.bufferSize, this.buffer.length);
    return this.buffer.slice(-n);
  }

  clear() { this.buffer.length = 0; }
}

module.exports = { BotLogger, LEVELS };
