'use strict';

const path = require('path');
const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const vec3 = require('vec3');
const { keyOf } = require('../util/vec3util');

const { BotLogger } = require('./BotLogger');
const { ItemClassifier } = require('./ItemClassifier');
const { ConfigStore } = require('../config/ConfigStore');
const { ChestService, isContainerBlock } = require('./ChestService');
const { ReclassifyTask } = require('./ReclassifyTask');
const { normalizeMinecraftVersion } = require('../util/version');

const RECONNECT_DELAY_MS = 5000;
const RECONNECT_MAX_ATTEMPTS = 20;

/**
 * StorageBot —— 单个仓库分类 bot 实例
 *
 * 复用 MULTIBOT「BotRuntime」模式：一个实例 = 一份 botConfig（连接参数 + 独立箱子配置），
 * 多实例互不干扰，由 BotManager 统一管理。
 *
 * 职责：
 *   - 连接 Minecraft 服务器（mineflayer，加载 mineflayer-x 补丁）；
 *   - 背包自动入库（AutoStore）：背包物品按分类移入目标箱 / 溢出箱；
 *   - 任务编排：重分类任务（ReclassifyTask）、停止 / 暂停 / 恢复；
 *   - 指令处理：聊天 / whisper / Web 面板统一入口 executeCommand；
 *   - 异常处理：溢出箱满暂停、寻路失败暂停、断线自动重连。
 */

class StorageBot {
  /**
   * @param {object} botConfig config/bots.json 中单个 bot 的配置
   * @param {object} [options]
   * @param {(entry:object)=>void} [options.onLog] 日志推送回调（面板实时日志）
   * @param {(snapshot:object)=>void} [options.onStatus] 状态变化回调
   * @param {(chat:object)=>void} [options.onChat] 游戏聊天消息转发回调（面板聊天控制台）
   */
  constructor(botConfig, options = {}) {
    this.config = botConfig;
    this.id = botConfig.id;
    this.logger = new BotLogger(this.id, { listener: options.onLog });
    this.onStatus = options.onStatus || (() => {});
    this.onChat = options.onChat || (() => {});

    /** 箱子配置路径（支持绝对路径 / 相对项目根） */
    this.storageConfigPath = botConfig.storageConfig
      ? path.resolve(process.cwd(), botConfig.storageConfig)
      : null;

    // ---- 核心组件（延迟到 createBot 后按需初始化）----
    this.bot = null;
    this.classifier = null;
    this.store = null;
    this.chest = null;
    this.task = null; // ReclassifyTask 实例

    // ---- 运行状态 ----
    this.connectionState = 'idle'; // idle|connecting|online|offline
    this.paused = false; // 全局暂停（溢出箱满等）
    this.autoStore = false; // 自动入库开关
    this.reconnectAttempts = 0;
    this._queue = Promise.resolve(); // 串行任务队列
    this._storeTimer = null;
    this._storeQueued = false;
    this._shutdown = false;
    this.taskHistory = []; // 任务历史（面板任务列表）
    this.audit = null; // 最近一次库存盘点结果（开箱识别）
    this._auditing = false;
    this._idleTimer = null; // 空闲回返回点定时器（已并入统一维护定时器）
    this._sourceCheckTimer = null; // 定时翻看源箱定时器（已并入统一维护定时器）
    this._maintenanceTimer = null; // 统一维护定时器（每 60s：翻源箱 + 回返回点）
    this._maintenanceRunning = false;
    this._lastSourceCheck = 0; // 上次翻看源箱时间戳（节流）
    this._standbyCooldownUntil = 0; // 返回点失败冷却截止时间
    this._sourceChecking = false;
    this._resolvedBoxes = { sources: null, overflows: null, at: 0 }; // 区域扫描结果缓存

    // 立即加载静态组件（分类器 / 箱子配置），面板在 bot 离线时也能查看配置
    this.initStaticComponents();
  }

  /**
   * 初始化不依赖连接的组件：物品分类器 + 箱子配置。
   * spawn 后会按 bot.version 校准（版本不同则重建）。
   */
  initStaticComponents() {
    const version = normalizeMinecraftVersion(this.config.version || '1.21.1');
    let classifierRebuilt = false;
    if (!this.classifier || this.classifier.version !== version) {
      try {
        this.classifier = new ItemClassifier(version);
        classifierRebuilt = true;
      } catch (err) {
        this.logger.error(`加载 minecraft-data 失败 (version=${version}): ${err.message}`);
      }
    }

    // 分类器重建时必须连带重建 ConfigStore（其持有 classifier 引用）
    if (this.storageConfigPath && (classifierRebuilt || !this.store || this.store.filePath !== this.storageConfigPath)) {
      this.store = new ConfigStore(this.storageConfigPath, this.classifier);
    }
    if (this.store) {
      const res = this.store.reload();
      if (res.ok) {
        this.logger.info(`箱子配置加载成功: ${this.store.targetBoxes.length} 个目标箱, ${this.store.sourceBoxes.length} 个源箱`);
        for (const w of res.warnings) this.logger.warn(`配置警告: ${w}`);
      } else {
        this.logger.error(`箱子配置加载失败: ${res.error}`);
      }
    }
  }

