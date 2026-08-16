'use strict';

/**
 * ReclassifyTask —— 批量重分类任务（重点）
 *
 * 严格按需求第 2 节实现（分批处理，禁止一次性取出源箱子全部物品）：
 *   ① 遍历每一个【源投料箱子】；
 *   ② 走到源箱子，打开容器，仅取出 batch_size 数量物品到 bot 背包；
 *   ③ 关闭源箱子；
 *   ④ 遍历背包这批物品：
 *        物品匹配目标分类箱且有空位 -> 存入对应目标箱；
 *        无匹配分类 / 目标箱已满 -> 存入溢出箱；
 *   ⑤ 背包全部物品处理完毕后，回到源投料箱子；
 *   ⑥ 循环 ②-⑤ 反复分批取物处理，直到当前源箱清空，再切换下一个源箱；
 *   ⑦ 输出任务日志：当前源箱 / 已处理数量 / 剩余待处理数量 / 溢出箱新增物品统计。
 *
 * 异常处理（需求第 3 节）：
 *   - 溢出箱也存满：暂停全部任务 + 警告日志，等待人工处理，不继续取新物品；
 *   - 寻路失败 / 箱子被遮挡 / 无法打开容器：错误日志 + 暂停当前任务；
 *   - bot 背包接近满载：停止从源箱取物，优先处理完背包现有物品。
 *
 * 状态机：idle -> running -> finished / paused / error ->（resume/cancel）
 */

class ReclassifyTask {
  /**
   * @param {import('./StorageBot').StorageBot} owner 所属 StorageBot（提供 bot/chest/classifier/store/logger）
   */
  constructor(owner) {
    this.owner = owner;
    this.state = 'idle'; // idle | running | paused | finished | error
    this._cancelled = false;
    this._paused = false;
    this._resumeWaiters = [];
    this._runPromise = null;
    this.stats = this._emptyStats();
  }

  _emptyStats() {
    return {
      currentSource: null,      // 当前源箱 {x,y,z,key}
      sourceIndex: 0,           // 源箱下标（从 1 计）
      sourceTotal: 0,           // 源箱总数
      processedCount: 0,        // 已从源箱取出的物品总数
      currentSourceRemaining: 0,// 当前源箱剩余物品数量
      batchIndex: 0,            // 已完成的批次
      overflowAdded: {},        // 溢出箱新增统计 { itemName: count }
      startedAt: null,
      finishedAt: null
    };
  }

  // ================= 状态查询 =================

  getStatus() {
    return { state: this.state, stats: this.stats };
  }

  getStats() {
    return this.stats;
  }

  // ================= 控制指令 =================

  /** 启动任务（幂等：运行/暂停中忽略） */
  start() {
    if (this.state === 'running' || this.state === 'paused') {
      return { ok: false, message: `任务已在 ${this.state} 状态` };
    }
    if (this.owner.connectionState !== 'online') {
      return { ok: false, message: 'bot 未在线' };
    }
    if (!this.owner.store || !this.owner.store.parsed) {
      return { ok: false, message: '箱子配置未加载' };
    }
    if (this.owner.store.sourceBoxes.length === 0) {
      return { ok: false, message: '未配置源投料箱子' };
    }
    this._cancelled = false;
    this._paused = false;
    this.stats = this._emptyStats();
    this.stats.startedAt = Date.now();
    this.stats.sourceTotal = this.owner.store.sourceBoxes.length;
    this.state = 'running';
    // 任务放入 owner 串行队列执行：与自动入库/盘点等容器操作完全串行，避免并发开窗互相打断寻路
    this._runPromise = this.owner.enqueue(() => this._run());
    return { ok: true, message: '批量重分类任务已启动' };
  }

  /** 停止任务 */
  cancel() {
    this._cancelled = true;
    this._wake();
    return { ok: true, message: '已请求停止任务' };
  }

  /** 暂停任务（下一批检查点生效） */
  pause() {
    if (this.state !== 'running') return;
    this._paused = true;
    this.owner.logger.warn('[重分类] 任务已暂停');
  }

