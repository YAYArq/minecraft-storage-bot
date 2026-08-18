'use strict';

const fs = require('fs');
const { keyOf } = require('../util/vec3util');

/**
 * ConfigStore —— 箱子区域配置加载 / 校验 / 热重载
 *
 * 对应需求「1. 可配置【箱子存储区域】」：
 *   - 源投料箱子 sourceBoxes[]：杂乱物品来源，可多个坐标；
 *   - 目标分类箱子 targetBoxes[]：每个坐标绑定固定物品分类（只允许存放该分类的物品）；
 *   - 溢出箱子 overflowBox：唯一，接收「无匹配分类」或「目标箱已满」的物品；
 *   - 每个 bot 实例拥有一份独立配置（多 bot 互不干扰）。
 *
 * 配置用 JSON 保存（示例见 config/storage_box.example.json）：
 *   targetBoxes[].items 支持三种写法混用：数字物品 id / minecraft:name / 中文名。
 *
 * 安全热重载：先完整解析校验新配置，全部通过后才替换内存数据，避免半新半旧。
 */

class ConfigStore {
  /**
   * @param {string} filePath storage_box.json 路径
   * @param {ItemClassifier} classifier 物品分类器（用于解析物品引用、中文名）
   */
  constructor(filePath, classifier) {
    this.filePath = filePath;
    this.classifier = classifier;
    this.data = null; // 最近一次成功加载的原始配置（深拷贝后）
    this.parsed = null; // 解析校验后的运行时结构
    this.lastError = null;
    this.loadWarnings = [];
  }

  /** 校验基础数字坐标 */
  static isCoord(v) {
    return Number.isFinite(Number(v));
  }

  /**
   * 解析物品引用列表：单引用解析失败时，若含分隔符（空格/逗号/分号）则拆分逐个解析。
   * @returns {Array} 解析出的物品对象列表
   */
  resolveRefList(ref) {
    const single = this.classifier.resolveRef(ref);
    if (single) return [single];
    // 分隔符只用逗号/分号——物品名可能含空格（如 "Honeycomb Block"），不能按空格拆分
    if (typeof ref === 'string' && /[,，;；]+/.test(ref)) {
      const out = [];
      for (const part of ref.split(/[,，;；]+/).filter(Boolean)) {
        const item = this.classifier.resolveRef(part);
        if (item) out.push(item);
      }
      return out;
    }
    return [];
  }

  /**
   * 解析物品引用列表（数字 id / minecraft:name / 中文名 / 空格逗号分隔多物品），按物品 id 去重。
   * 允许空数组（区域目标箱 items 由用户后台填写）。
   * @param {Array} refs
   * @param {string} label 错误提示前缀
   * @param {Array} errors
   * @param {Array} warnings
   * @returns {Array<{id,name,displayName,zhName,stackSize}>}
   */
  resolveItems(refs, label, errors, warnings) {
    const itemsById = new Map();
    if (Array.isArray(refs)) {
      for (const ref of refs) {
        const resolved = this.resolveRefList(ref);
        if (resolved.length) {
          for (const item of resolved) {
            if (!itemsById.has(item.id)) itemsById.set(item.id, item);
          }
        } else {
          warnings.push(`${label} 无法解析物品引用: ${JSON.stringify(ref)}（已忽略）`);
        }
      }
    }
    return [...itemsById.values()];
  }

  /** 解析箱子条目：支持单箱 {x,y,z} 或对角区域 {min:{x,y,z}, max:{x,y,z}}。
   * 区域表示该立方体内所有容器方块都视为这类箱子。
   * 非法条目返回 null（由调用方收集错误）。
   */
  static parseBoxEntry(entry, label, errors) {
    if (!entry) { errors.push(`${label} 配置为空`); return null; }
    // 单箱
    if (ConfigStore.isCoord(entry.x) && ConfigStore.isCoord(entry.y) && ConfigStore.isCoord(entry.z)) {
      const x = Number(entry.x), y = Number(entry.y), z = Number(entry.z);
      return { type: 'point', x, y, z, key: keyOf(x, y, z) };
    }
    // 对角区域
    if (entry.min && entry.max
      && ConfigStore.isCoord(entry.min.x) && ConfigStore.isCoord(entry.min.y) && ConfigStore.isCoord(entry.min.z)
      && ConfigStore.isCoord(entry.max.x) && ConfigStore.isCoord(entry.max.y) && ConfigStore.isCoord(entry.max.z)) {
      const min = {
        x: Math.min(Number(entry.min.x), Number(entry.max.x)),
        y: Math.min(Number(entry.min.y), Number(entry.max.y)),
        z: Math.min(Number(entry.min.z), Number(entry.max.z))
      };
      const max = {
        x: Math.max(Number(entry.min.x), Number(entry.max.x)),
        y: Math.max(Number(entry.min.y), Number(entry.max.y)),
        z: Math.max(Number(entry.min.z), Number(entry.max.z))
      };
      return { type: 'area', min, max, key: `${keyOf(min.x, min.y, min.z)}~${keyOf(max.x, max.y, max.z)}` };
    }
    errors.push(`${label} 需要合法坐标（单箱 {x,y,z} 或对角区域 {min,max}）: ${JSON.stringify(entry)}`);
    return null;
  }

