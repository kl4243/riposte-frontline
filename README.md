# Riposte: Frontline —— 浏览器 FPS（升级包）

纯 Node.js 内置服务器，无第三方 npm 依赖。包含静态页面、账号存档、公共大厅 WebSocket 中继。

## 运行要求

- Node.js >= 18
- 可对外提供 HTTP 与 WebSocket 升级（`ws://` / `wss://`）的主机

## 启动

```bash
node server.js
# 默认端口 3000，可用环境变量覆盖：PORT=8080 HOST=0.0.0.0 node server.js
```

浏览器访问 `http://<主机>:3000`。

- 开发者账号：`123456` / `123456`（ moderator，专属称号「开发者团队」）
- 数据自动保存到 `data/`（账号、会话、对局、头像），每 15 秒自动存档，异常退出有 `.bak` 快照

## 本次升级内容

1. **PC 端界面完整显示**：宽屏下主菜单 / 大厅列改为安全居中与可滚动兜底，短屏内容可滚动，底部按钮不再被裁切。
2. **修复联机无法进入游戏**：补齐缺失的中继模块 `relay.js`（公共大厅 `/serveur/:id` 与房间中继 `/room/:code`，协议版本 13）；大厅状态帧补回客户端必需的玩家列表 `j` 与房间号 `i`；房主倒计时 → 交接 → 进房链路已端到端验证。
3. **修复地图预览图不显示**：已从官方游戏（`playriposte.com`）提取 11 张真实地图预览图，放入 `maps/*.webp`（每队 1920×1080 WEBP）。`MAP_ART` 指向真实图片资源，页面不再使用程序化色块降级。
4. **修复联机房间 AI 无法占位**：房间默认配置 `ba`/`bb`（每队 AI 上限）从 `-1` 修正为 `6`，与官方服务器一致；客户端因此能正确渲染 AI 占位行并显示补位设置。房主启动对局的 `hote` 消息补发 `ba`/`bb`，确保 AI 配置完整传递到对局。
5. **稳定性加固**：WebSocket 帧大小上限、升级残留缓冲、分片 / 错误帧容错、心跳 ping/pong、断连清理、空闲大厅回收；服务端请求级兜底、限流、超时控制、进程级异常兜底与优雅退出。
6. **修复公网发布后无法登录 / 无法注册**：根因是会话只靠 `SameSite=Lax` cookie，在反向代理 / 跨站 iframe（如 WorkBuddy 网关）中第三方 cookie 被浏览器拦截，导致登录或注册成功后会话立即丢失。修复：① 登录 / 注册响应头返回 `X-Session-Token`，前端存入 localStorage，之后每次请求通过 `X-Session-Token` 头携带会话（不依赖 cookie，跨站 iframe 也能保持登录）；② 检测到经 HTTPS 反代（`x-forwarded-proto: https`）时，会话 cookie 自动升级为 `Secure; SameSite=None`，本地 HTTP 仍用 `Lax`。两种场景均已回归验证。
7. **修复跨设备联机 / 邀请码无效 / 公开房间不显示**：根因是房间 ID 格式不匹配——服务端 `srvRoomId()` 生成 4 位小写房间 ID（如 `cuw3`，符合 `/^[a-z]{3}[0-9]{1,2}$/`），但前端多处误用 5 位大写对局码正则（`/^[A-Z0-9]{5}$/`）校验房间 ID，导致：① 建房后 `SRV.id` 无法从 `nouveau` 更新为真实 ID，邀请链接显示 `?salon=nouveau`、邀请码无效；② 公开房间列表 `crees` 被错误过滤，大厅看不到房间；③ 好友用邀请链接加入时大写化 + 5 位校验走错路径。修复：统一房间 ID 正则为 `/^[a-z]{3}[0-9]{1,2}$/`（srvMsg 更新 ID、crees 过滤、URL 参数识别、netJoinCode 加入入口共 4 处）；邀请链接保留小写房间 ID，跨设备加入走 `srvJoin`。公网端到端验证：建房返回真实 ID → 出现在公开列表 → 好友用邀请码成功加入（人数 2）。

## 部署说明（重要）

- **联机与账号体系依赖本 Node 服务**：WebSocket 中继、`/api/*` 账号接口、`/salons` 大厅列表都由 `server.js` + `relay.js` 提供。
- **纯静态托管（如只托管单个 HTML）无法运行联机与账号**：只能玩单人 / 训练模式，公共大厅与登录不可用。
- 反向代理（Nginx / Caddy / 网关）需正确放行 WebSocket 升级头：`Upgrade`、`Connection`；HTTPS 页面下联机走 `wss://`。
- `data/` 目录需可写；持久化存档随主机保留，备份时一并打包。

## 文件

| 文件 | 说明 |
| --- | --- |
| `index.html` | 游戏单页（CSS / JS / 引擎全部内联） |
| `server.js` | HTTP 静态服务 + 账号 / 社区 / 对局 API |
| `relay.js` | WebSocket 大厅与房间中继（纯 Node 实现） |
| `package.json` | 启动脚本 `npm start`（即 `node server.js`） |
