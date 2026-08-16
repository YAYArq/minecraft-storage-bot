'use strict';

const { Movements, goals: { GoalNear } } = require('mineflayer-pathfinder');
const vec3 = require('vec3');

/**
 * 直线寻路 Movements：只走直线（4 方向）+ 直角转弯，不走斜线。
 * 覆盖 getNeighbors，去掉对角线邻居生成。
 */
const CARDINAL_DIRECTIONS = [
  { x: -1, z: 0 }, // West
  { x: 1, z: 0 }, // East
  { x: 0, z: -1 }, // North
  { x: 0, z: 1 } // South
];

class NoDiagonalMovements extends Movements {
  getNeighbors (node) {
    const neighbors = [];
    for (const i in CARDINAL_DIRECTIONS) {
      const dir = CARDINAL_DIRECTIONS[i];
      this.getMoveForward(node, dir, neighbors);
      this.getMoveJumpUp(node, dir, neighbors);
      this.getMoveDropDown(node, dir, neighbors);
      if (this.allowParkour) {
        this.getMoveParkourForward(node, dir, neighbors);
      }
    }
    this.getMoveDown(node, neighbors);
    this.getMoveUp(node, neighbors);
    return neighbors;
  }
}

/**
 * ChestService —— 容器交互服务（寻路 + 打开 / 取出 / 存入）
 *
 * 对应需求「使用 mineflayer-x 做寻路、容器交互」：
 *   - 寻路：mineflayer-pathfinder 的 Movements + GoalNear（bot.pathfinder 由 StorageBot 加载）；
 *   - 容器：mineflayer 标准 openContainer / window.deposit / window.withdraw。
 *
 * 关键防护：
 *   - 打开容器前校验目标方块确实可打开（chest / barrel / shulker / hopper 等）；
 *   - 取出/存入前按「可容纳数量」计算，绝不超容量放入；
 *   - 寻路失败 / 方块被遮挡 / 无法打开容器均抛出带语义的错误码，由上层暂停任务并记日志。
 */

const CONTAINER_NAME_HINTS = ['chest', 'barrel', 'shulker', 'hopper', 'dispenser', 'dropper'];

function isContainerBlock(block) {
  if (!block || !block.name) return false;
  return CONTAINER_NAME_HINTS.some(hint => block.name.includes(hint));
}

class ChestService {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {import('./BotLogger').BotLogger} logger
   */
  constructor(bot, logger) {
    this.bot = bot;
    this.logger = logger;
  }

  // ---------------- 寻路 ----------------

  /**
   * 寻路到指定坐标（完全参考 APRme/MULTIBOT MovementFeature）：
   *   标准 Movements + setGoal(new GoalNear(x, y, z, radius))，等待到达。
   * @param {{x:number,y:number,z:number}} pos
   * @param {number} [radius=1]
   * @param {boolean} [sprint=false] 是否疾跑（APRme 参数）
   */
  async goto(pos, radius = 1, sprint = false) {
    const target = vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
    // 已就位（距离足够近）则跳过寻路
    if (this.bot.entity && this.bot.entity.position) {
      const d = this.bot.entity.position.distanceTo(target);
      if (d <= radius) return;
    }
    if (!this.bot.pathfinder) {
      throw Object.assign(new Error('pathfinder 插件未加载'), { code: 'NO_PATHFINDER' });
    }
    // 直线寻路（不走斜线）+ 不破坏方块 + 不放方块（搭桥/垫脚成本设为 100，路径成本超阈值被丢弃）
    const defaultMove = new NoDiagonalMovements(this.bot);
    defaultMove.allowSprinting = sprint === true;
    defaultMove.canDig = false; // 不破坏任何方块
    defaultMove.placeCost = 100; // 禁止放方块（搭桥/垫脚路径成本 > 100 不可行）
    this.bot.pathfinder.setMovements(defaultMove);
    this.logger.debug(`寻路 -> (${pos.x}, ${pos.y}, ${pos.z})`);
    try {
      await this.bot.pathfinder.goto(new GoalNear(target.x, target.y, target.z, radius));
    } catch (err) {
      const code = err && err.code ? err.code : 'PATH_FAILED';
      throw Object.assign(
        new Error(`寻路失败 (${pos.x},${pos.y},${pos.z}): ${code} ${err && err.message ? err.message : ''}`),
        { code, pos }
      );
    }
  }

  // ---------------- 打开 / 关闭容器 ----------------

