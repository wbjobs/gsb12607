# Markdown 脚注编辑器

纯前端（无框架）的 Markdown 脚注编辑与引用分析工具。面向需要写长文档、又希望引用关系清晰可查的用户。

## 功能

- **实时解析**：编辑时通过 Web Worker 异步解析脚注定义 `[^id]:` 与引用 `[^id]`（Worker 不可用时自动降级为主线程解析）。
- **问题检测**：
  - 循环引用（Tarjan 强连通分量，含自引用）
  - 悬空引用（引用了未定义的脚注）
  - 重复定义（同一 id 定义多次）
- **脚注列表**：预览、引用计数、跳转到定义、重命名、删除。
- **引用关系图**：Canvas 绘制，循环节点标红、悬空节点虚线标橙、重复定义粗边，点击节点跳转到定义。
- **重命名**：同步更新所有引用与定义；检测空名、非法字符、与现有 id 冲突。
- **删除**：可选择"删除定义并移除所有引用"或"仅删除定义（引用标记为悬空）"。
- **持久化**：IndexedDB 自动保存（防抖），刷新后恢复；状态带版本号，内置 v1→v2 迁移，不兼容版本安全回退。
- **导出 HTML**：生成带编号脚注、回链、悬空/重复标注的独立 HTML 文件。

## 运行

需要通过 HTTP 服务访问（Web Worker 在 `file://` 下会被浏览器拦截；此时应用仍可运行，自动降级为同步解析）：

```bash
python3 -m http.server 8000
# 打开 http://localhost:8000
```

## 结构

```
index.html        页面骨架
css/style.css     样式
js/parser.js      解析 + 图分析 + 重命名/删除（纯函数，Worker 与主线程共用）
js/worker.js      Web Worker 入口
js/store.js       IndexedDB 持久化与状态版本迁移
js/graph.js       Canvas 引用关系图
js/exporter.js    Markdown → 带脚注 HTML 导出
js/main.js        应用编排
```

## 测试

解析器、导出器、状态迁移均有 Node 断言测试，例如：

```bash
node -e "const P=require('./js/parser.js'); /* ... */"
```
