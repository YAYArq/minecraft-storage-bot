'use strict';

const fs = require('fs');
const path = require('path');
const { StorageBot } = require('./StorageBot');
const { SystemSettings } = require('../config/SystemSettings');
const { keyOf } = require('../util/vec3util');

/**
 * BotManager —— 多 bot 实例管理器
 *
 * 复用 MULTIBOT「BotManager / BotRuntime」架构：
 *   - 一个进程管理多个 StorageBot 实例，每个实例独立连接参数 + 独立箱子配置；
 *   - 统一状态快照、日志广播（供 WebSocket 面板）、聊天/whisper 命令分发；
 *   - 系统设置（config/system.json）、库存盘点、任务历史。
 *
 * bots.json 示例见 config/bots.example.json。
 */

class BotManager {
  /**
   * @param {object} options
   * @param {string} options.configPath bots.json 路径
   * @param {(entry:object)=>void} [options.onLog] 任意 bot 的日志广播
   * @param {(snapshot:object)=>void} [options.onStatus] 任意 bot 状态变化广播
   * @param {(chat:object)=>void} [options.onChat] 任意 bot 聊天消息广播
   */
  constructor(options = {}) {
    this.configPath = path.resolve(process.cwd(), options.configPath || 'config/bots.json');
    this.onLog = options.onLog || (() => {});
    this.onStatus = options.onStatus || (() => {});
    this.onChat = options.onChat || (() => {});
    this.bots = new Map(); // id -> StorageBot
    this.masterConfig = null;
    this.settings = new SystemSettings(
      path.resolve(process.cwd(), options.settingsPath || 'config/system.json')
    );
    this.settings.load();
  }

  /** 加载 bots.json 并创建所有 bot 实例（不连接） */
  load() {
    const raw = fs.readFileSync(this.configPath, 'utf8');
    const json = JSON.parse(raw);
    if (!json || !Array.isArray(json.bots) || json.bots.length === 0) {
      throw new Error('bots.json 必须包含非空 bots 数组');
    }
    this.masterConfig = json;

    for (const botConfig of json.bots) {
      if (!botConfig.id) throw new Error('每个 bot 必须配置 id');
      if (this.bots.has(botConfig.id)) throw new Error(`bot id 重复: ${botConfig.id}`);
      const bot = new StorageBot(botConfig, {
        onLog: (entry) => this.onLog(entry),
        onStatus: (snapshot) => this.onStatus(snapshot),
        onChat: (chat) => this.onChat(chat),
        settings: this.settings
      });
      this.bots.set(botConfig.id, bot);
    }
    return this;
  }

  /** 启动所有 bot 连接 */
  start() {
    // 系统设置：启动自动入库（默认开启，可在面板「系统设置 → 行为参数」调整）
    const autoStore = !!this.settings.data.behavior.autoStoreOnStart;
    for (const bot of this.bots.values()) {
      if (autoStore) bot.setAutoStore(true);
      bot.start();
    }
  }

  /** 停止所有 bot */
  async stop() {
    await Promise.all([...this.bots.values()].map(b => b.stop()));
  }

  // ================= 查询 =================

  /** 全部 bot 状态快照（面板列表用） */
  getSnapshots() {
    return [...this.bots.values()].map(b => b.getStatus());
  }

  /** 单个 bot 状态快照 */
  getBot(id) {
    return this.bots.get(id) || null;
  }

  /** 解析物品引用列表 -> 标准物品信息（含中文名），供前端「识别 setblock」自动填分类名 */
  resolveItemRefs(id, refs) {
    const bot = this.bots.get(id);
    if (!bot || !bot.classifier) return { ok: false, message: 'bot 分类器未加载' };
    const results = (Array.isArray(refs) ? refs : []).map(ref => {
      const item = bot.classifier.resolveRef(ref);
      return item ? { ref, name: item.name, zhName: item.zhName } : { ref, name: null, zhName: null };
    });
    return { ok: true, results };
  }

  /** 触发取货：从仓库取出指定物品放取货箱/送货给玩家 */
  pickup(id, req) {
    const bot = this.bots.get(id);
    if (!bot) return { ok: false, message: `bot 不存在: ${id}` };
    return bot.pickup(req || {});
  }

