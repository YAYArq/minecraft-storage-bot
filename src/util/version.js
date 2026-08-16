'use strict';

/**
 * Minecraft 版本归一化。
 *
 * 支持版本（面板 / bots.json 可填）：
 *   - 1.21.11   -> 1.21.11（minecraft-data 3.105.0 自带数据）
 *   - 26.1      -> 26.1（mineflayer-x vendored 补丁注册，协议 775）
 *   - 26.1.2    -> 26.1（26.1 补丁版，协议同为 775）
 *   - 26.2 / 26.2.x -> 26.1（26.x 系列协议 775 兼容；若服务器协议升级需更新补丁）
 * 其余版本原样透传（交给 minecraft-data / mineflayer 判定）。
 */

function normalizeMinecraftVersion(version) {
  const s = String(version == null ? '' : version).trim();
  if (!s) return s;
  if (/^26\./.test(s)) return '26.1';
  return s;
}

module.exports = { normalizeMinecraftVersion };
