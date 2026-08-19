# 浏览器批注前端改造与桌面桥接降级规格

> 本文是供前端 Agent 实施的局部设计与验收规格，不是新的里程碑、进度或 authority 来源。
> SoulForge V0.5 的范围、能力状态与完成声明仍以 `docs/V0_5_IMPLEMENTATION_HANDOFF.md` 为准。
> 本文只定义前端信息架构、Agent 侧栏和浏览器预览降级行为，不授权扩大写入、权限或 native authority。

## 1. 用户目标

1. 将资源分类从左侧资源浏览器移到窗口上方，采用类似 Smithbox 的紧凑单行导航。
2. 分类由工作区顶层目录驱动，标签使用目录原名；例如只显示 `sfx`，不显示“SFX 特效”。
3. 将模型、思考强度、计划模式、权限模式及后续 Agent 专属设置移入右侧 Agent 面板，交互层级参考 VS Code Codex 插件。
4. 通用设置只保留工作区、原版目录、Patch Engine 写入边界、备份、回滚和主题。
5. 修复浏览器预览中“打开 Mod 工作区”和“选择原版目录”点击后没有可见反馈的问题。

## 2. 当前问题与已复现证据

### 2.1 导航概念混杂

`apps/desktop/src/renderer/src/App.tsx` 当前使用同一个 `WORKSPACE_MODES` 同时表达：

- 资源目录：`event`、`map`、`param`、`msg`、`menu`、`script`、`action`、`ai`、`sfx`、`chr`、`obj`、`other`；
- 格式聚合：`bnd4`；
- 应用页面：`ops`、`settings`；
- Agent 页面：`ai`。

`ResourceKind` 本身已经包含 `ai`，但 `isResourceKindMode()` 又排除了 `ai`。因此 `ai/` 资源目录和 Agent 页面发生 ID 冲突，资源目录无法作为正常资源族筛选。

### 2.2 左侧按钮墙挤占文件列表

`.mode-tabs` 位于资源浏览器内部，十余个按钮在窄窗口中换成多行，占据本应属于文件树和路径过滤的空间。中文解释与格式名重复，例如“EMEVD 事件”“SFX 特效”“角色资源”。

### 2.3 Agent 会话设置散落在通用设置

`aiProvider`、`aiThinking`、`aiMode` 位于左侧通用设置，但真正的计划、日志、上下文和输入框位于右侧 Agent 面板。用户需要在两个区域之间切换，设置与生效上下文也不在同一视线内。

### 2.4 浏览器预览没有 Electron bridge

2026-08-05 在 Codex 应用内浏览器的 `http://localhost:5173/` 复现：

- `location.protocol === "http:"`；
- `typeof window.soulforge === "undefined"`；
- `openWorkspace()` 直接读取 `window.soulforge.openWorkspaceDialog()`；
- 点击“打开 Mod 工作区”产生未捕获异常：

```text
TypeError: Cannot read properties of undefined (reading 'openWorkspaceDialog')
    at openWorkspace (.../src/App.tsx)
```

根因不是主进程目录对话框失效，而是 Vite renderer 被普通浏览器直接打开时不会加载 Electron preload。当前事件处理使用 `void openWorkspace()`，异常只进入控制台，界面没有 toast、状态或禁用原因，所以表现为“点击没反应”。

## 3. 设计方向

沿用既有设计系统，不重做配色或品牌：Precision & Density、锻造台暗色、hairline 分层、单一余火强调色（强调色只用于当前主操作与危险确认，不用于装饰）。载体是 `apps/desktop/src/renderer/src/styles.css` 的 token；对比度按 WCAG AA（小文本 ≥4.5:1），改 token 后必须重新核对对比度。视觉硬约束见 `docs/frontend-renovation/anti-ai-design.md`。

本轮的结构签名是“顶层资源根导航”：目录切换始终位于窗口上方，文件树只显示当前目录族；Agent 会话控制始终贴近右侧输入区。

