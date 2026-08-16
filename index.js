'use strict';

/**
 * Minecraft 仓库分类 Bot —— 入口
 *
 * 启动流程：
 *   1. require('mineflayer-x') 补丁（vendored 到 src/vendor/mineflayer-x，MIT 许可，
 *      因作者未发布 npm 包）：必须在创建任何 bot 之前加载，对非 26.1 服务器是安全 no-op；
 *   2. 加载 config/bots.json，创建多 bot 实例（复用 MULTIBOT 多 bot 架构）；
 *   3. 启动 HTTP 静态面板 + REST API + WebSocket（同一端口 10260，/ws 路径）；
 *   4. 连接所有 bot。
 *
 * 用法：node index.js [bots.json 路径]
 * 端口：默认 10260（可用环境变量 PORT 覆盖）
 */

const path = require('path');

// mineflayer-x 补丁必须先加载（注册 26.1 协议/数据/版本门控）
require('./src/vendor/mineflayer-x');

const { BotManager } = require('./src/bot/BotManager');
const { HttpServer } = require('./src/server/HttpServer');
const { WsServer } = require('./src/server/WsServer');

async function main() {
  const configPath = process.argv[2]
    ? path.resolve(process.cwd(), process.argv[2])
    : path.join(__dirname, 'config', 'bots.json');

  // 统一端口：HTTP 面板 + WebSocket(/ws) 共享同一端口（默认 10260，可用环境变量 PORT 覆盖）
  const PORT = Number(process.env.PORT) || 10260;

  // 1. 多 bot 管理器
  const manager = new BotManager({
    configPath,
    settingsPath: path.join(__dirname, 'config', 'system.json'),
    // 关键日志同步输出到 stdout（journalctl / 控制台排查用）
    onLog: (entry) => {
      if (entry.level === 'warn' || entry.level === 'error' || entry.level === 'info') {
        console.log(`[bot:${entry.botId}] [${entry.level}] ${entry.message}`);
      }
    }
  });
  try {
    manager.load();
  } catch (err) {
    console.error(`[启动失败] 加载 bots.json 出错: ${err.message}`);
    process.exit(1);
  }
  console.log(`[启动] 已加载 ${manager.bots.size} 个 bot 实例`);

  // 2. HTTP 面板 + REST API（同一端口承载 WebSocket）
  const http = new HttpServer({
    manager,
    publicDir: path.join(__dirname, 'public'),
    port: PORT,
    host: '0.0.0.0'
  });
  http.start();

  // 3. WebSocket 实时通道，挂载到同一 HTTP 服务（path=/ws，共享端口）
  const ws = new WsServer({ manager });
  ws.attach(http.server);

  // 4. 连接所有 bot
  manager.start();

  // 5. 优雅退出
  const shutdown = async (signal) => {
    console.log(`\n[退出] 收到 ${signal}，正在停止...`);
    try {
      await ws.stop();
      await http.stop();
      await manager.stop();
      process.exit(0);
    } catch (err) {
      console.error('[退出] 停止出错:', err.message);
      process.exit(1);
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[启动失败]', err);
  process.exit(1);
});