  /** 保存取货配置（pickup 段：取货箱坐标/送达方式/返回方式），写盘并热重载 */
  updatePickupConfig(id, pickup) {
    const bot = this.bots.get(id);
    if (!bot || !bot.store) return { ok: false, message: 'bot 的箱子配置未加载' };
    const json = JSON.parse(bot.store.rawText || '{}');
    const p = pickup && typeof pickup === 'object' ? pickup : {};
    const box = p.box && Number.isFinite(Number(p.box.x)) && Number.isFinite(Number(p.box.y)) && Number.isFinite(Number(p.box.z))
      ? { x: Number(p.box.x), y: Number(p.box.y), z: Number(p.box.z) }
      : null;
    json.pickup = {
      box,
      deliverMode: ['box', 'tpa', 'tp'].includes(p.deliverMode) ? p.deliverMode : 'box',
      returnMode: ['home', 'walk', 'tp'].includes(p.returnMode) ? p.returnMode : 'home',
      returnHomeCmd: typeof p.returnHomeCmd === 'string' && p.returnHomeCmd.trim() ? p.returnHomeCmd.trim() : '/home'
    };
    const result = this.updateStorageConfig(id, json);
    if (result.ok) result.message = '取货配置已保存';
    return result;
  }

  /** 单 bot 的箱子配置展示数据 */
  getBotConfigView(id) {
    const bot = this.bots.get(id);
    if (!bot) return null;
    if (!bot.store || !bot.store.parsed) {
      return { id, loaded: false, error: '配置未加载' };
    }
    return { id, loaded: true, config: bot.store.toJSON() };
  }

  /** 单 bot 日志历史 */
  getBotLogs(id, limit) {
    const bot = this.bots.get(id);
    return bot ? bot.logger.history(limit) : [];
  }

  /**
   * 命令分发（Web 面板 / REST API / 聊天共用）。
   * @param {string} botId
   * @param {string} command 指令名
   * @param {*} args
   */
  dispatch(botId, command, args) {
    const bot = this.bots.get(botId);
    if (!bot) return { ok: false, message: `bot 不存在: ${botId}` };
    return bot.executeCommand(command, args);
  }

  // ================= 配置编辑（bot 实例配置）=================

  /** 读取 bots.json 的原始内容 */
  readMasterConfig() {
    return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
  }

  writeMasterConfig(json) {
    fs.writeFileSync(this.configPath, JSON.stringify(json, null, 2) + '\n');
    this.masterConfig = json;
  }

  /** 获取单 bot 实例配置（bot 配置页面表单用） */
  getBotSettings(id) {
    const bot = this.bots.get(id);
    if (!bot) return null;
    return { ...bot.config };
  }

