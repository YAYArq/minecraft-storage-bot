'use strict';

const fs = require('fs');

/**
 * SystemSettings —— 系统设置（config/system.json）
 *
 * 对应面板「系统设置」区块：
 *   - server:     服务器连接（host / port / username / auth / version）
 *   - ai:         AI API（enabled / apiKey / baseUrl / model）
 *   - behavior:   行为参数（batchSize / freeSlotThreshold / autoStoreOnStart）
 *   - scanAreas:  扫描区域（立方体区域列表，供仓库地图与后续扫描功能使用）
 */

function defaults() {
  return {
    server: {
      host: '127.0.0.1',
      port: 25565,
      username: 'StorageBot1',
      auth: 'offline',
      version: '1.21.1'
    },
    ai: {
      enabled: false,
      apiKey: '',
      baseUrl: '',
      model: ''
    },
    behavior: {
      batchSize: 64,
      freeSlotThreshold: 6,
      autoStoreOnStart: true
    },
    scanAreas: [
      {
        name: '仓库区',
        min: { x: 95, y: 60, z: 195 },
        max: { x: 135, y: 70, z: 205 }
      }
    ]
  };
}

class SystemSettings {
  /**
   * @param {string} filePath config/system.json 路径
   */
  constructor(filePath) {
    this.filePath = filePath;
    this.data = defaults();
    this.lastError = null;
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const json = JSON.parse(raw);
      this.data = this._merge(defaults(), json);
      this.lastError = null;
    } catch (err) {
      // 文件不存在 / 解析失败：使用默认值（不覆盖文件）
      this.lastError = err.message;
      this.data = defaults();
    }
    return this.data;
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2) + '\n');
    this.lastError = null;
  }

  /** 深度合并（对象递归，数组整体替换） */
  _merge(base, override) {
    if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
    const out = { ...base };
    for (const [k, v] of Object.entries(override)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
        out[k] = this._merge(base[k], v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  /** 部分更新并保存 */
  update(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, message: '设置必须是对象' };
    }
    this.data = this._merge(this.data, patch);
    // 数值规范化
    this.data.server.port = Number(this.data.server.port) || 25565;
    this.data.behavior.batchSize = Number(this.data.behavior.batchSize) || 64;
    this.data.behavior.freeSlotThreshold = Number(this.data.behavior.freeSlotThreshold) || 6;
    if (!Array.isArray(this.data.scanAreas)) this.data.scanAreas = [];
    this.save();
    return { ok: true, message: '系统设置已保存' };
  }

  getJSON() {
    return JSON.parse(JSON.stringify(this.data));
  }
}

module.exports = { SystemSettings };
