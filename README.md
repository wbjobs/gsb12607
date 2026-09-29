# 脚注工坊 — 无框架 Markdown 脚注编辑器

面向长文档写作者的脚注工具：实时解析脚注与引用、可视化引用关系、检测
循环 / 悬空 / 重复，支持跳转、批量重命名、安全删除与带脚注 HTML 导出。
不使用任何框架，仅用原生 DOM、IndexedDB、Web Worker 与 Canvas。

## 运行

需要通过 HTTP 提供（ES Module + Module Worker 不支持 `file://`）：

```bash
python3 -m http.server 8000
# 打开 http://localhost:8000
```

Worker 若因环境无法启动，会自动回退到主线程解析。

## 测试

纯逻辑模块不依赖 DOM，可直接在 Node 中运行：

```bash
node tests/test.mjs
```

## 功能

- 实时解析：`[^label]` 引用、`[^label]: 定义`（含 4 空格 / Tab 多行延续）。
- 脚注列表：按正文首次引用编号，显示引用数、重复与循环标记。
- 关系图（Canvas）：正文节点 + 脚注节点，body 内引用为节点间有向边；
  力导向布局，可拖拽、缩放、平移，点击节点跳转。
- 问题检测：
  - 循环引用（Tarjan 强连通分量 + 回环路径提示，自引用也覆盖）；
  - 悬空引用（有引用、无定义）；
  - 重复定义（同名多条，首个为主定义）；
  - 未被正文引用的定义（信息级）。
- 跳转：Ctrl/⌘+点击引用跳到定义；Alt+← 返回；F2 重命名。
- 重命名：同步替换所有定义与引用；冲突（目标标签已存在）直接拒绝。
- 批量重命名：正则生成或逐行编辑，非法/冲突行标红后才允许提交。
- 删除定义：可选“保留引用（变为悬空）”或“连同引用一起删除”；
  重复定义可只删其中一条；悬空引用可一键创建定义或删除引用。
- 导出：独立内联样式 HTML，正文引用为编号上标，脚注区带回跳链接。

## 状态与迁移

- 状态序列化到 IndexedDB（库 `fn-markdown-editor`，store `kv`，键 `state`），
  含文档文本、光标、滚动位置、当前侧栏 Tab 与关系图视口；防抖自动保存。
- 当前结构版本 `v2`（见 `js/state.js`）。
  `v1` 旧结构 `{version,content,cursor,scrollTop,activeTab}` 自动迁移；
  高于当前版本的数据按兼容模式读取并提示，不丢弃可识别字段。
- “清除存储”会删除记录并重置为示例文档。

## 模块结构

```
js/footnotes.js       解析、编号、Tarjan 循环检测、图模型（纯逻辑）
js/edits.js           重命名/批量重命名/删除/创建的 range 编辑规划（纯逻辑）
js/exporter.js        Markdown -> 带脚注 HTML（纯逻辑）
js/state.js           状态结构、归一化、v1 -> v2 迁移（纯逻辑）
js/db.js              IndexedDB 读写
js/parser-client.js   Web Worker 封装与主线程兜底
sw/parser.worker.js   后台解析线程
js/graph.js           Canvas 力导向关系图
js/editor/highlight.js textarea 镜像高亮层
js/ui/                面板、命令对话框、DOM 工具
js/app.js             编排入口
```
