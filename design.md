# 随心写作 前端设计方案（Design v1.0 + v2 修订）

> **v2 修订**（优先于正文中的对应条目，理由见 [docs/改进计划.md](./docs/改进计划.md)）：
> - §5.2 粒度切换器已取消；§5.3 浮动操作条改为块右上方、只有"编辑 / AI"两个动作；块悬停不再"浮起"成卡片。
> - §5.4 "提意见输入框"升级为统一的 AI 指令框（快捷指令、最近指令、就地配置 Key、就地报错）。
> - §5.5 diff 不再"簇内删在上、增在下"分行排布（会把一段话切成碎片），改为段内行内标注；另有"修改后 / 对照"视图；取消"全部接受"的逐簇波浪与自动提交。
> - §3.2 常驻"呼吸"只保留在生成中；待确认指示条改为静态。
> - §2.2 正文字体内置思源宋体（Noto Serif SC），不再依赖系统或 Google Fonts；次要文字令牌调整到 WCAG AA。
> - §5.8 空状态改为启动页（新建 / 打开 / 粘贴导入 / 最近文稿）。

> 设计参照：Apple Human Interface Guidelines（Clarity · Deference · Depth）、macOS Sonoma 材质体系、iOS 弹簧动效语言
> 目标：让"块级 AI 写作"这个高信息密度的工具，拥有纸张般的安静与钟表般的精确
> 对应 spec：spec.md §6（UI/UX），本方案是其动画/交互/视觉的完整展开

---

## 1. 设计哲学 — 三条铁律

### 1.1 内容称王（Deference）

正文是唯一的主角。一切 UI——工具条、按钮、状态指示——**默认退后到视觉层级最底层**，只在被需要的瞬间浮现，用完即隐。

- 正文永远比 UI 亮、比 UI 清晰、比 UI 大。
- 工具永不常驻：浮动操作条不 hover/不选中不出现；空状态没有任何多余装饰。
- 这对应 Apple 的 "The UI helps people understand and interact with the content, but never competes with it."

### 1.2 一切变化皆有因果（Clarity + Motion）

AI 写作工具最大的信任问题是"我不知道刚刚发生了什么"。动效在此不是装饰，而是**因果叙事**：

- 任何元素的出现/消失/形变，必须有可见的起点与终点（不出现凭空闪现）。
- 状态流转（阅读→编辑→diff）用**同一元素的形变**表达，而不是"旧元素消失+新元素出现"——用户眼睛追着同一个对象走，认知零成本。
- 所有过渡遵循"快入慢出"的物理直觉：响应要快（<100ms 给出第一帧反馈），落定要稳（弹簧收尾）。

### 1.3 克制（Restraint）

全应用**只有一套时长、两条曲线、三个阴影等级**。任何地方想加新动效，先用现有令牌表达，表达不了才新增。这是 Apple 设计看起来"浑然一体"的根本原因。

---

## 2. 设计令牌（Design Tokens）

全部实现为 CSS Custom Properties，深浅主题仅切换令牌值，组件零改动。

### 2.1 色彩系统

**语义化分层**，不直接引用裸色值。浅色主题为"纸张质感"，深色主题为"墨夜"。

