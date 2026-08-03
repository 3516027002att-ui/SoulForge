# 设计系统（克制版）

载体：`apps/desktop/src/renderer/styles.css`。对比度标尺经 `scripts/_tmp_contrast.mjs` 求解（WCAG AA，小文本 ≥4.5:1）。改 token 后必须重跑该脚本。

## 表面与层级

- 深度策略：borders-only。普通区域用 hairline（`--line`）分隔，阴影只允许出现在浮层（cmdk、toast，`--shadow-float`）。
- 表面四级：`--forge-0` 画布/面板同色（侧栏与画布同色，hairline 分界）→ `--forge-1` 行内卡/输入底 → `--forge-2` 浮层 → `--forge-3` 叠层。逐级微亮，禁止每层都产生明显卡片边界。
- 暗色=冷钢（hue 262 低彩），亮色=和纸（hue 85 暖白）。

## 文字

- 四级墨色：ink-0 主 / ink-1 次 / ink-2 标签与元信息 / ink-3 最弱（仅 forge-0 上的短元信息）。暗 92/72/66/58，亮 26/44/48/54。
- 字体：UI 用系统栈（工具型产品，字体要"隐形"）；等宽仅用于文件名、ID、路径、代码、数值（tabular-nums）。中文操作文案不等宽。
- 中英混排规则：英文产品对象名（FMG/PARAM/EMEVD/PatchIR 等内部名在详情行）保持原文不译；动词与状态用中文；禁止半句中英混搭。

## 状态色（语义唯一来源）

- ember（余火）：唯一 accent，仅用于当前焦点、唯一主操作、选中位置标记。禁止覆盖大量普通文字。暗 L74 / 亮 L50（亮色主按钮白字 6.4:1）。
- warn：未保存、待审查、回滚动作。ok：成功、可回滚。danger：拒绝、放弃、写路径关闭、失败。
- `*-text` 变体用于小文本 AA；`--on-ember/--on-danger` 用于填充色上的前景。
- 不允许靠颜色单独传达状态：状态同时有文字或形状（如只读 pill 有文字、资源族用形状）。

## 形状与密度

- 圆角刻度：4 / 6 / 8，模态 12。默认偏小；禁止胶囊用于普通按钮与文件标签（pill 仅用于状态徽章）。
- 间距刻度：4 基准；组件内 8，相关间 12，区块 16，大分隔 24/32。表格行高收敛（行 padding 4-5px），密度优先。
- 资源族形状：实心圆 FMG / 实心方 PARAM / 菱形 EMEVD / 空心方 BND4 / 三角 script / 空心圆 只读预览。墨色承载，激活才着 ember。

## 交互状态

- hover：`--forge-hover` 微亮；active：`--forge-active`；selected：ember-soft 底 + ember 位置标记（树左侧 2px、tab 顶 2px）。
- focus：`:focus-visible` ember outline；cmdk 聚焦 `--ember-glow`（唯一 glow，语义=召唤入口）。
- disabled：opacity .45 + pointer-events none。loading：行内 spinner/typing 点，内容区用骨架而非空白。empty：真实空状态文案+下一步。error：原因+恢复路径，danger 文本。
- 动效：micro .15s / trans .22s，无弹簧；prefers-reduced-motion 全关。

## 权重预算（Squint/灰度硬约束）

- 主工作区视觉权重 > 侧栏 > Agent 面板。Agent 面板默认宽度 320，可折叠；1024 宽下默认折叠。
- 同屏 ember 大面积填充 ≤2 处（主按钮 + 激活位置标记），其余 ember 仅作 1-2px 标记或文本。
- 灰度下层级靠表面微差+hairline+字重，不靠颜色。
