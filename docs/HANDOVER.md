# 项目交接文档（HANDOVER）

> 给下一个接手该项目的 AI / 开发者。请先完整阅读本文档，再动代码。

## 1. 项目一句话

Minecraft 仓库分类 Bot：Node.js + mineflayer 实现的自动仓库整理机器人，多 bot 实例，Web 面板（简体中文）管理，跑在 MCSManager 实例里。

## 2. 参考仓库（设计来源）

- `APRme/MULTIBOT` —— 多 bot 实例架构（BotManager / BotRuntime）、聊天/HTTP 命令分发、面板风格
- `APRme/MULTIBOT_PANEL` —— 静态前端 + 事件推送的简体中文面板模式
- `colours93/mineflayer-x` —— **26.1（协议 775）支持补丁，已 vendored 到 `src/vendor/mineflayer-x/`**（npm 上没有这个包！）
- `PrismarineJS/mineflayer`、`PrismarineJS/minecraft-data` —— bot 内核与物品/方块数据
- `dongchengqiao/superwy-reforged` —— 参考了仓库管理/区域思路（**不用它的容器预览，本项目的盘点 = 开箱识别**）

## 3. 当前进度（已完成）

| 模块 | 状态 | 说明 |
| --- | --- | --- |
| 多 bot 实例 | ✅ | `BotManager` 管理多个 `StorageBot`，每个独立连接 + 独立箱子配置 |
| 物品分类 | ✅ | minecraft-data 映射：数字 id / `minecraft:name` / 中文名三种写法，入库时规范化为 `minecraft:name` |
| 自动入库 | ✅ | 背包物品按分类存入目标箱；无匹配/目标满 → 溢出箱 |
| 批量重分类 | ✅ | 遍历源箱，分批（batchSize）取出 → 分类放入 → 任务日志（已处理/剩余/溢出新增） |
| 定时翻看源箱 | ✅ | `sourceCheckInterval`（默认 120s），源箱有物品自动触发重分类 |
| 返回点（挂机点） | ✅ | `standbyPoint`，空闲回位，寻路失败自动重试（默认 3 次） |
| 异常处理 | ✅ | 溢出箱满 → 暂停全部任务等人工；开箱失败 → 错误日志 + 跳过 |
| 库存盘点 | ✅ | 开箱识别每个箱子内容 + 汇总，API `GET /api/bots/:id/audit` |
| 仓库地图 | ✅ | 前端 XZ 俯视图，箱子分类着色 |
| 任务列表 | ✅ | 重分类任务历史/当前状态 |
| 聊天与指令控制台 | ✅ | 游戏内 `!cmd`（信任玩家）+ 面板指令框 + REST |
| 系统设置 | ✅ | config/system.json：服务器连接（应用到所有 bot 并重启）、AI API（**未接入实际调用**，仅配置项） |
| 对角区域框选 | ✅ | Web 面板「对角区域框选」操作卡：两个对角坐标 → 扫描/添加源箱或溢出箱区域（area 条目），JSON 编辑保留 |
| 26.1 协议支持 | ✅ | mineflayer-x vendored + time shim + chunk 修复 + 碰撞形状修补（26.1 数据缺 shapes，从 1.21.11 补齐） |
| 直线寻路 | ✅ | `NoDiagonalMovements`（继承 mineflayer-pathfinder 的 Movements）：只走直线/直角，不走斜线，不挖不搭桥 |

## 4. 未解决问题（重要，接手先看）

### 4.1 新服务器开箱失败（阻塞中）
- **现象**：`<服务器域名:端口>`（26.1/协议 775，与 mineflayer-x 数据一致）上，bot 已寻路站到箱子相邻格（距离 0.6~1.6、共享面），但 `openContainer` 全部 `打开容器超时(5s)`——**所有箱子都点不开**。
- **已排除**：协议版本（ping 确认 26.1/775）；寻路（pathfinder 正常到达）；位置（微调/共享面已确认）。
- **结论**：疑似服务器端插件（锁箱 LWC/Lockette、反作弊、容器权限）拦截 bot 交互。之前 `<旧服务器域名>`（同 26.1）能正常开箱。
- **需要用户**：确认服务器插件、给 bot 开箱权限、提供服务器控制台日志。
- **注意**：`openContainerAt` 的 5 秒超时是刻意加的（快速失败，避免 20s 干等）。

### 4.2 26.1 碰撞形状修补
- 26.1 的 `blocks.json` **没有 `shapes` 字段**（1.21.11 也没有），mineflayer-pathfinder 的 `Movements` 构造会读 `block.shapes[0]` 崩溃。
- 修复：`src/vendor/mineflayer-x/lib/data.js` 里用 `blockCollisionShapes.json` + 1.21.11 真实形状补齐（半砖/楼梯等）。日志：`已修补 26.1 碰撞形状: 缺失映射 N 个, 缺失形状 N 个`。
- 若以后出 26.2+ 版本，需按同样方式补数据（用户提过要支持 1.21.11 / 26.1 / 26.1.2 / 26.2）。

### 4.3 bot 浮空/无重力问题
- 服务器 26.1.2 的 `update_time` 包格式：`age` 是**数组 [hi, lo]**、`clockUpdates[].clockId` 字段名实际是 **`id`**。
- 修复：`src/vendor/mineflayer-x/lib/mineflayer.js` 的 time shim 全格式兜底（支持 age 数组 / clockUpdates id）。
- 若再出现浮空，先查这个 shim 是否被新格式绕过。

### 4.4 26.1 区块 section 缺失
- `ChunkColumn261.getBlock` 对缺失 section 返回 air（`src/vendor/mineflayer-x/lib/chunk.js`），避免 `Cannot read properties of undefined (reading 'get')` 崩溃。