```css
:root {
  /* ── 背景层级（由远及近） ── */
  --bg-canvas:      #f5f4f0;   /* 应用最底层，微暖灰纸 */
  --bg-sidebar:     rgba(255,255,255,0.55); /* 大纲栏：半透明 vibrancy */
  --bg-card:        #ffffff;   /* 块卡片 */
  --bg-elevated:    #ffffff;   /* 浮层（操作条/popover） */
  --bg-hover:       rgba(0,0,0,0.035);
  --bg-selected:    rgba(0,113,227,0.06);  /* 选中块底色：accent 6% */

  /* ── 文字层级 ── */
  --text-primary:   #1d1d1f;   /* Apple 标志性近黑 */
  --text-secondary: #6e6e73;   /* Apple secondary label */
  --text-tertiary:  #86868b;   /* 占位/禁用 */
  --text-on-accent: #ffffff;

  /* ── 强调色（全应用唯一 accent） ── */
  --accent:         #0071e3;   /* Apple 官网链接蓝 */
  --accent-hover:   #0077ed;
  --accent-pressed: #006edb;

  /* ── 语义色 ── */
  --success:        #34c759;   /* Apple systemGreen */
  --danger:         #ff3b30;   /* Apple systemRed */
  --warning:        #ff9500;

  /* ── diff 专用（低饱和、可长读） ── */
  --diff-del-bg:     #fee2e2;
  --diff-del-text:   #991b1b;
  --diff-ins-bg:     #dcfce7;
  --diff-ins-text:   #166534;
  --diff-cluster-focus-ring: rgba(0,113,227,0.35);

  /* ── 分隔线（hairline） ── */
  --separator:      rgba(0,0,0,0.08);
  --separator-strong: rgba(0,0,0,0.12);
}

[data-theme="dark"] {
  --bg-canvas:      #1c1c1e;   /* Apple systemGray6 dark */
  --bg-sidebar:     rgba(30,30,30,0.6);
  --bg-card:        #2c2c2e;
  --bg-elevated:    #3a3a3c;
  --bg-hover:       rgba(255,255,255,0.06);
  --bg-selected:    rgba(10,132,255,0.14);

  --text-primary:   #f5f5f7;
  --text-secondary: #98989d;
  --text-tertiary:  #636366;

  --accent:         #0a84ff;   /* Apple dark-mode 蓝 */
  --accent-hover:   #1a8fff;
  --accent-pressed: #0077ed;

  --diff-del-bg:    rgba(255,69,58,0.16);
  --diff-del-text:  #ff6961;
  --diff-ins-bg:    rgba(48,209,88,0.16);
  --diff-ins-text:  #63e68b;

  --separator:      rgba(255,255,255,0.1);
  --separator-strong: rgba(255,255,255,0.16);
}
```

**配色纪律**：
- 全应用彩色元素只有四种语义：accent（可操作/选中）、success（接受）、danger（删除/拒绝）、warning（待确认 pending）。
- pending 状态用 warning 橙做 2px 呼吸指示，不用红——红只留给"删除内容"。

### 2.2 字体系统

```css
:root {
  /* UI：跟随系统的无衬线栈 */
  --font-ui: -apple-system, "SF Pro Text", "PingFang SC",
             "Segoe UI Variable", "Microsoft YaHei UI", sans-serif;

  /* 正文：衬线，长文阅读 */
  --font-body: "Source Han Serif SC", "Noto Serif SC",
               "Songti SC", "SimSun", serif;

  /* 等宽：仅用于快捷键提示、字数统计 */
  --font-mono: ui-monospace, "SF Mono", "JetBrains Mono", monospace;

  /* 字号阶梯（1.125 比例，Apple 偏好小步进） */
  --text-caption: 11px;   /* 快捷键角标、时间戳 */
  --text-small:   12px;   /* 次要标签 */
  --text-ui:      13px;   /* UI 主体字号（macOS 标准） */
  --text-ui-lg:   15px;   /* 设置项、输入框 */
  --text-body:    17px;   /* 正文 */
  --text-title:   20px;   /* 顶栏文档标题 */
}

/* 正文排版（写作标准打磨） */
.prose {
  font-family: var(--font-body);
  font-size: var(--text-body);
  line-height: 1.8;
  letter-spacing: 0.01em;        /* 中文微字距，呼吸感 */
  color: var(--text-primary);
  text-rendering: optimizeLegibility;
  font-feature-settings: "kern", "liga";
  hanging-punctuation: first allow-end; /* 标点悬挂 */
}
```

### 2.3 间距、圆角、阴影