  /** 加载并校验配置；失败时抛出 Error（保留上一次成功配置） */
  load() {
    const raw = fs.readFileSync(this.filePath, 'utf8');
    const json = JSON.parse(raw);
    const parsed = this.validate(json);
    this.rawText = raw; // JSON 编辑器用（保留原始文本）
    this.data = JSON.parse(raw);
    this.parsed = parsed;
    this.lastError = null;
    return parsed;
  }

  /** 热重载：成功则替换内存数据，失败抛错并保留旧配置 */
  reload() {
    try {
      const parsed = this.load();
      return { ok: true, warnings: this.loadWarnings, parsed };
    } catch (err) {
      this.lastError = err;
      return { ok: false, error: err.message };
    }
  }

  /** 完整校验并构建运行时结构（不做任何内存写入） */
  validate(json) {
    const errors = [];
    const warnings = [];
    if (!json || typeof json !== 'object') errors.push('配置根节点必须是 JSON 对象');

    // ---- 目标分类箱子 ----
    const targetBoxes = [];
    if (Array.isArray(json.targetBoxes) && json.targetBoxes.length > 0) {
      const seen = new Set();
      for (const tb of json.targetBoxes) {
        const parsed = ConfigStore.parseBoxEntry(tb, '目标分类箱', errors);
        if (!parsed) continue;
        if (seen.has(parsed.key)) {
          errors.push(`目标分类箱坐标重复: ${parsed.key}`);
          continue;
        }
        seen.add(parsed.key);
        if (parsed.type === 'area') {
          // 对角区域目标箱：区域内所有箱子视为同一分类；items 允许为空（用户后台填写）
          const items = this.resolveItems(tb.items, `目标分类箱区域 ${parsed.key}`, errors, warnings);
          targetBoxes.push({
            type: 'area',
            min: parsed.min,
            max: parsed.max,
            key: parsed.key,
            category: typeof tb.category === 'string' && tb.category ? tb.category : (items[0] ? items[0].zhName : '未分类'),
            items
          });
          continue;
        }
        const x = parsed.x, y = parsed.y, z = parsed.z;
        const key = parsed.key;
        let items = [];
        if (!Array.isArray(tb.items) || tb.items.length === 0) {
          // items 允许为空：用户先添加箱子、后台再填物品清单（与区域目标箱一致）
          warnings.push(`目标分类箱 ${key} 尚未填写物品清单（可在配置中补充）`);
        } else {
          // 解析 items 引用（数字 id / minecraft:name / 中文名 / 空格逗号分隔多物品），按物品 id 去重
          const itemsById = new Map();
          for (const ref of tb.items) {
            const resolved = this.resolveRefList(ref);
            if (resolved.length) {
              for (const item of resolved) {
                if (!itemsById.has(item.id)) itemsById.set(item.id, item);
              }
            } else {
              warnings.push(`目标分类箱 ${key} 无法解析物品引用: ${JSON.stringify(ref)}（已忽略）`);
            }
          }
          items = [...itemsById.values()];
          if (items.length === 0) {
            errors.push(`目标分类箱 ${key} 的 items 全部无法解析`);
            continue;
          }
        }
        targetBoxes.push({
          x, y, z, key,
          category: typeof tb.category === 'string' && tb.category ? tb.category : (items[0] ? items[0].zhName : '未分类'),
          items
        });
      }
    } else {
      errors.push('targetBoxes 必须是非空数组');
    }

    // ---- 源投料箱子（支持单箱 / 对角区域）----
    const sourceBoxes = [];
    if (Array.isArray(json.sourceBoxes)) {
      const seenSrc = new Set();
      for (const sb of json.sourceBoxes) {
        const parsed = ConfigStore.parseBoxEntry(sb, '源投料箱', errors);
        if (parsed) {
          if (!seenSrc.has(parsed.key)) {
            seenSrc.add(parsed.key);
            sourceBoxes.push(parsed);
          }
        }
      }
    }

    // ---- 溢出箱子（支持多个；兼容旧单数 overflowBox 配置）----
    const overflowBoxes = [];
    const obList = Array.isArray(json.overflowBoxes)
      ? json.overflowBoxes
      : (json.overflowBox ? [json.overflowBox] : []);
    if (obList.length === 0) {
      errors.push('overflowBoxes 至少需要一个溢出箱坐标');
    } else {
      const seenOb = new Set();
      for (const ob of obList) {
        const parsed = ConfigStore.parseBoxEntry(ob, '溢出箱', errors);
        if (parsed) {
          if (!seenOb.has(parsed.key)) {
            seenOb.add(parsed.key);
            overflowBoxes.push(parsed);
          }
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(errors.join('；'));
    }

    // ---- 返回点（默认待机位置，可选）----
    let standbyPoint = null;
    if (json.standbyPoint != null) {
      if (ConfigStore.isCoord(json.standbyPoint.x) && ConfigStore.isCoord(json.standbyPoint.y) && ConfigStore.isCoord(json.standbyPoint.z)) {
        standbyPoint = {
          x: Number(json.standbyPoint.x),
          y: Number(json.standbyPoint.y),
          z: Number(json.standbyPoint.z),
          key: keyOf(json.standbyPoint.x, json.standbyPoint.y, json.standbyPoint.z)
        };
      } else {
        errors.push(`standbyPoint 需要合法坐标: ${JSON.stringify(json.standbyPoint)}`);
      }
    }

    if (errors.length > 0) {
      throw new Error(errors.join('；'));
    }

    // ---- 任务参数 ----
    const batchSize = Number.isInteger(json.batchSize) && json.batchSize > 0 ? json.batchSize : 64;
    const freeSlotThreshold = Number.isInteger(json.freeSlotThreshold) && json.freeSlotThreshold > 0 ? json.freeSlotThreshold : 6;
    // 开箱距离上限（眼睛到箱子包围盒，格）：服务器原版 reach 3，默认 2.9；允许按实例/服务器插件调整，范围 1~8
    const openReachRaw = Number(json.openReach);
    const openReach = Number.isFinite(openReachRaw) && openReachRaw > 0 ? Math.min(8, Math.max(1, openReachRaw)) : 2.9;
    // 定时翻看源投料箱间隔（秒，0 = 关闭；默认 120 秒）
    const sourceCheckInterval = Number.isFinite(Number(json.sourceCheckInterval)) && Number(json.sourceCheckInterval) >= 0
      ? Number(json.sourceCheckInterval)
      : 120;
    // 自动巡查整理间隔（秒，0 = 关闭；默认 600 秒）：定时整理目标箱/溢出箱错放物品
    const tidyInterval = Number.isFinite(Number(json.tidyInterval)) && Number(json.tidyInterval) >= 0
      ? Number(json.tidyInterval)
      : 600;
    // 取货配置：取货箱坐标 / 送达方式（box=放取货箱 tpa=传送到玩家 tp=传送到玩家）/ 返回方式（home=执行指令 tp=传送回待机点）
    const pickupRaw = json.pickup && typeof json.pickup === 'object' ? json.pickup : {};
    const pickupBox = pickupRaw.box && ConfigStore.isCoord(pickupRaw.box.x) && ConfigStore.isCoord(pickupRaw.box.y) && ConfigStore.isCoord(pickupRaw.box.z)
      ? { x: Number(pickupRaw.box.x), y: Number(pickupRaw.box.y), z: Number(pickupRaw.box.z) }
      : null;
    const pickup = {
      box: pickupBox,
      deliverMode: ['box', 'tpa', 'tp'].includes(pickupRaw.deliverMode) ? pickupRaw.deliverMode : 'box',
      returnMode: ['home', 'walk', 'tp'].includes(pickupRaw.returnMode) ? pickupRaw.returnMode : 'home',
      returnHomeCmd: typeof pickupRaw.returnHomeCmd === 'string' && pickupRaw.returnHomeCmd ? pickupRaw.returnHomeCmd : '/home'
    };

    // ---- 用户附加中文词典 ----
    if (json.zhNameMap && typeof json.zhNameMap === 'object') {
      for (const [zh, ref] of Object.entries(json.zhNameMap)) {
        this.classifier.zhDict[zh] = ref;
      }
      // 重建中文索引
      this.classifier.byZhName.clear();
      for (const [zh, ref] of Object.entries(this.classifier.zhDict)) {
        const item = this.classifier.resolveRef(ref);
        if (item && !this.classifier.byZhName.has(zh)) this.classifier.byZhName.set(zh, item);
      }
    }

    this.loadWarnings = warnings;
    return { targetBoxes, sourceBoxes, overflowBoxes, standbyPoint, batchSize, freeSlotThreshold, sourceCheckInterval, tidyInterval, pickup, openReach };
  }

  // ---------- 保存前规范化 ----------

  /**
   * 保存前规范化配置：
   *   - targetBoxes[].items 统一转换为游戏标准物品 id（minecraft:name）；
   *   - 无法解析的引用保留原值（并记入警告）；
   *   - targetBoxes[].category 为空时自动用首个物品的中文名。
   * @param {object} json 待保存配置
   * @returns {{json:object, warnings:string[]}}
   */
  normalizeForSave(json) {
    const out = JSON.parse(JSON.stringify(json || {}));
    const warnings = [];
    if (Array.isArray(out.targetBoxes)) {
      for (const tb of out.targetBoxes) {
        if (Array.isArray(tb.items)) {
          const norm = [];
          for (const ref of tb.items) {
            const resolved = this.resolveRefList(ref);
            if (resolved.length) {
              for (const item of resolved) {
                norm.push(`minecraft:${item.name}`); // 游戏标准物品 id
              }
            } else {
              norm.push(ref); // 解析失败保留原值
              warnings.push(`目标箱 ${tb.key || `${tb.x},${tb.y},${tb.z}`} 无法解析物品引用: ${JSON.stringify(ref)}`);
            }
          }
          tb.items = norm;
        }
        // category 为空 -> 用首个物品中文名
        if (!tb.category || typeof tb.category !== 'string' || !tb.category.trim()) {
          const first = Array.isArray(tb.items) && tb.items.length ? this.classifier.resolveRef(tb.items[0]) : null;
          tb.category = first ? first.zhName : '分类';
        }
      }
    }
    return { json: out, warnings };
  }

  // ---------- 运行时查询 ----------

  /** 根据物品（classifier 标准化对象）匹配目标分类箱；无匹配返回 null */
  matchTargetBox(item) {
    if (!item || !this.parsed) return null;
    for (const tb of this.parsed.targetBoxes) {
      for (const it of tb.items) {
        if (it.id === item.id || it.name === item.name) return tb;
      }
    }
    return null;
  }

  get targetBoxes() { return this.parsed ? this.parsed.targetBoxes : []; }
  get sourceBoxes() { return this.parsed ? this.parsed.sourceBoxes : []; }
  get overflowBoxes() { return this.parsed ? this.parsed.overflowBoxes : []; }
  /** 兼容旧引用：第一个溢出箱 */
  get overflowBox() { const o = this.overflowBoxes; return o.length ? o[0] : null; }
  get standbyPoint() { return this.parsed ? this.parsed.standbyPoint : null; }
  get batchSize() { return this.parsed ? this.parsed.batchSize : 64; }
  get freeSlotThreshold() { return this.parsed ? this.parsed.freeSlotThreshold : 6; }
  get sourceCheckInterval() { return this.parsed ? this.parsed.sourceCheckInterval : 120; }
  get tidyInterval() { return this.parsed ? this.parsed.tidyInterval : 600; }
  get openReach() { return this.parsed ? this.parsed.openReach : 2.9; }
  get pickup() {
    return this.parsed ? this.parsed.pickup : { box: null, deliverMode: 'box', returnMode: 'home', returnHomeCmd: '/home' };
  }

  /** 面板展示用：返回解析后的配置快照（含中文名） */
  toJSON() {
    return {
      batchSize: this.batchSize,
      freeSlotThreshold: this.freeSlotThreshold,
      openReach: this.openReach,
      sourceBoxes: this.sourceBoxes,
      targetBoxes: this.targetBoxes.map(tb => tb.type === 'area'
        ? { type: 'area', min: tb.min, max: tb.max, category: tb.category, items: tb.items.map(it => ({ id: it.id, name: it.name, zhName: it.zhName })) }
        : { x: tb.x, y: tb.y, z: tb.z, category: tb.category, items: tb.items.map(it => ({ id: it.id, name: it.name, zhName: it.zhName })) }),
      overflowBoxes: this.overflowBoxes,
      overflowBox: this.overflowBox, // 兼容旧前端
      standbyPoint: this.standbyPoint,
      sourceCheckInterval: this.sourceCheckInterval,
      tidyInterval: this.tidyInterval,
      pickup: this.pickup,
      warnings: this.loadWarnings
    };
  }
}

module.exports = { ConfigStore };
