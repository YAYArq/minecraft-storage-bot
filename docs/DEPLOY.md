# 部署说明

## 1. 环境要求

- Node.js **>= 18**（建议 20/22 LTS）
- 可访问的 Minecraft Java 版服务器（或离线单机服务器）

## 2. 安装

```bash
# 进入项目目录
cd minecraft-storage-bot

# 安装依赖（首次较慢，网络差时可配置 npm 镜像）
npm install --registry=https://registry.npmmirror.com
```

依赖清单见 `package.json`：

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| mineflayer | 4.35.0 | bot 框架 |
| mineflayer-pathfinder | 2.4.5 | 寻路 |
| minecraft-data | 3.105.0 | 物品 id / 分类 / 中文名数据 |
| vec3 | 0.1.10 | 三维坐标 |
| ws | 8.18.0 | WebSocket 实时通道 |

`mineflayer-x`（MC 26.1 补丁）未发布 npm 包，已随项目 vendored 至 `src/vendor/mineflayer-x`（MIT），无需额外安装。

## 3. 配置

### 3.1 bot 实例

```bash
cp config/bots.example.json config/bots.json
```

编辑 `config/bots.json`：

```jsonc
{
  "bots": [
    {
      "id": "bot1",
      "host": "127.0.0.1",       // 服务器地址
      "port": 25565,             // 端口
      "username": "StorageBot1", // 游戏名
      "auth": "offline",         // 正版服填 microsoft；离线服填 offline
      "version": "1.21.1",       // 服务器版本；26.1 服务器填 "26.1"
      "storageConfig": "config/storage_box.json",
      "trustedPlayers": ["Steve"],
      "commandPrefix": "!"
    }
  ]
}
```

> 多 bot：在 `bots` 数组里继续追加对象（不同 id / 用户名 / 箱子配置），互不干扰。

### 3.2 箱子区域配置

编辑 `config/storage_box.json`：

```jsonc
{
  "batchSize": 64,               // 每批从源箱取出的物品数
  "freeSlotThreshold": 6,        // 背包空位低于此值暂停取物，先处理背包

  "sourceBoxes": [               // 源投料箱子（可多个）
    { "x": 100, "y": 64, "z": 200 },
    { "x": 101, "y": 64, "z": 200 }
  ],

  "targetBoxes": [               // 目标分类箱（每箱绑定固定分类）
    { "x": 120, "y": 64, "z": 200, "category": "钻石", "items": ["钻石", "diamond", 264] },
    { "x": 121, "y": 64, "z": 200, "category": "铁锭", "items": ["铁锭", "iron_ingot", 265] }
  ],

  "overflowBox": { "x": 130, "y": 64, "z": 200 },  // 唯一溢出箱

  "zhNameMap": {}                // 可选：扩展中文词典 {"中文名": "minecraft:item_name"}
}
```

说明：

- `items` 支持三种写法混用：数字物品 id（如 `264`）、`minecraft:name`（如 `minecraft:diamond`）、中文名（如 `钻石`，走内置词典）；
- 目标箱坐标必须唯一，`items` 必须能解析出至少一个物品，否则配置校验失败（日志会给出具体错误）；
- 修改配置后无需重启，在面板点「重载配置」或游戏内执行 `!reload`。

## 4. 启动

```bash
npm start
# 或
node index.js config/bots.json
```

启动输出：

```
[启动] 已加载 1 个 bot 实例
[WS] WebSocket 已挂载: ws://<host>:<port>/ws
[HTTP] 面板服务已启动: http://0.0.0.0:10260
```

## 5. 使用 Web 面板

浏览器打开 <http://服务器IP:10260>：

1. 左侧选择 bot 实例；
2. 右侧查看该 bot 的箱子配置（源箱 / 目标箱 / 溢出箱 / 绑定分类）；
3. 点击操作按钮：启动自动入库、执行区域重分类、暂停/恢复/停止任务、重载配置；
4. 底部实时日志展示寻路、移入、箱子已满、错误等事件。

> HTTP 面板与 WebSocket 共享同一端口（默认 10260，`/ws` 路径），只需在云安全组放行该端口。
> 换端口：`index.js` 中 `PORT` 环境变量，或直接改默认值；前端 `public/app.js` 自动跟随当前访问端口。

## 6. 使用游戏内指令（信任玩家）

| 指令 | 说明 |
| --- | --- |
| `!store on` / `!store off` | 开启 / 关闭自动入库 |
| `!reclassify` | 启动批量重分类任务 |
| `!pause` / `!resume` | 暂停 / 恢复任务 |
| `!stop` | 停止任务 |
| `!reload` | 热重载箱子配置 |
| `!status` | 查看状态 |

只有 `trustedPlayers` 中的玩家发言有效。

## 7. 常见问题

- **连接被踢 / 鉴权失败**：确认 `auth` 与服务器一致（离线服 `offline`），用户名未被占用；
- **版本不支持**：确认 `version` 与服务器实际协议版本一致；26.1 服务器请填 `26.1`（补丁已内置）；
- **打不开箱子**：确认目标坐标处确实是箱子/木桶/潜影盒等容器方块，且 bot 能到达（路径上无岩浆/虚空等）；
- **溢出箱满**：任务会自动暂停并输出警告，请人工清理溢出箱后点「恢复任务」或游戏内 `!resume`；
- **Windows**：使用 Git Bash / PowerShell 运行 `npm start` 均可；如需开机自启，可用 pm2：`npm i -g pm2 && pm2 start index.js --name storage-bot`。
