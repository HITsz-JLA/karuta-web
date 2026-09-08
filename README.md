# Karuta Web

基于 [komariChikaA/karuta](https://github.com/komarichikaa/karuta) 的 **纯前端** Web 版点歌对战工具。

服务器保存管理员上传的数据包；数据集、图片、音频、对局逻辑、PDF 导出仍在浏览器本地完成（IndexedDB），适合手机 / 平板 / 桌面。

## 相对原版的改动

- **专辑打印模式**：排版时图片保持原方向，**不再旋转/翻转**横向图。
- **牌号录入**：每张牌有编号；编辑时可直接指定牌号；选卡时可输入 `1 5 12` 或 `1,5,12` 快速勾选。

## 功能概览

- 数据集新建 / 编辑 / 删除
- ZIP 数据包导入导出（兼容原版 CSV + images + music 结构）
- 服务器本地数据包目录与独立管理员上传页面
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
npm run preview
```

构建产物在 `dist/`，可直接放到任意静态站点（GitHub Pages、社团服务器等）。

更完整的部署、远程数据包格式和后续任务见 [`docs/任务交接.md`](docs/任务交接.md) 与 [`docs/部署与数据包说明.md`](docs/部署与数据包说明.md)。

## 使用提示

1. 首次使用：首页「导入 ZIP」或「新建」数据集。
2. 在「数据集」里录入作品时填写 **牌号**，可加快现场选卡。
3. 开始对局 → 选卡页用编号快速录入 → 进入对战。
4. 手机上对战按钮为大触控区域，管理面板可折叠。

## 技术栈

- Vite + React + TypeScript
- IndexedDB（`idb`）本地存储
- JSZip / PapaParse
- Canvas 生成打印 PDF（客户端）

## 致谢

桌面版逻辑与交互参考 [komariChikaA/karuta](https://github.com/komarichikaa/karuta)。