明确拒绝：

- 左侧多行 pill 按钮墙；
- 中文解释与资源/目录名重复；
- 将 Agent 会话设置混入全局设置；
- 默认状态就带描边、实色底或悬浮阴影的“按钮卡片”；
- 在普通浏览器中伪造 Electron bridge 或直接读取本机目录；
- 把离线规则草稿换皮成真实本地模型。

### 3.1 按钮视觉语言

用户给出的参考是 Windows 窗口控制按钮式的低存在感控件：按钮在静止时与所在背景融为一体，只通过图标、文字和排列关系表达可操作性；鼠标悬停、键盘聚焦、选中或按下时才产生自然的层次反馈。

此规则适用于顶部资源栏、activity bar、工具栏、Agent 会话控制、标签关闭按钮和普通次级操作：

- 静止：背景透明或与父级表面相同，不显示常驻阴影，不使用厚边框，不把每个按钮包成独立卡片；
- hover：表面只比背景亮/暗一个层级，并出现短距离、低模糊度的自然阴影；
- selected/active：允许保留克制的表面差和阴影，同时使用文本、图标或细下划线表达状态，不能只依赖阴影；
- pressed：阴影收窄或转为轻微 inset，不能使用明显跳动、缩放或弹簧动画；
- focus-visible：提供独立的 1px 高对比焦点环，不能把 hover 阴影当作键盘焦点；
- disabled：降低前景对比度，无 hover 阴影，并提供不可用原因；
- destructive：关闭/删除按钮静止时保持中性，仅在 hover/focus 时进入危险色；
- 动画采用现有 `--dur-micro`，建议 120–150ms，只过渡 background、color、box-shadow。

建议增加语义 token，而不是在各组件中散落 shadow 数值：

```css
--control-rest-bg: transparent;
--control-hover-bg: var(--forge-hover);
--control-active-bg: var(--forge-active);
--control-hover-shadow: 0 1px 2px rgb(0 0 0 / 24%), 0 4px 10px rgb(0 0 0 / 14%);
--control-active-shadow: 0 1px 2px rgb(0 0 0 / 28%), 0 3px 8px rgb(0 0 0 / 18%);
```

亮色主题必须使用独立、明显更浅的阴影 token，不能直接复用暗色值。阴影仅出现在 hover/active/focus 交互态，页面静止截图中不应形成一排浮动卡片。

当前 `BrowserWindow` 使用默认原生 frame。该参考图只定义按钮视觉语言，不授权本轮为了仿制窗口控制按钮而切换 `frame: false`。若后续明确要求自绘最小化、最大化和关闭按钮，必须另行增加 main-owned 窗口控制 IPC、preload 最小暴露、关闭确认和 Electron 安全测试；renderer 不得直接获得 Electron/Node 权限。

## 4. 顶部资源目录栏

### 4.1 单一配置源

新增 `apps/desktop/src/renderer/src/navigation/resourceFamilies.ts`，从 core 已有 `KNOWN_RESOURCE_DIRS` 和扫描结果生成展示模型。禁止在 renderer 复制路径分类算法。

固定显示顺序：

```text
all  event  map  param  msg  menu  script  action  ai  chr  obj  sfx  other
```

规则：

- 标签保持目录原名和小写，不追加“事件”“地图”“文本”“特效”“角色资源”等说明；
- `all` 是功能入口，不声称为真实目录；
- `unknown` 不合并进 `other`，只在 `all` 中保留，并在存在时显示独立警告计数；
- EMEVD、MSB、FMG、TAE、BND4 等格式名称属于选中文件或编辑器标题，不属于目录栏；
- `bnd4` 不是顶层目录，不放进目录栏。选择真实 BND 文件后自动进入容器工作台，命令面板可保留“以 BND4 容器打开”；
- 设置、审计、任务历史和 Agent 都不进入资源目录栏。

### 4.2 组件与布局