  /** 恢复任务：若因异常暂停则重新拉起运行循环 */
  resume() {
    this._paused = false;
    this._wake();
    if (this.state === 'paused') {
      this.state = 'running';
      // 同样放入串行队列，避免与自动入库并发
      this._runPromise = this.owner.enqueue(() => this._run());
      this.owner.logger.info('[重分类] 任务已恢复');
    }
  }

  _wake() {
    const waiters = this._resumeWaiters;
    this._resumeWaiters = [];
    for (const fn of waiters) fn();
  }

  /** 任务循环内的检查点：处理取消 / 暂停 / 全局暂停 */
  async _checkpoint() {
    if (this._cancelled) throw Object.assign(new Error('任务已取消'), { code: 'CANCELLED' });
    while (this._paused || this.owner.paused) {
      await new Promise(resolve => this._resumeWaiters.push(resolve));
    }
  }

  // ================= 主流程 =================

  async _run() {
    const owner = this.owner;
    const logger = owner.logger;

    // 重分类期间关闭自动入库，避免两者抢开容器；结束后恢复原开关
    const prevAutoStore = owner.autoStore;
    owner.autoStore = false;

    try {
      logger.info('==== 批量重分类任务开始 ====');
      // 先清空背包现有物品，保证后续每批取出量可精确统计
      await this._processInventoryBatch();

      let finished = false;
      while (!finished) {
        await this._checkpoint();
        finished = await this._stepBatch();
      }

      this.state = 'finished';
      logger.info(`==== 重分类任务完成：共处理 ${this.stats.processedCount} 件物品 ====`);
    } catch (err) {
      if (err && err.code === 'CANCELLED') {
        this.state = 'idle';
        logger.info('[重分类] 任务已停止');
      } else if (err && err.code === 'OVERFLOW_FULL') {
        this.state = 'paused'; // 已由 depositToOverflow 触发全局暂停并输出警告
      } else {
        this.state = 'paused';
        logger.error(`[重分类] 任务异常，已暂停：${err && err.message ? err.message : err}`);
      }
    } finally {
      owner.autoStore = prevAutoStore;
      this.stats.finishedAt = Date.now();
      if (typeof owner.recordTaskHistory === 'function') owner.recordTaskHistory();
      // 任务结束（完成 / 异常 / 取消）后回到默认待机点；手动暂停（paused）时留在原地
      if (this.state !== 'paused' && typeof owner.goStandby === 'function') {
        owner.goStandby().catch(() => {});
      }
      owner.emitStatus();
    }
  }