  // ================= 生命周期 =================

  /** 启动连接 */
  start() {
    if (this.bot) return;
    this._shutdown = false;
    this.connectionState = 'connecting';
    this.emitStatus();
    this.createBot();
  }

  /** 彻底停止（不再重连） */
  async stop() {
    this._shutdown = true;
    clearTimeout(this._storeTimer);
    clearInterval(this._maintenanceTimer);
    if (this.task) this.task.cancel();
    if (this.bot) {
      this.bot.removeAllListeners();
      try { this.bot.quit('shutdown'); } catch (e) { /* ignore */ }
      this.bot = null;
    }
    this.connectionState = 'offline';
    this.logger.info('bot 已停止');
    this.emitStatus();
  }

  /** 重启（应用新的连接配置，如 host/port/username/version） */
  restart() {
    this._shutdown = false;
    this.paused = false; // 重启/重连即解除全局暂停（溢出箱满等旧状态不跨连接保留）
    clearTimeout(this._storeTimer);
    if (this.task) this.task.cancel();
    if (this.bot) {
      this.bot.removeAllListeners();
      try { this.bot.quit('restart'); } catch (e) { /* ignore */ }
      this.bot = null;
    }
    this.connectionState = 'connecting';
    this.logger.info('正在重启 bot（应用新配置）...');
    this.emitStatus();
    this.createBot();
  }

  createBot() {
    const cfg = this.config;
    // 重连/新建连接前清理旧连接遗留状态：
    // 旧连接的窗口操作可能永不结束，导致 _storeQueued 卡死、队列挂起，重连后新批次全部被跳过
    this._storeQueued = false;
    this._sourceChecking = false;
    this._maintenanceRunning = false;
    this._storeTimer = null;
    this._queue = Promise.resolve();
    if (this.task) {
      try { this.task.cancel(); } catch (e) { /* ignore */ }
      this.task = null;
    }
    // 版本归一化：26.1.2 / 26.2 -> 26.1（协议 775），1.21.11 等透传
    const version = normalizeMinecraftVersion(cfg.version);
    if (version !== cfg.version) {
      this.logger.info(`版本 ${cfg.version} 归一化为 ${version}（协议兼容）`);
    }
    this.logger.info(`正在连接 ${cfg.host}:${cfg.port} (${cfg.username}) version=${version}`);

    const bot = mineflayer.createBot({
      host: cfg.host,
      port: cfg.port || 25565,
      username: cfg.username,
      auth: cfg.auth || 'offline',
      version: version || undefined,
      hideErrors: true, // 抑制 minecraft-protocol 偶发 chunk 解压错误的大量 hex 输出（防 pty 缓冲阻塞）
      // 客户端品牌标识：Fabric 模组服要求客户端 brand 为 fabric（如 <旧服务器域名>）
      brand: cfg.brand || 'vanilla'
    });
    this.bot = bot;

    // 聊天 / whisper 指令监听（信任玩家校验）
    this.attachChatCommands(bot);

    bot.once('spawn', () => {
      this.connectionState = 'online';
      this.reconnectAttempts = 0;
      this.initComponents();
      this.logger.info(`已上线，位置 (${Math.floor(bot.entity.position.x)}, ${Math.floor(bot.entity.position.y)}, ${Math.floor(bot.entity.position.z)})`);
      this.emitStatus();
    });

    bot.on('kicked', (reason) => {
      let text = reason;
      if (reason && typeof reason === 'object') {
        text = reason.text || reason.reason || JSON.stringify(reason);
      }
      this.logger.warn(`被服务器踢出: ${text}`);
    });

    bot.on('error', (err) => {
      this.logger.error(`连接错误: ${err && err.message ? err.message : err}`);
    });

    bot.on('end', (reason) => {
      this.connectionState = 'offline';
      this.emitStatus();
      if (this._shutdown) return;
      this.logger.warn(`连接断开 (${reason || 'unknown'})，${RECONNECT_DELAY_MS / 1000}s 后重连`);
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this._shutdown) return;
    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      this.logger.error(`连续 ${RECONNECT_MAX_ATTEMPTS} 次重连失败，停止自动重连`);
      return;
    }
    this.reconnectAttempts += 1;
    setTimeout(() => {
      if (this._shutdown) return;
      this.logger.info(`第 ${this.reconnectAttempts} 次重连...`);
      this.createBot();
    }, RECONNECT_DELAY_MS);
  }

