# AI Writer — 块级 AI 协作写作

> 导入 → 拆块 → 点选块 → 改（手动 / 提意见 / AI 重写）→ 内联 diff 确认 → 导出
>
> 设计铁律：**作者主权（AI 永不直接改写正文，一切 AI 产出走内联 diff 由人确认）**、手感优先、状态可移植、本地优先。

桌面应用：Tauri 2（Rust 壳）+ React 18 + TypeScript + Vite + Zustand + Immer + diff-match-patch。
详见 [spec.md](./spec.md)（产品与技术规格）与 [design.md](./design.md)（前端设计方案）。

## 快速开始

### 方式一：浏览器模式（无需 Rust，先跑起来）

```bash
npm install
npm run dev        # http://localhost:5173
```

浏览器模式下能力自动降级：文件选择用 `<input type=file>`、保存用浏览器下载、API Key 存 `localStorage`（仅开发用）、崩溃恢复存 `localStorage`。

### 方式二：桌面模式（Tauri 2）

需要本机安装 [Rust 工具链](https://www.rust-lang.org/tools/install)（stable ≥ 1.77）。

```bash
npm install
npm run tauri dev      # 开发：壳 + 前端热更新
npm run tauri build    # 打包安装包（nsis / msi）
```

桌面模式下：文件对话框走原生、API Key 写入**系统安全区**（Windows Credential Manager / macOS Keychain / Linux Secret Service，见 `src-tauri/src/main.rs` 的 keyring 命令）、崩溃恢复写入应用数据目录。

## 功能与规格对应

| Spec | 能力 |
| --- | --- |
| §4 F1 | 导入 Markdown / TXT（粘贴、选文件、拖放），`#` 标题成大纲节点，超 20 万字截断并提示 |
| §4 F2 | 句子级拆块（Intl.Segmenter），段落 / 全文为聚合视图；粒度切换 `1/2/3` |
| §4 F3 | 块选中、浮动操作条：`E` 编辑 / `R` AI 重写 / `T` 提意见 |
| §4 F4 | AI 流式产出 → 内联 diff 逐簇确认（`Tab` 切换、`Y/N` 裁决、`Enter` 全收、`Esc` 全拒） |
| §4 F5 | 大纲树 ↔ 块双向定位（点击大纲定位呼吸高亮，选中块反高亮大纲） |
| §4 F6 | 30s 自动保存 + 关闭时保存，重开提示恢复 |
| §4 F7 | 导出 Markdown / 工程 JSON（含大纲、待办、版本历史） |

## 快捷键

按 `?` 查看应用内完整快捷键表。

- 粒度：`1` 句 / `2` 段 / `3` 篇；导航：`↑` / `↓`
- 块级：`E` 编辑 / `R` AI 重写 / `T` 提意见（编辑中 `Ctrl+Enter` 确认、`Esc` 取消）
- diff 确认：`Tab`/`Shift+Tab` 换簇、`Y` 接受、`N` 拒绝、`Enter` 全部接受、`Esc` 全部拒绝
- 工程：`Ctrl+S` 导工程 JSON、`Ctrl+Shift+S` 导 Markdown、`Ctrl+Z`/`Ctrl+Shift+Z` 撤销 / 重做

## 目录结构

```
src/
  lib/        纯逻辑：断句、导入解析、diff、AI 流式、工程 IO、平台抽象（platform.ts 双轨）
  store/      Zustand + Immer：projectStore（文档/撤销重做）、uiStore（界面/浮层/待办）
  components/ 12 个展示组件（Toolbar / OutlineTree / BlockFlow / BlockCard / DiffView / …）
  styles/     设计系统：tokens（令牌）/ base / app / components
src-tauri/    Tauri 壳：main.rs（keyring 三命令）、capabilities、图标（scripts/gen-icons.mjs 生成）
scripts/     一次性工具脚本
```

## 外部 agent 续作协议

工程 JSON 自描述，任何外部 agent 可接力处理：

1. 读 `blocks[status=pending]` 与 `suggestions[state=pending]` 获得待办；
2. 外部处理后，将 `suggestions[].state` 置为 `accepted/rejected`，并按结果更新 `blocks[].text`、追加 `versions`；
3. 不认识的字段必须原样保留（forward-compatible）。