```css
:root {
  /* 4px 基准网格 */
  --sp-1: 4px;  --sp-2: 8px;  --sp-3: 12px;
  --sp-4: 16px; --sp-6: 24px; --sp-8: 32px; --sp-12: 48px;

  /* 圆角：连续曲率（Apple squircle 近似用较大 radius） */
  --radius-s: 6px;    /* 按钮、输入框 */
  --radius-m: 10px;   /* 块卡片 */
  --radius-l: 14px;   /* 浮层、popover */
  --radius-full: 999px; /* 胶囊（粒度切换器） */

  /* 阴影三级：离地高度 = 层级 */
  --shadow-1: 0 1px 2px rgba(0,0,0,0.04), 0 1px 6px rgba(0,0,0,0.04);          /* hover 微抬升 */
  --shadow-2: 0 4px 16px rgba(0,0,0,0.08), 0 1px 4px rgba(0,0,0,0.06);          /* 浮动操作条 */
  --shadow-3: 0 12px 40px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.08);         /* popover/toast */
}

[data-theme="dark"] {
  /* 深色下阴影让位给描边 */
  --shadow-1: 0 1px 2px rgba(0,0,0,0.3), inset 0 0 0 0.5px rgba(255,255,255,0.08);
  --shadow-2: 0 4px 16px rgba(0,0,0,0.4), inset 0 0 0 0.5px rgba(255,255,255,0.1);
  --shadow-3: 0 12px 40px rgba(0,0,0,0.5), inset 0 0 0 0.5px rgba(255,255,255,0.12);
}
```

---

## 3. 动效系统（Motion Language）— 方案核心

### 3.1 全局时钟：只有一套时长

```css
:root {
  /* 三档时长，覆盖 100% 场景 */
  --dur-instant: 100ms;   /* 状态反馈：按下、hover 变色 */
  --dur-fast:    180ms;   /* 小元素：工具条淡入、tooltip */
  --dur-base:    280ms;   /* 布局形变：块展开、面板滑动 */
  --dur-slow:    400ms;   /* 大位移：侧栏收展、粒度切换 */

  /* 两条曲线 */
  --ease-out:   cubic-bezier(0.22, 1, 0.36, 1);   /* 标准 Apple 式 ease-out：进入用 */
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);  /* 对称：往复/形变用 */

  /* 一条弹簧（CSS 线性近似；JS 驱动时用 spring 参数） */
  --spring-gentle: cubic-bezier(0.34, 1.4, 0.5, 1); /* 微过冲，无回弹振荡 */
}
```

**JS 驱动的弹簧参数**（用于块位移、操作条弹出等有质量感的元素）：

```js
// 对应 iOS SwiftUI .spring(response:dampingFraction:)
const spring = {
  snappy:  { response: 0.30, dampingFraction: 0.72 }, // 按钮、操作条
  gentle:  { response: 0.42, dampingFraction: 0.85 }, // 块卡片、面板
  bouncy:  { response: 0.50, dampingFraction: 0.62 }, // 仅 toast 成功态用一次
};
```

### 3.2 动效词汇表（每条动画的因果语义）

| 动效 | 语义 | 参数 |
|---|---|---|
| **Fade-through** | 内容切换但容器不变（阅读态→编辑态内容替换） | 旧内容 opacity 1→0（120ms ease-out）→ 新内容 0→1（180ms） |
| **Height-morph** | 同一对象长高/变矮（块三态流转） | `height` + `--dur-base` + `--ease-in-out`，配合内容交叉淡化 |
| **Lift** | 元素被"拿起"（hover 块卡片） | translateY(-2px) + shadow-1→shadow-2，150ms ease-out |
| **Slide-reveal** | 工具从内容上方"长出来"（浮动操作条） | opacity + translateY(-4px→0)，180ms spring.snappy |
| **Breath** | 等待中的活物感（AI 生成、pending 指示） | 2px 指示条 opacity 0.4↔1，1.6s 正弦循环 |
| **Cascade** | 一组相关元素入场（diff 变更簇） | 每簇延迟 40ms 依次 fade+translateY(4px→0) |
| **Sheet-drop** | toast 从顶栏下缘落下 | translateY(-100%→0) spring.gentle，离场向上收起 |

**铁律**：所有可被打断的动画（如生成中断、Esc 取消）**回退动画时长减半**——撤销永远比执行快，给"已停下"的确定感。