新增 `apps/desktop/src/renderer/src/navigation/WorkspaceResourceBar.tsx`，置于 titlebar 下方、`.shell` 上方。

要求：

- 单行紧凑标签，不允许换行为按钮墙；
- 窄窗口采用水平滚动或末尾 overflow 菜单；
- 当前项使用余火色下划线，不使用大面积高亮胶囊；
- 数量使用低对比度等宽数字；
- 使用 `role="tablist"`、`role="tab"`、`aria-selected` 和 roving `tabIndex`；
- 支持方向键、Home、End、Enter/Space；
- 命令面板复用同一个配置源，不能维护第二套标签和顺序。

### 4.3 状态拆分

不要继续扩展 `WorkspaceMode` 字符串联合。建议拆为：

```ts
type ResourceMode = 'all' | ResourceKind;
type CenterView = 'resource' | 'settings' | 'operations';
```

- `resourceMode` 只负责文件过滤和编辑器上下文；
- `centerView` 负责中央内容；
- `sidebarView` 继续负责 explorer/search/staging/audit/settings；
- `agentOpen` 独立控制右侧 Agent；
- 删除中央 `workspaceMode === 'ai'` 的 Agent 页面，或改为非资源 ID，但不得再占用 `ai`；
- 选择顶部 `ai` 必须筛选真实 `ai/` 目录。

## 5. 左侧资源浏览器

删除 `.mode-tabs`。左侧只保留：

- 打开 Mod 工作区；
- 选择/更换原版目录；
- 当前工作区和只读原版挂载状态；
- 路径过滤；
- 当前资源目录族的文件树或列表。

当前资源模式名称和计数可在 panel header 中只读显示，但不能重新出现第二套分类按钮。

## 6. 右侧 Agent 面板

### 6.1 组件拆分

`App.tsx` 已承担过多职责。本轮至少提取：

- `apps/desktop/src/renderer/src/agent/AgentSidebar.tsx`；
- `apps/desktop/src/renderer/src/agent/AgentSessionControls.tsx`；
- 可选的 `apps/desktop/src/renderer/src/agent/AgentModelSettings.tsx`。

先使用受控 props 承接现有状态，不为本轮引入新的全局状态库。

### 6.2 信息层级

右侧 Agent 面板按以下顺序组织：

1. Header：Agent、当前模型/服务、运行状态、设置按钮、关闭按钮；
2. 可折叠会话配置：模型、思考强度、运行/计划模式、权限模式及锁定原因；
3. 会话、计划、工具调用和诊断日志；
4. 固定底部：当前文件/目录上下文、输入框、发送按钮；
5. 模型服务管理可放入 header 齿轮打开的抽屉，不占用会话滚动区域。

通用设置中删除 `aiProvider`、`aiThinking`、`aiMode` 控件，只保留工作区与安全基础设施设置。

### 6.3 权限边界

迁移控件不等于开放权限：

- 主进程仍是权限模式 authority；
- P0 期间 `plan` 锁定保持不变，并在 Agent 控件旁显示锁定原因；
- renderer 不得自行切换普通/完全权限；
- 完全权限也不能绕过 evidence、Patch Engine、验证、备份、审计和回滚；
- 不得通过 UI 默认值形成比主进程更高的权限。

## 7. “本地模型”的正确语义

当前 `AiProvider='mock'` 是离线规则计划器，不运行本地大模型。禁止只改显示文本后宣称“本地模型”。

实现要求：

- 真实“本地模型”必须来自 `listModelServices()` 返回的回环地址配置，例如 `127.0.0.1` 或 `localhost`；
- 会话选择值使用真实 `configId`，执行走现有 main-owned Agent 通道；
- 没有可用配置时显示“未配置本地模型”，不得假绿；
- 如保留 `mock`，显示名改为“离线计划”，辅助文字说明“不调用模型”；
- API key 仅在保存时传给 preload/main 加密，renderer 不回读、不记录、不回显；
- `ModelServiceSettingsPanel` 的保存、删除和脱敏 DTO 契约保持不变。