## 5. 架构速览

```
index.js                    入口：加载 bots.json → BotManager → HttpServer(10260) + WsServer(/ws)
src/
  bot/
    BotManager.js            多 bot 管理、命令分发、区域 API（scan/area/delete）
    StorageBot.js            单 bot：连接/重连、自动入库、重分类任务、盘点、定时维护
    ChestService.js          寻路（mineflayer-pathfinder）+ 开箱/存取
    ReclassifyTask.js        批量重分类任务（分批处理状态机）
    ItemClassifier.js        物品分类（minecraft-data id/中文名映射）
    BoxRegistry.js           目标箱/溢出箱容量与匹配
    BotLogger.js             日志（内存环形缓冲 + 广播）
  config/
    ConfigStore.js           storage_box.json 校验/加载/热重载/normalize（point + area）
    SystemSettings.js        system.json（服务器连接/AI API/行为参数/扫描区域）
  server/
    HttpServer.js            REST + 静态前端（10260）
    WsServer.js              WebSocket /ws：snapshot / commandResult / logs / chat
  util/vec3util.js           keyOf 等
  vendor/mineflayer-x/       26.1 补丁（勿删）
public/                      无打包原生前端（index.html + app.js + app.css）
config/
  bots.json                  实例列表（服务器上实际是 MCSM 实例目录下）
  storage_box.json           箱子配置（每 bot 独立）
docs/                        文档
test/                        node:test 单元测试（npm test）
```

## 6. 部署（MCSManager 实例）

- **服务器**：<服务器IP>（宝塔面板 + MCSManager Docker）
- **实例路径**：`/<MCSM实例根目录>/daemon/data/InstanceData/storagebot1/`
- **备份路径**：`/www/wwwroot/minecraft-storage-bot/`
- **启动命令**：`node index.js`（实例配置）
- **面板端口**：`10260`（HTTP + WS 共用，`http://<服务器IP>:10260`，需宝塔放行/反代）
- **部署方式**：SSH（root / 密码 `<SSH密码>`）上传到实例目录 + `docker exec <MCSM容器名> sh -c "pkill -f 'node index.js'"` 触发 MCSM 自动重启
- **MCSM 面板登录**：宝塔账号 `<面板账号>` / 密码 `<面板密码>`（MCSM 在宝塔 Docker 里）

## 7. 使用方式（用户视角）

1. 面板 → 实例 → 操作：`自动入库`、`执行区域重分类`、`暂停/恢复/停止任务`、`重载配置`、`重启 Bot`
2. 配置页：连接配置（bots.json）、可视化表单（返回点/源箱/目标箱/溢出箱）、**对角区域框选**（两对角坐标框区域）、JSON 高级编辑
3. 游戏内指令：`!store on/off`、`!reclassify`、`!pause`、`!resume`、`!reload`、`!status`（仅 trustedPlayers）
4. 盘点：面板按钮触发，结果存内存（`GET /api/bots/:id/audit`），地图展示

## 8. 注意事项（踩过的坑）

1. **mineflayer-x 必须 `require()` 一次再 `mineflayer.createBot`**（加载时补丁），且**必须用 `require('minecraft-data')('26.1')`** 获取数据（非 26.1 版本 no-op）。
2. **不能删 `src/vendor/mineflayer-x/`**——npm 上没有 mineflayer-x 包。
3. **开箱距离与寻路**：开箱按服务器原版判定——**玩家眼睛到箱子包围盒距离 ≤3 格（interaction range，代码留 0.1 余量按 2.9）**即可，与玩家手动操作等价，不必紧贴箱子。寻路先 GoalNear(1.5)、失败放宽到 2.5、再失败时若眼睛已在 reach 内仍直接开箱（悬空/高处的箱子从下方 2~3 格正常走路就能点到）。曾为 ≤1.6 格、后 2.0 格、再后中心距 3.0（边缘位置服务器拒收），最终改为眼睛到包围盒判定。**超距（>2.9）明确拒绝**（防隔层/超距远程点击）。
4. **自动入库/任务/盘点都走串行队列**（`bot.enqueue`），禁止并发开箱/寻路（会互相打断导致 "goal was changed"）。
5. **寻路参数**：`canDig=false`、`placeCost=100`（不挖不搭桥）、`NoDiagonalMovements`（只走直线）。改寻路前先看用户明确要求（用户曾要求"完全照 apr + mineflayer-pathfinder 插件"，后又要求删除自造的候选格微调——**当前实现就是纯 pathfinder，不要加回自造寻路**）。
6. **配置保存会 normalize**：物品引用统一转 `minecraft:name`，category 自动中文。用户面板里能看到规范化结果。
7. **面板端口 10260 是用户明确指定的**（HTTP + WS 同一个端口，`/ws` 路径）。改端口要同时改 index.js 与文档。
8. **日志级别**：`minLevel` 默认 info，debug 日志面板不可见（排查时临时改 info 或降 minLevel）。
9. **AI API 目前只是配置项，没有任何实际调用**——用户可能要求接入，接手前先和用户确认用途。

## 9. 测试

```bash
npm test        # node:test 单元测试（16 个，含配置校验/分类/重分类分批逻辑/寻路兜底）
node --check src/**/*.js   # 语法检查
```

## 10. 上线清单（下次发布前核对）

- [ ] 修复 4.1 开箱问题（服务器端，需用户配合）
- [ ] 确认 26.2 支持（若需要）
- [ ] GitHub 仓库初始化 + 首次推送
- [ ] 面板 10260 公网访问（宝塔放行/反代）
