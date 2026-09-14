# Karuta Web

基于 [komariChikaA/karuta](https://github.com/komarichikaa/karuta) 的 Web 版歌牌对战工具。

服务器保存管理员上传的数据包；数据集、图片和本地练习资源保存在浏览器 IndexedDB，在线 1v1 由 Express + WebSocket 房间服务同步，适合手机 / 平板 / 桌面。服务器曲库还可以直接在线浏览卡面并试听歌曲，无需先下载或导入整个 ZIP。

## 相对原版的改动

- **专辑打印模式**：排版时图片保持原方向，**不再旋转/翻转**横向图。
- **牌号录入**：每张牌有编号；编辑时可直接指定牌号；选卡时可输入 `1 5 12` 或 `1,5,12` 快速勾选。

## 功能概览

- 数据集新建 / 编辑 / 删除
- ZIP 数据包导入导出（兼容原版 CSV + images + music 结构）
- 服务器本地数据包目录与独立管理员上传页面
- 服务器曲库预览：在页面内切换曲库、搜索作品、筛选多曲作品、浏览卡面并按需试听单曲
- 在线 1v1 歌牌对战：随机拆分、双方选 30、互换、各自 BAN 5、各自 25 张手牌、实时抢牌与结算
- 在线页面采用闪彩风格；开局三分钟和每回合 40 秒休息阶段可拖动自己这一侧的 3×11 固定槽位，并支持随机排、按名称排、固定牌位
- 最终 50 张实牌以外随机抽取 20 首空牌歌曲，每首只出现一次；空牌回合没有对应场上卡面，点击任一卡面都会判错且不移出实牌
- 普通歌曲选错或正确收取对手牌后，由对手在 40 秒休息阶段选择一张牌交回；超时由服务端自动转牌
- 某方无需换牌的收牌结算后，或完成换牌后手牌数变为 0，该方立即获胜并结束对局
- 开局 180 秒排牌阶段和每回合 40 秒休息阶段都支持提前准备；右侧实时显示双方准备状态，开局双方准备后高亮并提示音倒计时 20 秒进入游戏，休息阶段双方准备后倒计时 5 秒进入下一回合
- 在线对战具备服务端 Ping/Pong RTT 与抖动监测、有限 RTT/2 抢牌补偿、125ms 近同时操作收集窗口；网络差距过大时禁止开局
- 在线牌局使用真实卡面；音频按回合临时凭证从服务器数据包读取，歌名在结算后公开
- 公开进行中的在线房间支持只读观战；观战者可看到双方 3×11 布局、剩余牌数、抢牌/取错/交牌动画及 A/B 双方延迟
- 音频会在进入大厅后预解锁；每回合先完整下载到本地 Cache Storage/Blob URL，双方都确认本地加载完成后才设置开始时间和启动倒计时，禁止服务器慢加载导致“只剩 2 秒才播放”；自动播放失败时提供恢复提示，休息音乐默认以 28% 音量播放，服务端支持 HTTP Range
- 选牌目录使用窗口化渲染和紧凑卡面布局；服务器卡面进入浏览器 Cache Storage，并限制内存对象 URL 数量，减少反复滚动时的网络与解码压力
- CSV 导出（含 `card_number` 列）
- 标准 / 专辑 A4 打印 PDF
- 开局选卡、空牌模式、PASS/SKIP、休息曲、管理员面板

## 环境要求

- Node.js 22（推荐）
- npm 10 或更高版本
- 支持 IndexedDB、Cache Storage 和 WebSocket 的现代浏览器

## 快速开始

安装依赖：

```bash
npm ci
```

开发时分别启动后端和 Vite：

```bash
npm run server
# 另开终端
npm run dev -- --host 0.0.0.0
```

默认开发页面为 `http://localhost:5173/`，Vite 会将 `/api` 和 `/ws` 代理到 `http://127.0.0.1:8787`。

## 环境变量

在项目根目录创建不会提交到 Git 的 `.env`：

```dotenv
HOST=0.0.0.0
PORT=8787
MAX_UPLOAD_MB=2048
ONLINE_MAX_ROOMS=100
KARUTA_DATA_DIR=data-packages
ADMIN_PASSWORD=请替换为强密码
```

`ADMIN_PASSWORD` 未配置时，服务端会生成随机密码并写入 `data-packages/.admin-password`。该目录及 `.env` 均已由 `.gitignore` 排除。

如需让 Vite 开发服务器连接其他后端，可在启动 Vite 前设置 `KARUTA_DEV_BACKEND_URL`。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动 Vite 开发服务器 |
| `npm run server` | 启动 Express + WebSocket 服务 |
| `npm run build` | TypeScript 检查并生成生产构建 |
| `npm test` | 运行服务端测试 |
| `npm run lint` | 运行 Oxlint |
| `npm run preview` | 本地预览 Vite 构建产物 |

提交代码前建议依次执行：

```bash
npm run build
npm test
npm run lint
```

## 生产运行

生产环境需要 Node 服务同时提供页面、曲库 API、音频 Range 请求和 WebSocket：

```bash
npm ci
npm run build
npm start
```

构建产物位于 `dist/`。若只部署静态文件，本地数据集功能仍可使用，但服务器曲库、管理员上传和在线 1v1 不可用。

健康检查地址为：

```text
GET /api/health
```

更完整的部署、远程数据包格式和后续任务见 [`docs/任务交接.md`](docs/任务交接.md) 与 [`docs/部署与数据包说明.md`](docs/部署与数据包说明.md)。

## 项目结构

```text
src/                 React 页面、组件和客户端逻辑
server/              Express、WebSocket、曲库与 ZIP 按需读取
public/              静态资源
scripts/             数据集辅助脚本
docs/                部署、数据包与任务交接文档
data-packages/        本地服务器曲库（不提交）
dist/                 生产构建产物（不提交）
runtime/              可选的本地 Node 运行时（不提交）
logs/                 本地运行日志（不提交）
```

## 使用提示

1. 首页的「预览曲库」可直接浏览服务器卡面并试听；需要本地练习或编辑时，再将服务器数据包导入浏览器。
2. 在线 1v1 不需要本机导入，双方直接读取服务器牌组；也可在首页「新建」本地数据集。
3. 在「数据集」里录入作品时填写 **牌号**，可加快现场选卡。
4. 本地练习：开始本地歌牌对战 → 选卡页用编号快速录入 → 进入对战。
5. 在线对战：进入「在线 1v1」，房主选择服务器牌组和至少 60 张候选牌，分享 6 位房间码；奇数会由服务器随机弃置 1 张后平分，对手加入后直接读取同一套卡面。
6. 手机上卡面为大触控区域；在线牌局中点击对应卡面抢牌，不是只显示歌名。
7. 开局排牌和休息阶段可拖动自己这一侧的卡面调整顺序；对手的顺序不会被改变，抢牌时排牌自动锁定。

## Git 与数据安全

- 不要提交 `.env`、管理员密码、SSH 密钥、运行日志或 `data-packages/` 中的曲库 ZIP。
- `package-lock.json` 和 `pnpm-lock.yaml` 属于依赖锁文件，不应加入忽略列表；团队应约定实际使用的包管理器并保持对应锁文件更新。
- 示例配置如需提交，请使用 `.env.example`，只保留变量名和安全的示例值。

## 技术栈

- Vite + React + TypeScript
- Express + `ws` WebSocket 房间服务
- IndexedDB（`idb`）本地存储
- JSZip / PapaParse；服务端按 ZIP 中央目录读取单回合音频
- Canvas 生成打印 PDF（客户端）

## 致谢

桌面版逻辑与交互参考 [komariChikaA/karuta](https://github.com/komarichikaa/karuta)。

在线大厅、房间和临时音频凭证的交互模式参考 [Sallyn0225/shinycolors-song-guess](https://github.com/Sallyn0225/shinycolors-song-guess)；本项目不复制其素材、曲库或前端界面。