  /** 上线后初始化依赖组件（物品分类器 / 箱子配置 / 容器服务 / 任务） */
  initComponents() {
    // 版本校准：bot 实际协议版本与配置版本不同时，按 bot 实际版本重建分类器与配置
    const version = this.bot.version || this.config.version || '1.21.1';
    if (!this.classifier || this.classifier.version !== version) {
      this.config.version = version;
      this.initStaticComponents();
    } else if (this.store) {
      // 版本一致：重连后重新加载配置（文件可能已修改）
      const res = this.store.reload();
      if (res.ok) {
        this.logger.info(`箱子配置已刷新: ${this.store.targetBoxes.length} 个目标箱`);
      } else {
        this.logger.error(`箱子配置加载失败: ${res.error}`);
      }
    }

    // pathfinder 插件（寻路）
    try {
      this.bot.loadPlugin(pathfinder);
    } catch (err) {
      this.logger.error(`加载 pathfinder 插件失败: ${err.message}`);
    }

    this.chest = new ChestService(this.bot, this.logger);

    // 背包变化监听（自动入库）
    this.bot.inventory.on('updateSlot', () => this.onInventoryChanged());

    this.task = new ReclassifyTask(this);
    this.logger.info('组件初始化完成');
    // 上线后立即处理一次背包（自动入库开启时，含遗留物品）
    if (this.autoStore) this.enqueueAutoStore();
    // 启动维护定时器：空闲回返回点 + 定时翻看源投料箱
    this.startMaintenanceTimers();
  }

  // ================= 箱子区域解析（单箱 / 对角区域）=================

  /** 解析源投料箱列表（point 直接返回；area 扫描区域内所有容器） */
  async resolveSourceBoxes() {
    return this._resolveBoxes('sources', this.store ? this.store.sourceBoxes : []);
  }

  /** 解析溢出箱列表（point 直接返回；area 扫描区域内所有容器） */
  async resolveOverflowBoxes() {
    return this._resolveBoxes('overflows', this.store ? this.store.overflowBoxes : []);
  }

  /** 解析 + 区域扫描（结果缓存 60 秒，区域扫描成本高） */
  async _resolveBoxes(kind, boxes) {
    if (!boxes || !boxes.length) return [];
    if (this._resolvedBoxes[kind] && Date.now() - this._resolvedBoxes.at < 60000) {
      return this._resolvedBoxes[kind];
    }
    const list = [];
    for (const b of boxes) {
      if (b.type === 'area') {
        const found = await this.scanArea(b.min, b.max);
        list.push(...found);
      } else {
        list.push({ x: b.x, y: b.y, z: b.z, key: b.key });
      }
    }
    this._resolvedBoxes[kind] = list;
    this._resolvedBoxes.at = Date.now();
    return list;
  }

  /** 扫描立方体区域（对角坐标），返回区域内所有容器方块坐标；区域过大则跳过 */
  async scanArea(min, max) {
    const list = [];
    const dx = max.x - min.x + 1, dy = max.y - min.y + 1, dz = max.z - min.z + 1;
    if (dx * dy * dz > 10000) {
      this.logger.warn(`扫描区域过大（${dx}x${dy}x${dz} = ${dx * dy * dz} 格，上限 10000），跳过: ${min.x},${min.y},${min.z} ~ ${max.x},${max.y},${max.z}`);
      return list;
    }
    for (let x = min.x; x <= max.x; x++) {
      for (let y = min.y; y <= max.y; y++) {
        for (let z = min.z; z <= max.z; z++) {
          const block = this.bot.blockAt(vec3(x, y, z));
          if (block && this.chest && isContainerBlock(block)) {
            list.push({ x, y, z, key: keyOf(x, y, z) });
          }
        }
      }
    }
    this.logger.info(`区域扫描完成 (${min.x},${min.y},${min.z} ~ ${max.x},${max.y},${max.z})，发现 ${list.length} 个容器`);
    return list;
  }

  // ================= 定时维护（空闲返回点 / 定时翻看源箱）=================

  /**
   * 统一维护定时器（每 60 秒 tick）：
   *   1) 按 sourceCheckInterval 节流翻看源投料箱（有物品则启动重分类）；
   *   2) 空闲时回到返回点。
   * 串行执行，避免两个定时器互相打断寻路（此前 bug：goal was changed）。
   */
  startMaintenanceTimers() {
    clearInterval(this._maintenanceTimer);
    const sec = this.store ? this.store.sourceCheckInterval : 0;
    if (sec > 0) this.logger.info(`定时翻看源投料箱已启用：每 ${sec} 秒`);
    this._lastSourceCheck = 0;
    this._maintenanceTimer = setInterval(() => {
      this.maintenanceTick().catch(() => {});
    }, 60000);
  }

  /** 维护 tick：先翻源箱，再回返回点（串行） */
  async maintenanceTick() {
    if (this.connectionState !== 'online' || this.paused) return;
    if (!this.store || !this.store.parsed) return;
    if (this.task && this.task.state === 'running') return; // 任务运行中不做维护
    if (this._maintenanceRunning) return;
    this._maintenanceRunning = true;
    try {
      // 1) 定时翻看源箱（按 sourceCheckInterval 节流）
      const sec = this.store.sourceCheckInterval;
      if (sec > 0) {
        const now = Date.now();
        if (!this._lastSourceCheck || now - this._lastSourceCheck >= sec * 1000) {
          await this.checkSourceBoxes();
          this._lastSourceCheck = now;
        }
      }
      // 2) 兜底：自动入库开启但背包有残留物品（事件漏触发/上次失败）→ 立即处理；
      //    无残留则直接回返回点。放入串行队列，避免与自动入库并发抢寻路。
      await new Promise((resolve) => this.enqueue(async () => {
        try {
          if (this.autoStore && this.chest && this.chest.inventoryItems().length > 0) {
            await this.processAutoStore(); // 处理背包残留（内部会回返回点）
          } else {
            await this.goStandby();
          }
        } finally {
          resolve();
        }
      }));
    } catch (err) {
      this.logger.error(`[维护任务] 异常: ${err.message}`);
    } finally {
      this._maintenanceRunning = false;
    }
  }