## 8. “打开工作区”按钮修复

### 8.1 运行环境契约

新增 `apps/desktop/src/renderer/src/runtime/rendererRuntime.ts`，集中判断运行表面，不允许每个组件散落 `typeof window.soulforge`：

```ts
type RendererRuntime =
  | { kind: 'electron'; bridge: SoulforgeRendererApi }
  | { kind: 'browser-preview'; bridge: null };
```

Electron 判定必须同时确认 bridge 对象和本操作所需方法存在，不能只依赖 user-agent 或 URL。

`global.d.ts` 应如实表达 bridge 在普通浏览器中可能不存在。改为 optional 后，生产调用必须通过统一 runtime boundary 获得已经收窄的 bridge，不能以非空断言掩盖问题。

### 8.2 浏览器预览行为

普通浏览器不能安全完成 Electron 原生目录选择。本轮正确修复不是接入 `showDirectoryPicker()`，而是提供明确、可访问的降级：

- 页面顶部或资源浏览器显示“浏览器预览：文件系统功能仅在 SoulForge 桌面版可用”；
- “打开 Mod 工作区”和“选择原版目录”保持可聚焦，标记 `aria-disabled="true"`；
- 点击或按 Enter 时更新 `role="status"`/toast，明确提示需要桌面版；
- 不抛异常、不产生 unhandled rejection、不保持无反馈；
- 写入、回滚、模型凭据等其他 Electron-only 操作采用同一 capability gate；
- 不注入演示工作区，不用 fixture 冒充用户真实资源。

### 8.3 Electron 行为

Electron 中保持真实流程：

1. `openWorkspaceDialog()`；
2. 用户取消时安静返回；
3. `scanWorkspace()`；
4. `analyzeWorkspace()`；
5. 更新工作区、文件、计数和状态；
6. 任一步失败时捕获并显示结构化错误，不吞异常。

`openWorkspace()`、`chooseBaseDirectory()` 不应再通过裸 `window.soulforge` 调用。即使 preload 部分缺失，也必须返回可见诊断。

### 8.4 禁止方案

- 禁止 renderer 或普通网页直接访问本机文件系统；
- 禁止为了侧边预览而创建无认证的 localhost 文件 API；
- 禁止在生产构建中伪造 `window.soulforge`；
- 禁止把 Electron 对话框失败降级成任意路径文本输入；
- 禁止以 catch 后无提示的方式“修复”控制台错误。

如果未来要让 Codex 侧边浏览器拥有完整本机能力，必须另行设计 main-owned、显式启用、身份校验、来源限制和最小权限的开发桥；不属于本轮前端修复。

## 9. 文件级实施顺序

1. `App.tsx`：拆分 resource/center/agent 状态，移除左侧 `.mode-tabs`，移除 `ai` ID 冲突。
2. `navigation/resourceFamilies.ts`：建立目录展示单一配置源。
3. `navigation/WorkspaceResourceBar.tsx`：实现顶部目录栏和键盘交互。
4. `agent/AgentSidebar.tsx`、`agent/AgentSessionControls.tsx`：迁移 Agent 控件。
5. `editors/ModelServiceSettingsPanel.tsx`：移入 Agent 设置抽屉，保持凭据边界。
6. `runtime/rendererRuntime.ts`、`global.d.ts`：建立 Electron/browser-preview capability boundary。
7. `App.tsx` 的 `openWorkspace()`、`chooseBaseDirectory()`：增加运行环境和错误反馈。
8. `styles.css`：删除 `.mode-tabs`，增加顶部资源栏、Agent 设置区和 browser-preview 提示样式。
9. Playwright fixture 与测试：覆盖目录导航、Agent 设置迁移和两种运行表面。

不要修改 Patch Engine、Bridge native writer 或主进程权限策略。

## 10. 验收标准

### 10.1 资源导航