### 3.3 打字机（流式生成）渲染策略

SSE 字符到达频率远高于人眼阅读速度，直接逐字插入会抖动。采用**缓冲渲染**：

- 收到 chunk 写入缓冲，渲染层以 **每帧 2~4 字**（中文 120~200 字/秒观感）匀速吐出；
- 缓冲积压 >50 字时提速至每帧 8 字追平，落后则降速——像水位调节，永远顺滑；
- 每吐出一个标点（`。！？；`）做 30ms 微停顿，模拟真实打字节奏；
- 块右下角跟随一个 8px 的 accent 色圆点光标，随文字移动，`opacity` 呼吸；
- 生成完成瞬间：光标圆点缩小消失（150ms），整块内容做 height-morph 过渡到 diff 态。

### 3.4 减少动态（可访问性）

```css
@media (prefers-reduced-motion: reduce) {
  :root { --dur-fast: 1ms; --dur-base: 1ms; --dur-slow: 1ms; }
  /* 打字机改为整段出现；呼吸动画替换为静态高亮 */
}
```

---

## 4. 布局骨架

```
┌────────────────────────────────────────────────────────┐
│ Toolbar (48px, vibrancy 毛玻璃，滚动时浮现 hairline)      │
├────────────┬───────────────────────────────────────────┤
│ Sidebar    │  Column                                   │
│ 大纲树      │   ┌──────── 720px 限宽正文列 ────────┐     │
│ 240–320px  │   │  Block                            │     │
│ 可拖拽调宽  │   │  阅读态卡片流，垂直节奏 16px        │     │
│ 可收至 0   │   └───────────────────────────────────┘     │
└────────────┴───────────────────────────────────────────┘
```

- **正文列**：`max-width: 720px; margin: 0 auto; padding: 48px 32px 30vh;`（底部 30vh 留白，最后一块永远能滚到屏幕中段——Mac 写作软件的隐形礼仪）。
- **Toolbar**：48px，背景 `--bg-sidebar` + `backdrop-filter: blur(20px) saturate(180%)`。内容滚动经过其下时，底边 hairline（`--separator`）以 150ms 淡入——内容"到顶"的空间暗示。
- **Sidebar**：与正文区之间无硬分隔线，仅靠背景材质区分；拖拽调宽时 4px 宽的隐形热区，hover 显示 2px accent 指示。

---

## 5. 组件设计（含每个微交互的完整参数）

### 5.1 按钮体系

三种层级，严格对应视觉重量：

| 层级 | 用途 | 样式 |
|---|---|---|
| **Primary** | 每屏唯一主行动（全部接受、测试连接） | accent 实底 + 白字，radius-s |
| **Secondary** | 常规操作（导出、全部拒绝） | `--bg-elevated` + hairline 描边 + 主文字色 |
| **Plain** | 高频低危（工具条内图标钮） | 无框，hover 出 `--bg-hover` 圆角底 |

**按钮微交互（所有层级统一）**：

```
hover:    背景色变化 100ms ease-out（不位移、不放大）
pressed:  transform: scale(0.97)，80ms ease-out；
          松开以 spring.snappy 回弹——像实体键的回程
focus:    2px accent 外环（offset 2px），仅键盘导航时出现（:focus-visible）
disabled: opacity 0.4，无过渡，cursor: default
```

### 5.2 顶栏粒度切换器（Segmented Control）

macOS 原生分段控件的 Web 高保真复刻，**全应用手感最精的一个组件**：

- 容器：胶囊形（radius-full），`--bg-hover` 底，内边距 2px，三段：句子 / 段落 / 全文。
- **滑块（thumb）**：白色圆角胶囊 + shadow-1，位于选中项之下。切换时 thumb **不跳变，而是滑动**：
  - 用 FLIP 技术：记录旧位置 → 更新 DOM → transform 补偿 → spring.gentle 滑向新位置；
  - 滑动中 thumb 宽度从旧项宽度**形变插值**到新项宽度（两项宽度不同也顺滑）。