  /**
   * 翻看源投料箱：逐个打开检查，任一源箱有物品则启动重分类任务处理（分类入库）。
   */
  async checkSourceBoxes() {
    if (this.connectionState !== 'online' || this.paused) return;
    if (!this.store || !this.store.parsed) return;
    if (this.task && this.task.state === 'running') return;
    if (this._sourceChecking) return;
    this._sourceChecking = true;
    try {
      const boxes = await this.resolveSourceBoxes();
      if (!boxes.length) return;
      let hasItems = false;
      // 开箱循环放入串行队列：与自动入库/重分类/盘点完全串行，
      // 避免并发寻路互相打断（此前 bug：定时源箱检查打断自动入库 -> "goal was changed"、走一半就返回）
      await new Promise((resolve) => this.enqueue(async () => {
        try {
          for (const sb of boxes) {
            let window = null;
            try {
              window = await this.chest.openContainerAt(sb);
              const total = window.containerItems().reduce((s, it) => s + it.count, 0);
              if (total > 0) {
                this.logger.info(`[定时源箱检查] 源箱 (${sb.key}) 有 ${total} 件物品`);
                hasItems = true;
                break;
              }
            } catch (err) {
              this.logger.warn(`[定时源箱检查] 源箱 (${sb.key}) 打不开，跳过: ${err.message}`);
            } finally {
              if (window) this.chest.close(window);
            }
          }
        } finally {
          resolve();
        }
      }));
      if (hasItems) {
        this.logger.info('[定时源箱检查] 检测到源箱有物品，启动批量重分类处理');
        this.task.start();
      }
    } catch (err) {
      this.logger.error(`[定时源箱检查] 异常: ${err.message}`);
    } finally {
      this._sourceChecking = false;
    }
  }

  /** 给 mineflayer 实例挂载聊天/whisper 命令监听（仅信任玩家生效）+ 聊天消息转发 */
  attachChatCommands(bot) {
    const trusted = new Set(this.config.trustedPlayers || []);
    const prefix = this.config.commandPrefix || '!';
    const handle = (username, message) => {
      // 转发所有聊天到面板（聊天控制台）
      try { this.onChat({ username, message, ts: Date.now() }); } catch (e) { /* ignore */ }
      if (!trusted.has(username)) return; // 仅信任玩家可下发指令
      if (typeof message !== 'string' || !message.startsWith(prefix)) return;
      const text = message.slice(prefix.length).trim();
      if (!text) return;
      const [cmd, ...rest] = text.split(/\s+/);
      const args = rest.join(' ').trim();
      const res = this.executeCommand(cmd, args || true);
      if (res) this.logger.info(`[指令] ${username}: ${text} -> ${res.message}`);
    };
    bot.on('chat', handle);
    bot.on('whisper', handle);
  }

  // ================= 状态 =================

  /** 面板/API 用状态快照 */
  getStatus() {
    const pos = this.bot && this.bot.entity && this.bot.entity.position
      ? { x: Math.floor(this.bot.entity.position.x), y: Math.floor(this.bot.entity.position.y), z: Math.floor(this.bot.entity.position.z) }
      : null;
    return {
      id: this.id,
      username: this.config.username,
      host: this.config.host,
      port: this.config.port,
      connectionState: this.connectionState,
      paused: this.paused,
      autoStore: this.autoStore,
      position: pos,
      gameMode: this.bot && this.bot.game ? (this.bot.game.gameMode || null) : null,
      pathfinderLoaded: !!(this.bot && this.bot.pathfinder),
      configLoaded: !!(this.store && this.store.parsed),
      task: this.task ? this.task.getStatus() : null,
      inventoryFreeSlots: this.chest ? this.chest.inventoryFreeSlotCount() : null,
      reclassifyStats: this.task ? this.task.getStats() : null,
      lastError: this.logger.history(1).find(e => e.level === 'error') || null
    };
  }

  emitStatus() {
    try { this.onStatus(this.getStatus()); } catch (e) { /* ignore */ }
  }

  // ================= 自动入库 =================

  onInventoryChanged() {
    if (!this.autoStore || this.paused || !this.store || !this.store.parsed) return;
    // 防抖：连续拾取合并为一次处理
    clearTimeout(this._storeTimer);
    this._storeTimer = setTimeout(() => this.enqueueAutoStore(), 500);
  }

  enqueueAutoStore() {
    if (this._storeQueued) return; // 队列中已有批次
    this._storeQueued = true;
    this.enqueue(async () => {
      this._storeQueued = false;
      try {
        await this.processAutoStore();
      } catch (err) {
        this.logger.error(`自动入库异常: ${err.message}`);
        this.pauseAll(`自动入库异常: ${err.message}`);
      }
    });
  }

