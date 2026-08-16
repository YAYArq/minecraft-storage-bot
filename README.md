# Minecraft 仓库分类 Bot

基于 **mineflayer + mineflayer-x** 的多 bot 实例仓库分类机器人（Node.js）。

复用 [APRme/MULTIBOT](https://github.com/APRme/MULTIBOT) 的多 bot 实例架构（BotManager / BotRuntime 模式），
寻路与容器交互基于 mineflayer / [mineflayer-x](https://github.com/colours93/mineflayer-x)（vendored 补丁，支持 MC 26.1），
物品 id / 分类 / 中文名映射基于 [minecraft-data](https://github.com/PrismarineJS/minecraft-data)。

## 功能一览

| 功能 | 说明 |
| --- | --- |
| 背包自动入库 | bot 拾取物品后自动按分类移入目标箱；目标箱满 / 无匹配分类 -> 溢出箱 |
| 批量重分类（重点） | `startReclassify`：逐源箱、每批 `batchSize` 取出 -> 分类入库 -> 循环至全部源箱清空，输出任务日志 |
| 源投料箱子 | 支持多个坐标，分批取出处理，不长期存放 |
| 目标分类箱子 | 每个坐标绑定固定物品分类（可配物品 id / `minecraft:name` / 中文名） |
| 溢出箱子 | 唯一坐标，接收无匹配 / 目标箱已满物品 |
| 异常处理 | 溢出箱满 -> 暂停全部任务等人工；寻路失败/打不开容器 -> 错误日志+暂停任务；背包近满 -> 先处理背包 |
| 中文映射 | minecraft-data 物品 id/name/displayName + 内置中文词典（可扩展） |
| Web 面板 | 简体中文（参考 YAYA MCC BOT 风格），单端口 10260 承载 HTTP + WebSocket |
| 仓库地图 | XZ 俯视图展示源箱 / 目标箱 / 溢出箱 / 扫描区域，悬停查看箱子内容（开箱识别） |
| 任务列表 | 批量重分类任务：当前运行状态 + 历史记录 |
| 库存盘点 | 开箱识别：bot 逐个打开源箱 / 目标箱 / 溢出箱统计物品清单 |
| 聊天与指令控制台 | 游戏聊天实时转发 + 指令下发（入库 / 重分类 / 暂停 / 恢复 / 停止 / 重载） |
| 系统设置 | 服务器连接 / AI API / 行为参数（batchSize 等）/ 扫描区域，保存于 config/system.json |

> 说明：不提供丢弃功能，物品一律入库（目标箱或溢出箱）。

## 目录结构

```
minecraft-storage-bot/
├── index.js                      # 入口：加载 mineflayer-x 补丁 + 启动 HTTP/WS + 多 bot
├── package.json                  # 依赖清单
├── config/
│   ├── bots.example.json         # bot 实例配置示例（复制为 bots.json 使用）
│   ├── storage_box.json          # 箱子区域配置示例（源箱/目标箱/溢出箱）
│   └── system.json               # 系统设置（服务器连接 / AI API / 行为参数 / 扫描区域）
├── src/
│   ├── bot/
│   │   ├── StorageBot.js         # 单个 bot 实例：自动入库 / 指令 / 异常处理 / 重连
│   │   ├── BotManager.js         # 多 bot 管理器（复用 MULTIBOT 架构）
│   │   ├── ReclassifyTask.js     # 批量重分类任务（分批处理状态机）
│   │   ├── ChestService.js       # 容器交互：寻路 / 打开 / 取出 / 存入 / 容量
│   │   ├── ItemClassifier.js     # minecraft-data 物品 id/分类/中文名映射
│   │   └── BotLogger.js          # 环形缓冲日志器（面板实时推送）
│   ├── config/
│   │   ├── ConfigStore.js        # 箱子配置加载 / 校验 / 热重载
│   │   └── SystemSettings.js     # 系统设置（config/system.json）加载 / 保存
│   ├── server/
│   │   ├── HttpServer.js         # 静态面板 + REST API
│   │   └── WsServer.js           # WebSocket 实时日志 / 指令
│   ├── util/
│   │   └── vec3util.js           # 坐标工具
│   └── vendor/
│       └── mineflayer-x/         # mineflayer-x 补丁（vendored，MIT，支持 MC 26.1）
├── public/
│   ├── index.html                # 面板页面（简体中文，无需打包）
│   ├── app.js                    # 前端逻辑（WebSocket + REST）
│   └── app.css                   # MCSManager 风格深色主题
├── test/                         # node --test 单元测试
└── docs/DEPLOY.md                # 详细部署说明
```

## 快速开始

```bash
# 1. 安装依赖（Node.js >= 18）
npm install

# 2. 配置 bot 实例
cp config/bots.example.json config/bots.json
#    编辑 config/bots.json：服务器地址、账号、版本、箱子配置路径、信任玩家

# 3. 配置箱子区域 config/storage_box.json（示例已就绪，按需修改坐标与分类）

# 4. 启动
npm start
#    或指定配置：node index.js config/bots.json
```

启动后：

- Web 面板 + REST API + WebSocket 统一端口：<http://localhost:10260>（WS 路径 `ws://localhost:10260/ws`）
- REST API：`/api/bots`、`/api/bots/:id/config`、`/api/bots/:id/logs`、`POST /api/bots/:id/command`
- 端口可用环境变量 `PORT` 覆盖（默认 10260）

## 支持的服务端版本

版本归一化（配置里填以下任一版本均可）：

| 填写版本 | 实际连接 | 说明 |
| --- | --- | --- |
| `1.21.11` | 1.21.11 | minecraft-data 3.105.0 自带数据 |
| `26.1` | 26.1 | mineflayer-x 补丁注册（协议 775） |
| `26.1.2` | 26.1 | 26.1 补丁版，协议同为 775，自动归一化 |
| `26.2` / `26.2.x` | 26.1 | 26.x 系列协议 775 兼容，自动归一化 |

> 若某个 26.x 服务器协议号已升级（>775），需同步更新 `src/vendor/mineflayer-x` 补丁数据。
>
> **Fabric 模组服限制**：若服务器强制要求客户端安装 Fabric Loader / Fabric API / 客户端模组（登录即被踢 "This server requires Fabric Loader and Fabric API..."），纯协议 bot 无法进入。需要在服务器端关闭模组强制校验（服务端 mod 配置），或为 bot 使用原版 / Paper 服务器。

## 配置文件说明

### config/bots.json（bot 实例）

```jsonc
{
  "bots": [
    {
      "id": "bot1",                      // 唯一 id（多 bot 互不干扰）
      "host": "127.0.0.1",
      "port": 25565,
      "username": "StorageBot1",
      "auth": "offline",                 // offline | microsoft | ...
      "version": "1.21.1",               // 服务器版本（26.1 也可）
      "storageConfig": "config/storage_box.json", // 该 bot 独立的箱子配置
      "trustedPlayers": ["Steve"],       // 允许通过游戏聊天下指令的玩家
      "commandPrefix": "!"               // 聊天指令前缀
    }
  ]
}
```

### config/storage_box.json（箱子区域，示例见该文件）

- `sourceBoxes[]`：源投料箱子坐标，可多个，分批取出；
- `targetBoxes[]`：目标分类箱，每箱绑定 `items`（物品 id / `minecraft:name` / 中文名混用均可），
  只允许存放该分类物品；
- `overflowBox`：唯一溢出箱；
- `batchSize`：每批从源箱取出的数量（默认 64）；
- `freeSlotThreshold`：背包空位低于该值时停止取物、优先处理背包（默认 6）；
- `zhNameMap`：扩展中文词典（日志 / 面板显示用）。

## 游戏内指令（信任玩家）

| 指令 | 说明 |
| --- | --- |
| `!store on` / `!store off` | 开启 / 关闭自动入库 |
| `!reclassify` | 启动批量重分类任务 |
| `!pause` / `!resume` | 暂停 / 恢复任务 |
| `!stop` | 停止任务 |
| `!reload` | 热重载箱子配置 |
| `!status` | 查看当前状态 |

面板操作按钮与指令等价。

## 运行日志与异常

- 实时日志经 WebSocket 推送至面板（寻路状态、物品移入、箱子已满、错误提示）；
- 溢出箱满：暂停全部任务并输出警告，人工处理溢出箱后点「恢复任务」继续；
- 寻路失败 / 箱子被遮挡 / 无法打开容器：输出错误日志并暂停当前任务；
- 断线自动重连（最多 20 次，间隔 5s）。

## 测试

```bash
npm test        # node --test test/
npm run check   # node --check 语法检查
```

详细部署说明见 [docs/DEPLOY.md](docs/DEPLOY.md)。
