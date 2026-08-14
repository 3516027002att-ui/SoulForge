# 流光溢彩白主题实施报告(§16.2)

> 按 `锐评/deepseek.txt` §16.2 模板填写。验证日期:2026-08-14。
> 只涉及前端主题改造;未动路由、能力、IPC、治理、密度与安全边界。

## 状态

implementation-complete

## 改动文件

- `apps/desktop/src/renderer/src/styles.css`:light token 体系(四级墨色、透白表面 `--forge-0..-3`、hairline 单一接缝)、环境流光、去卡片化(§7.3)、交互态、`reduced-motion` 停流光
- `apps/desktop/src/renderer/src/App.tsx`:默认主题 light(mount 时 `dataset.theme='light'`)、设置面板「界面主题」文案与徽标
- `apps/desktop/src/renderer/index.html`:根节点 `data-theme="light"`(防首帧残留未知主题态)
- `apps/desktop/src/main/index.ts`:标题栏 `titleBarOverlay` 改流光溢彩白(`#FBFBF9`/`#383C42`),消除暗色窗口按钮区
- `apps/desktop/src/renderer/src/editors/FlverWorkbenchPanel.tsx`:选中描边 `var(--accent, #6af)` → `var(--ember)`(去硬编码蓝)
- `apps/desktop/src/renderer/src/editors/MsbScenePanel.tsx`:同上
- `apps/desktop/e2e/playwright/fixture-main.mjs`:fixture 窗口帧镜像生产 light(`backgroundColor`/`titleBarOverlay`),使 e2e 能断言「暗色窗口按钮区不复现」
- `apps/desktop/e2e/playwright/tests/renderer.spec.mjs`:主题 token、首帧、ambient、去卡片化、按钮四态等断言 + 既有断言随主题修正
- `apps/desktop/e2e/playwright/capture-shots.mjs`:补 `closeAgentPanel` + Files 域激活,重生成入库截图
- `apps/desktop/e2e/playwright/theme-capture.mjs`:(新增)1024/1440/1920/200% 尺寸证据脚本
- `docs/frontend-renovation/shots/*.png`:6 张截图(见「截图」节)

## 生产入口

- 默认主题:`App.tsx` mount 时显式落 `document.documentElement.dataset.theme='light'`,`index.html` 根节点再兜一层 `data-theme="light"`;dark 路径保留,主题切换 UI 写入同一 dataset 即可覆盖。
- ambient 实现:`body::before` + `body::after` 伪元素(首选,不改 App 组件结构;取舍说明见 styles.css:192-196 注释)。共 7 层 radial-gradient:珊瑚/薄荷/蓝/琥珀(暖冷材质感),最大 alpha `0.082`,`z-index:0` 且 `.app-root` 抬到 `z-index:1` 保证流光永远在内容之下;动画仅 transform(`translate3d`/`scale`),58s/72s `alternate infinite`;`reduced-motion` 由全局 reduce 规则(伪元素动画停到 `.01ms`)一并关闭。
- 已覆盖的 production 工作台:FMG 本地化、Flver、MSB 场景、变更队列(暂存侧栏)、Agent dock、命令面板、浏览器预览、设置面板、审计时间线、diaglog —— 全部由统一 token 驱动,无平行 demo、无假能力、无未接生产的替代组件。

## 自动验证

- `npm run typecheck`:PASS(本次现跑,exit 0)
- `npm run build`(全链,含 `-w @soulforge/desktop`):PASS(fresh build,e2e 跑在本次产物上)
- `npm run test:renderer-unit`:PASS(本次现跑,exit 0)
- `npm run test:renderer-e2e`:PASS(49 passed,0 failed,约 12.5m)
- `git diff --check`:PASS(仅 LF→CRLF 提示,无空白错误)

## 对比度抽样

按 §13.4 / WCAG AA:小字 ≥4.5:1、非文字状态 ≥3:1。以下为独立计算值(oklch→线性 sRGB→WCAG 相对亮度,非注释转述)。