- 键盘 `1/2/3` 触发时，与点击走完全相同的动画路径——键盘党与鼠标党感受一致。
- 切换后正文区块边界变化：旧块 fade-out（120ms）→ 布局重排 → 新块列表 cascade 入场（每块间隔 25ms，最多 8 块后剩余直接显示，防长文档动画拖沓）。

### 5.3 块卡片（Block）— 应用的心脏

#### 状态视觉映射

| 状态 | 视觉 |
|---|---|
| clean（默认） | 无卡片感：透明背景，纯文字流，块间距 16px |
| hover | 背景浮起 `--bg-card` + radius-m + shadow-1 + 左缘露出 3px 灰色锚点；全部 150ms ease-out |
| active（选中） | 背景 `--bg-card`，左缘 2px accent 指示条（从锚点位置**伸长**而来，非淡入），底色 `--bg-selected` 极浅提示 |
| pending（待确认） | 左缘 2px warning 橙呼吸指示条 |
| dirty（未保存） | 块右上角 4px `--text-tertiary` 圆点，保存后淡出 |

**关键细节——指示条的诞生**：hover 时的 3px 灰锚点，点击选中瞬间**向下生长**为贯穿块高的 2px accent 条（height 0→100%，180ms ease-out）。用户看到的是"我抓住了这个锚点"，而不是"某处出现了根线"。

#### 浮动操作条（Floating Toolbar）

选中块后，操作条出现在块**上方居中**，悬浮于内容之上：

- 入场：slide-reveal——opacity 0→1 + translateY(-4px→0) + scale(0.96→1)，spring.snappy。
- 布局：三个 Plain 图标钮 + 快捷键角标：
  `✎ 编辑 E`　`💬 提意见 R`　`✨ 重写 T`
  （图标 14px，角标 10px `--text-tertiary` 等宽字体）
- 离场：Esc/选中他块时，反方向 120ms 收起（离场比入场快）。
- **跟随策略**：块高度变化（如展开编辑）时，操作条以 spring.gentle 跟随块顶移动，绝不瞬移。

#### 三态流转（阅读 ↔ 编辑 ↔ diff）

这是全应用最重要的动画，用**同一容器连续形变**表达：

```
阅读态 ──按 E──▶ 编辑态：
  1. 容器 height-morph 到内容新高度（280ms）
  2. 同时内容 fade-through：阅读文字淡出 → textarea 淡入（ caret 已在点击处就位 ）
  3. 容器左缘 accent 条加深 + 右上角浮现 "Esc 取消 · ⌘↵ 确认" 提示（12px tertiary）

编辑态 ──⌘↵──▶ 阅读态：
  反向 height-morph，textarea 边框收起，文字落定
```

**防跳动**：height 过渡期间容器 `overflow: hidden`，内部绝对定位的旧内容与新内容交叉淡化——布局高度与内容透明度双轨并行，任何时刻画面稳定。

### 5.4 提意见输入框

按 `R` 后，输入框从块**底部向下展开**（height-morph，280ms）：

- 视觉：与块同宽，`--bg-elevated` + hairline 描边，radius-m，内嵌 13px placeholder："对这段有什么意见？例如：压到 50 字以内"。
- 展开完成后 textarea 自动聚焦（动画结束回调内 focus，避免动画中抢夺滚动）。
- 提交（⌘↵）：输入框向上收起的同时，块内切换为打字机流式态——两个动画**无缝接力**，中间无静止帧。

### 5.5 内联 diff 视图 — 信任的舞台

#### 布局与配色

- 就地展示，不弹窗。删除：`--diff-del-bg` 底 + 删除线 + `--diff-del-text`；新增：`--diff-ins-bg` 底 + `--diff-ins-text`。
- 变更簇之间保留正常行距，簇内删除与新增**上下两行排布**（删在上、增在下），而不是同行穿插——中文逐字 diff 同行穿插会花屏。
- 每个变更簇右侧悬浮迷你 ✓/✗ 钮（16px 圆钮，success/danger 描边，hover 实底白字）。

#### 交互序列