  /**
   * 处理一批背包物品入库：
   *   1. 按目标分类箱聚合；
   *   2. 无匹配分类的物品 -> 溢出箱；
   *   3. 目标箱满 -> 剩余转入溢出箱；溢出箱满 -> 暂停全部任务。
   */
  async processAutoStore() {
    if (this.paused || !this.autoStore || !this.chest) return;
    const items = this.chest.inventoryItems();
    if (!items.length) return;

    const byTarget = new Map(); // targetKey -> { tb, entries: [{item, std}] }
    const overflowEntries = [];

    for (const it of items) {
      const std = this.classifier.itemOf(it);
      if (!std) { this.logger.debug(`无法识别物品，跳过: ${it.name || it.type}`); continue; }
      const tb = this.store.matchTargetBox(std);
      if (tb) {
        if (!byTarget.has(tb.key)) byTarget.set(tb.key, { tb, entries: [] });
        byTarget.get(tb.key).entries.push({ item: it, std });
      } else {
        overflowEntries.push({ item: it, std });
      }
    }

    // 逐目标箱：打开一次容器，放入该箱所有分类物品
    for (const { tb, entries } of byTarget.values()) {
      await this.depositToTargetBox(tb, entries);
    }

    // 溢出箱
    if (overflowEntries.length) {
      await this.depositToOverflow(overflowEntries);
    }

    // 任务进行中时由重分类任务负责统计，自动入库只输出汇总日志
    if (byTarget.size || overflowEntries.length) {
      const moved = [...byTarget.values()].reduce((s, v) => s + v.entries.length, 0);
      this.logger.info(`自动入库完成: 目标箱 ${moved} 种物品, 溢出箱 ${overflowEntries.length} 种物品`);
    }

    // 本批处理完毕：回到默认待机点（返回点）
    await this.goStandby();

    // 兜底：背包仍有残留物品（上次处理失败留下的）→ 30 秒后重试，避免一直卡住不动
    if (this.chest && this.chest.inventoryItems().length > 0) {
      clearTimeout(this._storeTimer);
      this._storeTimer = setTimeout(() => this.enqueueAutoStore(), 30000);
    }
  }

  /**
   * 回到默认待机点（返回点）。配置了 standbyPoint 且距离较远时寻路返回；
   * 失败只记录日志，不影响后续。
   */
  async goStandby() {
    const sp = this.store && this.store.standbyPoint;
    if (!sp || this.connectionState !== 'online' || !this.bot || !this.bot.entity) return;
    if (this.task && this.task.state === 'running') return; // 任务运行中不打断
    // 失败冷却：返回点持续不可达时，冷却期内不再反复尝试（防空转）
    if (this._standbyCooldownUntil && Date.now() < this._standbyCooldownUntil) return;
    const d = this.bot.entity.position.distanceTo(vec3(sp.x, sp.y, sp.z));
    if (d <= 3) return; // 已在返回点附近

    // 寻路失败自动重试：共尝试 RETRY+1 次，间隔 3 秒；全部失败才进入冷却
    const RETRY = 2;
    for (let attempt = 0; attempt <= RETRY; attempt++) {
      // 重试期间任务可能启动（如定时源箱检查触发的重分类），任务优先，放弃回点避免互相打断寻路
      if (this.task && this.task.state === 'running') return;
      this.logger.info(`返回待机点 (${sp.x},${sp.y},${sp.z})（距离 ${d.toFixed(1)} 格，第 ${attempt + 1} 次尝试）...`);
      try {
        await this.chest.goto(sp);
        this.logger.info('已回到待机点');
        this._standbyCooldownUntil = 0;
        return;
      } catch (err) {
        if (attempt < RETRY) {
          this.logger.warn(`返回待机点失败（第 ${attempt + 1} 次），3 秒后重试: ${err.message}`);
          await new Promise(resolve => setTimeout(resolve, 3000));
        } else {
          this.logger.warn(`返回待机点失败（已重试 ${RETRY + 1} 次）: ${err.message}`);
          // 失败后 60 秒内不重复尝试（维护周期本身为 60 秒，避免连续空转）
          this._standbyCooldownUntil = Date.now() + 60 * 1000;
        }
      }
    }
  }

  /** 存入目标箱：满了的物品转溢出箱；单个箱子失败只记录日志（不暂停全局），物品留在背包下次重试 */
  async depositToTargetBox(tb, entries) {
    this.logger.info(`入库 -> 目标箱 (${tb.x},${tb.y},${tb.z}) [${tb.category}]`);
    let window = null;
    try {
      window = await this.chest.openContainerAt(tb);
      const stillOpen = [];
      for (const { item, std } of entries) {
        const moved = await this.chest.put(window, std, item.count);
        if (moved >= item.count) {
          this.logger.info(`  ${std.zhName} x${moved} 移入目标箱 (${tb.key})`);
        } else {
          const remaining = item.count - moved;
          if (moved > 0) this.logger.info(`  ${std.zhName} x${moved} 移入目标箱，剩余 ${remaining}（箱子已满）`);
          this.logger.warn(`目标箱 ${tb.key} [${tb.category}] 已满，${std.zhName} x${remaining} 转溢出箱`);
          stillOpen.push({ item: { ...item, count: remaining }, std });
        }
      }
      if (stillOpen.length) {
        await this.depositToOverflow(stillOpen);
      }
    } catch (err) {
      // 寻路失败 / 打不开 / 目标箱不存在：记录错误，物品留在背包，不暂停全局
      const names = entries.map(e => `${e.std.zhName} x${e.item.count}`).join('、');
      this.logger.error(`目标箱 (${tb.key}) [${tb.category}] 处理失败（物品 ${names} 暂留背包）: ${err.message}`);
    } finally {
      if (window) this.chest.close(window);
    }
  }

