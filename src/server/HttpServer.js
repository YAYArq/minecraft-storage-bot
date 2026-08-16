'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

/**
 * HttpServer —— 静态文件服务 + REST API
 *
 * 参考 MULTIBOT_PANEL 的静态服务器实现：
 *   - public/ 前端无需打包直接打开；
 *   - 提供 bot 列表 / 箱子配置 / 日志 / 指令的 REST 接口；
 *   - 实时数据走 WebSocket（见 WsServer）。
 */

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

class HttpServer {
  /**
   * @param {object} options
   * @param {import('../bot/BotManager').BotManager} options.manager
   * @param {string} options.publicDir public 目录
   * @param {number} [options.port=10260]
   * @param {string} [options.host='0.0.0.0']
   */
  constructor(options = {}) {
    this.manager = options.manager;
    this.publicDir = path.resolve(options.publicDir || 'public');
    this.port = options.port || 10260;
    this.host = options.host || '0.0.0.0';
    this.server = null;
  }

  start() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.listen(this.port, this.host, () => {
      console.log(`[HTTP] 面板服务已启动: http://${this.host}:${this.port}`);
    });
  }

  async stop() {
    if (this.server) await new Promise(r => this.server.close(r));
  }

  handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname.startsWith('/api/')) {
      return this.handleApi(pathname.slice(5), req, res);
    }
    return this.serveStatic(pathname, res);
  }

  // ---------------- REST API ----------------

  handleApi(route, req, res) {
    const parts = route.split('/').filter(Boolean);
    try {
      if (parts.length === 1 && parts[0] === 'settings' && req.method === 'GET') {
        // GET /api/settings —— 系统设置
        return this.json(res, 200, this.manager.getSettings());
      }
      if (parts.length === 1 && parts[0] === 'settings' && req.method === 'PUT') {
        // PUT /api/settings —— 保存系统设置
        return this.readBody(req).then(body => {
          const result = this.manager.updateSettings(body);
          return this.json(res, result.ok ? 200 : 400, result);
        });
      }
      if (parts.length === 2 && parts[0] === 'settings' && parts[1] === 'apply-server' && req.method === 'POST') {
        // POST /api/settings/apply-server —— 服务器连接应用到实例并重启
        return this.manager.applyServerSettings().then(result =>
          this.json(res, result.ok ? 200 : 400, result)
        );
      }
      if (parts.length === 1 && parts[0] === 'tasks' && req.method === 'GET') {
        // GET /api/tasks —— 任务列表（当前 + 历史）
        return this.json(res, 200, { tasks: this.manager.getTasks() });
      }
      if (parts.length === 1 && parts[0] === 'bots' && req.method === 'GET') {
        // GET /api/bots —— bot 实例列表
        return this.json(res, 200, { bots: this.manager.getSnapshots() });
      }
      if (parts.length === 1 && parts[0] === 'bots' && req.method === 'POST') {
        // POST /api/bots —— 新增 bot 实例
        return this.readBody(req).then(body => {
          const result = this.manager.addBot(body);
          return this.json(res, result.ok ? 200 : 400, result);
        });
      }
      if (parts.length === 2 && parts[0] === 'bots' && req.method === 'GET') {
        const snap = this.manager.getBot(parts[1]);
        if (!snap) return this.json(res, 404, { error: 'bot not found' });
        return this.json(res, 200, snap.getStatus());
      }
      if (parts.length === 2 && parts[0] === 'bots' && req.method === 'DELETE') {
        // DELETE /api/bots/:id —— 删除 bot 实例
        return this.manager.removeBot(parts[1]).then(result =>
          this.json(res, result.ok ? 200 : 400, result)
        );
      }
      if (parts.length === 3 && parts[0] === 'bots' && parts[2] === 'config' && req.method === 'GET') {
        const view = this.manager.getBotConfigView(parts[1]);
        if (!view) return this.json(res, 404, { error: 'bot not found' });
        return this.json(res, 200, view);
      }
      if (parts.length === 3 && parts[0] === 'bots' && parts[2] === 'settings' && req.method === 'GET') {
        // GET /api/bots/:id/settings —— bot 实例配置（配置页面表单）
        const s = this.manager.getBotSettings(parts[1]);
        if (!s) return this.json(res, 404, { error: 'bot not found' });
        return this.json(res, 200, { ok: true, bot: s });
      }
      if (parts.length === 3 && parts[0] === 'bots' && parts[2] === 'settings' && req.method === 'PUT') {
        // PUT /api/bots/:id/settings —— 保存 bot 实例配置
        return this.readBody(req).then(body => {
          const result = this.manager.updateBotSettings(parts[1], body);
          return this.json(res, result.ok ? 200 : 400, result);
        });
      }
      if (parts.length === 3 && parts[0] === 'bots' && parts[2] === 'restart' && req.method === 'POST') {
        // POST /api/bots/:id/restart —— 重启 bot
        return this.manager.restartBot(parts[1]).then(result =>
          this.json(res, result.ok ? 200 : 400, result)
        );
      }
      if (parts.length === 3 && parts[0] === 'bots' && parts[2] === 'audit' && req.method === 'POST') {
        // POST /api/bots/:id/audit —— 触发库存盘点（开箱识别）
        return this.manager.auditBot(parts[1]).then(result =>
          this.json(res, result.ok ? 200 : 400, result)
        );
      }
      if (parts.length === 3 && parts[0] === 'bots' && parts[2] === 'audit' && req.method === 'GET') {
        // GET /api/bots/:id/audit —— 最近一次盘点结果
        const audit = this.manager.getAudit(parts[1]);
        return this.json(res, 200, { audit });
      }
      if (parts.length === 3 && parts[0] === 'bots' && parts[2] === 'boxes' && req.method === 'GET') {
        // GET /api/bots/:id/boxes —— 箱子配置文件原始文本 + 解析结果
        const view = this.manager.getBotConfigView(parts[1]);
        if (!view) return this.json(res, 404, { error: 'bot not found' });
        return this.json(res, 200, { ...view, raw: this.manager.getStorageConfigRaw(parts[1]) });
      }
      if (parts.length === 3 && parts[0] === 'bots' && parts[2] === 'boxes' && req.method === 'PUT') {
        // PUT /api/bots/:id/boxes —— 保存箱子配置（校验通过后写盘并热重载）
        return this.readBody(req).then(body => {
          const result = this.manager.updateStorageConfig(parts[1], body.raw !== undefined ? body.raw : body);
          return this.json(res, result.ok ? 200 : 400, result);
        });
      }
      if (parts.length === 4 && parts[0] === 'bots' && parts[2] === 'boxes' && parts[3] === 'scan' && req.method === 'POST') {
        // POST /api/bots/:id/boxes/scan —— 扫描对角区域内容器（前端区域框选预览）
        return this.readBody(req).then(body =>
          this.manager.scanBoxArea(parts[1], body.corner1, body.corner2).then(result =>
            this.json(res, result.ok ? 200 : 400, result)
          )
        );
      }
      if (parts.length === 4 && parts[0] === 'bots' && parts[2] === 'boxes' && parts[3] === 'area' && req.method === 'POST') {
        // POST /api/bots/:id/boxes/area —— 添加源箱/溢出箱条目（单箱或对角区域）
        return this.readBody(req).then(body => {
          const result = this.manager.addBoxArea(parts[1], body.type, body.entry);
          return this.json(res, result.ok ? 200 : 400, result);
        });
      }
      if (parts.length === 4 && parts[0] === 'bots' && parts[2] === 'boxes' && parts[3] === 'delete' && req.method === 'POST') {
        // POST /api/bots/:id/boxes/delete —— 删除某个箱子/区域条目
        return this.readBody(req).then(body => {
          const result = this.manager.removeBoxEntry(parts[1], body.key);
          return this.json(res, result.ok ? 200 : 400, result);
        });
      }
      if (parts.length === 3 && parts[0] === 'bots' && parts[2] === 'logs' && req.method === 'GET') {
        const q = new URL(req.url, 'http://x').searchParams;
        const limit = Number(q.get('limit')) || 100;
        return this.json(res, 200, { logs: this.manager.getBotLogs(parts[1], limit) });
      }
      if (parts.length === 3 && parts[0] === 'bots' && parts[2] === 'command' && req.method === 'POST') {
        return this.readBody(req).then(body => {
          const { command, args } = body;
          if (!command) return this.json(res, 400, { error: 'command required' });
          const result = this.manager.dispatch(parts[1], command, args);
          return this.json(res, result.ok ? 200 : 400, result);
        });
      }
      return this.json(res, 404, { error: `not found: /api/${route}` });
    } catch (err) {
      return this.json(res, 500, { error: err.message });
    }
  }

  // ---------------- 静态文件 ----------------

  serveStatic(pathname, res) {
    let file = pathname === '/' ? '/index.html' : pathname;
    const full = path.resolve(this.publicDir, '.' + file);
    // 路径穿越防护
    if (!full.startsWith(this.publicDir + path.sep) && full !== path.join(this.publicDir, 'index.html')) {
      return this.text(res, 403, 'forbidden');
    }
    fs.readFile(full, (err, data) => {
      if (err) return this.text(res, 404, 'not found');
      const ext = path.extname(full).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      res.end(data);
    });
  }

  // ---------------- 工具 ----------------

  json(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  }

  text(res, status, text) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(text);
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => { data += chunk; });
      req.on('end', () => {
        try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('invalid json body')); }
      });
      req.on('error', reject);
    });
  }
}

module.exports = { HttpServer };