  /**
   * 保存 bot 实例配置：合并 patch 写回 bots.json（保留其他 bot 与格式）。
   * 连接参数（host/port/username/auth/version）变化时需重启 bot 生效。
   * @returns {{ok:boolean, message:string, needsRestart:boolean}}
   */
  updateBotSettings(id, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, message: '配置必须是对象' };
    }
    const json = this.readMasterConfig();
    const idx = json.bots.findIndex(b => b.id === id);
    if (idx < 0) return { ok: false, message: `bots.json 中找不到 bot: ${id}` };

    const prev = json.bots[idx];
    // 关键连接字段（变化时需要重启）
    const RESTART_KEYS = ['host', 'port', 'username', 'auth', 'version'];
    const needsRestart = RESTART_KEYS.some(k =>
      patch[k] !== undefined && String(patch[k]) !== String(prev[k])
    );

    const merged = { ...prev, ...patch, id };
    if (!merged.host) return { ok: false, message: 'host 不能为空' };
    if (!merged.username) return { ok: false, message: 'username 不能为空' };
    merged.port = Number(merged.port) || 25565;
    if (!Array.isArray(merged.trustedPlayers)) merged.trustedPlayers = [];
    if (typeof merged.commandPrefix !== 'string' || !merged.commandPrefix) merged.commandPrefix = '!';

    json.bots[idx] = merged;
    this.writeMasterConfig(json);

    // 同步运行时配置
    const bot = this.bots.get(id);
    if (bot) bot.config = merged;
    return {
      ok: true,
      needsRestart,
      message: needsRestart
        ? '配置已保存，连接参数已变化，建议重启 bot 生效'
        : '配置已保存'
    };
  }

  /** 新增 bot 实例（写入 bots.json 并创建实例） */
  addBot(entry) {
    if (!entry || typeof entry !== 'object') return { ok: false, message: '配置必须是对象' };
    if (!entry.id) return { ok: false, message: 'id 必填' };
    if (this.bots.has(entry.id)) return { ok: false, message: `bot id 已存在: ${entry.id}` };
    if (!entry.host) return { ok: false, message: 'host 必填' };
    if (!entry.username) return { ok: false, message: 'username 必填' };

    const json = this.readMasterConfig();
    json.bots.push({
      id: entry.id,
      host: entry.host,
      port: Number(entry.port) || 25565,
      username: entry.username,
      auth: entry.auth || 'offline',
      version: entry.version || '1.21.1',
      storageConfig: entry.storageConfig || 'config/storage_box.json',
      trustedPlayers: Array.isArray(entry.trustedPlayers) ? entry.trustedPlayers : [],
      commandPrefix: entry.commandPrefix || '!'
    });
    this.writeMasterConfig(json);

    // 创建并启动新实例
    const bot = new StorageBot(json.bots[json.bots.length - 1], {
      onLog: (e) => this.onLog(e),
      onStatus: (s) => this.onStatus(s),
      onChat: (c) => this.onChat(c)
    });
    this.bots.set(bot.id, bot);
    bot.start();
    return { ok: true, message: `已创建并启动 bot: ${entry.id}` };
  }

  /** 删除 bot 实例（写入 bots.json 并停止实例） */
  async removeBot(id) {
    const bot = this.bots.get(id);
    if (!bot) return { ok: false, message: `bot 不存在: ${id}` };
    const json = this.readMasterConfig();
    const next = json.bots.filter(b => b.id !== id);
    if (next.length === json.bots.length) return { ok: false, message: `bots.json 中找不到 bot: ${id}` };
    json.bots = next;
    this.writeMasterConfig(json);
    await bot.stop();
    this.bots.delete(id);
    return { ok: true, message: `已删除 bot: ${id}` };
  }

  /** 重启单 bot（应用连接配置变化） */
  async restartBot(id) {
    const bot = this.bots.get(id);
    if (!bot) return { ok: false, message: `bot 不存在: ${id}` };
    bot.restart();
    return { ok: true, message: `已请求重启 bot: ${id}` };
  }

  // ================= 配置编辑（箱子配置）=================

  /** 读取单 bot 的箱子配置文件原始文本（JSON 编辑器用） */
  getStorageConfigRaw(id) {
    const bot = this.bots.get(id);
    if (!bot || !bot.store) return null;
    return bot.store.rawText || JSON.stringify(bot.store.toJSON(), null, 2);
  }

  /**
   * 保存箱子配置：先校验（不写盘），通过后写盘并热重载。
   * @param {string} id
   * @param {object|string} raw 配置对象或 JSON 文本
   * @returns {{ok:boolean, message:string, warnings?:string[], config?:object}}
   */
  updateStorageConfig(id, raw) {
    const bot = this.bots.get(id);
    if (!bot || !bot.store) return { ok: false, message: 'bot 的箱子配置未加载' };

    let parsed;
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (err) {
      return { ok: false, message: `JSON 解析失败: ${err.message}` };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, message: '配置必须是 JSON 对象' };
    }

    // 校验（validate 抛错则不写盘，保留旧配置）
    try {
      bot.store.validate(parsed);
    } catch (err) {
      return { ok: false, message: `配置校验失败: ${err.message}` };
    }

    // 规范化：物品引用统一转为游戏标准 id（minecraft:name），category 自动中文
    const { json: normalized, warnings } = bot.store.normalizeForSave(parsed);

    // 写盘并重载
    fs.writeFileSync(bot.storageConfigPath, JSON.stringify(normalized, null, 2) + '\n');
    const res = bot.store.reload();
    if (!res.ok) return { ok: false, message: `配置重载失败: ${res.error}` };
    bot.emitStatus();
    return {
      ok: true,
      message: '箱子配置已保存并重载（物品已规范化为游戏标准 id）',
      warnings: [...(res.warnings || []), ...warnings],
      config: bot.store.toJSON()
    };
  }

  // ================= 区域框选（对角坐标）=================

  /**
   * 扫描对角立方体区域内的容器（需 bot 在线），返回容器坐标列表。
   * 前端「对角选择操作框」：扫描预览 → 确认后添加为 area 配置。
   */
  async scanBoxArea(id, corner1, corner2) {
    const bot = this.bots.get(id);
    if (!bot) return { ok: false, message: `bot 不存在: ${id}` };
    if (!corner1 || !corner2
      || ![corner1.x, corner1.y, corner1.z, corner2.x, corner2.y, corner2.z].every(n => Number.isFinite(Number(n)))) {
      return { ok: false, message: '需要两个对角坐标 corner1 / corner2（含 x/y/z）' };
    }
    if (bot.connectionState !== 'online' || !bot.bot || !bot.bot.entity) {
      return { ok: false, message: 'bot 未在线，无法扫描区块内容器（离线时请直接填写坐标）' };
    }
    const min = {
      x: Math.min(Number(corner1.x), Number(corner2.x)),
      y: Math.min(Number(corner1.y), Number(corner2.y)),
      z: Math.min(Number(corner1.z), Number(corner2.z))
    };
    const max = {
      x: Math.max(Number(corner1.x), Number(corner2.x)),
      y: Math.max(Number(corner1.y), Number(corner2.y)),
      z: Math.max(Number(corner1.z), Number(corner2.z))
    };
    try {
      // 扫描含寻路（走到区域中心加载区块），放入串行队列避免与自动入库并发寻路
      const boxes = await bot.enqueue(() => bot.scanArea(min, max));
      return { ok: true, min, max, boxes, count: boxes.length };
    } catch (err) {
      return { ok: false, message: `区域扫描失败: ${err.message}` };
    }
  }

  /**
   * 向配置添加对角区域 / 单箱条目（source 源箱 / overflow 溢出箱 / target 分类目标箱），写盘并热重载。
   * target + 对角区域：扫描区域内每个容器，逐个添加为独立目标箱（每箱独立绑定分类/物品，与上方一致）。
   * @param {string} id
   * @param {'source'|'overflow'|'target'} type
   * @param {object} entry {x,y,z} 或 {min:{x,y,z}, max:{x,y,z}}；target 类型可带 category
   */
  async addBoxArea(id, type, entry) {
    const bot = this.bots.get(id);
    if (!bot || !bot.store) return { ok: false, message: 'bot 的箱子配置未加载' };
    if (!['source', 'overflow', 'target'].includes(type)) {
      return { ok: false, message: 'type 必须是 source（源箱）、overflow（溢出箱）或 target（分类目标箱）' };
    }
    const key = type === 'source' ? 'sourceBoxes' : type === 'overflow' ? 'overflowBoxes' : 'targetBoxes';
    const json = JSON.parse(bot.store.rawText || JSON.stringify(bot.store.toJSON(), null, 2));
    if (!Array.isArray(json[key])) json[key] = [];
    const errors = [];
    const parsed = bot.store.constructor.parseBoxEntry(entry, key, errors);
    if (!parsed) return { ok: false, message: errors.join('；') };

    // target + 对角区域：区域内每个箱子作为独立目标箱（每箱独立物品，不是共享一份清单）
    if (type === 'target' && parsed.type === 'area') {
      if (bot.connectionState !== 'online') {
        return { ok: false, message: 'bot 未在线，无法扫描区域内容器；请先用单个坐标添加或等 bot 上线' };
      }
      const cat = (entry && entry.category) || '未分类';
      const boxes = await bot.enqueue(() => bot.scanArea(parsed.min, parsed.max));
      if (!boxes.length) return { ok: false, message: `区域 ${parsed.key} 内未发现容器（请确认 bot 已走到该区域附近）` };
      const existing = new Set();
      for (const b of json.targetBoxes) {
        const p = bot.store.constructor.parseBoxEntry(b, key, []);
        if (p) existing.add(p.key);
      }
      let added = 0;
      for (const b of boxes) {
        if (existing.has(b.key)) continue;
        json.targetBoxes.push({ x: b.x, y: b.y, z: b.z, category: cat, items: [] });
        existing.add(b.key);
        added += 1;
      }
      if (!added) return { ok: false, message: '区域内箱子的坐标已全部存在于目标分类箱配置' };
      const result = this.updateStorageConfig(id, json);
      if (result.ok) result.message = `已添加分类目标箱 ${added} 个（区域 ${parsed.key}，分类：${cat}）——物品清单请在配置中逐个填写`;
      return result;
    }

    // 去重：相同坐标 / 相同对角区域不重复添加
    const dup = json[key].some(b => {
      const p = bot.store.constructor.parseBoxEntry(b, key, []);
      return p && p.key === parsed.key;
    });
    if (dup) return { ok: false, message: `该条目已存在: ${parsed.key}` };
    // target 类型：保留 category（分类名），items 由用户后台填写
    const entryToPush = type === 'target'
      ? { ...entry, category: (entry && entry.category) || '未分类' }
      : entry;
    json[key].push(entryToPush);
    const result = this.updateStorageConfig(id, json);
    if (result.ok) {
      const label = type === 'source' ? '源箱' : type === 'overflow' ? '溢出箱' : '分类目标箱';
      result.message = `已添加${label}${parsed.type === 'area' ? '区域' : ''} ${parsed.key}${type === 'target' ? `（分类：${entryToPush.category}）` : ''}`;
    }
    return result;
  }

  /**
   * 从配置删除某个箱子 / 区域（按 key：单箱 "x,y,z"，区域 "x1,y1,z1~x2,y2,z2"）。
   */
  removeBoxEntry(id, key) {
    const bot = this.bots.get(id);
    if (!bot || !bot.store) return { ok: false, message: 'bot 的箱子配置未加载' };
    if (!key) return { ok: false, message: '缺少 key' };
    const json = JSON.parse(bot.store.rawText || JSON.stringify(bot.store.toJSON(), null, 2));
    let removed = null;
    for (const listKey of ['sourceBoxes', 'overflowBoxes', 'targetBoxes']) {
      if (!Array.isArray(json[listKey])) continue;
      for (let i = json[listKey].length - 1; i >= 0; i--) {
        const b = json[listKey][i];
        const isArea = b.type === 'area' || (b.min && b.max);
        const k = b.key || (isArea
          ? `${keyOf(Math.min(b.min.x, b.max.x), Math.min(b.min.y, b.max.y), Math.min(b.min.z, b.max.z))}~${keyOf(Math.max(b.min.x, b.max.x), Math.max(b.min.y, b.max.y), Math.max(b.min.z, b.max.z))}`
          : keyOf(Number(b.x), Number(b.y), Number(b.z)));
        if (k === key) {
          removed = { listKey, entry: b, key: k };
          json[listKey].splice(i, 1);
          break;
        }
      }
      if (removed) break;
    }
    if (!removed) return { ok: false, message: `未找到该条目: ${key}` };
    const result = this.updateStorageConfig(id, json);
    if (result.ok) {
      result.message = `已删除 ${removed.listKey} 条目 ${key}`;
    }
    return result;
  }

  // ================= 系统设置 / 盘点 / 任务列表 =================

  /** 系统设置（config/system.json） */
  getSettings() {
    return { ok: true, settings: this.settings.getJSON() };
  }

  updateSettings(patch) {
    return this.settings.update(patch);
  }

  /** 把系统设置中的「服务器连接」应用到所有 bot（写 bots.json + 重启） */
  async applyServerSettings() {
    const srv = this.settings.data.server;
    if (!srv || !srv.host || !srv.username) return { ok: false, message: '服务器连接配置不完整' };
    const json = this.readMasterConfig();
    for (const entry of json.bots) {
      entry.host = srv.host;
      entry.port = Number(srv.port) || 25565;
      entry.username = srv.username;
      entry.auth = srv.auth || 'offline';
      entry.version = srv.version || '1.21.1';
    }
    this.writeMasterConfig(json);
    for (const bot of this.bots.values()) bot.config = json.bots.find(b => b.id === bot.id) || bot.config;
    for (const bot of this.bots.values()) bot.restart();
    return { ok: true, message: `服务器连接已应用到 ${this.bots.size} 个实例并重启` };
  }

  /** 触发库存盘点（开箱识别）；放入串行队列，避免与自动入库并发开箱 */
  auditBot(id) {
    const bot = this.bots.get(id);
    if (!bot) return Promise.resolve({ ok: false, message: `bot 不存在: ${id}` });
    return bot.enqueue(() => bot.auditInventory());
  }

  /** 最近一次盘点结果 */
  getAudit(id) {
    const bot = this.bots.get(id);
    return bot ? bot.getAudit() : null;
  }

  /** 任务列表：所有 bot 的当前任务 + 历史 */
  getTasks() {
    const tasks = [];
    for (const bot of this.bots.values()) {
      if (bot.task) {
        tasks.push({
          botId: bot.id,
          type: 'reclassify',
          current: true,
          state: bot.task.state,
          stats: { ...bot.task.stats, overflowAdded: { ...(bot.task.stats.overflowAdded || {}) } }
        });
      }
      for (const h of bot.taskHistory) tasks.push({ ...h, current: false });
    }
    return tasks.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  }
}

module.exports = { BotManager };