  /** 存入溢出箱：按配置顺序尝试，存满自动换下一个；全部溢出箱满则暂停全部任务 */
  async depositToOverflow(entries) {
    const boxes = await this.resolveOverflowBoxes();
    if (!boxes.length) {
      this.logger.error('未配置溢出箱，物品无处存放');
      this.pauseAll('未配置溢出箱');
      return;
    }
    // 剩余待存物品，逐个溢出箱尝试
    let remaining = [...entries];
    let openedAny = false; // 是否至少成功打开过一个溢出箱（用于区分"满了"与"全部打不开"）
    for (const ob of boxes) {
      if (!remaining.length) break;
      this.logger.info(`入库 -> 溢出箱 (${ob.x},${ob.y},${ob.z})`);
      let window = null;
      try {
        window = await this.chest.openContainerAt(ob);
        openedAny = true;
        const next = [];
        for (const { item, std } of remaining) {
          const moved = await this.chest.put(window, std, item.count);
          if (moved > 0) this.logger.info(`  ${std.zhName} x${moved} 移入溢出箱 (${ob.key})`);
          if (moved < item.count) {
            this.logger.warn(`溢出箱 (${ob.key}) 已满，${std.zhName} x${item.count - moved} 尝试下一个溢出箱`);
            next.push({ item: { ...item, count: item.count - moved }, std });
          }
        }
        remaining = next;
      } catch (err) {
        // 单个溢出箱打不开/寻路失败：记录并继续尝试下一个，不暂停全局
        this.logger.error(`溢出箱 (${ob.key}) 处理失败（尝试下一个）: ${err.message}`);
        continue;
      } finally {
        if (window) this.chest.close(window);
      }
    }
    if (remaining.length) {
      if (openedAny) {
        // 箱子能打开但容量不足：真满，暂停等人工
        const names = remaining.map(r => `${r.std.zhName} x${r.item.count}`).join('、');
        this.logger.error(`所有溢出箱已满！无法存放: ${names}。暂停全部任务，请人工处理溢出箱`);
        this.pauseAll('溢出箱已满，等待人工处理');
      } else {
        // 所有溢出箱都打不开（位置错误/被阻挡等）：只记录，不暂停，物品留背包
        const names = remaining.map(r => `${r.std.zhName} x${r.item.count}`).join('、');
        this.logger.error(`溢出箱全部无法打开（请检查坐标），物品暂留背包: ${names}`);
      }
    }
  }

  // ================= 串行队列 =================

  /** 串行执行异步任务，避免并发开箱冲突 */
  enqueue(fn) {
    this._queue = this._queue.then(() => fn()).catch(() => {});
    return this._queue;
  }

  // ================= 指令入口 =================