  /**
   * 推进一个批次：
   *   - 源箱已清空 -> 切换到下一个源箱；全部完成返回 true；
   *   - 否则取出 batch_size 物品 -> 处理背包 -> 返回 false（继续下一批）。
   */
  async _stepBatch() {
    const owner = this.owner;
    const chest = owner.chest;
    const store = owner.store;
    const logger = owner.logger;

    // —— 背包接近满载：不取新物品，先处理背包现有物品 ——
    const freeSlots = chest.inventoryFreeSlotCount();
    if (freeSlots <= store.freeSlotThreshold) {
      logger.warn(`[重分类] 背包接近满载（空位 ${freeSlots}），暂停从源箱取物，先处理背包物品`);
      await this._processInventoryBatch();
      return false;
    }

    // —— 定位当前源箱（区域会展开为多个容器）——
    const boxes = await owner.resolveSourceBoxes();
    if (!boxes.length) return true; // 无源箱，直接完成
    if (this.stats.currentSource === null) {
      this.stats.currentSource = boxes[0];
      this.stats.sourceIndex = 1;
      this.stats.sourceTotal = boxes.length;
    }
    const sb = this.stats.currentSource;
    logger.info(`[重分类] 处理源投料箱 ${this.stats.sourceIndex}/${boxes.length} (${sb.x},${sb.y},${sb.z})`);

    // —— ② 走到源箱，打开容器 ——
    let window = null;
    try {
      window = await chest.openContainerAt(sb);
      const items = window.containerItems();
      const remaining = items.reduce((s, it) => s + it.count, 0);
      this.stats.currentSourceRemaining = remaining;

      if (remaining <= 0) {
        // 当前源箱清空 -> 切换到下一个源箱
        chest.close(window);
        window = null;
        logger.info(`[重分类] 源箱 (${sb.key}) 已清空`);
        if (this.stats.sourceIndex >= boxes.length) {
          this.stats.currentSource = null;
          return true; // 全部源箱处理完毕
        }
        this.stats.currentSource = boxes[this.stats.sourceIndex];
        this.stats.sourceIndex += 1;
        return false;
      }

      // —— 规划本批取物：背包拿满再走（配额 = 背包空位 × 64，至少 batchSize；物品种类不超过背包空位）——
      const quota = Math.max(store.batchSize, freeSlots * 64);
      const plan = this._planBatch(items, quota, Math.max(1, freeSlots - 1));
      if (plan.length === 0) {
        logger.error(`[重分类] 无法规划取物（背包空位不足）`);
        throw Object.assign(new Error('背包空间不足'), { code: 'INV_FULL' });
      }
      let taken = 0;
      for (const p of plan) {
        await window.withdraw(p.type, p.metadata, p.count);
        taken += p.count;
      }
      this.stats.processedCount += taken;
      logger.info(`[重分类] 从源箱取出 ${taken} 件 (第 ${this.stats.batchIndex + 1} 批)，源箱剩余 ${remaining - taken} 件`);
      this.stats.currentSourceRemaining = remaining - taken;
    } catch (err) {
      // 寻路失败 / 箱子被遮挡 / 无法打开容器 / 取物失败：暂停当前任务
      if (err && err.code === 'CANCELLED') throw err;
      logger.error(`[重分类] 源箱 (${sb.key}) 操作失败：${err.message}`);
      throw Object.assign(new Error(`源箱操作失败: ${err.message}`), { code: err.code || 'SOURCE_FAIL' });
    } finally {
      if (window) chest.close(window);
    }

    // —— ④⑤ 关闭源箱后处理背包本批物品，全部处理完回到源箱（下一轮循环 goto）——
    await this._processInventoryBatch();
    this.stats.batchIndex += 1;
    this._logProgress();
    return false;
  }

  /** 规划一批取物：按容器内物品顺序，累计到 batch_size，种类受背包空位限制 */
  _planBatch(containerItems, batchSize, maxKinds) {
    let remaining = batchSize;
    let kinds = 0;
    const plan = [];
    for (const it of containerItems) {
      if (remaining <= 0) break;
      if (kinds >= maxKinds) break; // 预留背包槽位
      const take = Math.min(it.count, remaining);
      if (take > 0) {
        plan.push({ type: it.type, metadata: it.metadata || 0, name: it.name, count: take });
        remaining -= take;
        kinds += 1;
      }
    }
    return plan;
  }

  // ================= 背包物品分类入库 =================

  /** 处理背包全部物品：匹配目标箱 -> 存入；无匹配/目标箱满 -> 溢出箱 */
  async _processInventoryBatch() {
    const owner = this.owner;
    await this._checkpoint();
    const items = owner.chest.inventoryItems();
    if (!items.length) return;

    const byTarget = new Map(); // targetKey -> { tb, entries:[{item,std}] }
    const overflowEntries = [];

    for (const it of items) {
      const std = owner.classifier.itemOf(it);
      if (!std) {
        owner.logger.debug(`无法识别物品，跳过: ${it.name || it.type}`);
        continue;
      }
      const tb = owner.store.matchTargetBox(std);
      if (tb) {
        if (!byTarget.has(tb.key)) byTarget.set(tb.key, { tb, entries: [] });
        byTarget.get(tb.key).entries.push({ item: it, std });
      } else {
        overflowEntries.push({ item: it, std });
      }
    }

    // 目标箱：一次开箱放入该箱全部匹配物品
    for (const { tb, entries } of byTarget.values()) {
      await this._checkpoint();
      await this._depositToTargetBox(tb, entries);
    }

    // 溢出箱
    if (overflowEntries.length) {
      await this._checkpoint();
      await this._depositToOverflow(overflowEntries);
    }
  }

