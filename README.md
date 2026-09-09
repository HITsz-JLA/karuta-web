# Karuta Web

基于 [komariChikaA/karuta](https://github.com/komarichikaa/karuta) 的 Web 版歌牌对战工具。

服务器保存管理员上传的数据包；数据集、图片和本地练习资源保存在浏览器 IndexedDB，在线 1v1 由 Express + WebSocket 房间服务同步，适合手机 / 平板 / 桌面。

## 相对原版的改动

- **专辑打印模式**：排版时图片保持原方向，**不再旋转/翻转**横向图。
- **牌号录入**：每张牌有编号；编辑时可直接指定牌号；选卡时可输入 `1 5 12` 或 `1,5,12` 快速勾选。

## 功能概览

- 数据集新建 / 编辑 / 删除
- ZIP 数据包导入导出（兼容原版 CSV + images + music 结构）
- 服务器本地数据包目录与独立管理员上传页面
- 在线 1v1 歌牌对战：创建 / 加入房间、双方准备、实时抢牌、结算
- 在线页面采用闪彩风格；回合结算到下一回合开始前可拖动自己这一侧的卡面，布局只保存在当前浏览器
- 在线牌局使用真实卡面；音频按回合临时凭证从服务器数据包读取，歌名在结算后公开
- CSV 导出（含 `card_number` 列）
- 标准 / 专辑 A4 打印 PDF
- 开局选卡、空牌模式、PASS/SKIP、休息曲、管理员面板

## 开发

```bash
npm ci
npm run server
# 另开终端
npm run dev -- --host 0.0.0.0
```

```bash
npm run build
npm test
npm run lint
npm run preview
```

构建产物在 `dist/`，可直接放到任意静态站点（GitHub Pages、社团服务器等）。

更完整的部署、远程数据包格式和后续任务见 [`docs/任务交接.md`](docs/任务交接.md) 与 [`docs/部署与数据包说明.md`](docs/部署与数据包说明.md)。

## 使用提示

1. 首次使用：首页加载服务器数据包（两名玩家使用同一包）；也可「新建」本地数据集。
2. 在「数据集」里录入作品时填写 **牌号**，可加快现场选卡。
3. 本地练习：开始本地歌牌对战 → 选卡页用编号快速录入 → 进入对战。
4. 在线对战：进入「在线 1v1」，房主选择已加载的服务器数据集并选卡，分享 6 位房间码；对手加入并同步卡面后双方准备。
5. 手机上卡面为大触控区域；在线牌局中点击对应卡面抢牌，不是只显示歌名。
6. 休息阶段可拖动自己这一侧的卡面调整顺序；对手的顺序不会被改变，下一回合开始后排牌自动锁定。

## 技术栈

- Vite + React + TypeScript
- Express + `ws` WebSocket 房间服务
- IndexedDB（`idb`）本地存储
- JSZip / PapaParse；服务端按 ZIP 中央目录读取单回合音频
- Canvas 生成打印 PDF（客户端）

## 致谢

桌面版逻辑与交互参考 [komariChikaA/karuta](https://github.com/komarichikaa/karuta)。

在线大厅、房间和临时音频凭证的交互模式参考 [Sallyn0225/shinycolors-song-guess](https://github.com/Sallyn0225/shinycolors-song-guess)；本项目不复制其素材、曲库或前端界面。