| 场景 | 前景/背景 | 比值 | 结果 |
| --- | --- | --- | --- |
| 正文墨色 | `ink-0` / `--canvas` | 14.97 | PASS |
| 次级文本 | `ink-1` / `--canvas` | 7.48 | PASS |
| 三级文本 | `ink-2` / `--canvas` | 6.30 | PASS |
| 弱化文本 | `ink-3` / `--canvas` | 4.88 | PASS |
| ember 强调文字 | `ember-text` / `--canvas` | 7.06 | PASS |
| warn 小字 | `--warn` / 白 | 5.62 | PASS |
| warn-soft 底上 warn | `--warn` / `--warn-soft` 合成 | 5.44 | PASS |
| 主按钮文字 | `on-primary` / `primary-fill` | 8.75 | PASS |
| ember 状态点(非文字) | `--ember` / `--canvas` | 6.37 | PASS |
| ok 状态点(非文字) | `--ok` / `--canvas` | 5.16 | PASS |
| warn 状态点(非文字) | `--warn` / `--canvas` | 5.75 | PASS |
| danger 状态点(非文字) | `--danger` / `--canvas` | 5.85 | PASS |
| 焦点环(非文字) | `ember-text` / `--canvas` | 7.28 | PASS |

装饰性 pane hairline 实测约 1.13:1,按 spec §13.4「装饰性 pane hairline 不承担唯一识别职责,不强求 3:1」豁免(见「范围与保留」)。

## 截图

| 场景 | 尺寸(意图 / 落盘像素) | 路径 |
| --- | --- | --- |
| 空工作区(入库图) | 默认窗口 / 960×617 | `shots/final-01-empty-workspace.png` |
| 状态机写入后(入库图) | 默认窗口 / 960×617 | `shots/final-02-change-written.png` |
| 空工作区 1024 | 1024×768 / 768×576 | `shots/size-1024-empty-workspace.png` |
| 空工作区 1440 | 1440×900 / 1080×675 | `shots/size-1440-empty-workspace.png` |
| 空工作区 1920 | 1920×1080 / 1440×810 | `shots/size-1920-empty-workspace.png` |
| 200% zoom | 1280×820 ×2 / 960×615 | `shots/size-200pct-zoom-empty-workspace.png` |

尺寸档覆盖 spec §14.1「至少 1024px、1440px、1920px 和 200% zoom」;窄窗 653/768/1024/1440 的布局正确性由 e2e 断言承担,不重复造截图。

## 有限修正日志

| token/选择器 | 原值 | 新值 | 失败证据 | 修正后证据 |
| --- | --- | --- | --- | --- |
| `--warn`(light) | `oklch(55% 0.12 85)`(§5.2 基线) | `oklch(51% 0.11 80)` | §13.4 实测 warn 小字在珊瑚 ambient 热区 4.39、叠 `--warn-soft` 软底 3.99,均低于小字 4.5 门 | bare-coral 5.21、soft-coral 4.68(styles.css:136-141 注释同记) |
| 选中描边(Flver/Msb TSX) | `var(--accent, #6af)` 硬编码蓝 | `var(--ember)` | `--accent` 已不在主题 token 集,描边脱离主题 | 选中态跟随主题,ember 对比 7.28:1 |
| 其余 | — | — | 无 | 无 |

## 范围与保留

- 未改的结构/行为:路由、能力、IPC、治理状态、密度、安全边界均未动;dark 路径保留(只保证不坏,未重做);三个工作台的物理浏览流程与状态机(草稿→暂存→写入)未改。
- 保留的既有未提交修改:本任务只改主题相关文件;任务开始前的他人未提交改动未被覆盖(git status 基线已核对,本次 commit 只包含本任务文件)。
- 交给其他前端卡的问题:
  - FMG 工作台右区 entries pane header 的 `border-bottom` 与 text pane 的 `border-top` 相邻,接缝视觉呈约 2px 双 hairline(纯外观,不承担识别职责,未在本卡处理)。
  - 装饰性 hairline 对比度约 1.13:1,spec 允许不强求 3:1;若未来需要强分隔,可改为 2px 或加深 `--line`,属后续增强。

## 人工验收

- 已产出「白、静、薄、净、密、活」审查证据:默认流光溢彩白;环境流光藏在白色表面之下(58s/72s、transform-only、alpha≤0.082);常驻 pane 去卡片化、单一 hairline 接缝、浮层才有弱阴影;四级墨色小字全部 ≥4.5:1;fidelity 与密度保持(懒加载/虚拟化/滚动未被主题破坏)。
- 最终视觉结论待用户/调用方确认。
