'use strict';

/**
 * ItemClassifier —— 物品分类器
 *
 * 职责（对应需求 5.基础功能 第 1 条）：
 *   - 读取 minecraft-data 做物品 id / name / displayName 映射；
 *   - 提供「物品引用解析」：配置里写数字 id、minecraft:name、英文名或中文名都能解析成同一个物品；
 *   - 提供「中文名称映射」：minecraft-data 本身只带英文 displayName，
 *     这里通过内置可扩展中文词典（BUILTIN_ZH + 用户附加词典）给出中文名，找不到则回退 displayName。
 *
 * 词典覆盖常见矿物、锭、作物、食物、建材等，用户可在 config 中通过
 * storage_box.json 的 "zhNameMap" 字段扩展（见 config/storage_box.example.json）。
 */

const BUILTIN_ZH = {
  // —— 锭 / 矿物（用户示例物品）——
  '钻石': 'diamond',
  '铁锭': 'iron_ingot',
  '金锭': 'gold_ingot',
  '铜锭': 'copper_ingot',
  '下界合金锭': 'netherite_ingot',
  '绿宝石': 'emerald',
  '青金石': 'lapis_lazuli',
  '石英': 'quartz',
  '红石': 'redstone',
  '煤': 'coal',
  '粗铁': 'raw_iron',
  '粗金': 'raw_gold',
  '粗铜': 'raw_copper',
  '铁矿石': 'iron_ore',
  '金矿石': 'gold_ore',
  '钻石矿石': 'diamond_ore',
  '绿宝石矿石': 'emerald_ore',
  '下界石英矿石': 'nether_quartz_ore',
  // —— 食物（用户示例物品）——
  '面包': 'bread',
  '胡萝卜': 'carrot',
  '马铃薯': 'potato',
  '烤马铃薯': 'baked_potato',
  '苹果': 'apple',
  '金苹果': 'golden_apple',
  '牛排': 'cooked_beef',
  '熟猪排': 'cooked_porkchop',
  '熟鸡肉': 'cooked_chicken',
  '生牛肉': 'beef',
  '生猪肉': 'porkchop',
  '生鸡肉': 'chicken',
  '鸡蛋': 'egg',
  '牛奶': 'milk_bucket',
  '小麦': 'wheat',
  '小麦种子': 'wheat_seeds',
  '甜菜根': 'beetroot',
  '西瓜片': 'melon_slice',
  '南瓜': 'pumpkin',
  '糖': 'sugar',
  '曲奇': 'cookie',
  '蛋糕': 'cake',
  // —— 木材与建材 ——
  '橡木原木': 'oak_log',
  '云杉原木': 'spruce_log',
  '白桦原木': 'birch_log',
  '丛林原木': 'jungle_log',
  '金合欢原木': 'acacia_log',
  '深色橡木原木': 'dark_oak_log',
  '红树木原木': 'mangrove_log',
  '樱花原木': 'cherry_log',
  '橡木木板': 'oak_planks',
  '石头': 'stone',
  '圆石': 'cobblestone',
  '深板岩': 'deepslate',
  '圆石深板岩': 'cobbled_deepslate',
  '沙子': 'sand',
  '红沙': 'red_sand',
  '沙砾': 'gravel',
  '黏土': 'clay',
  '玻璃': 'glass',
  '砖块': 'bricks',
  // —— 羊毛 / 染料 ——
  '白色羊毛': 'white_wool',
  '白色染料': 'white_dye',
  // —— 杂项 ——
  '木棍': 'stick',
  '骨头': 'bone',
  '骨粉': 'bone_meal',
  '线': 'string',
  '羽毛': 'feather',
  '皮革': 'leather',
  '兔子皮': 'rabbit_hide',
  '燧石': 'flint',
  '火药': 'gunpowder',
  '末影珍珠': 'ender_pearl',
  '末影之眼': 'ender_eye',
  '烈焰棒': 'blaze_rod',
  '烈焰粉': 'blaze_powder',
  '恶魂之泪': 'ghast_tear',
  '蜘蛛眼': 'spider_eye',
  '发酵蛛眼': 'fermented_spider_eye',
  '岩浆膏': 'magma_cream',
  '糖': 'sugar',
  '海晶碎片': 'prismarine_shard',
  '海晶砂粒': 'prismarine_crystals',
  '墨囊': 'ink_sac',
  '紫颂果': 'chorus_fruit',
  '潜影壳': 'shulker_shell',
  '鞘翅': 'elytra',
  '附魔之瓶': 'experience_bottle',
  '铁粒': 'iron_nugget',
  '金粒': 'gold_nugget'
};