  /**
   * 统一指令入口（聊天命令 / Web 面板共用）。
   * @param {string} cmd 指令名
   * @param {*} args 参数
   * @returns {{ok:boolean, message:string}}
   */
  executeCommand(cmd, args) {
    const c = String(cmd).toLowerCase();
    switch (c) {
      case 'store':
      case 'autostore': {
        const on = args === true || args === 'on' || args === '1';
        this.setAutoStore(on);
        return { ok: true, message: `自动入库已${on ? '开启' : '关闭'}` };
      }
      case 'reclassify':
      case 'startreclassify': {
        if (this.connectionState !== 'online') return { ok: false, message: 'bot 未在线' };
        if (!this.store || !this.store.parsed) return { ok: false, message: '箱子配置未加载' };
        this.startReclassify();
        return { ok: true, message: '已触发批量重分类任务' };
      }
      case 'stop':
      case 'stoptask': {
        this.stopTask();
        return { ok: true, message: '已停止当前任务' };
      }
      case 'pause':
      case 'pausetask': {
        this.pauseTask();
        return { ok: true, message: '已暂停当前任务' };
      }
      case 'resume':
      case 'resumetask':
      case 'unpause': {
        // 解除全局暂停（溢出箱满等触发的 paused）并恢复任务；
        // 原实现只 task.resume()，不解除 owner.paused，导致暂停后 bot 永久不动
        if (this.paused) {
          this.unpauseAll();
          return { ok: true, message: '已解除全局暂停并恢复任务' };
        }
        this.resumeTask();
        return { ok: true, message: '已恢复当前任务' };
      }
      case 'reload': {
        return this.reloadConfig();
      }
      case 'status': {
        return { ok: true, message: JSON.stringify(this.getStatus(), null, 2) };
      }
      case 'chat': {
        // 面板聊天控制台：让 bot 在游戏内发出一条聊天消息
        if (this.connectionState !== 'online' || !this.bot) {
          return { ok: false, message: 'bot 未在线' };
        }
        const text = String(args == null ? '' : args).trim();
        if (!text) return { ok: false, message: '聊天内容为空' };
        try {
          this.bot.chat(text);
          this.logger.info(`[聊天] bot 发言: ${text}`);
          return { ok: true, message: `已发送: ${text}` };
        } catch (err) {
          return { ok: false, message: `发送失败: ${err.message}` };
        }
      }
      case 'diagblock': {
        // 调试：查看指定坐标及周边方块的读取情况（排查开箱失败）
        if (this.connectionState !== 'online' || !this.bot) {
          return { ok: false, message: 'bot 未在线' };
        }
        const parts = String(args == null ? '' : args).split(/[,，\s]+/).map(Number);
        const [x, y, z] = parts;
        if (![x, y, z].every(Number.isFinite)) {
          return { ok: false, message: '用法: diagblock x y z' };
        }
        const pos = this.bot.entity.position;
        this.logger.info(`[diag] bot 位置 (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}) 目标 (${x},${y},${z})`);
        for (let dy = -2; dy <= 2; dy++) {
          const b = this.bot.blockAt(vec3(x, y + dy, z));
          this.logger.info(`[diag] (${x},${y + dy},${z}) -> ${b ? `${b.name} (boundingBox=${b.boundingBox})` : 'null'}`);
        }
        return { ok: true, message: 'diagblock 已输出到日志' };
      }
      case 'diagmove': {
        // 调试：输出运动状态（位置/速度/落地/效果/游戏模式），排查"起飞无重力"
        if (!this.bot || !this.bot.entity) return { ok: false, message: 'bot 未在线' };
        const e = this.bot.entity;
        const eff = e.effects || {};
        const effStr = Object.entries(eff)
          .map(([k, v]) => `${k}(amp=${v ? v.amplifier : '?'})`)
          .join(', ') || '无';
        this.logger.info(`[diagmove] pos=(${e.position.x.toFixed(2)}, ${e.position.y.toFixed(2)}, ${e.position.z.toFixed(2)}) ` +
          `vel=(${(e.velocity ? e.velocity.x : 0).toFixed(2)}, ${(e.velocity ? e.velocity.y : 0).toFixed(2)}, ${(e.velocity ? e.velocity.z : 0).toFixed(2)}) ` +
          `onGround=${e.onGround} gameMode=${this.bot.game ? this.bot.game.gameMode : '?'} flying=${e.isFlying || false} fallFlying=${e.fallFlying || false} ` +
          `minY=${this.bot.game ? this.bot.game.minY : '?'} height=${this.bot.game ? this.bot.game.height : '?'} ` +
          `effects=[${effStr}]`);
        // 脚下方块
        const under = this.bot.blockAt(vec3(Math.floor(e.position.x), Math.floor(e.position.y - 1), Math.floor(e.position.z)));
        this.logger.info(`[diagmove] 脚下方块: ${under ? `${under.name} (${under.boundingBox})` : 'null'} 站在格内 y=${e.position.y % 1 !== 0 ? '悬浮(非整数)' : '整数'}`);
        return { ok: true, message: 'diagmove 已输出到日志' };
      }
      case 'gototest': {
        // 调试：让 bot 寻路到指定坐标（排查半砖/楼梯寻路）
        if (this.connectionState !== 'online' || !this.bot) return { ok: false, message: 'bot 未在线' };
        const [x, y, z] = String(args == null ? '' : args).split(/[,，\s]+/).map(Number);
        if (![x, y, z].every(Number.isFinite)) return { ok: false, message: '用法: gototest x y z' };
        this.logger.info(`[gototest] 开始寻路到 (${x},${y},${z})，当前 (${this.bot.entity.position.x.toFixed(1)}, ${this.bot.entity.position.y.toFixed(1)}, ${this.bot.entity.position.z.toFixed(1)})`);
        this.enqueue(async () => {
          try {
            await this.chest.goto({ x, y, z });
            this.logger.info('[gototest] 寻路成功到达');
          } catch (err) {
            this.logger.error(`[gototest] 寻路失败: ${err.message}`);
          }
        });
        return { ok: true, message: 'gototest 已开始（结果见日志）' };
      }
      default:
        return { ok: false, message: `未知指令: ${cmd}` };
    }
  }

  // ---------- 指令实现 ----------

  setAutoStore(on) {
    this.autoStore = !!on;
    this.logger.info(`自动入库 ${this.autoStore ? '开启' : '关闭'}`);
    // 开启后立即处理一次背包（含遗留物品）；chest 需已初始化（spawn 后）
    if (this.autoStore && this.chest) this.enqueueAutoStore();
    this.emitStatus();
  }

  startReclassify() {
    if (this.task) this.task.start();
  }

  stopTask() {
    if (this.task) this.task.cancel();
  }

  pauseTask() {
    if (this.task) this.task.pause();
  }

  resumeTask() {
    if (this.task) this.task.resume();
  }