- 左侧不存在 `.mode-tabs`；
- 顶部精确显示目录标签，页面不存在“SFX 特效”“EMEVD 事件”“角色资源”；
- 点击 `sfx` 只显示 `resourceKind='sfx'`；
- 点击 `ai` 只显示 `ai/` 资源，不打开 Agent 页面；
- `unknown` 未被合并或隐藏；
- BND 文件仍能进入容器工作台；
- 653×694、768、1024、1440 宽度均保持单行导航和可操作性。

### 10.2 Agent 面板

- 通用设置不再出现模型、思考强度和权限模式；
- 右侧 Agent 面板包含模型、思考强度、计划/运行模式、权限及锁定原因；
- 折叠再打开后会话设置不丢失；
- 发送请求使用界面当前显示的设置；
- `mock` 不显示为真实本地模型；
- renderer 无法通过控件抬高主进程授权。

### 10.3 打开按钮

- 普通浏览器打开 renderer 时不出现 `window.soulforge` TypeError；
- 点击两个目录按钮都有明确的浏览器预览提示；
- 浏览器控制台无 page error/unhandled rejection；
- Electron fixture 中目录对话框、扫描和分析流程仍可执行；
- 用户取消目录对话框不显示错误；
- preload 缺方法时返回可见、结构化的能力不可用诊断。

### 10.4 按钮视觉

- 静止状态下顶部资源、activity bar 和次级工具按钮与所在背景融为一体；
- hover 时才出现自然的低层阴影和轻微表面差；
- selected/active 状态具有稳定但克制的层次，不出现厚边框或高饱和实色胶囊；
- pressed 状态不会跳动或放大，阴影正确收窄；
- 键盘 focus-visible 清晰可见，并与 hover/selected 可区分；
- disabled 状态不会触发阴影，且屏幕阅读器能获得不可用原因；
- 亮色和暗色主题都没有脏灰、过黑或大面积扩散阴影。

## 11. 测试计划

更新 `apps/desktop/e2e/playwright/tests/renderer.spec.mjs` 和 fixture：

- 将 `.mode-tabs` 断言改为顶部资源栏；
- 增加 `event/`、`msg/`、`action/`、`ai/`、`sfx/`、真实 BND 外形的微小合法 fixture；
- 验证目录切换、AI ID 不冲突、BND 上下文打开；
- 验证设置页和 Agent 面板的控件归属；
- Electron fixture 验证 `workspace.openDialog` 调用和取消路径；
- 新增无 preload 的 browser-preview 用例，监听 `pageerror` 和 console error；
- 验证键盘 Tab、方向键、Enter、Escape、焦点可见性和窄屏滚动。
- 对顶部资源栏和代表性工具按钮保存 rest、hover、active、focus-visible 四态截图，检查阴影只在交互态出现；
- 在暗色、亮色主题分别读取代表性按钮的 computed background、box-shadow 和 outline，防止主题 token 串用。

建议执行：

```powershell
npm run typecheck
npm run test:ui-localization
npm run test:desktop-security
npm run build -w @soulforge/desktop
npm run test:renderer-playwright -w @soulforge/desktop
npm test
npm run build
```

`npm run test:desktop-ipc-contract` 也应执行；如果仍命中既有 `ai:agent:event` subscribe/invoke 分类假红，必须单独如实记录，不能通过删除断言或跳过测试掩盖。

## 12. 非目标与完成声明

- 不在本轮接入新的本地模型运行时；
- 不扩大 Agent 权限；
- 不新增 browser-to-filesystem 写通道；
- 不重做全部编辑器、主题或品牌；
- 不解决 FMG 非分页快照旁路、DCX 全量扫描超时等独立问题；
- 不把 UI、fixture 或 browser-preview 通过写成 native、真实模型或发布完成。

实现 Agent 完成后应提供实际变更文件、浏览器与 Electron 双表面验证结果、截图，以及所有未执行或失败的验证；不得只报告“按钮可点击”或静态构建通过。
