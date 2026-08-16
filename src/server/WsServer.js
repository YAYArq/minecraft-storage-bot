'use strict';

const { WebSocketServer } = require('ws');

/**
 * WsServer —— WebSocket 实时通道（面板 <-> 后端）
 *
 * 挂载在 HttpServer 的同一个 HTTP 服务上（共享端口，path = /ws），
 * 无需单独开放端口；前端连接 ws://host:port/ws。
 *
 * 协议（JSON 文本帧）：
 *   服务端 -> 客户端：
 *     { type: 'snapshot', bots: [...] }              初始全量快照
 *     { type: 'log', entry: {...} }                  实时日志
 *     { type: 'status', bot: {...} }                 状态变化
 *     { type: 'commandResult', botId, ok, message }  指令回执
 *   客户端 -> 服务端：
 *     { type: 'command', botId, command, args? }     下发指令
 *     { type: 'ping' }                               保活
 */

class WsServer {
  /**
   * @param {object} options
   * @param {import('../bot/BotManager').BotManager} options.manager
   * @param {string} [options.path='/ws'] WebSocket 路径
   */
  constructor(options = {}) {
    this.manager = options.manager;
    this.path = options.path || '/ws';
    this.wss = null;
    this.clients = new Set();
  }

  /**
   * 挂载到已创建的 HTTP server 上（共享端口）。
   * @param {import('http').Server} server
   */
  attach(server) {
    this.wss = new WebSocketServer({ server, path: this.path });
    console.log(`[WS] WebSocket 已挂载: ws://<host>:<port>${this.path}`);

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      // 新客户端：先推送全量快照
      this.send(ws, { type: 'snapshot', bots: this.manager.getSnapshots() });

      ws.on('message', (raw) => {
        this.handleMessage(ws, raw);
      });
      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
    });

    // 订阅所有 bot 的日志与状态变化，转发给全部客户端（链式调用，保留外部监听）
    const prevLog = this.manager.onLog;
    const prevStatus = this.manager.onStatus;
    const prevChat = this.manager.onChat;
    this.manager.onLog = (entry) => {
      if (prevLog) prevLog(entry);
      this.broadcast({ type: 'log', entry });
    };
    this.manager.onStatus = (snapshot) => {
      if (prevStatus) prevStatus(snapshot);
      this.broadcast({ type: 'status', bot: snapshot });
    };
    this.manager.onChat = (chat) => {
      if (prevChat) prevChat(chat);
      this.broadcast({ type: 'chat', chat });
    };
  }

  async stop() {
    if (this.wss) {
      for (const ws of this.clients) {
        try { ws.close(); } catch (e) { /* ignore */ }
      }
      await new Promise(r => this.wss.close(r));
      this.wss = null;
    }
  }

  handleMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch (e) {
      return this.send(ws, { type: 'error', message: '非法 JSON' });
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'ping') {
      return this.send(ws, { type: 'pong', ts: Date.now() });
    }

    if (msg.type === 'command') {
      const { botId, command, args } = msg;
      if (!botId || !command) {
        return this.send(ws, { type: 'commandResult', botId, ok: false, message: 'botId 与 command 必填' });
      }
      const result = this.manager.dispatch(botId, command, args);
      return this.send(ws, { type: 'commandResult', botId, ...result });
    }

    this.send(ws, { type: 'error', message: `未知消息类型: ${msg.type}` });
  }

  send(ws, payload) {
    try { ws.send(JSON.stringify(payload)); } catch (e) { /* ignore */ }
  }

  broadcast(payload) {
    const text = JSON.stringify(payload);
    for (const ws of this.clients) {
      try { ws.send(text); } catch (e) { /* ignore */ }
    }
  }
}

module.exports = { WsServer };