  /** 存入目标箱；满了的剩余物品转溢出箱 */
  async _depositToTargetBox(tb, entries) {
    const owner = this.owner;
    const logger = owner.logger;
    let window = null;
    try {
      window = await owner.chest.openContainerAt(tb);
      const toOverflow = [];
      for (const { item, std } of entries) {
        const moved = await owner.chest.put(window, std, item.count);
        if (moved > 0) {
          logger.info(`[重分类] ${std.zhName} x${moved} -> 目标箱 (${tb.key}) [${tb.category}]`);
        }
        if (moved < item.count) {
          const left = item.count - moved;
          logger.warn(`[重分类] 目标箱 (${tb.key}) [${tb.category}] 已满，${std.zhName} x${left} 转溢出箱`);
          toOverflow.push({ item: { ...item, count: left }, std });
        }
      }
      if (toOverflow.length) {
        await this._depositToOverflow(toOverflow);
      }
    } finally {
      if (window) owner.chest.close(window);
    }
  }

  /** 存入溢出箱并统计新增；按顺序尝试多个溢出箱，全部满 -> 暂停全部任务 */
  async _depositToOverflow(entries) {
    const owner = this.owner;
    const logger = owner.logger;
    const boxes = await owner.resolveOverflowBoxes();
    if (!boxes.length) {
      owner.pauseAll('未配置溢出箱，重分类任务无法继续');
      throw Object.assign(new Error('未配置溢出箱'), { code: 'NO_OVERFLOW' });
    }
    let remaining = [...entries];
    for (const ob of boxes) {
      if (!remaining.length) break;
      let window = null;
      try {
        window = await owner.chest.openContainerAt(ob);
        const next = [];
        for (const { item, std } of remaining) {
          const moved = await owner.chest.put(window, std, item.count);
          if (moved > 0) {
            this.stats.overflowAdded[std.name] = (this.stats.overflowAdded[std.name] || 0) + moved;
            logger.info(`[重分类] ${std.zhName} x${moved} -> 溢出箱 (${ob.key})`);
          }
          if (moved < item.count) {
            logger.warn(`[重分类] 溢出箱 (${ob.key}) 已满，${std.zhName} x${item.count - moved} 尝试下一个溢出箱`);
            next.push({ item: { ...item, count: item.count - moved }, std });
          }
        }
        remaining = next;
      } finally {
        if (window) owner.chest.close(window);
      }
    }
    if (remaining.length) {
      // 所有溢出箱都存满：暂停全部任务，等待人工处理，不继续取新物品
      const names = remaining.map(r => `${r.std.zhName} x${r.item.count}`).join('、');
      logger.error(`[重分类] 所有溢出箱已满！无法存放: ${names}。暂停全部任务，请人工处理溢出箱`);
      owner.pauseAll('溢出箱已满，等待人工处理');
      throw Object.assign(new Error('所有溢出箱已满'), { code: 'OVERFLOW_FULL' });
    }
  }

  // ================= 日志（需求⑦） =================

  _logProgress() {
    const s = this.stats;
    const zh = (name) => this.owner.classifier.nameToZh(name);
    const overflow = Object.entries(s.overflowAdded)
      .filter(([, c]) => c > 0)
      .map(([n, c]) => `${zh(n)} x${c}`)
      .join(', ') || '无';
    this.owner.logger.info(
      `[重分类] 源箱 (${s.currentSource.key})：已处理 ${s.processedCount} 件，源箱剩余 ${s.currentSourceRemaining} 件，溢出箱新增：${overflow}`
    );
  }
}

module.exports = { ReclassifyTask };
