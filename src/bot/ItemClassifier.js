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
  '竹块': 'bamboo_block',
  '诡异菌柄': 'warped_stem',
  '绯红菌柄': 'crimson_stem',
  '诡异菌核': 'warped_hyphae',
  '绯红菌核': 'crimson_hyphae',
  // 去皮原木
  '去皮橡木原木': 'stripped_oak_log',
  '去皮云杉原木': 'stripped_spruce_log',
  '去皮白桦原木': 'stripped_birch_log',
  '去皮丛林原木': 'stripped_jungle_log',
  '去皮金合欢原木': 'stripped_acacia_log',
  '去皮深色橡木原木': 'stripped_dark_oak_log',
  '去皮红树木原木': 'stripped_mangrove_log',
  '去皮樱花原木': 'stripped_cherry_log',
  '去皮竹块': 'stripped_bamboo_block',
  '去皮诡异菌柄': 'stripped_warped_stem',
  '去皮绯红菌柄': 'stripped_crimson_stem',
  // 木板（全木种）
  '橡木木板': 'oak_planks',
  '云杉木板': 'spruce_planks',
  '白桦木板': 'birch_planks',
  '丛林木板': 'jungle_planks',
  '金合欢木板': 'acacia_planks',
  '深色橡木木板': 'dark_oak_planks',
  '红树木板': 'mangrove_planks',
  '樱花木板': 'cherry_planks',
  '竹木板': 'bamboo_planks',
  '诡异木板': 'warped_planks',
  '绯红木板': 'crimson_planks',
  // 活板门（全木种）
  '橡木活板门': 'oak_trapdoor',
  '云杉木活板门': 'spruce_trapdoor',
  '白桦木活板门': 'birch_trapdoor',
  '丛林木活板门': 'jungle_trapdoor',
  '金合欢木活板门': 'acacia_trapdoor',
  '深色橡木活板门': 'dark_oak_trapdoor',
  '红树木活板门': 'mangrove_trapdoor',
  '樱花木活板门': 'cherry_trapdoor',
  '竹活板门': 'bamboo_trapdoor',
  '诡异木活板门': 'warped_trapdoor',
  '绯红木活板门': 'crimson_trapdoor',
  // 台阶（木种 + 常见石质）
  '橡木台阶': 'oak_slab',
  '云杉台阶': 'spruce_slab',
  '白桦台阶': 'birch_slab',
  '丛林台阶': 'jungle_slab',
  '金合欢台阶': 'acacia_slab',
  '深色橡木台阶': 'dark_oak_slab',
  '红树台阶': 'mangrove_slab',
  '樱花台阶': 'cherry_slab',
  '竹台阶': 'bamboo_slab',
  '诡异台阶': 'warped_slab',
  '绯红台阶': 'crimson_slab',
  '石头台阶': 'stone_slab',
  '圆石台阶': 'cobblestone_slab',
  '闪长岩台阶': 'diorite_slab',
  '安山岩台阶': 'andesite_slab',
  '花岗岩台阶': 'granite_slab',
  '砂岩台阶': 'sandstone_slab',
  '红砂岩台阶': 'red_sandstone_slab',
  '砖台阶': 'brick_slab',
  '石砖台阶': 'stone_brick_slab',
  '石英台阶': 'quartz_slab',
  '深板岩台阶': 'deepslate_slab',
  '黑石台阶': 'blackstone_slab',
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
  '金粒': 'gold_nugget',
  // —— 装备（金套 + 常见）——
  '金头盔': 'golden_helmet',
  '金胸甲': 'golden_chestplate',
  '金护腿': 'golden_leggings',
  '金靴子': 'golden_boots',
  '铁头盔': 'iron_helmet',
  '铁胸甲': 'iron_chestplate',
  '铁护腿': 'iron_leggings',
  '铁靴子': 'iron_boots',
  '钻石头盔': 'diamond_helmet',
  '钻石胸甲': 'diamond_chestplate',
  '钻石护腿': 'diamond_leggings',
  '钻石靴子': 'diamond_boots',
  // —— 杂项 ——
  '光源方块': 'light',
  '盾牌': 'shield'
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