```
生成完成 → diff 入场（cascade）：
  变更簇自上而下依次入场，每簇延迟 40ms，
  fade + translateY(4px→0)——像审阅清单逐项展开

当前簇聚焦：
  首个变更簇获得 2px accent 外发光环（--diff-cluster-focus-ring，4px blur）
  Tab 切换：光环 spring.snappy 滑向下一簇（ring 是独立绝对定位层，FLIP 移动）
  块外内容降透明度至 0.55——注意力聚焦，但保留上下文可读

接受（Y / ✓）：
  新增文本的背景绿在 200ms 内"洗"到全簇 → 绿色淡化消失 →
  文本落定为主文字色，簇高度 height-morph 收敛
  
拒绝（N / ✗）：
  新增文本整体 opacity → 0.3 + 删除线扫过（150ms）→
  簇收起，原文恢复

全部接受（Enter）：
  从当前簇开始，每簇间隔 60ms 依次执行"接受"动画，
  形成自上而下的绿色波浪——一次赏心悦目的确认仪式
```

**防花屏纪律**：同一时刻只有一个簇在执行动画；波浪中已完成簇不再变动。

### 5.6 大纲树（Sidebar）

- 节点行高 28px，缩进 16px/级；hover `--bg-hover` 圆角行底（100ms）。
- **双向定位动画**：
  - 点大纲节点 → 正文区平滑滚动（`scroll-behavior: smooth`，自定义 400ms ease-in-out 避免系统默认的匀速生硬感）→ 目标块群背景以 `--bg-selected` 做一次 800ms 的"呼吸点亮"后消退——告诉你"是这些"，但不永久标记。
  - 点块 → 大纲树对应节点展开（子树 height-morph 展开 280ms）+ 节点行短暂 `--bg-selected` 呼吸。
- 拖拽块挂到节点：拖起时块缩为 48px 高的摘要条（scale 0.9 + shadow-3），拖到节点上节点行出现 accent 插入指示线，松手时摘要条 spring.snappy 归位 + toast 确认。

### 5.7 Toast（轻提示）

- 位置：顶栏下缘居中，sheet-drop 入场，spring.gentle。
- 形态：胶囊形，`--bg-elevated` + shadow-3 + blur 底，13px 文字，左侧 14px 语义图标（成功 ✓ 绿 / 失败 ⚠ 红 / 信息 ⓘ accent）。
- 生命周期：停留 2s → 向上收起离场。多条堆叠时，旧条向上推移（spring.gentle 位移），最多 3 条，溢出合并为"还有 N 条"。
- 成功态（如"已导出"）允许使用唯一一次 spring.bouncy 入场——庆祝感用在真正完成时。

### 5.8 空状态（首屏稿纸）

```
            ┌─────────────────────────────┐
            │                             │
            │      ⌘V  粘贴开始写作         │
            │                             │
            │   或拖入 .md / .txt 文件      │
            │                             │
            │   ── 试试这段示例 ──          │
            │   「在一个没有雨的城市……」    │
            └─────────────────────────────┘
```

- 中央一张 480px 宽的"稿纸"卡（`--bg-card` + radius-l + shadow-1），虚线 hairline 边框暗示可拖入。
- 首次载入：稿纸从 opacity 0 + translateY(8px) 以 spring.gentle 浮起（仅这一次允许入场动画，之后切回空状态不重复）。
- 拖文件悬停窗口时：稿纸边框变为 accent 实线 + 底纹 `--bg-selected` 呼吸 + 文案变为"松开以导入"。
- 粘贴触发后：稿纸内容原地 fade-through 为拆块进度（细进度条 150ms 内完成的话直接跳过），然后稿纸 height-morph 展开为正文块流——**从一张纸长成一篇文章**，无跳页。

### 5.9 设置面板

- 从右侧滑入的 360px 面板（不遮挡正文中央），位移 `--dur-slow` ease-out + 背景正文区叠加 0.2 黑色遮罩（macOS 偏好侧滑设置而非模态）。
- API Key 输入框 type=password，右侧"显示"切换钮；保存成功时输入框外环绿色闪过 300ms。
- "测试连接"按钮：点击后进入 loading（文案变"测试中…"+ 圆点呼吸），成功 → 按钮短暂变绿 ✓（800ms）后复原；失败 → 按钮下方红字说明就地展开（height-morph），不弹窗。