class ItemClassifier {
  /**
   * @param {string} mcVersion 服务器协议版本，如 '1.21.1'（minecraft-data 支持）、'26.1'（mineflayer-x 注册）
   * @param {object} [extraZhMap] 用户附加中文词典 { 中文名: 'minecraft:item_name' 或 'item_name' }
   */
  constructor(mcVersion, extraZhMap) {
    this.version = mcVersion;
    /** 加载 minecraft-data 游戏数据（物品 / 方块 / 语言）。 */
    this.mcData = require('minecraft-data')(mcVersion);

    /** 索引：id -> item, name -> item, displayName(小写) -> item, 中文名 -> item */
    this.byId = new Map();
    this.byName = new Map();
    this.byDisplayName = new Map();
    this.byZhName = new Map();

    // minecraft-data >=3.105 中 mcData.items 改为对象，数组在 mcData.itemsArray（兼容旧版）
    const items = this.mcData.itemsArray || this.mcData.items;
    if (!Array.isArray(items)) {
      throw new Error(`minecraft-data(${mcVersion}) 缺少物品数组`);
    }
    for (const item of items) {
      if (Number.isInteger(item.id)) this.byId.set(item.id, item);
      if (item.name) this.byName.set(item.name, item);
      if (item.displayName) this.byDisplayName.set(String(item.displayName).toLowerCase(), item);
    }

    // 合并中文词典：内置 + 用户扩展（用户覆盖内置同名项）
    this.zhDict = Object.assign({}, BUILTIN_ZH, extraZhMap || {});
    for (const [zh, ref] of Object.entries(this.zhDict)) {
      const item = this.resolveRef(ref);
      if (item && !this.byZhName.has(zh)) this.byZhName.set(zh, item);
    }
  }

  /**
   * 解析任意物品引用 -> 标准化 item 对象（含中文名）。
   * @param {number|string|object} ref 数字 id / 'minecraft:diamond' / 'diamond' / '钻石'
   * @returns {{id:number,name:string,displayName:string,zhName:string,stackSize:number}|null}
   */
  resolveRef(ref) {
    let item = null;
    if (ref == null) return null;

    if (typeof ref === 'number') {
      item = this.byId.get(ref);
    } else if (typeof ref === 'object' && ref.name) {
      item = this.byName.get(ref.name);
    } else if (typeof ref === 'string') {
      const s = ref.trim();
      if (/^\d+$/.test(s)) {
        item = this.byId.get(Number(s));
      } else {
        const bare = s.startsWith('minecraft:') ? s.slice('minecraft:'.length) : s;
        item = this.byName.get(bare)
          || this.byZhName.get(s)
          || this.byDisplayName.get(s.toLowerCase());
      }
    }
    return item ? this.attachZh(item) : null;
  }

  /** 给原生 minecraft-data item 附加 zhName 后返回 */
  attachZh(item) {
    const zhName = this.nameToZh(item.name);
    return {
      id: item.id,
      name: item.name,
      displayName: item.displayName,
      zhName,
      stackSize: item.stackSize
    };
  }

  /** item name -> 中文名（词典命中）；否则回退 displayName；再回退 name */
  nameToZh(name) {
    for (const [zh, ref] of Object.entries(this.zhDict)) {
      if (ref === name || ref === `minecraft:${name}`) return zh;
    }
    const item = this.byName.get(name);
    return item && item.displayName ? item.displayName : name;
  }

  /** 将 mineflayer 槽位/物品对象（含 name/displayName/id/type）转换为带中文名的统一对象 */
  itemOf(slotOrItem) {
    if (!slotOrItem) return null;
    if (slotOrItem.name) {
      const item = this.byName.get(slotOrItem.name);
      if (item) {
        const std = this.attachZh(item);
        // 保留服务器下发的物品 type（可能与 minecraft-data id 有偏差，deposit/withdraw 必须用服务器 id）
        if (typeof slotOrItem.type === 'number') std.type = slotOrItem.type;
        return std;
      }
      return null;
    }
    if (typeof slotOrItem.type === 'number') {
      const item = this.byId.get(slotOrItem.type);
      return item ? this.attachZh(item) : null;
    }
    return null;
  }
}

module.exports = { ItemClassifier, BUILTIN_ZH };