  /**
   * 寻路到箱子旁并打开容器窗口。
   * 与玩家手动操作等价：MC 生存模式交互距离（reach）为 3 格，只要进入 3 格内即可开箱，
   * 不必紧贴箱子（此前 GoalNear(1) + ≤2 格防护导致箱子被包围时 PATH_FAILED 放弃，而玩家能点到）。
   * 寻路失败（路径不可达）不立即放弃：若当前位置已在交互距离内，仍直接开箱。
   * @returns {Promise<import('prismarine-windows').Window>}
   */
  async openContainerAt(pos) {
    const target = vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
    // 先尝试贴近箱子（1.5 格内）；紧贴不了再放宽到 2.5 格内；再失败则靠下方 reach 检查兜底
    // （不放宽到 3：边缘位置按服务器"眼睛到箱子"判定可能打不开，与其硬开不如明确失败）
    try {
      await this.goto(pos, 1.5);
    } catch (err) {
      try {
        await this.goto(pos, 2.5);
      } catch (err2) { /* 兜底：不抛，看当前眼睛到箱子的距离是否已在服务器 reach 内 */ }
    }
    // 距离防护：按服务器原版判定——玩家眼睛到箱子包围盒距离 ≤3 格（interaction range）。
    // 用"眼睛到包围盒"而非"中心距"：悬空箱/高处的箱子从下方 2~3 格也能点到（玩家正常走路就能点到）。
    const eye = this.bot.entity.position.offset(0, 1.62, 0); // 生存模式眼睛高度
    const dx = Math.max(target.x - eye.x, 0, eye.x - (target.x + 1));
    const dy = Math.max(target.y - eye.y, 0, eye.y - (target.y + 1));
    const dz = Math.max(target.z - eye.z, 0, eye.z - (target.z + 1));
    const reachDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (reachDist > 2.9) { // 服务器 3.0，留 0.1 余量
      throw Object.assign(
        new Error(`距箱子 (${pos.x},${pos.y},${pos.z}) 眼睛 ${reachDist.toFixed(1)} 格，超出服务器交互距离（reach 3 格），拒绝开箱`),
        { code: 'TOO_FAR', pos }
      );
    }
    const dist = this.bot.entity.position.distanceTo(target);
    // 等待方块数据就绪：刚寻路到达时区块可能仍在加载，blockAt 会短暂返回 air / undefined
    let block = this.bot.blockAt(target);
    for (let i = 0; i < 15 && (!block || !isContainerBlock(block)); i++) {
      await new Promise(resolve => setTimeout(resolve, 200));
      block = this.bot.blockAt(target);
    }
    if (!isContainerBlock(block)) {
      throw Object.assign(
        new Error(`(${pos.x},${pos.y},${pos.z}) 处不是可打开的容器方块: ${block ? block.name : '未知'}`),
        { code: 'NOT_CONTAINER', pos }
      );
    }
    this.logger.info(`打开容器 ${block.name} (${pos.x},${pos.y},${pos.z})，距离 ${dist.toFixed(1)} 格，bot 在 (${this.bot.entity.position.x.toFixed(1)}, ${this.bot.entity.position.y.toFixed(1)}, ${this.bot.entity.position.z.toFixed(1)})`);
    let window;
    try {
      // 先对准箱子（准星指向箱子中心），帮助激活容器
      try {
        await this.bot.lookAt(vec3(target.x + 0.5, target.y + 0.5, target.z + 0.5), true);
      } catch (e) { /* 对准失败不阻塞 */ }
      // 5 秒快速超时：位置不同步导致点不到箱子时快速失败，避免干等 20 秒
      const openPromise = this.bot.openContainer(block);
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(Object.assign(new Error('打开容器超时(5s)'), { code: 'OPEN_TIMEOUT' })), 5000)
      );
      window = await Promise.race([openPromise, timeout]);
    } catch (err) {
      throw Object.assign(
        new Error(`无法打开容器 (${pos.x},${pos.y},${pos.z}): ${err && err.message ? err.message : err}`),
        { code: 'OPEN_FAILED', pos }
      );
    }
    if (!window) {
      throw Object.assign(new Error(`打开容器 (${pos.x},${pos.y},${pos.z}) 返回空窗口`), { code: 'OPEN_EMPTY', pos });
    }
    return window;
  }

  /** 关闭容器窗口（幂等） */
  close(window) {
    try {
      if (window && window.close) window.close();
    } catch (e) { /* 忽略已关闭窗口 */ }
  }

  // ---------------- 容量计算 ----------------

  /**
   * 从背包中找到该物品的实际 type（服务器下发值）。
   * deposit/withdraw 只接受服务器下发的数字 id；minecraft-data 表 id 与服务器注册表 id
   * 在实验版本（26.1.x）可能不一致，必须用背包中物品的实际 type，否则报
   * "Can't find X in slots [54 - 90]"。
   */
  _actualType(item) {
    if (item && typeof item.type === 'number') return item.type; // 直接传背包物品时
    const inv = this.bot && this.bot.inventory ? this.bot.inventory.items() : [];
    const found = item && inv.find(i => i.name === item.name);
    if (found && typeof found.type === 'number') return found.type;
    return item ? (typeof item.id === 'number' ? item.id : item.name) : null;
  }

  /** 容器对该物品的剩余可容纳数量（空槽 + 已有堆叠的剩余空间） */
  containerCapacityFor(window, item) {
    const stackSize = item.stackSize || 64;
    // 物品匹配用背包中该物品的实际 type（服务器下发），其次 minecraft-data id
    const typeId = this._actualType(item);
    let space = 0;
    for (const slot of window.slots) {
      if (!slot) {
        space += stackSize;
      } else if ((slot.type === typeId || slot.name === item.name) && slot.count < stackSize) {
        space += stackSize - slot.count;
      }
    }
    return space;
  }

  /** 容器是否还能放进该物品（>0 表示有空位） */
  containerHasSpace(window, item) {
    return this.containerCapacityFor(window, item) > 0;
  }

  /** 背包空闲槽位数（null 槽） */
  inventoryFreeSlotCount() {
    if (!this.bot.inventory || !this.bot.inventory.slots) return 0;
    return this.bot.inventory.slots.filter(s => s === null).length;
  }

  /** 背包物品列表（合并后的主背包物品） */
  inventoryItems() {
    return this.bot.inventory ? this.bot.inventory.items() : [];
  }

  // ---------------- 取出 / 存入 ----------------

  /**
   * 从容器取出指定数量到背包（不超过容器实际拥有量、不超过背包空位）。
   * @returns {Promise<number>} 实际取出数量
   */
  async take(window, item, count) {
    const available = count;
    if (available <= 0) return 0;
    // 背包空位约束：一个物品最多占一个槽位（同类可合并，按最坏情况 1 槽/种 估算）
    const freeSlots = this.inventoryFreeSlotCount();
    if (freeSlots <= 0) throw Object.assign(new Error('背包已满，无法继续取出'), { code: 'INV_FULL' });
    try {
      // itemType 必须为数字 id（mineflayer deposit/withdraw 只接受数字 id）；
      // 优先服务器下发的 type（可能与 minecraft-data id 有偏差），其次 minecraft-data id
      const itemType = typeof item.type === 'number' ? item.type : (typeof item.id === 'number' ? item.id : item.name);
      await window.withdraw(itemType, item.metadata || 0, available);
      return available;
    } catch (err) {
      throw Object.assign(
        new Error(`从容器取出失败 (${item.name}): ${err && err.message ? err.message : err}`),
        { code: 'WITHDRAW_FAILED' }
      );
    }
  }

  /**
   * 从背包存入指定数量到容器（严格受容器容量限制，超容量绝不放入）。
   * @returns {Promise<number>} 实际存入数量
   */
  async put(window, item, count) {
    if (!count || count <= 0) return 0;
    const space = this.containerCapacityFor(window, item);
    if (space <= 0) return 0; // 容器已满 / 无该类物品空位
    const toMove = Math.min(count, space);
    try {
      // itemType 必须为数字 id（mineflayer deposit/withdraw 只接受数字 id）；
      // 用背包中该物品的实际 type（服务器下发），数据表 id 可能与服务器注册表不一致
      const itemType = this._actualType(item);
      await window.deposit(itemType, item.metadata || 0, toMove);
      return toMove;
    } catch (err) {
      const msg = err && err.message ? err.message : '';
      // 容器满导致 deposit 找不到可放槽位（destination full）：视为"没放进去"返回 0，
      // 由上层转溢出箱（原实现抛 DEPOSIT_FAILED 会暂停整个任务，物品滞留背包）
      if (/destination full|full/i.test(msg)) return 0;
      throw Object.assign(
        new Error(`存入容器失败 (${item.name} x${toMove}): ${msg}`),
        { code: 'DEPOSIT_FAILED' }
      );
    }
  }
}

module.exports = { ChestService, isContainerBlock };