---

## 6. 光标、选中与键盘的"隐形手感"

1. **文本选中色**：`::selection { background: rgba(0,113,227,0.18) }`——比系统默认浅，长文反复选中不刺眼。
2. **键盘块导航**：`↑/↓` 移动选中时，若目标块在视口外，滚动采用"最短距离"策略——只滚到块露出 80px 即停，不做居中大滚动（避免方向迷失）。
3. **快捷键提示**：所有快捷键角标常驻可见（不藏进 tooltip）——工具型软件的学习曲线靠可见性压平。
4. **操作条的键盘镜像**：按 `E/R/T` 瞬间，操作条上对应按钮做一次 100ms 的 pressed 缩放动画——键盘操作在界面上留下视觉回声，强化映射记忆。
5. **全局焦点环纪律**：`:focus-visible` 才显示 accent 环，鼠标点击永不出现蓝环。

---

## 7. 深色主题

- 随系统切换（`prefers-color-scheme`），切换时所有色彩令牌通过 200ms 的 `color/background-color` 过渡渐变——主题切换本身也是一次优雅过渡，不是闪烁。
- 深色下阴影权重降低，改用 inset hairline 描边分层（见 §2.3）。
- diff 的红绿在深色下降饱和提明度（见令牌表），保证对比度 ≥ 4.5:1。

---

## 8. 性能预算（动画不卡顿的工程约束）

| 约束 | 措施 |
|---|---|
| 只动画合成层属性 | 位移/缩放/透明度走 `transform` + `opacity`；height 过渡仅限单块（局部重排可接受），**绝不**对整个块流做 height 动画 |
| 5 万字首屏 | 块流虚拟化（仅视口 ±5 块挂载 DOM）；虚拟化与 height-morph 冲突时，动画期间临时完整挂载该块 |
| 打字机 | `requestAnimationFrame` 批渲染，禁止每字符一次 React setState；缓冲队列在 store 外维护 |
| 动画帧率 | 任何动画掉帧即降级：cascade 间隔缩短、呼吸动画停用 |
| backdrop-filter | 仅顶栏与 toast 使用（模糊是 GPU 大户），侧栏用纯色近似 |

---

## 9. 实现映射（React + Zustand 技术栈）

| 动效 | 实现方案 |
|---|---|
| 按钮 pressed / hover / fade | 纯 CSS transition |
| height-morph / 操作条滑入 | CSS transition + 双内容交叉淡化（自研 hook `useHeightMorph`） |
| 粒度切换 thumb 滑动 / diff 光环移动 | FLIP（自研 40 行 hook，不引库） |
| 弹簧物理 | 轻量 spring 库（如 `@react-spring/web` 仅用于操作条与 toast；或手写 rAF spring，~50 行） |
| 打字机 | rAF 缓冲渲染器（见 §3.3） |
| 滚动定位 | 自定义 rAF ease-in-out scrollTo |
| 主题切换 | CSS 变量 + 200ms transition |

**依赖纪律**：除可选的 spring 库外，不引入任何动画框架——本方案的每个动效都在 50 行以内可实现，保持 M1 骨架轻量。

---

## 10. 验收清单（"非常舒服"的客观标准）

- [ ] 所有反馈第一帧 < 100ms
- [ ] 块三态流转中正文文字零跳动（逐帧录屏验证）
- [ ] 粒度切换 thumb 滑动无瞬移、无宽度跳变
- [ ] diff 全部接受的波浪动画节奏均匀
- [ ] 打字机在 5 倍速流下依然匀速无卡顿
- [ ] Esc 中断任何动画，回退在 150ms 内完成
- [ ] `prefers-reduced-motion` 下全部动画退化为即时切换
- [ ] 深色主题切换无闪烁、diff 对比度达标
- [ ] 5 万字文档块流滚动稳定 60fps