  reloadConfig() {
    if (!this.store) return { ok: false, message: '箱子配置未加载' };
    const res = this.store.reload();
    if (res.ok) {
      this.logger.info(`配置已重载: ${this.store.targetBoxes.length} 个目标箱, ${this.store.sourceBoxes.length} 个源箱`);
      if (this.bot) this.startMaintenanceTimers(); // 按新配置重启定时器
      this.emitStatus();
      return { ok: true, message: '配置重载成功' };
    }
    this.logger.error(`配置重载失败: ${res.error}`);
    return { ok: false, message: `配置重载失败: ${res.error}` };
  }

  /** 全局暂停（溢出箱满 / 自动入库异常） */
  pauseAll(reason) {
    this.paused = true;
    if (this.task) this.task.pause();
    this.logger.error(`[暂停] ${reason}`);
    this.emitStatus();
  }

  /** 解除全局暂停 */
  unpauseAll() {
    this.paused = false;
    if (this.task) this.task.resume();
    this.logger.info('已解除全局暂停');
    this.emitStatus();
  }

  // ================= 任务历史 / 库存盘点 =================

  /** 重分类任务结束时记录一条历史（面板任务列表用） */
  recordTaskHistory() {
    if (!this.task) return;
    const s = this.task.stats;
    this.taskHistory.unshift({
      botId: this.id,
      type: 'reclassify',
      state: this.task.state,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt || Date.now(),
      processedCount: s.processedCount || 0,
      sourceTotal: s.sourceTotal || 0,
      overflowAdded: { ...(s.overflowAdded || {}) }
    });
    if (this.taskHistory.length > 50) this.taskHistory.pop();
  }

  /** 库存盘点（开箱识别）：遍历源箱 / 目标箱 / 溢出箱，逐个打开统计物品 */
  async auditInventory() {
    if (this.connectionState !== 'online') return { ok: false, message: 'bot 未在线' };
    if (!this.store || !this.store.parsed) return { ok: false, message: '箱子配置未加载' };
    if (this._auditing) return { ok: false, message: '盘点进行中，请稍候' };

    this._auditing = true;
    this.logger.info('开始库存盘点（开箱识别）...');
    const srcBoxes = await this.resolveSourceBoxes();
    const ovfBoxes = await this.resolveOverflowBoxes();
    const scanList = [
      ...srcBoxes.map(sb => ({ ...sb, category: '源箱' })),
      ...this.store.targetBoxes.map(tb => ({ ...tb, category: `目标箱·${tb.category}` })),
      ...ovfBoxes.map(ob => ({ ...ob, category: '溢出箱' }))
    ];
    const result = { botId: this.id, startedAt: Date.now(), finishedAt: null, boxes: [], summary: null };
    const byItem = new Map(); // name -> { zhName, count } 全局物品聚合
    try {
      for (const b of scanList) {
        if (this._shutdown) break;
        let window = null;
        try {
          window = await this.chest.openContainerAt(b);
          const items = window.containerItems().map(it => {
            const std = this.classifier.itemOf({ type: it.type, name: it.name });
            return { name: it.name, zhName: std ? std.zhName : it.name, count: it.count };
          });
          // 每箱汇总：总件数 + 种类数
          const box = {
            key: b.key, x: b.x, y: b.y, z: b.z, category: b.category,
            items,
            totalCount: items.reduce((s, i) => s + i.count, 0),
            totalKinds: items.length
          };
          // 全局聚合：所有箱子按物品合并
          for (const it of items) {
            const e = byItem.get(it.name) || { zhName: it.zhName, count: 0 };
            e.count += it.count;
            byItem.set(it.name, e);
          }
          result.boxes.push(box);
          this.logger.info(`盘点 (${b.key}) [${b.category}]：${box.totalCount} 件 / ${box.totalKinds} 种`);
        } catch (err) {
          this.logger.warn(`盘点 (${b.key}) 失败：${err.message}`);
          result.boxes.push({ key: b.key, x: b.x, y: b.y, z: b.z, category: b.category, items: [], totalCount: 0, totalKinds: 0, error: err.message });
        } finally {
          if (window) this.chest.close(window);
        }
      }
      result.finishedAt = Date.now();
      // 全局总和：总件数 / 总种类 / 按物品聚合（倒序）
      const summaryItems = [...byItem.entries()]
        .map(([name, v]) => ({ name, zhName: v.zhName, count: v.count }))
        .sort((a, b) => b.count - a.count);
      result.summary = {
        totalCount: summaryItems.reduce((s, i) => s + i.count, 0),
        totalKinds: summaryItems.length,
        items: summaryItems
      };
      this.audit = result;
      this.logger.info(`库存盘点完成：共 ${result.boxes.length} 个箱子，合计 ${result.summary.totalCount} 件 / ${result.summary.totalKinds} 种物品`);
      // 盘点结束：回到默认挂机点（返回点）
      await this.goStandby();
      return { ok: true, message: '库存盘点完成', audit: result };
    } finally {
      this._auditing = false;
    }
  }

  getAudit() {
    return this.audit;
  }
}

module.exports = { StorageBot };
