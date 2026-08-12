# SoulForge 全局前端实施规范

> **最高优先级产品决定**
>
> SoulForge 的常规编辑器前端不再自行设计。以本机 `tools` 目录中 Smithbox（PARAM、GPARAM、Text、Map、Model、Texture、Material、通用 File Browser）与 DarkScript3（Event）为默认实现规范；Agent dock 照搬用户提供的 TRAE/Cursor 式参考截图。实施 Agent 不得“参考后重新设计”、现代化简化、改成卡片式网页界面，或用现有 SoulForge 组件反向限制目标结构。
>
> 本文的各栏结构与比例是**实施前初值**。真实权威是 §2.4 的 REF-01 实测清单：Agent 必须亲自打开参考程序测量并记录 §2.4 的全部项目。实测结果与本文初值冲突时，以实测为准，并在同一张 UI 卡内同步更新本文对应规格与 §19.2 勾选项，使差异归入 §1.2；不得静默保留两套互相矛盾的结构规格。
>
> 本文件是低推理能力实施 Agent 的机械操作手册。本文中的“必须 / 不得”分别等价于 `MUST / MUST NOT`。
>
> 本文件不是 release、Gate、authority、Evidence 或进度来源，也不增加任何代码实施前置门槛。是否允许修改由当前任务调用方和仓库更高优先级规则决定；实施 Agent不得从本文推导额外的实施阻塞条件。

---

## 0. 文档目的和使用方法

### 0.1 目标用户

目标用户是长期处理 Sekiro PARAM、GPARAM、FMG、EMEVD、BND4、Lua/HKS、地图和资产的 Mod 作者。他需要的是高密度、精确、低噪音的桌面生产工具，而不是项目仪表盘、证据展示站或围绕 AI 对话组织的网页应用。

日常任务应遵循稳定的领域选择链：

```text
领域
→ 逻辑库 / bank / document
→ table / event / entry
→ row / field / cursor
→ edit / compare / review / commit / rollback
```

### 0.2 实施者必须按此顺序工作

1. 打开第 2 节指定的本机成熟工具，观察对应页面并保存参考截图。
2. 阅读当前生产入口；不得只新增平行组件而不替换错误生产路径。
3. 按第 18 节的技术依赖顺序实施；这些编号只是本文内部的工程步骤。
4. 先写负向测试和数据契约，再实现最小改动。
5. 逐条运行卡片测试；失败时停在当前技术问题，不跨卡“顺手修复”。
6. 保存参考工具与 SoulForge 的同尺寸对照截图。
7. 分别报告 `implementation-complete`、`fixture-confirmed`、`native-verified`；不得互相替代。

本文不定义、也不要求任何“专用前端治理 slice”。没有 `gov next`、`claim`、同名条目匹配或 `blocked-by-governance-no-matching-slice` 步骤；这些编号全部是收到实施请求后直接执行的技术步骤。

### 0.3 本规范取代哪些旧条款

本文件取代 `docs/frontend-renovation/browser-feedback-spec.md` 中以下命令式结论。治理体系曾以该旧规格的结论为理由封存证据（`evidence.jsonl` 存在对 `browser-feedback-spec.md` 的引用）；实施本文件会改变那些结论对应的产品结构，但本文件不解除或重封任何治理证据。实施前由调用方先核查治理 Gate 是否因旧规格结论失效而变红，并按治理流程处理，不得由 flash Agent 自行改治理数据：

- 以 `event / map / param / msg / menu / action` 等物理顶层目录作为一级导航；
- 以物理文件数量作为领域数量；
- 以目录名优先选择编辑器；
- 在所有语义领域复用同一个物理资源浏览器；
- 旧右侧 Agent 管理控制台；
- 文件级顺序和文件级数量验收；
- 任何要求 Agent 独立窗口或从主窗口移除 Agent dock 的条款。

继续保留旧文档中不冲突的 Electron/browser-preview 安全降级规则：普通浏览器没有 preload 时，不得伪造 `window.soulforge`、本地文件访问、Bridge 或写入能力。

若旧文档、现有代码、测试快照与本文冲突，以本文的目标产品结构为准。调用方已经要求实施时，Agent 在调用方给定范围内直接开始本文步骤。

旧 `browser-feedback-spec.md` 的逐节处理固定如下，实施 Agent 不得自行调和：

| 旧章节 | 处理 |
| --- | --- |
| §1、§3、§4、§5 的顶层目录导航、物理计数和“所有领域共用资源浏览器” | **失效**，由本文 §3–§5、§16、§18.9–§18.13 取代 |
| §6、§7 中 Agent 顶栏、常驻控制台、模型/权限信息层级与 placement | **失效**，由本文 §12、§18.20 取代；凭据仍只由 main 保存和脱敏 |
| §8 Electron/browser-preview capability boundary | **保留**；无 preload 时必须显示桌面专属反馈，不得伪造本地能力 |
| §9 文件级实施顺序 | **失效**，由本文 §18 技术 DAG 和原子卡取代 |
| §10.1、§10.2 目录导航与旧 Agent 验收 | **失效**，由本文 §19 取代 |
| §10.3、§10.4 与 §11 中 browser-preview、键盘、focus 和按钮视觉纪律 | **保留不冲突部分** |
| §12 不扩大权限、不伪造 native/发布完成 | **保留** |

`docs/V0_5_IMPLEMENTATION_HANDOFF.md` 中“EMEVD 四视图”只作为旧可见投影描述失效；底层 DSL、revision、typed mutation、Bridge/Patch Engine 和现有能力边界继续保留。本文改变的是默认前端工作流，不删除底层能力，也不改写其他文档记录的发布状态。

**四视图与治理状态冲突：** 治理侧存在大量 `completed` 切片把四视图 controller 作为 production 写链入口（`submitEmevdDslPlanViaFourView`、`commitEmevdPlanViaPatchEngine` 经四视图 UI 接线，`test:emevd-four-view` 是 `W-EMEVD-DSL-01` 的 requiredValidation）。本文 §16 与 EVENT-30B 要求把四视图从 production 断开——这与已封存的 completed 切片表述冲突。**这不是本文能消化的矛盾**：实施 EVENT-30A/B 前，须先经治理流程取得一次正式的 scope 裁定（`scope.json` 延期/改写条目或新切片），把“四视图 UI 从 production 默认入口改由 DarkScript3 式 source editor 取代，底层 typed 写链保持不变”登记为已裁定事项；未取得裁定时，断开四视图 UI 的动作不得执行，flash Agent 不得自行改治理数据或宣布旧切片失效。

---

## 1. 不可突破的产品结论

### 1.1 常规编辑器默认照搬 Smithbox

以下编辑器必须以 Smithbox 为默认实现规范，而不是灵感来源：

```text
PARAM
GPARAM / Graphics Param
Text / FMG
Map
Model
Texture
Material
通用 File Browser
```

“基本照搬”具体包含：

- 相同的编辑器职责划分；
- 相同的栏位数量与从左到右顺序；
- 相近的默认栏宽比例；
- 相同的搜索框和低频工具所在区域；
- 相同的列表、表格和属性编辑密度；
- 相同的父子选择链；
- 相同的整行选中、焦点、hover 和滚动模型；
- 相同的多文档、dirty、只读和工具折叠位置；
- 相同的“列表是列表、表格是表格、属性是属性”桌面工具构图。

其中“栏位数量、顺序、默认比例”的最终值以 §2.4 REF-01 实测清单为准（见文首产品决定块与 §2.4 步骤 8）。

实施 Agent 不得：

- 观察 Smithbox 后自行重新设计；
- 以“更现代”为由减少栏位或移动工具；
- 把 pane 改成圆角卡片；
- 把专业工作台堆叠成移动端卡片；
- 用大标题、欢迎页、统计卡或证据卡占据编辑区；
- 因现有 SoulForge 组件不兼容而保留错误结构；
- 只模仿配色而忽略信息架构和操作顺序。

### 1.2 允许与 Smithbox 不同的项目

只有以下差异无需复制 Smithbox：

1. SoulForge 名称、图标和现有钢铁 / 灰烬 / 和纸 / 余火 token。
2. 主窗口右侧 TRAE/Cursor 式 Agent dock。
3. Problems、Change Review、备份、验证、恢复和自动回滚。
4. 未获得真实 read/write 能力的入口必须隐藏、只读或失败关闭。
5. 不复制第三方源码、品牌、图标、素材、字符串和受限元数据。
6. renderer 无文件系统权限、main-owned 状态、Bridge/Patch Engine 安全边界。

除上述六项外，实施者没有另行设计的权限。

### 1.3 明确禁止的当前产品形态

以下形态一律视为阻断错误（结构类条目的判定基准随 REF-01 实测更新，见文首产品决定块）：

- 顶部显示 `PARAM 36`，其中 36 是磁盘文件数；
- PARAM 第一栏列出 `param/drawparam/*.gparam.dcx`；
- `.bak/.prev` 出现在普通资源列表、搜索、标签或当前文档；
- GPARAM 文件被送入 PARAM Editor；
- PARAM 只有三栏，缺少 Tools；
- Text 因 `menu/` 路径接收 TPF；
- EMEVD 默认显示“四视图”；
- Evidence、Hex 或 parser dump 常驻日常编辑器；
- Agent 显示模型管理、工具库存、会话计数和任务控制台；
- 一个资源同时渲染多个编辑器；
- 巨型错误卡清空整个工作台。

### 1.4 本机工具、metadata、Oodle 与语料边界

- Smithbox、DarkScript3、Yapped、Yabber 和 HKS 工具只用于公开 UI/行为/格式家族对照；不得反编译、复制源码、程序集资源、品牌图标或受限字符串；
- 不得把真实游戏资产、用户 Mod、私有 corpus、Oodle DLL、凭据、证书或签名私钥提交到仓库、测试 fixture、staging 或安装包；
- Oodle 只能从用户本地只读 base runtime 解析并由 main/Bridge 使用；不得复制到 Mod 工作区。KRAK 写缺少合规 compressor 时必须失败关闭；
- 外部 metadata 只能由用户本地导入；必须记录 game/tool 版本、digest、license 和 provenance。版本或 digest 不匹配时允许只读诊断，禁止写；
- synthetic fixture 必须微小、合法构造并明确标记；fixture 只能验证结构实现，不能替代真实 native corpus roundtrip；
- 原版游戏根始终只读；数据库、缓存、日志、备份和恢复元数据不得写入 Mod 工作区；
- writer/converter 只写 main-owned staging；用户 Mod 的最终 create/replace/delete 只能由 Patch Engine 执行。

---

## 2. 强制 UI 参考库

### 2.1 当前机器的参考根

当前机器上已经存在成熟 Sekiro 工具：

```text
D:\mystream\Sekiro Shadows Die Twice\tools
```

这些程序只用于观察 UI、行为、格式家族和工作流。它们不是 SoulForge runtime 依赖，不得被修改、复制进仓库、打进安装包或用来绕过 Bridge/Patch Engine。

### 2.2 主参考程序

| SoulForge 页面 | 必须先查看的参考程序 | 参考内容 | 结构权威性 |
| --- | --- | --- | --- |
| PARAM | `D:\mystream\Sekiro Shadows Die Twice\tools\smithbox\Smithbox-2.2.4-2026-07-24-a\win-x64\Smithbox.OpenGL.exe` | Param Editor 四栏、列表密度、字段值、Tools | 真实 Smithbox：Params→Rows→Fields 是选择链；Tools 以 Smithbox 实际入口与折叠方式为准（本文初值：PARAM/GPARAM/Text 各四栏，见 §7.1/§8.1/§9.1） |
| GPARAM | 同一 Smithbox | Graphics Param Editor 的 bank/group/value 层级 | 真实 Smithbox 实际 pane 结构，以 REF-01 实测为准（本文初值：Banks/Groups/Fields-Values/Tools） |
| Text | 同一 Smithbox | Text Editor 的语言、容器、FMG、正文和 Tools | 真实 Smithbox 实际 pane 结构，以 REF-01 实测为准（本文初值：Languages-Containers-FileList/Entries/Content/Tools） |
| Map | 同一 Smithbox | 资源树、viewport、inspector、tools | 真实 Smithbox 实际布局，以 REF-01 实测为准 |
| Model | 同一 Smithbox | 模型资源树、viewport、属性检查 | 真实 Smithbox 实际布局，以 REF-01 实测为准 |
| Texture | 同一 Smithbox | 纹理列表、预览、metadata/tools | 真实 Smithbox 实际布局，以 REF-01 实测为准（Texture 无 viewport，不套用“Resource Tree | Viewport | Inspector | Tools”通用四栏） |
| Material | 同一 Smithbox | 材质列表、属性和值编辑 | 真实 Smithbox 实际布局，以 REF-01 实测为准（Material 无 viewport） |
| Files | 同一 Smithbox | File Browser 的物理层级和操作密度 | 真实 Smithbox 实际布局，以 REF-01 实测为准 |
| Event | `D:\mystream\Sekiro Shadows Die Twice\tools\事件编辑器3.4.1\DarkScript3.exe` | 源码、大纲、查找、跳转、诊断和多文档 | DarkScript3 实际布局，以 REF-01 实测为准（本文初值：Files/Outline 260px + Source + optional Inspector 320px） |
| Agent | TRAE/Cursor 式 Agent dock | 顶栏、空闲态、消息流、底部 composer | 依赖用户提供的 TRAE 参考截图；**该参考图目前不在 `tools` 目录或仓库内，且未在 REF-01 的实测范围内**。若拿不到参考图：§12 的结构初值不可用来宣布「与 TRAE 一致」；「未对照实测」的口径必须在 AGENT-60A 报告中声明，并由调用方决定是补参考图实测、接受初值作为产品决定，还是暂停本卡。任何情况下不得由 flash Agent 自行宣布构图已与 TRAE 一致 |

Smithbox OpenGL 无法启动时，允许使用：

```text
D:\mystream\Sekiro Shadows Die Twice\tools\smithbox\Smithbox-2.2.4-2026-07-24-a\win-x64\Smithbox.Vulkan.exe
```

### 2.3 次级对照工具

| 工具 | 目录 | 允许的对照用途 |
| --- | --- | --- |
| Yapped Rune Bear | `D:\mystream\Sekiro Shadows Die Twice\tools\Yapped Rune Bear v2.14.1` | PARAM 行/字段交互的次级核对 |
| Yabber | `D:\mystream\Sekiro Shadows Die Twice\tools\Yabber 1.3.1\Yabber.exe` | BND/DCX 容器层级和操作结果的次级核对 |
| DSLuaDecompiler | `D:\mystream\Sekiro Shadows Die Twice\tools\hks解码\DSLuaDecompiler.exe` | Script 格式与只读反编译工作流对照 |

次级工具不得覆盖 Smithbox/DarkScript3 的主 UI 结论，也不得成为 production parser/writer authority。

### 2.4 每张 UI 卡的强制参考流程

实施任何编辑器前必须完成以下步骤：

1. 验证参考程序路径存在。若路径变化，先在同一 `tools` 根下按程序名查找。确实找不到时：结构类实施（§6–§11 的 pane 数、顺序、栏宽、行高、Tools 入口）暂停，把缺失报告给调用方，由调用方提供参考截图或实测清单后继续——结构未实测前不得实现，也不得以本文初值顶替实测；与结构无关的卡（类型、decoder、IPC、native read、测试）不受影响，继续推进。不得把“参考路径变化”当作停止全部实现的理由，也不得在无实测时宣称已与参考程序一致。
2. 启动参考程序，打开对应编辑器。
3. 只读观察，不在参考工具中保存游戏或 Mod 文件。
4. 记录以下项目：
   - pane 数量；
   - pane 从左到右顺序；
   - 默认宽度与最小宽度；
   - 标题、过滤框和工具按钮位置；
   - 表头、行高、列对齐和省略规则；
   - 选中、hover、focus、disabled、readonly 和 dirty 状态；
   - 各 pane 独立滚动边界；
   - 键盘方向键、Enter、Escape、搜索和快捷键行为；
   - 空表、无匹配、失败和部分解析状态；
   - 与本文 §6–§11 初值不一致的结构项（pane 数、顺序、栏宽、行高、Tools 入口）逐一记录差异。
5. 把参考截图保存到当前任务运行器的临时/交付产物区，不写入仓库，也不把截图自动登记成发布或能力证明。
6. 以相同窗口尺寸保存 SoulForge 对照截图。
7. 产出第 17 节的 Copy、Density、Swap、Squint、Grayscale 审查所需的证据（同尺寸截图 + 结构清单）。**五项审查本身是人工/调用方判断，不是 flash Agent 自己能执行的完成条件**；Agent 不得在报告里宣称「五项审查通过」，只能报告「已产出五项审查所需证据」。
8. 实测与本文初值冲突时：以实测为准，同一张 UI 卡内同步更新本文对应结构规格与 §19.2 勾选项（差异按第 1.2 节归类后不视为差异）；无法同步时任务不得完成，且必须在报告中写明哪一项结构规格冲突、本文哪一节未同步。实测不存在冲突时，以本文初值继续。

禁止仅阅读本文或查看一张裁切截图后凭印象实现。

---

## 3. 全局信息架构

### 3.1 主窗口固定层级

```text
系统菜单                                      OS / Electron
领域编辑器栏                                  Project / PARAM / GPARAM / Text / ...
文档标签栏                                    逻辑文档，不是每个磁盘文件
主工作区                                      唯一 full-bleed 编辑器 + 右侧 Agent dock
Problems / Output                             底部 dock
状态栏                                        workspace / selection / revision / transaction
```

中央区域一次只能渲染一个编辑器。日常编辑器必须贴合 client area，不得再套外层圆角 panel。

### 3.2 一级领域

```ts
export type EditorDomainId =
  | 'project'
  | 'param'
  | 'gparam'
  | 'text'
  | 'event'
  | 'map'
  | 'script'
  | 'behavior'
  | 'animation'
  | 'model'
  | 'texture'
  | 'material'
  | 'vfx'
  | 'container'
  | 'files';
```

领域栏固定显示产品名称，不显示裸物理目录，不显示无单位文件数：

```text
项目 | PARAM | GPARAM | 文本 | 事件 | 地图 | 脚本 |
行为 | 动画 | 模型 | 纹理 | 材质 | VFX | 容器 | 文件
```

领域顺序和目标集合固定。运行时只有在真实 read contract 已注册且运行条件满足时才把对应入口标为可操作；`project` 和 `files` 始终存在。候选格式不能制造可操作领域。

这里的运行时隐藏/只读规则不是实施终点。第 18 节必须继续完成缺失的 read → workbench → write/roundtrip 技术卡；不得以“目前隐藏”或“目前只读”为理由省略目标编辑器。

### 3.3 领域栏不显示计数

顶部领域栏不得显示：

```text
PARAM 36
GPARAM 34
容器 221
文件 242
```

上面这些数字只是某个工作区快照的示例。数量只在对应编辑器内部显示，并必须带语义单位：

```text
Game Parameters · 1 library · N tables
Draw / Graphics Parameters · N banks
Text · 9 languages · N tables
Event · N documents · N events
Files · N files
```

本文各处（§4.5、CAT-05、GPARAM-11A/B、§19.1）引用的“34 个 GParam”是任务开始时的磁盘样本快照，不是永久验收常量。凡是写死 34 的断言，实施时必须按当时挂载 workspace 经 Bridge 实测的动态样本数替换；换一个 mod 挂载或样本集变化时，验收应跟随实测数量，不得因数字不同报红或去修不存在的 bug。

### 3.4 文档标签

标签代表逻辑文档，而非扫描到的每个物理文件：

- Game Parameters 使用一个逻辑标签；
- GPARAM 可按当前 bank 或逻辑集合开标签，但不得为导航计数制造文件标签；
- Text 标签使用语言 / FMG 逻辑表；
- Event 标签使用 EMEVD 文档；
- `.bak/.prev` 只能通过 History & Recovery 显式只读打开，并带历史标记；
- cache、audit、temp 不形成标签。

---

## 4. 语义目录契约

### 4.1 禁止 renderer 自行分类

领域栏和语义编辑器必须消费 main/core 生成的 `EditorCatalogSnapshot`。renderer 不得根据 `RendererIndexedFile.resourceKind`、路径首段或 suffix 自行构造领域。

固定数据流：

```text
Physical scan
→ artifact-role filter
→ Bridge format confirmation
→ container-child projection
→ EditorCatalog
→ logical libraries / banks / documents
→ renderer-safe EditorCatalogSummary
→ DomainNavigationBar
→ one WorkbenchRoute
→ mature editor workbench
```

明确禁止：

```text
DomainNavigationBar(files)
domainForFile(file.resourceKind)
filterFilesForDomain(files)
visibleFiles.length
file.resourceKind === 'param' ? 'param' : ...
```

### 4.2 必须提供的 shared 类型

后续实现必须在 `packages/shared/src/editor-catalog.ts` 定义并导出 closed union 和 runtime decoder：

```ts
export type ArtifactRole =
  | 'primary'
  | 'base'
  | 'backup'
  | 'previous'
  | 'recovery'
  | 'projection'
  | 'cache'
  | 'audit'
  | 'temporary';

export type NativeFormatId =
  | 'dcx-dflt'
  | 'dcx-krak'
  | 'bnd4'
  | 'param'
  | 'gparam'
  | 'fmg'
  | 'emevd'
  | 'msb'
  | 'lua-source'
  | 'lua-bytecode'
  | 'hks-bytecode'
  | 'esd'
  | 'tae'
  | 'flver'
  | 'tpf'
  | 'dds'
  | 'mtd'
  | 'matbin'
  | 'fxr'
  | 'unknown';

export type ContainerRole =
  | 'none'
  | 'gameparam-binder'
  | 'drawparam-binder'
  | 'msg-binder'
  | 'script-binder'
  | 'behavior-binder'
  | 'animation-binder'
  | 'texture-binder'
  | 'vfx-binder'
  | 'generic-binder';

export interface FormatCandidate {
  readonly formatId: NativeFormatId;
  readonly source: 'content-probe' | 'compound-suffix' | 'path-hint';
  readonly ruleId: string;
}

export interface FormatLayer {
  readonly layerIndex: number;
  readonly formatId: Exclude<NativeFormatId, 'unknown'>;
  readonly confirmedBy: 'bridge';
  readonly childStableId: string | null;
}

export interface ConfirmedFormatStack {
  readonly stackId: string;
  readonly layers: readonly FormatLayer[];
  readonly leafFormatId: Exclude<NativeFormatId, 'unknown'>;
  readonly containerRole: ContainerRole;
}

interface PhysicalVariantCommon {
  readonly variantId: string;
  readonly precedence: number;
  readonly contentHash: string | null;
  readonly sourceRevision: string | null;
  readonly provenanceDigest: string | null;
}

export type PhysicalVariantRef =
  | (PhysicalVariantCommon & {
      readonly role: 'primary' | 'base';
      readonly sourceLayer: 'overlay' | 'base';
      readonly recoveryOfResourceId: null;
    })
  | (PhysicalVariantCommon & {
      readonly role: 'backup' | 'previous' | 'recovery';
      readonly sourceLayer: 'history';
      readonly recoveryOfResourceId: string;
    });

export type RecognitionState =
  | { kind: 'candidate'; evidence: readonly FormatCandidate[] }
  | { kind: 'confirmed'; stack: ConfirmedFormatStack }
  | { kind: 'conflict'; confirmedStackIds: readonly string[] }
  | { kind: 'unsupported'; reasonCode: string };

export interface ProjectionRef {
  readonly projectionId: string;
  readonly projectionKind: 'source' | 'text' | 'json';
  readonly nativeResourceId: string;
  readonly nativeSourceRevision: string;
  readonly nativeSourceHash: string;
  readonly provenanceDigest: string;
}

export type ReadOperationId =
  | 'catalog-open' | 'page-tables' | 'page-rows' | 'page-fields'
  | 'page-banks' | 'page-groups' | 'page-entries' | 'read-source'
  | 'read-outline' | 'read-preview' | 'read-metadata' | 'read-properties';

export type WriteOperationId =
  | 'param-field-set' | 'param-row-upsert' | 'param-row-delete'
  | 'gparam-field-set' | 'fmg-entry-upsert' | 'fmg-entry-delete'
  | 'emevd-source-change' | 'bnd4-child-replace' | 'script-plaintext-change'
  | 'map-entity-upsert' | 'map-entity-delete' | 'flver-material-slot-set'
  | 'tpf-texture-replace' | 'material-property-set' | 'vfx-field-set'
  | 'behavior-transition-upsert' | 'tae-event-upsert';

export type CapabilityReasonCode =
  | 'read-contract-missing' | 'write-contract-missing' | 'operation-not-allowed'
  | 'runtime-unavailable' | 'oodle-unavailable' | 'metadata-mismatch'
  | 'bridge-authority-insufficient' | 'writer-unverified'
  | 'outer-rebuild-unavailable' | 'native-reread-unavailable'
  | 'unknown-region-unverifiable' | 'sibling-verification-unavailable';

export type ReadCapabilityStage = 'D3'|'D4'|'D5'|'D6';
export type WriteCapabilityStage = 'D7'|'D8'|'D9'|'D10';

export type ReadCapability =
  | { kind: 'ready'; operationIds: readonly ReadOperationId[]; verifiedStages: readonly ['D3', 'D4', 'D5', 'D6']; resolverSnapshotId: string }
  | { kind: 'blocked'; reasonCode: CapabilityReasonCode; missing: readonly ReadCapabilityStage[] }
  | { kind: 'unavailable'; reasonCode: CapabilityReasonCode };

export type WriteCapability =
  | { kind: 'ready'; operationIds: readonly WriteOperationId[]; verifiedStages: readonly ['D7', 'D8', 'D9', 'D10']; resolverSnapshotId: string }
  | { kind: 'blocked'; reasonCode: CapabilityReasonCode; missingStages: readonly WriteCapabilityStage[] }
  | { kind: 'unavailable'; reasonCode: CapabilityReasonCode };

export interface OperationCapability {
  readonly read: ReadCapability;
  readonly write: WriteCapability;
}

export type CatalogDecision =
  | { kind: 'catalog'; domain: EditorDomainId; integrationId: string }
  | { kind: 'history'; recoveryOfResourceId: string | null }
  | { kind: 'projection'; requireMatchingProvenance: true }
  | { kind: 'hidden'; reason: 'cache' | 'audit' | 'temporary' }
  | { kind: 'files'; reasonCode: string };

export interface LogicalDocumentRef {
  readonly resourceId: string;
  readonly domain: EditorDomainId;
  readonly libraryId: string;
  readonly bankId: string | null;
  readonly documentId: string;
  readonly sourceVariant: 'overlay' | 'base';
}

export interface CatalogLibrary {
  readonly libraryId: string;
  readonly domain: EditorDomainId;
  readonly label: string;
  readonly bankIds: readonly string[];
  readonly documentIds: readonly string[];
  readonly counts: Readonly<Partial<Record<'libraries'|'banks'|'tables'|'rows'|'entries'|'events'|'files', number>>>;
}

export interface CatalogBank {
  readonly bankId: string;
  readonly libraryId: string;
  readonly label: string;
  readonly semanticKey: string;
  readonly languageId: string | null;
  readonly containerKind: 'item' | 'menu' | null;
  readonly documentIds: readonly string[];
}

export interface CatalogDocument {
  readonly ref: LogicalDocumentRef;
  readonly label: string;
  readonly recognition: RecognitionState;
  readonly capability: OperationCapability;
  readonly effectiveVariant: PhysicalVariantRef;
  readonly alternateVariantIds: readonly string[];
}

export interface EditorCatalogSnapshot {
  readonly catalogRevision: string;
  readonly libraries: readonly CatalogLibrary[];
  readonly banks: readonly CatalogBank[];
  readonly documents: readonly CatalogDocument[];
  readonly history: readonly PhysicalVariantRef[];
  readonly projections: readonly ProjectionRef[];
}

export interface EditorCatalogSummary {
  readonly catalogRevision: string;
  readonly domains: readonly DomainSummary[];
  readonly libraries: readonly CatalogLibrary[];
  readonly banks: readonly CatalogBank[];
  readonly documents: readonly CatalogDocumentSummary[];
  readonly historyCount: number;
}

export interface CatalogDocumentSummary {
  readonly ref: LogicalDocumentRef;
  readonly label: string;
  readonly recognition: RecognitionState;
  readonly capability: OperationCapability;
  readonly effectiveVariantId: string;
}

export interface DomainSummary {
  readonly domain: EditorDomainId;
  readonly label: string;
  readonly visibility: 'visible' | 'hidden' | 'disabled';
  readonly capability: 'read-ready' | 'runtime-blocked' | 'deferred';
  readonly defaultTarget: LogicalDocumentRef | null;
}
```

上述名字和字段是最低契约，不允许实施 Agent自行换成另一组含义相近但不兼容的类型。所有请求/响应必须有 runtime decoder；不得使用 `as` 强转绕过 decoder。`EditorCatalogSummary` 必须通过显式投影生成，不能把含 hash/provenance 的 `CatalogDocument` 直接透传给 renderer。

`FormatCandidate` 与 `ConfirmedFormatStack` 必须分离。suffix、path hint 和 TypeScript probe 永远不能构造 `FormatLayer`；只有 Bridge 可以产生 `confirmedBy: 'bridge'` 的层。

renderer DTO 不得包含绝对路径、main locator、Bridge command、真实 workspace root 或任意 `unknown` payload。`PhysicalVariantRef.variantId` 是 main-issued opaque ID，不是路径。

### 4.3 识别优先级

```text
1000 artifact role: backup/recovery/projection/cache/audit/temp
 900 Bridge-confirmed native format stack
 800 confirmed container child
 700 bounded content probe
 600 longest compound suffix candidate
 300 path hint candidate
   0 Files fallback
```

规则：

- priority 1000 先决定 History 或 hidden，不能再进入普通领域；
- 只有 Bridge-confirmed format 或 confirmed container child 能产生 ready 文档；
- suffix/path 只能产生 candidate，candidate 留在 Files；
- `ResourceKind` 只能作为 priority 300 path hint；
- 同一 child 出现两个不兼容 confirmed leaf 时为 conflict，禁止静默选一个；
- overlay 与 base 是同一逻辑资源的 source variants，不得显示成两个普通文档；
- backup 通过 `recoveryOfResourceId` 关联 primary，不参与普通计数。
- `.emevd.dcx.js`、导出的 `.txt/.json` 和其他生成 sidecar 只能作为已有 native document 的 projection；只有 sidecar 内记录的 native identity、source revision/hash 和 provenance digest 与 primary 一致时才关联，绝不能形成第二个普通文档；
- effective variant 先比较 `sourceLayer`（overlay 高于 base，history 永不成为 effective），再比较 `precedence`；同层同 precedence 但 hash 不同时形成 conflict，禁止按扫描顺序取最后一个。

### 4.4 固定分类规则

| 输入 | 决策 | 逻辑层级 | 默认编辑器 | 禁止行为 |
| --- | --- | --- | --- | --- |
| primary `gameparam.parambnd.dcx` | catalog `param` | `game-parameters → tables` | Param Editor | 不按文件列出 |
| `gameparam.parambnd.dcx.bak/.prev` | history | 关联 `game-parameters` | 无普通默认编辑器 | 不计数、不自动打开 |
| confirmed `*.gparam` / `*.gparam.dcx` | catalog `gparam` | `draw-graphics-parameters → map banks` | GParam Editor | 不进入 PARAM |
| confirmed `.drawparambnd.dcx` root | catalog `container` | binder → children | Container | 不把 root 粗暴当 PARAM |
| `.drawparambnd` 中 confirmed PARAM child | projection `param` | param library/table | Param | 可与 GPARAM child 共存 |
| `.drawparambnd` 中 confirmed GPARAM child | projection `gparam` | bank/group/value | GParam | 可与 PARAM child 共存 |
| Bridge-confirmed `msg/<language>/*.msgbnd.dcx` | catalog `text` | language → container → FMG | Text | 路径只提供 language hint，不单独确认格式 |
| Bridge-confirmed `menu/**/*.tpf.dcx` | catalog `texture` | texture bank → texture | Texture | 禁止 Text；路径不单独确认格式 |
| `*.emevd.dcx` | catalog `event` | event document → outline | Event | 禁止四视图默认页 |
| Bridge-confirmed `*.luabnd.dcx` | catalog `script` | container → entries | Script | 需确认 child 才投影源码 |
| confirmed `.lua/.hks` | catalog `script` | document → source/symbols | Script | suffix-only 仍 candidate |
| `*.talkesdbnd.dcx` / confirmed `.esd` | behavior | container → machine/state | Behavior | 不由 action 目录决定 |
| `*.anibnd.dcx` / confirmed `.tae` | animation | container → animation/timeline | Animation | 不由 chr 目录决定 |
| confirmed `*.msb.dcx` | map | map → entities | Map | 无 read contract 时 Files |
| confirmed `*.flver` | model | model → mesh/material slots | Model | 无 read contract 时 Files |
| confirmed `*.tpf/.dds` | texture | bank → texture | Texture | TPF 不得进 Text |
| confirmed `*.mtd/.matbin` | material | material → properties | Material | 未确认时 Files |
| confirmed `*.fxr/*.ffxbnd.dcx` | vfx | effect bank → effect | VFX | 未确认时 Files |
| 无法确认 | files | physical hierarchy | Files | 不得伪装 empty editor |

实施时不得把上表重新翻译成自由分支。`packages/shared/src/editor-catalog.ts` 必须提供以下注册表形状，`packages/core/src/workspace/editorCatalog.ts` 只解释此注册表：

```ts
export type ArtifactRoleMatcher =
  | { kind: 'registered-recovery' }
  | { kind: 'case-insensitive-suffix'; suffix: '.bak' | '.prev' }
  | { kind: 'verified-projection-manifest' }
  | { kind: 'main-storage-class'; storageClass: 'cache' | 'audit' | 'temporary' }
  | { kind: 'source-root'; sourceLayer: 'overlay' | 'base' };

export interface ArtifactRoleRule {
  readonly ruleId: string;
  readonly matcher: ArtifactRoleMatcher;
  readonly role: ArtifactRole;
}

export const ARTIFACT_ROLE_RULES = [
  { ruleId: 'registered-recovery', matcher: { kind: 'registered-recovery' }, role: 'recovery' },
  { ruleId: 'backup-suffix', matcher: { kind: 'case-insensitive-suffix', suffix: '.bak' }, role: 'backup' },
  { ruleId: 'previous-suffix', matcher: { kind: 'case-insensitive-suffix', suffix: '.prev' }, role: 'previous' },
  { ruleId: 'verified-projection', matcher: { kind: 'verified-projection-manifest' }, role: 'projection' },
  { ruleId: 'main-cache', matcher: { kind: 'main-storage-class', storageClass: 'cache' }, role: 'cache' },
  { ruleId: 'main-audit', matcher: { kind: 'main-storage-class', storageClass: 'audit' }, role: 'audit' },
  { ruleId: 'main-temporary', matcher: { kind: 'main-storage-class', storageClass: 'temporary' }, role: 'temporary' },
  { ruleId: 'overlay-source', matcher: { kind: 'source-root', sourceLayer: 'overlay' }, role: 'primary' },
  { ruleId: 'base-source', matcher: { kind: 'source-root', sourceLayer: 'base' }, role: 'base' },
] as const satisfies readonly ArtifactRoleRule[];

export type RuleMatcher =
  | { kind: 'artifact-role'; roles: readonly ArtifactRole[] }
  | { kind: 'confirmed-leaf'; formatId: NativeFormatId; containerRole?: ContainerRole; semanticSubtype?: string }
  | { kind: 'confirmed-child'; formatId: NativeFormatId; parentRole: ContainerRole; semanticSubtype?: string }
  | { kind: 'content-probe' }
  | { kind: 'compound-suffix'; suffix: string }
  | { kind: 'path-hint'; firstSegment: string }
  | { kind: 'always' };

export interface ResourceClassificationRule {
  readonly ruleId: string;
  readonly priority: 1000 | 900 | 800 | 700 | 600 | 300 | 0;
  readonly matcher: RuleMatcher;
  readonly decision:
    | { kind: 'catalog'; domain: EditorDomainId; integrationId: string; libraryKey: string }
    | { kind: 'history' }
    | { kind: 'projection'; requireMatchingProvenance: true }
    | { kind: 'hidden' }
    | { kind: 'files'; reasonCode: string };
}

export const RESOURCE_CLASSIFICATION_RULES = [
  { ruleId: 'artifact-backup-history', priority: 1000, matcher: { kind: 'artifact-role', roles: ['backup','previous','recovery'] }, decision: { kind: 'history' } },
  { ruleId: 'artifact-generated-projection', priority: 1000, matcher: { kind: 'artifact-role', roles: ['projection'] }, decision: { kind: 'projection', requireMatchingProvenance: true } },
  { ruleId: 'artifact-internal-hidden', priority: 1000, matcher: { kind: 'artifact-role', roles: ['cache','audit','temporary'] }, decision: { kind: 'hidden' } },
  { ruleId: 'gameparam-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'bnd4', containerRole: 'gameparam-binder', semanticSubtype: 'gameparam-primary' }, decision: { kind: 'catalog', domain: 'param', integrationId: 'param-editor', libraryKey: 'game-parameters' } },
  { ruleId: 'drawparam-binder-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'bnd4', containerRole: 'drawparam-binder' }, decision: { kind: 'catalog', domain: 'container', integrationId: 'container-editor', libraryKey: 'drawparam-containers' } },
  { ruleId: 'gparam-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'gparam', semanticSubtype: 'map-bank' }, decision: { kind: 'catalog', domain: 'gparam', integrationId: 'gparam-editor', libraryKey: 'draw-graphics-parameters' } },
  { ruleId: 'loose-param-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'param', semanticSubtype: 'loose-table' }, decision: { kind: 'catalog', domain: 'param', integrationId: 'param-editor', libraryKey: 'loose-parameters' } },
  { ruleId: 'loose-fmg-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'fmg', semanticSubtype: 'loose-table' }, decision: { kind: 'catalog', domain: 'text', integrationId: 'text-editor', libraryKey: 'loose-text' } },
  { ruleId: 'msgbnd-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'bnd4', containerRole: 'msg-binder' }, decision: { kind: 'catalog', domain: 'text', integrationId: 'text-editor', libraryKey: 'game-text' } },
  { ruleId: 'emevd-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'emevd' }, decision: { kind: 'catalog', domain: 'event', integrationId: 'event-editor', libraryKey: 'events' } },
  { ruleId: 'msb-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'msb' }, decision: { kind: 'catalog', domain: 'map', integrationId: 'map-editor', libraryKey: 'maps' } },
  { ruleId: 'script-binder-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'bnd4', containerRole: 'script-binder' }, decision: { kind: 'catalog', domain: 'script', integrationId: 'script-editor', libraryKey: 'scripts' } },
  { ruleId: 'lua-source-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'lua-source' }, decision: { kind: 'catalog', domain: 'script', integrationId: 'script-editor', libraryKey: 'loose-scripts' } },
  { ruleId: 'lua-bytecode-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'lua-bytecode' }, decision: { kind: 'catalog', domain: 'script', integrationId: 'script-editor', libraryKey: 'loose-scripts' } },
  { ruleId: 'hks-bytecode-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'hks-bytecode' }, decision: { kind: 'catalog', domain: 'script', integrationId: 'script-editor', libraryKey: 'loose-scripts' } },
  { ruleId: 'behavior-binder-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'bnd4', containerRole: 'behavior-binder' }, decision: { kind: 'catalog', domain: 'behavior', integrationId: 'behavior-editor', libraryKey: 'behaviors' } },
  { ruleId: 'animation-binder-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'bnd4', containerRole: 'animation-binder' }, decision: { kind: 'catalog', domain: 'animation', integrationId: 'animation-editor', libraryKey: 'animations' } },
  { ruleId: 'texture-binder-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'bnd4', containerRole: 'texture-binder' }, decision: { kind: 'catalog', domain: 'texture', integrationId: 'texture-editor', libraryKey: 'textures' } },
  { ruleId: 'vfx-binder-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'bnd4', containerRole: 'vfx-binder' }, decision: { kind: 'catalog', domain: 'vfx', integrationId: 'vfx-editor', libraryKey: 'effects' } },
  { ruleId: 'loose-esd-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'esd' }, decision: { kind: 'catalog', domain: 'behavior', integrationId: 'behavior-editor', libraryKey: 'loose-behaviors' } },
  { ruleId: 'loose-tae-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'tae' }, decision: { kind: 'catalog', domain: 'animation', integrationId: 'animation-editor', libraryKey: 'loose-animations' } },
  { ruleId: 'flver-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'flver' }, decision: { kind: 'catalog', domain: 'model', integrationId: 'model-editor', libraryKey: 'models' } },
  { ruleId: 'tpf-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'tpf' }, decision: { kind: 'catalog', domain: 'texture', integrationId: 'texture-editor', libraryKey: 'textures' } },
  { ruleId: 'dds-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'dds' }, decision: { kind: 'catalog', domain: 'texture', integrationId: 'texture-editor', libraryKey: 'textures' } },
  { ruleId: 'mtd-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'mtd' }, decision: { kind: 'catalog', domain: 'material', integrationId: 'material-editor', libraryKey: 'materials' } },
  { ruleId: 'matbin-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'matbin' }, decision: { kind: 'catalog', domain: 'material', integrationId: 'material-editor', libraryKey: 'materials' } },
  { ruleId: 'fxr-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'fxr' }, decision: { kind: 'catalog', domain: 'vfx', integrationId: 'vfx-editor', libraryKey: 'effects' } },
  { ruleId: 'generic-bnd4-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'bnd4', containerRole: 'generic-binder' }, decision: { kind: 'catalog', domain: 'container', integrationId: 'container-editor', libraryKey: 'containers' } },
  { ruleId: 'drawparam-param-child', priority: 800, matcher: { kind: 'confirmed-child', formatId: 'param', parentRole: 'drawparam-binder' }, decision: { kind: 'catalog', domain: 'param', integrationId: 'param-editor', libraryKey: 'drawparam-tables' } },
  { ruleId: 'drawparam-gparam-child', priority: 800, matcher: { kind: 'confirmed-child', formatId: 'gparam', parentRole: 'drawparam-binder' }, decision: { kind: 'catalog', domain: 'gparam', integrationId: 'gparam-editor', libraryKey: 'draw-graphics-parameters' } },
  { ruleId: 'fmg-child', priority: 800, matcher: { kind: 'confirmed-child', formatId: 'fmg', parentRole: 'msg-binder' }, decision: { kind: 'catalog', domain: 'text', integrationId: 'text-editor', libraryKey: 'game-text' } },
  { ruleId: 'lua-child', priority: 800, matcher: { kind: 'confirmed-child', formatId: 'lua-source', parentRole: 'script-binder' }, decision: { kind: 'catalog', domain: 'script', integrationId: 'script-editor', libraryKey: 'scripts' } },
  { ruleId: 'lua-bytecode-child', priority: 800, matcher: { kind: 'confirmed-child', formatId: 'lua-bytecode', parentRole: 'script-binder' }, decision: { kind: 'catalog', domain: 'script', integrationId: 'script-editor', libraryKey: 'scripts' } },
  { ruleId: 'hks-child', priority: 800, matcher: { kind: 'confirmed-child', formatId: 'hks-bytecode', parentRole: 'script-binder' }, decision: { kind: 'catalog', domain: 'script', integrationId: 'script-editor', libraryKey: 'scripts' } },
  { ruleId: 'esd-child', priority: 800, matcher: { kind: 'confirmed-child', formatId: 'esd', parentRole: 'behavior-binder' }, decision: { kind: 'catalog', domain: 'behavior', integrationId: 'behavior-editor', libraryKey: 'behaviors' } },
  { ruleId: 'tae-child', priority: 800, matcher: { kind: 'confirmed-child', formatId: 'tae', parentRole: 'animation-binder' }, decision: { kind: 'catalog', domain: 'animation', integrationId: 'animation-editor', libraryKey: 'animations' } },
  { ruleId: 'tpf-child', priority: 800, matcher: { kind: 'confirmed-child', formatId: 'tpf', parentRole: 'texture-binder' }, decision: { kind: 'catalog', domain: 'texture', integrationId: 'texture-editor', libraryKey: 'textures' } },
  { ruleId: 'fxr-child', priority: 800, matcher: { kind: 'confirmed-child', formatId: 'fxr', parentRole: 'vfx-binder' }, decision: { kind: 'catalog', domain: 'vfx', integrationId: 'vfx-editor', libraryKey: 'effects' } },
  { ruleId: 'bounded-content-probe', priority: 700, matcher: { kind: 'content-probe' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'parambnd-dcx-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.parambnd.dcx' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'drawparambnd-dcx-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.drawparambnd.dcx' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'msgbnd-dcx-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.msgbnd.dcx' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'gparam-dcx-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.gparam.dcx' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'emevd-dcx-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.emevd.dcx' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'luabnd-dcx-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.luabnd.dcx' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'talkesdbnd-dcx-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.talkesdbnd.dcx' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'anibnd-dcx-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.anibnd.dcx' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'msb-dcx-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.msb.dcx' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'flver-dcx-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.flver.dcx' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'tpf-dcx-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.tpf.dcx' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'ffxbnd-dcx-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.ffxbnd.dcx' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'fxr-dcx-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.fxr.dcx' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'param-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.param' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'gparam-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.gparam' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'fmg-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.fmg' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'lua-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.lua' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'hks-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.hks' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'esd-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.esd' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'tae-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.tae' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'flver-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.flver' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'tpf-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.tpf' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'dds-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.dds' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'mtd-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.mtd' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'matbin-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.matbin' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'fxr-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.fxr' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'physical-path-hint', priority: 300, matcher: { kind: 'path-hint', firstSegment: '*' }, decision: { kind: 'files', reasonCode: 'path-hint-only' } },
  { ruleId: 'files-fallback', priority: 0, matcher: { kind: 'always' }, decision: { kind: 'files', reasonCode: 'unrecognized-format' } },
] as const satisfies readonly ResourceClassificationRule[];

export interface EditorIntegration {
  readonly integrationId: string;
  readonly domain: EditorDomainId;
  readonly editorId: string;
  readonly visibleWhen: 'always' | 'read-ready';
}

export const EDITOR_INTEGRATIONS = [
  { integrationId: 'project-editor', domain: 'project', editorId: 'project', visibleWhen: 'always' },
  { integrationId: 'param-editor', domain: 'param', editorId: 'param', visibleWhen: 'read-ready' },
  { integrationId: 'gparam-editor', domain: 'gparam', editorId: 'gparam', visibleWhen: 'read-ready' },
  { integrationId: 'text-editor', domain: 'text', editorId: 'fmg', visibleWhen: 'read-ready' },
  { integrationId: 'event-editor', domain: 'event', editorId: 'emevd-source', visibleWhen: 'read-ready' },
  { integrationId: 'map-editor', domain: 'map', editorId: 'msb', visibleWhen: 'read-ready' },
  { integrationId: 'script-editor', domain: 'script', editorId: 'script', visibleWhen: 'read-ready' },
  { integrationId: 'behavior-editor', domain: 'behavior', editorId: 'esd', visibleWhen: 'read-ready' },
  { integrationId: 'animation-editor', domain: 'animation', editorId: 'tae', visibleWhen: 'read-ready' },
  { integrationId: 'model-editor', domain: 'model', editorId: 'flver', visibleWhen: 'read-ready' },
  { integrationId: 'texture-editor', domain: 'texture', editorId: 'tpf', visibleWhen: 'read-ready' },
  { integrationId: 'material-editor', domain: 'material', editorId: 'material', visibleWhen: 'read-ready' },
  { integrationId: 'vfx-editor', domain: 'vfx', editorId: 'vfx', visibleWhen: 'read-ready' },
  { integrationId: 'container-editor', domain: 'container', editorId: 'bnd4', visibleWhen: 'read-ready' },
  { integrationId: 'files-editor', domain: 'files', editorId: 'files', visibleWhen: 'always' },
] as const satisfies readonly EditorIntegration[];

type AssertNever<T extends never> = T;
type RegisteredIntegrationId = typeof EDITOR_INTEGRATIONS[number]['integrationId'];
type RuleCatalogDecision = Extract<typeof RESOURCE_CLASSIFICATION_RULES[number]['decision'], { kind: 'catalog' }>;
type _NoUnknownIntegrationId = AssertNever<Exclude<RuleCatalogDecision['integrationId'], RegisteredIntegrationId>>;
type _EveryDomainHasIntegration = AssertNever<Exclude<EditorDomainId, typeof EDITOR_INTEGRATIONS[number]['domain']>>;
```

`ARTIFACT_ROLE_RULES` 严格按声明顺序求值并取第一个匹配项；无法匹配 source root 是扫描边界错误，不能默认成 primary。`.bak/.prev` 比任何 compound format suffix 先执行，所以 `gameparam.parambnd.dcx.bak` 永远没有机会进入 Param route。

所有 900/800 规则只匹配 Bridge-confirmed stack；700/600/300 规则只能返回 Files。artifact History/projection/hidden 规则优先于所有格式规则。`firstSegment: '*'` 只是统一 path-hint fallback，不把任何实际目录名映射成领域。

规则求值固定为：先按 priority 降序；priority 600 先按 suffix 长度降序，避免 `.drawparambnd.dcx` 被较短的 `.parambnd.dcx` 抢先；其他同 priority 按数组声明顺序。第一个匹配 decision 终止普通分类。Bridge 已报告同一 leaf 冲突时不运行 900/800 单选，而是直接生成 `RecognitionState.conflict` 并进入 Files blocked view。

固定 key 生成规则：

- GameParam：`libraryId = 'game-parameters'`，`bankId = null`，每个内部 PARAM table 是 document；
- GPARAM：`libraryId = 'draw-graphics-parameters'`，`bankId = 'gparam:' + normalizedMapBankKey`，同一 map bank 的 groups/values 不再形成全局文件；
- Text：`libraryId = 'game-text'`，`bankId = 'text:' + normalizedLanguageId + ':' + containerKind`，并填写 `languageId` 与 `containerKind`；每个 FMG logical table 是 document；
- 其他领域：`libraryId` 来自注册表 `libraryKey`，`bankId` 只在 Bridge 返回真实 bank/container 语义时生成；
- 所有 normalized key 使用 ASCII lower-case、`-` 分隔和 Bridge 返回的稳定语义 ID；不得包含绝对路径、扫描序号或显示文案。

### 4.5 当前样本的确定结果

以下“34 个 *.gparam.dcx”是任务开始时的磁盘样本快照，不是永久验收常量；实施 CAT-05 时按当时挂载 workspace 经 Bridge 实测的动态样本数替换：

```text
34 个 *.gparam.dcx（快照）
1 个 primary gameparam.parambnd.dcx
1 个 gameparam.parambnd.dcx.bak
```

正确语义结果必须是：

```text
PARAM:
  1 Game Parameters library
  N internal PARAM tables

GPARAM:
  1 Draw / Graphics Parameters library
  N banks（N = 当时实测样本数，仅在 Bridge-confirmed read 成立时）

History & Recovery:
  1 GameParam backup
```

绝不能得到 `PARAM 36`。

---

## 5. 唯一编辑器路由

### 5.1 路由顺序

```text
0. artifact-role prefilter
1. explicit Open With（仅 primary/base artifact；source variant 仍区分 overlay/base）
2. Bridge-confirmed leaf format
3. confirmed container-child semantic projection
4. registered read capability and runtime availability
5. content probe candidate
6. suffix/path candidate
7. Files fallback
```

`artifact role` 是不可绕过的 prefilter，必须在 `Open With` 和所有普通编辑器路由前执行：

- backup/previous/recovery → History-only；`Open With` 也只能打开带历史标记的只读恢复查看器，不能选择 Param/GParam/Text 等普通 editor；
- cache/audit/temporary → hidden；
- primary/base → 继续路由，逻辑文档另用 `sourceVariant` 区分 overlay/base。

### 5.2 `WorkbenchRoute`

```ts
export type WorkbenchRoute =
  | { kind: 'ready'; editorId: string; document: LogicalDocumentRef; readOnly: boolean }
  | { kind: 'history'; recoveryOfResourceId: string | null }
  | { kind: 'files-candidate'; reasonCode: string }
  | { kind: 'runtime-blocked'; editorId: string; reasonCode: string }
  | { kind: 'unsupported'; reasonCode: string };
```

每次打开只能得到一个 route。不得同时渲染 Text、Hex、Evidence 或多个 preview。

### 5.3 必测负向路由

- `.parambnd.dcx.bak` 不能得到 Param Editor `ready`；
- `menu/hi/*.tpf.dcx` 不能得到 Text Editor；
- `param/drawparam/*.gparam.dcx` 不能得到 Param Editor；
- `resourceKind === 'param'` 不能单独产生 Param route；
- suffix-only candidate 不能产生 `ready`、`empty` 或 `editable`；
- cache/audit/temp 不能进入 DOM 普通资源列表。

---

## 6. Smithbox 式全局工作台

### 6.1 full-bleed

编辑器占满标签栏与底部 dock 之间的全部空间：

```css
.editor-workbench {
  min-width: 0;
  min-height: 0;
  width: 100%;
  height: 100%;
  display: grid;
  overflow: hidden;
  border-radius: 0;
  padding: 0;
}
```

禁止 `.viewer-content > .panel`、外层卡片、16px 四周留白和主编辑器纵向整体滚动。

### 6.2 pane 通用规则

- pane 之间使用 1px hairline；
- 每栏 `min-width: 0; min-height: 0; overflow: hidden`；
- 标题、搜索和工具条固定在栏顶部；
- 数据区独立滚动；
- resizer 命中宽度 4–6px，视觉线仍为 1px；
- 拖动宽度按 workspace + editor id 持久化；
- 键盘调整每次 16px；
- 不用阴影区分普通 pane；
- 日常表格和属性区不使用圆角卡片。

### 6.3 高密度 token

后续实现必须补齐语义 token，不得把数字散落在组件 inline style：

```css
/* 以下数值为实施前初值；准确值由 REF-01 对 Smithbox 实测后落入 SoulForge token，不得凭空发明另一套密度 */
--editor-row-height: 24px;
--editor-row-height-compact: 22px;
--editor-header-height: 32px;
--editor-toolbar-height: 30px;
--editor-pane-padding-x: 8px;
--editor-hairline: 1px;
--editor-resizer-hit: 5px;
--editor-selection-bg: ...;
--editor-selection-fg: ...;
--editor-focus-ring: ...;
--editor-dirty: ...;
--editor-added: ...;
--editor-modified: ...;
--editor-deleted: ...;
--editor-warning: ...;
--editor-error: ...;
```

---

## 7. PARAM Editor：照搬 Smithbox Param Editor

### 7.1 固定结构（初值，以 REF-01 实测为准）

```text
Params 20% | Rows 29% | Fields 35% | Tools 16%
min 180px  | min 260px| min 320px  | min 200px
```

以上比例与最小宽度是实施前初值，须经 REF-01 对 Smithbox Param Editor 实测后按实测更新本文。Params→Rows→Fields 是选择链而非并列三栏；Tools 的入口与折叠方式以 Smithbox 实际行为为准，若 Smithbox 没有固定的右侧第四栏，则以实测记录的真实入口为准并在本卡内改写本节。

第一栏必须直接显示 GameParam 内部 PARAM tables，不显示 gameparam/drawparam 物理文件。

### 7.2 打开行为

点击 `PARAM` 时：

1. 从 Catalog 取得 `libraryId = game-parameters` 的 effective primary。
2. 忽略 History 中的 `.bak/.prev`。
3. 打开 primary logical library。
4. 加载内部 table page。
5. 默认选择上次有效 table；没有历史选择时选择首个 table。
6. 加载 Rows；选择首行后加载 Fields。

不得恢复“最近打开的 param 目录文件”，也不得把 `.bak` 作为最近文档。

### 7.3 Params 栏

必须复制 Smithbox 的：

- 分类组；
- table 搜索；
- table 名称与可选本地化名称；
- 当前 table 整行选中；
- 独立滚动；
- table 数量只在栏头以 `N tables` 显示。

禁止显示路径、DCX、BND、文件大小或 backup。

### 7.4 Rows 栏

- 表头至少包含 `Id`、`Name`；
- 高密度、虚拟化或分页；
- 搜索 ID 与名称；
- 选择 table 后立即清理旧 row/field；
- 选择 row 后加载 Fields；
- dirty/added/deleted 使用语义颜色和图标，不改变行高；
- 失败页保留 Params 和可重试 Rows，不清空整个编辑器。

### 7.5 Fields 栏

- 字段名；
- 当前值；
- 对照值或原始值；
- 枚举名称；
- 类型、范围和说明；
- 修改状态；
- 引用跳转只在真实 resolver 可用时显示。

字段编辑器必须按 metadata 类型选择，不得把全部值渲染成自由文本。

### 7.6 Tools 栏

布局和折叠方式照搬 Smithbox。只有真实能力可显示：

- Sort Rows；
- Row Names；
- Data Comparison；
- Copy / Duplicate；
- Data Transfer；
- Mass Edit；
- Reference Jump；
- Undo/Redo。

未接通真实实现的工具必须隐藏，不能放 disabled 假按钮吸引用户。

### 7.7 明确禁止

以下负向清单是当前错误实现的快照；“三栏 PARAM/ROW/FIELD”的判定基准随 REF-01 实测结构更新：实测结构与本文初值不同时，本卡同步更新本节与测试断言，禁止在三栏与四栏之间留下两套互相矛盾的规定。

```text
param/drawparam/*.gparam.dcx
gameparam.parambnd.dcx.bak
磁盘文件大小
三栏 PARAM/ROW/FIELD（当前快照；以 REF-01 实测结构为准）
圆角外壳
整页错误卡
Evidence/Hex 折叠区进入默认 DOM
```

### 7.8 正确标题

```text
Game Parameters · 1 library · N tables
```

不得显示：

```text
PARAM · param/gameparam/gameparam.parambnd.dcx.bak
PARAM 36 项
```

---

## 8. GPARAM Editor：照搬 Smithbox Graphics Param Editor

### 8.1 固定结构（初值，以 REF-01 实测为准）

```text
Banks 18% | Groups 24% | Fields / Values 42% | Tools 16%
min 180px | min 220px | min 360px            | min 200px
```

以上比例与最小宽度是实施前初值，须经 REF-01 对 Smithbox Graphics Param Editor 实测后按实测更新本文；Tools 入口以 Smithbox 实际行为为准。

### 8.2 层级

```text
Draw / Graphics Parameters
→ map/area bank
→ group
→ field/value
```

多个 `.gparam.dcx` 是内部 banks，不是顶层磁盘资源列表。Bank 主标签优先显示 Bridge 解析的 map/area identity，文件名仅作为 tooltip 或 Details 次级信息。

### 8.3 能力关闭

- 没有 Bridge-confirmed GPARAM read：不显示可操作 GPARAM 入口；资源保留在 Files candidate。
- read 已通、write 未通：显示真实只读 Smithbox 式工作台。
- writer 未通过独立 GPARAM roundtrip：所有写控件隐藏。
- `.drawparambnd` child 必须按真实 storage profile 重建 parent，不得借用 PARAM writer。

GPARAM 与 PARAM 可共享搜索、diff 和 Change Review 基础设施，但不能共享错误的数据模型。

---

## 9. Text Editor：照搬 Smithbox Text Editor

### 9.1 固定结构（初值，以 REF-01 实测为准）

```text
Languages / Containers / File List 24%
| Text Entries 30%
| Text Content 30%
| Tools 16%
```

最小宽度：`260 / 300 / 320 / 200px`。以上是实施前初值，须经 REF-01 对 Smithbox Text Editor 实测后按实测更新本文；Tools 入口以 Smithbox 实际行为为准。

### 9.2 固定选择链

```text
language
→ item/menu container
→ FMG logical table
→ entry
→ content
```

“menu container”是 FMG 语义容器，不等于磁盘 `menu/` 顶层目录。

### 9.3 必须复制

- 左侧语言分组与展开；
- container 和 FMG logical file list；
- entry 的 ID 与预览文本；
- 中央/右侧正文编辑；
- Text Tools 折叠组；
- 每栏搜索和独立滚动；
- Unicode、IME、换行和 dirty 状态。

### 9.4 明确路由

```text
msg/<language>/*.msgbnd.dcx → Text
confirmed FMG child          → Text
menu/**/*.tpf.dcx            → Texture
unknown menu child           → Files candidate
```

解析失败必须显示 `partial/error`，不得显示假的“0 条”。真实空 FMG 才能显示 `0 entries`。

---

## 10. Container、Script、Behavior、Animation、Map 与资产编辑器

### 10.1 Container / BND4

固定结构（初值，以 REF-01 实测为准）：

```text
Containers 20% | Entries 28% | Preview / Source / Bytes 36% | Metadata / Tools 16%
```

- 第一栏只列逻辑容器，不列 backup/cache；
- Entries 使用稳定 child identity，而不是只靠可重复文件名；
- 已确认 child 必须投影到对应专属编辑器；
- 未确认 child 在 Preview 中只读显示，不制造专属能力；
- Bytes 只在用户显式选择原始视图时出现；
- replace/add/delete 必须使用 typed child mutation、parent rebuild 和 D10 sibling verify。

Yabber 只作容器层级和结果对照；SoulForge 的生产读写仍由 Bridge/Patch Engine 完成。

### 10.2 Script

固定结构（初值，以 REF-01 实测为准）：

```text
Container / Files 22% | Source / Read-only Disassembly flex | Symbols / Metadata 24% | Tools 16%
```

- plaintext Lua/HKS 按真实 encoding、BOM、newline、NUL policy 显示；
- bytecode 只显示真实反编译或明确的只读字节视图；
- 没有 compiler 时不得把反编译文本伪装成可回写源码；
- 符号、引用和跳转只使用真实解析结果；
- DSLuaDecompiler 只作交互对照，不成为写入依赖。

### 10.3 Behavior 与 Animation

```text
Behavior: Machines/States | Conditions/Commands | Inspector | Tools
Animation: Containers/Animations | Timeline/Events | Inspector | Tools
```

- Behavior 必须表达 machine → state → transition/condition/action；
- Animation 必须表达 binder → animation → timeline event；
- 没有真实结构 read 时先完成对应 read 卡，不用通用资源列表冒充；
- writer 缺失时保留完整只读专业工作台，而不是空白页面。

### 10.4 Smithbox 是 Map 与资产的默认布局规范

这些页面必须先打开 Smithbox 对应编辑器，复制其 pane 顺序、viewport 占比、inspector 分组和 tools 位置。下面是通用初值，真实布局以 REF-01 对各编辑器的实测为准——没有 viewport 的编辑器（Texture、Material 等）不套用“Resource Tree | Viewport | Inspector | Tools”四栏，按实测布局实施：

```text
Resource Tree | Viewport / Editor | Inspector | Tools
```

### 10.5 Map / Model / Texture / Material / VFX

每个格式是独立技术卡，不允许用一个 `ASSET` 卡让 Agent自行挑一种。以下为初值，均以 REF-01 实测为准：

```text
Map:      Resource Tree | Viewport | Entity Inspector | Tools
Model:    Model Tree    | Viewport | Mesh/Material Inspector | Tools
Texture:  Banks/List    | Texture Preview | Metadata | Tools
Material: Material List | Properties/Values | Preview/References | Tools
VFX:      Effect Tree   | Preview/Graph when real | Inspector | Tools
```

### 10.6 能力门控

- 没有真实 read DTO 时，不渲染假 viewport；
- 没有 writer 时，属性控件只读；
- 没有 reference resolver 时，不显示跳转按钮；
- 没有真实 thumbnail/texture decoder 时，不显示伪缩略图；
- 任何尚未完成 read 的领域不得因扫描到文件而显示为可用；第 18 节仍须先补 read 卡，不能把隐藏当作交付结果。

### 10.7 Files

Files 是唯一允许显示真实物理目录、文件、suffix、format candidate、artifact role 和诊断来源的编辑器。

Files 必须承担：

- 未确认格式；
- 无专属编辑器资源；
- 高级 Open With；
- History & Recovery 入口；
- 明确开发诊断入口。

Files 不能把 candidate 状态伪装为 ready editor。

---

## 11. Event Editor：照搬 DarkScript3

### 11.1 主参考

```text
D:\mystream\Sekiro Shadows Die Twice\tools\事件编辑器3.4.1\DarkScript3.exe
```

Event 不使用 Smithbox Param 四栏，也不保留 SoulForge “EMEVD 四视图”。

### 11.2 固定结构（初值，以 REF-01 实测为准）

```text
Event Files / Outline 260px
| Source Editor flex
| optional Inspector 320px

Problems / Output bottom dock
```

### 11.3 Source Editor

后续实现使用 CodeMirror 6，并具备：

- 行号；
- 代码折叠；
- DarkScript 风格语法高亮；
- 查找与替换；
- Go to Event / Definition / Reference；
- 错误与警告 gutter；
- 多文档标签；
- dirty 标记；
- undo/redo；
- 键盘导航；
- 大文档增量渲染。

### 11.4 Inspector 和诊断

- Event list 转为左侧 Outline；
- 指令详情和控制流只作为用户显式打开的 Inspector；
- 原始 bytes/Hex 只能从 Developer Diagnostics 打开；
- Problems 只显示可行动问题；
- parser dump、Evidence、绝对路径不进入默认 editor DOM。

底层 DSL、revision、typed mutation、Bridge/Patch Engine 能力保留并重接到源码工作流；不再以前台“四视图”暴露。

---

## 12. TRAE 式 Agent 右侧 dock

### 12.1 产品决定

Agent 常驻主窗口右侧，照搬 TRAE/Cursor 式构图；不是独立窗口，不允许重新停靠成其他 pane，也不是旧任务管理控制台。**参考来源缺口：** §2.2 所列 TRAE 参考截图目前不在 `tools` 目录或仓库内。拿不到参考图时，不得把本节初值当作「与 TRAE 一致」的证据，处置按 §2.2 Agent 行：报告缺失、由调用方决定补图实测 / 接受初值为产品决定 / 暂停本卡。拿到参考图后，以 §2.4 实测流程为准并同步本节数值。

```text
48px Header
Scrollable welcome / conversation
Bottom Composer
```

```css
.agent-sidebar {
  display: grid;
  grid-template-rows: 48px minmax(0, 1fr) auto;
}
```

### 12.2 尺寸

以下数值应来自 TRAE 参考截图实测；参考图缺失时为实施初值，不得自行发明或宣称已实测：

```css
--agent-dock-default: 440px;
--agent-dock-min: 340px;
--agent-dock-max: 620px;
--agent-header-height: 48px;
--agent-resizer-width: 4px;
--agent-side-padding: 16px;
--agent-composer-min-height: 168px;
--agent-composer-max-height: min(320px, 40vh);
--agent-composer-toolbar-height: 44px;
--agent-icon-button-size: 28px;
--agent-send-button-size: 32px;
--agent-welcome-max-width: 360px;
```

- 默认 440px；
- workspace 级持久化；
- 鼠标拖动或键盘每次 16px；
- 普通状态只有 1px 左分隔线；
- 中央编辑器不足 560px 时变为主窗口内右侧 overlay；
- `Ctrl+J` 显示/隐藏；
- 隐藏不取消任务、不清除审批。

### 12.2.1 固定视觉样式

```css
.agent-sidebar {
  color: var(--ink-0);
  background: var(--forge-0);
  border-left: 1px solid var(--line);
  box-shadow: none;
}

.agent-dock-header {
  height: var(--agent-header-height);
  padding: 0 12px 0 16px;
  border-bottom: 1px solid var(--line);
}

.agent-welcome {
  width: min(100% - 32px, var(--agent-welcome-max-width));
  margin-inline: auto;
  transform: translateY(24px);
  text-align: center;
}

.agent-composer {
  margin: 0 var(--agent-side-padding) 16px;
  min-height: var(--agent-composer-min-height);
  max-height: var(--agent-composer-max-height);
  background: var(--forge-1);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-l);
  box-shadow: none;
  overflow: hidden;
}
```

细节固定为（初值，来源与 §12.2 相同）：

- header 产品名 13px/600；header controls 间距 4px，分隔线高 24px；
- welcome 图标容器 44×44px、圆角 4px；标题 28px/600、图标与标题间 12px；副标题 14px `var(--ink-3)`，上间距 8px；三行说明 14px、行高 1.8、左对齐，整体上间距 22px，勾选使用 `var(--ok)`；
- conversation viewport 水平 padding 16px，消息之间 16px；用户消息 padding 10px 12px，背景 `var(--forge-1)`，圆角最多 6px；Agent 正文无外框；
- composer participant bar 高 40px、padding 0 12px、背景 `var(--forge-2)`；prompt 区 padding 12px 16px；toolbar 高 44px、padding 0 10px；三层之间不用额外卡片；
- composer textarea 背景透明、无边框、无 outline，正文 14px/1.55；placeholder 使用 `var(--ink-3)`；
- 普通图标按钮 28×28px、图标 16px、背景透明；hover 为 `var(--forge-hover)`；active 为 `var(--forge-active)`；不得使用 glow；
- send/stop 32×32px，enabled 使用 `var(--ember)` 和 `var(--on-ember)`，disabled 使用 `var(--forge-3)` 和 `var(--ink-3)`；
- 只有 composer 外框、审批卡和临时 drawer 可以使用边界；欢迎区、Agent 回复、工具摘要不得再套 panel/card。

### 12.3 顶栏

左侧 `SoulForge`；右侧固定：

```text
新任务 | 历史 | 展开/恢复宽度 | 分隔线 | 关闭
```

按钮 28×28px，图标 16px。默认无背景、无边框；hover 只显示一级表面色；`focus-visible` 使用 2px 焦点环。“新任务”和“历史”必须是两个独立可见入口；若参考截图只有其一，必须明确用“新任务”覆盖其语义。不得放置模型配置、权限长文案、任务表单或设置齿轮。

### 12.4 空闲欢迎态

只在没有消息且没有活动任务时显示，垂直居中并下移约 24px：

```text
Agent
面向 Sekiro Mod 的安全协作编辑

✓ 理解当前参数、文本、事件与资源选区
✓ 先分析与规划，再生成可审查的修改
✓ 经 Patch Engine 提交，验证失败自动回滚
```

禁止推荐问题按钮、四步教程、工具数量、会话数量和模型警告。

### 12.5 消息流

以下像素值来源与 §12.2 相同（TRAE 参考截图实测；缺失时为初值）：

- 用户消息为轻微表面色全宽块，不使用气泡尾巴；
- Agent 回复使用普通文档排版，不套大卡片；
- 正文 13px，行高 1.6；
- 工具调用默认折叠为单行摘要；
- 原始参数、Hex、parser dump 和绝对路径不进入消息 DOM；
- 离底部超过 48px 后停止自动滚动并显示“回到底部”；
- 流式输出只更新当前回复；
- 审批卡是唯一允许明显边界的内容。

### 12.6 Composer

固定三层（像素初值来源与 §12.2 相同）：

```text
参与者条
输入区 + context chips
底部工具栏
```

参与者条：

```text
[Agent icon] @Agent [Ask / Plan / Edit]
```

输入区：

- 正文最小 72px；
- 自动增长，整个 Composer 不超过 40vh；
- Enter 发送，Shift+Enter 换行；
- IME composing 时禁止误发送；
- 占位文案：`与 Agent 对话。输入 / 查看可用命令，例如 /plan、/explain。`

底栏顺序固定：

```text
@ | # | 附件 | 模型选择 | 推理/Plan | 发送/停止
```

职责：

- `@` 选择当前 Param/Row/Field、FMG entry、Event/cursor 等语义实体；
- `#` 搜索 EditorCatalog 逻辑资源；
- 附件只接受截图或 main-issued renderer-safe reference token；
- 模型选择只显示已配置且健康检查通过的服务；
- Plan 显示真实运行模式；
- 空文本或上下文验证失败时发送 disabled；
- 执行中发送变为停止，停止只终止当前生成。

未打通真实链路的控件必须隐藏。

### 12.7 绝对禁止语音

不得出现或新增：

```text
麦克风按钮
语音按钮
录音权限请求
音频采集
语音转写
音频 IPC
语音占位按钮
语音相关测试和事件
```

### 12.8 语义上下文

```ts
export interface EditorSelectionContext {
  readonly domain: EditorDomainId;
  readonly libraryId: string | null;
  readonly bankId: string | null;
  readonly documentId: string | null;
  readonly paramTableId: string | null;
  readonly rowId: string | null;
  readonly fieldId: string | null;
  readonly fmgEntryId: string | null;
  readonly eventId: string | null;
  readonly cursor: { line: number; column: number } | null;
  readonly revision: string | null;
}
```

不得包含绝对路径。发送时冻结上下文快照，运行中切换编辑器不能改变任务目标。

### 12.9 Change Review

审批卡必须显示：

- 操作；
- 逻辑目标；
- diff；
- 影响范围；
- 验证；
- 备份；
- 回滚。

`批准并提交` 是唯一主按钮。提交失败必须说明失败阶段、是否已自动回滚和下一步操作。禁止巨型错误卡替换整个侧栏。

### 12.10 固定组件树

```text
AgentSidebar
├─ AgentDockResizer
├─ AgentDockHeader
├─ AgentConversationViewport
│  ├─ AgentWelcome
│  ├─ AgentMessageList
│  ├─ AgentToolActivityRow
│  ├─ AgentApprovalCard
│  └─ AgentScrollToBottom
├─ AgentComposer
│  ├─ AgentParticipantBar
│  ├─ AgentContextChipList
│  ├─ AgentPromptEditor
│  └─ AgentComposerToolbar
├─ AgentContextPicker
├─ AgentResourceReferencePicker
└─ AgentSecondaryDrawer
```

保留 `AgentSidebar` 外部导出名。`AgentTaskPanel` 不再作为顶部常驻控制台；任务进度、取消和审批进入消息流。模型服务、工具库存、会话历史和开发设置进入 `AgentSecondaryDrawer`。

组件不得全部塞回一个超大 `AgentSidebar.tsx`。60A–60D 必须按上述边界拆文件，并为每个有状态组件提供独立 reducer 或纯状态转换测试。

### 12.11 Agent typed DTO 和状态机

所有 Agent IPC 必须使用 named DTO 和 runtime decoder：

```ts
export type AgentRunMode = 'ask' | 'plan' | 'edit';

export interface AgentContextSnapshot {
  readonly snapshotId: string;
  readonly selection: EditorSelectionContext;
  readonly createdAt: string;
}

export interface AgentMessagePageRequest {
  readonly sessionId: string;
  readonly cursor: string | null;
  readonly limit: number; // 1..100
}

export interface AgentMessagePage {
  readonly items: readonly AgentMessageDto[];
  readonly nextCursor: string | null;
}

export type AgentMessageDto =
  | { id: string; kind: 'user'; text: string; contextSnapshotId: string; createdAt: string }
  | { id: string; kind: 'assistant'; markdown: string; streaming: boolean; createdAt: string }
  | { id: string; kind: 'tool-activity'; summary: string; status: 'running'|'succeeded'|'failed'; createdAt: string }
  | { id: string; kind: 'approval'; reviewId: string; status: 'pending'|'approved'|'rejected'|'committed'|'failed'; createdAt: string };

export type AgentStreamEvent =
  | { seq: number; sessionId: string; kind: 'message-started'; message: AgentMessageDto }
  | { seq: number; sessionId: string; kind: 'message-delta'; messageId: string; delta: string }
  | { seq: number; sessionId: string; kind: 'message-finished'; messageId: string }
  | { seq: number; sessionId: string; kind: 'tool-updated'; message: AgentMessageDto }
  | { seq: number; sessionId: string; kind: 'approval-updated'; message: AgentMessageDto }
  | { seq: number; sessionId: string; kind: 'run-failed'; reasonCode: string; retryable: boolean };

export interface AgentAttachmentReference {
  readonly token: string;
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  readonly byteLength: number;
  readonly expiresAt: string;
}

export interface AgentResourceReference {
  readonly token: string;
  readonly domain: EditorDomainId;
  readonly label: string;
  readonly expiresAt: string;
}

export interface SubmitAgentRunRequest {
  readonly sessionId: string;
  readonly prompt: string;
  readonly mode: AgentRunMode;
  readonly modelConfigId: string;
  readonly contextSnapshotId: string;
  readonly attachments: readonly AgentAttachmentReference[];
  readonly resources: readonly AgentResourceReference[];
}

export interface StopAgentRunRequest {
  readonly sessionId: string;
  readonly runId: string;
}

export interface DecideAgentApprovalRequest {
  readonly sessionId: string;
  readonly reviewId: string;
  readonly expectedRevision: string;
  readonly decision: 'approve-and-commit' | 'reject';
}
```

`limit` 必须由 decoder 限制为 1–100；`seq` 必须严格递增，重复/倒序 event 丢弃并记诊断。`prompt` 限 1–65536 UTF-16 code units，attachments 最多 8 个、resources 最多 16 个。附件和资源引用只使用 main-issued、带大小/类型/TTL 的 token，不携带路径。`modelConfigId` 必须在 main 的健康服务快照中存在，renderer 不能提交 provider 凭据或权限模式。

Composer reducer 固定状态：

```text
idle → composing → submitting → streaming → idle
                         ├→ tool-running → streaming
                         ├→ awaiting-approval → committing → verifying → idle
                         └→ failed → composing
```

类型与 reducer 签名固定为：

```ts
export type AgentComposerState =
  | { kind: 'idle'; prompt: '' }
  | { kind: 'composing'; prompt: string }
  | { kind: 'submitting'; runId: string }
  | { kind: 'streaming'; runId: string }
  | { kind: 'tool-running'; runId: string; toolActivityId: string }
  | { kind: 'awaiting-approval'; runId: string; reviewId: string }
  | { kind: 'committing'; runId: string; reviewId: string }
  | { kind: 'verifying'; runId: string; reviewId: string }
  | { kind: 'failed'; prompt: string; reasonCode: string };

export type AgentComposerEvent =
  | { type: 'PROMPT_CHANGED'; prompt: string }
  | { type: 'SUBMIT'; runId: string }
  | { type: 'STREAM_STARTED'; runId: string }
  | { type: 'DELTA'; runId: string }
  | { type: 'TOOL_STARTED'; runId: string; toolActivityId: string }
  | { type: 'TOOL_FINISHED'; runId: string }
  | { type: 'APPROVAL_REQUIRED'; runId: string; reviewId: string }
  | { type: 'APPROVE'; runId: string; reviewId: string }
  | { type: 'REJECT'; runId: string; reviewId: string }
  | { type: 'COMMIT_FINISHED'; runId: string; reviewId: string }
  | { type: 'VERIFY_FINISHED'; runId: string; reviewId: string }
  | { type: 'STREAM_FINISHED'; runId: string }
  | { type: 'FAIL'; prompt: string; reasonCode: string }
  | { type: 'STOP'; runId: string }
  | { type: 'RESET' };

export declare function reduceAgentComposer(
  state: AgentComposerState,
  event: AgentComposerEvent,
): AgentComposerState;
```

允许转换固定为：`idle/composing + PROMPT_CHANGED`、`composing + SUBMIT → submitting`、`submitting + STREAM_STARTED → streaming`、`streaming + TOOL_STARTED → tool-running`、`tool-running + TOOL_FINISHED → streaming`、`streaming/tool-running + APPROVAL_REQUIRED → awaiting-approval`、`awaiting-approval + APPROVE → committing`、`awaiting-approval + REJECT → idle`、`committing + COMMIT_FINISHED → verifying`、`verifying + VERIFY_FINISHED → idle`、`streaming + STREAM_FINISHED → idle`、任意活动态 `+ FAIL → failed`、任意活动态 `+ STOP → idle`、`failed + RESET → composing/idle`。其他组合必须返回原状态并记录开发诊断；不允许用多个互不约束的 boolean 表示同一状态机。

---

## 13. GameParam 打开链路

### 13.1 正常打开目标

点击 PARAM 默认打开 effective primary：

```text
param/gameparam/gameparam.parambnd.dcx
```

不得打开：

```text
param/gameparam/gameparam.parambnd.dcx.bak
```

Mod 侧 DFLT GameParam read 不要求已挂载原版目录，也不要求创建写入 staging root。只有实际 format stack 为 KRAK 且需要用户本地 Oodle runtime 时，才显示对应 runtime blocker。

### 13.2 Bridge allowed roots

Bridge 收到的每个 allowed root 必须在调用前存在且经过 main 验证。只读调用只传真实存在的 overlay/base roots；不得为方便统一附加一个尚不存在的 staging 目录。

需要 staging 的调用顺序固定为：

```text
mkdir recursive
→ realpath
→ verify main-owned workspace storage boundary
→ register allowed root
→ Bridge open/extract/write
```

必须新增 main-owned root preparation helper，所有 Bridge production handler 复用；不得只修一个 PARAM handler。

### 13.3 错误显示

`Every allowed root must be an existing directory.` 必须转换为可行动 Problems：

```text
无法准备安全暂存目录。GameParam 尚未打开。
操作：重试 / 打开 Problems / 检查工作区存储权限
```

原始技术消息可放 Problems details，不能出现在 PARAM 第一栏，更不能清空其他可浏览内容。

---

## 14. 状态模型

### 14.1 文档加载状态

```ts
export type DocumentLoadPhase =
  | 'catalog-resolve' | 'locator-resolve' | 'bridge-open'
  | 'native-parse' | 'document-store' | 'first-page';

export type DocumentLoadReasonCode =
  | 'document-not-found' | 'history-only' | 'bridge-runtime-unavailable'
  | 'compression-runtime-unavailable' | 'native-format-unconfirmed'
  | 'native-parse-failed' | 'partial-native-document' | 'capability-blocked'
  | 'request-cancelled' | 'request-expired' | 'unknown-format';

export type DocumentLoadState =
  | { kind: 'idle' }
  | { kind: 'loading'; phase: DocumentLoadPhase }
  | { kind: 'ready' }
  | { kind: 'empty'; reason: 'true-empty' }
  | { kind: 'no-match'; query: string }
  | { kind: 'partial'; reasonCode: DocumentLoadReasonCode }
  | { kind: 'blocked'; reasonCode: DocumentLoadReasonCode; retryable: boolean }
  | { kind: 'unsupported'; reasonCode: DocumentLoadReasonCode }
  | { kind: 'error'; reasonCode: DocumentLoadReasonCode; retryable: boolean };
```

“0 条”只能用于已成功解析且真实为空。路由失败、Bridge 失败、容器未解包和数据被截断不能显示为 empty。

只读、可写和缺失操作由 `OperationCapability` 表达，不得再塞进 `DocumentLoadState`。例如文档可以同时是 `load=ready` 且 `write=blocked`；这比把整个文档标成 `readonly` 更精确。

### 14.2 编辑事务状态

```ts
export type EditTransactionState =
  | { kind: 'clean' }
  | { kind: 'dirty'; revision: string }
  | { kind: 'staging'; operationId: string }
  | { kind: 'staged'; operationId: string }
  | { kind: 'awaiting-approval'; operationId: string }
  | { kind: 'committing'; operationId: string }
  | { kind: 'verifying'; operationId: string; phase: string }
  | { kind: 'committed'; operationId: string; committedRevision: string }
  | { kind: 'rolling-back'; operationId: string }
  | { kind: 'rolled-back'; operationId: string; restoredRevision: string }
  | { kind: 'rollback-failed'; operationId: string; reasonCode: string }
  | { kind: 'failed'; operationId: string; phase: string; reasonCode: string };
```

状态栏和 Change Review 必须显示当前状态。局部失败保留其他 pane 和已加载数据。

### 14.3 能力状态

必须分别表达：

- 调用方对本次 operation 的直接授权（不增加额外实施门槛）；
- declared support level；
- runtime availability；
- operation-specific read capability；
- operation-specific write capability；
- native verification authority。

Bridge handshake 成功、fixture 成功或扫描到文件，均不能单独产生 write capability。

### 14.4 DocumentStore 与 mutation IPC 闭合契约

renderer 发送逻辑引用，main 从当前 trusted sender/session 解析 locator。`ownerKey`、绝对路径和 locator 永远不出 main/core：

```ts
// packages/core internal only; never export through shared/preload.
export interface NativeDocumentLocatorLayer {
  readonly layerIndex: number;
  readonly formatId: Exclude<NativeFormatId, 'unknown'>;
  readonly entry: null | {
    readonly parentLayerIndex: number;
    readonly stableEntryId: string;
    readonly entryIndex: number;
    readonly entryName: string;
    readonly expectedEntryHash: string;
  };
}

export interface NativeDocumentLocator {
  readonly locatorId: string;
  readonly outerResourceId: string;
  readonly outerSourceUri: string; // main-only absolute resource URI
  readonly sourceVariant: 'overlay' | 'base';
  readonly expectedOuterRevision: string;
  readonly expectedOuterHash: string;
  readonly containerRole: ContainerRole;
  readonly layers: readonly NativeDocumentLocatorLayer[];
  readonly leafDocumentStableId: string;
}

export type EditorScalar = null | boolean | number | string | readonly number[];

export interface TypedFieldChange {
  readonly fieldId: string;
  readonly value: EditorScalar;
}

export type EditorMutation =
  | { kind: 'param-field-set'; tableId: string; rowId: string; fieldId: string; value: EditorScalar }
  | { kind: 'param-row-upsert'; tableId: string; rowId: string; fields: readonly TypedFieldChange[] }
  | { kind: 'param-row-delete'; tableId: string; rowId: string }
  | { kind: 'gparam-field-set'; bankId: string; groupId: string; fieldId: string; value: EditorScalar }
  | { kind: 'fmg-entry-upsert'; tableId: string; entryId: string; text: string }
  | { kind: 'fmg-entry-delete'; tableId: string; entryId: string }
  | { kind: 'emevd-source-change'; sourceText: string }
  | { kind: 'bnd4-child-replace'; childStableId: string; stagedPayloadToken: string }
  | { kind: 'script-plaintext-change'; childStableId: string; text: string; encoding: string; newline: 'crlf'|'lf'|'preserve' }
  | { kind: 'map-entity-upsert'; entityStableId: string; fields: readonly TypedFieldChange[] }
  | { kind: 'map-entity-delete'; entityStableId: string }
  | { kind: 'flver-material-slot-set'; meshStableId: string; slotIndex: number; materialStableId: string }
  | { kind: 'tpf-texture-replace'; textureStableId: string; attachmentToken: string }
  | { kind: 'material-property-set'; propertyId: string; value: EditorScalar }
  | { kind: 'vfx-field-set'; nodeStableId: string; fieldId: string; value: EditorScalar }
  | { kind: 'behavior-transition-upsert'; stateStableId: string; transitionStableId: string; fields: readonly TypedFieldChange[] }
  | { kind: 'tae-event-upsert'; animationStableId: string; eventStableId: string; fields: readonly TypedFieldChange[] };

export interface OpenEditorDocumentRequest {
  readonly document: LogicalDocumentRef;
}

export type EditorPageQuery =
  | { kind: 'param-tables'; search: string }
  | { kind: 'param-rows'; tableId: string; search: string }
  | { kind: 'param-fields'; tableId: string; rowId: string }
  | { kind: 'gparam-groups'; bankId: string; search: string }
  | { kind: 'gparam-fields'; bankId: string; groupId: string }
  | { kind: 'fmg-entries'; tableId: string; search: string }
  | { kind: 'event-outline'; search: string }
  | { kind: 'container-entries'; parentStableId: string | null; search: string }
  | { kind: 'script-symbols'; search: string }
  | { kind: 'resource-tree'; parentStableId: string | null; search: string }
  | { kind: 'properties'; targetStableId: string; groupId: string | null };

export interface PageEditorDocumentRequest {
  readonly documentHandle: string;
  readonly expectedRevision: string;
  readonly query: EditorPageQuery;
  readonly cursor: string | null;
  readonly limit: number; // decoder: integer 1..500
}

export type EditorContentQuery =
  | { kind: 'fmg-content'; tableId: string; entryId: string }
  | { kind: 'event-source' }
  | { kind: 'script-source'; childStableId: string }
  | { kind: 'resource-preview'; targetStableId: string };

export interface ReadEditorContentRequest {
  readonly documentHandle: string;
  readonly expectedRevision: string;
  readonly query: EditorContentQuery;
}

export interface ApplyEditorMutationRequest {
  readonly documentHandle: string;
  readonly expectedRevision: string;
  readonly mutation: EditorMutation;
}

export type EditorDocumentErrorCode =
  | 'invalid-request' | 'not-found' | 'owner-mismatch' | 'stale-revision'
  | 'capability-blocked' | 'runtime-blocked' | 'native-open-failed'
  | 'mutation-rejected' | 'cancelled' | 'expired';

export interface OpenEditorDocumentValue {
  readonly documentHandle: string;
  readonly revision: string;
  readonly loadState: DocumentLoadState;
  readonly readOperations: readonly ReadOperationId[];
  readonly writeOperations: readonly WriteOperationId[];
}

export type EditorPageItemDto =
  | { kind: 'param-table'; tableId: string; name: string; localizedName: string | null }
  | { kind: 'param-row'; tableId: string; rowId: string; name: string | null; change: 'none'|'added'|'modified'|'deleted' }
  | { kind: 'param-field'; tableId: string; rowId: string; fieldId: string; name: string; value: EditorScalar; compareValue: EditorScalar; enumLabel: string | null; valueType: string; description: string | null; editable: boolean }
  | { kind: 'gparam-group'; bankId: string; groupId: string; name: string }
  | { kind: 'gparam-field'; bankId: string; groupId: string; fieldId: string; name: string; value: EditorScalar; compareValue: EditorScalar; editable: boolean }
  | { kind: 'fmg-entry'; tableId: string; entryId: string; preview: string; change: 'none'|'added'|'modified'|'deleted' }
  | { kind: 'event-outline'; eventId: string; displayName: string; startLine: number; endLine: number }
  | { kind: 'container-entry'; stableId: string; name: string; formatId: NativeFormatId; byteLength: number; childCount: number }
  | { kind: 'script-symbol'; symbolId: string; name: string; symbolKind: 'function'|'variable'|'label'; line: number }
  | { kind: 'resource-node'; stableId: string; parentStableId: string | null; label: string; nodeKind: string; hasChildren: boolean }
  | { kind: 'property'; targetStableId: string; groupId: string | null; propertyId: string; label: string; value: EditorScalar; compareValue: EditorScalar; editable: boolean };

export interface EditorDocumentPageValue {
  readonly documentHandle: string;
  readonly revision: string;
  readonly queryKind: EditorPageQuery['kind'];
  readonly items: readonly EditorPageItemDto[];
  readonly nextCursor: string | null;
  readonly totalKnown: number | null;
}

export type EditorContentValue =
  | { kind: 'fmg-content'; tableId: string; entryId: string; text: string }
  | { kind: 'event-source'; sourceText: string; sourceDigest: string }
  | { kind: 'script-source'; childStableId: string; text: string; editable: boolean; encoding: string; newline: 'crlf'|'lf'|'mixed' }
  | { kind: 'resource-preview'; targetStableId: string; previewToken: string; mediaType: string; byteLength: number };

export interface ApplyEditorMutationValue {
  readonly documentHandle: string;
  readonly revision: string;
  readonly transactionState: EditTransactionState;
}

export type EditorDocumentResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: EditorDocumentErrorCode; retryable: boolean };
```

core store 的固定签名是：

```ts
export interface EditorDocumentStoreContract {
open(ownerKey: string, locator: NativeDocumentLocator): Promise<EditorDocumentResult<OpenEditorDocumentValue>>;
get(ownerKey: string, documentHandle: string): Promise<EditorDocumentResult<OpenEditorDocumentValue>>;
page(ownerKey: string, request: PageEditorDocumentRequest): Promise<EditorDocumentResult<EditorDocumentPageValue>>;
readContent(ownerKey: string, request: ReadEditorContentRequest): Promise<EditorDocumentResult<EditorContentValue>>;
apply(ownerKey: string, request: ApplyEditorMutationRequest): Promise<EditorDocumentResult<ApplyEditorMutationValue>>;
close(ownerKey: string, documentHandle: string): Promise<EditorDocumentResult<{ closed: true }>>;
}
```

IPC handler 必须从 trusted `webContents` 推导 `ownerKey`，并要求 `OpenEditorDocumentRequest.document` 与当前活动 Catalog 中的整条引用精确匹配；不得接受 renderer 提供的 owner/locator/URI 值。所有请求先过 runtime decoder；另一 renderer 即使猜中 handle 也得到 `owner-mismatch`。page 返回的 item kind 必须与 query kind 匹配，否则 decoder 拒绝整页。

---

## 15. D0–D10 原生能力闭环

> **符号撞名提示：** 本节 D0–D10 与 §4.2 的 `ReadCapabilityStage`（D3–D6）/ `WriteCapabilityStage`（D7–D10）使用相同字母但语义不同：前者是本规范定义的前端工作流循环编号，后者是 capability resolver 的能力阶段。实现类型时严格按 §4.2 的字面类型定义（stage 语义）写，不得把本节循环编号当成 capability stage。两者保持原样，不互相合并。

扫描到文件不等于获得能力。任何可见编辑动作必须完成：

```text
D0  Caller-authorized operation and assigned scope；只读取本次调用范围，不匹配额外任务对象
D1  Physical scan
D2  Semantic EditorCatalog
D3  Bridge native open / confirmed format stack
D4  Main-owned DocumentStore revision + hashes
D5  Shared/preload bounded typed DTO
D6  Unique WorkbenchRoute + honest load state
D7  Typed mutation
D8  Bridge rebuild DCX/BND4/native outer stack
D9  Patch Engine commit + backup/recovery point
D10 Native reopen + semantic verify + automatic rollback
```

### 15.1 写能力不变量

只有 main-owned capability resolver 可以返回 write-ready。以下任一条件必须失败关闭：

- 当前任务或运行期策略不允许该 operation；
- operation-specific capability 不允许；
- runtime/Oodle/metadata 缺失；
- Bridge 只有 candidate/fixture authority；
- native writer 未验证；
- D7–D10 任一 gap 非空；
- 外层格式无法重建；
- unknown/opaque changed region 无法证明；
- sibling 无法枚举或验证；
- native reread 不可用。

resolver 的 main/core 内部输入固定为：

```ts
interface InternalCapabilityResolverSnapshot {
  readonly snapshotId: string;
  readonly operationId: WriteOperationId;
  readonly callerAuthorized: boolean;
  readonly registeredSupport: boolean;
  readonly runtimeReady: boolean;
  readonly bridgeAuthority: 'candidate' | 'fixture-confirmed' | 'native-verified';
  readonly writerProfileId: string | null;
  readonly verifiedStages: readonly WriteCapabilityStage[];
  readonly gaps: readonly CapabilityReasonCode[];
}
```

只有 `callerAuthorized && registeredSupport && runtimeReady && bridgeAuthority === 'native-verified' && writerProfileId !== null && verifiedStages` 精确包含 D7/D8/D9/D10 且 `gaps.length === 0` 时，resolver 才能构造 `WriteCapability.kind = 'ready'`。构造函数不从 shared 导出；renderer 只能消费结果。负向测试必须逐一证明 false authorization、candidate、fixture-only、runtime blocked、writer null、缺任一 stage、任一 gap 都不能得到 write-ready。

### 15.2 提交顺序

`NativeRoundTripExpectation` 是 `packages/core` / main / Patch Engine 内部密封对象，不得放入 shared、preload 或 renderer。实施 Agent不得让 renderer 传入“如何验证自己的修改”。

```ts
type NativeMutationExpectation =
  | { kind: 'param-field-set'; table: string; rowId: string; field: string; valueDigest: string }
  | { kind: 'param-row-upsert'; table: string; rowId: string; rowDigest: string }
  | { kind: 'param-row-delete'; table: string; rowId: string }
  | { kind: 'gparam-field-set'; bankId: string; groupId: string; field: string; valueDigest: string }
  | { kind: 'fmg-entry-upsert'; tableId: string; entryId: string; textDigest: string }
  | { kind: 'fmg-entry-delete'; tableId: string; entryId: string }
  | { kind: 'emevd-source-change'; documentId: string; sourceDigest: string }
  | { kind: 'bnd4-child-replace'; childStableId: string; childHash: string }
  | {
      kind: 'script-plaintext-change';
      childStableId: string;
      decodedTextDigest: string;
      encoding: string;
      bom: 'present' | 'absent';
      newline: 'crlf' | 'lf' | 'preserve';
      trailingNulBytes: number;
    }
  | { kind: 'map-entity-upsert'; entityStableId: string; entityDigest: string }
  | { kind: 'map-entity-delete'; entityStableId: string }
  | { kind: 'flver-material-slot-set'; meshStableId: string; slotIndex: number; materialStableId: string }
  | { kind: 'tpf-texture-replace'; textureStableId: string; textureDigest: string; metadataDigest: string }
  | { kind: 'material-property-set'; propertyId: string; valueDigest: string }
  | { kind: 'vfx-field-set'; nodeStableId: string; fieldId: string; valueDigest: string }
  | { kind: 'behavior-transition-upsert'; stateStableId: string; transitionStableId: string; transitionDigest: string }
  | { kind: 'tae-event-upsert'; animationStableId: string; eventStableId: string; eventDigest: string };

type NativeVerifierProfileId =
  | 'verify-param-field-v1' | 'verify-param-row-v1' | 'verify-gparam-field-v1'
  | 'verify-fmg-entry-v1' | 'verify-emevd-source-v1' | 'verify-bnd4-child-v1'
  | 'verify-script-text-v1' | 'verify-msb-entity-v1' | 'verify-flver-material-slot-v1'
  | 'verify-tpf-texture-v1' | 'verify-material-property-v1' | 'verify-fxr-field-v1'
  | 'verify-esd-transition-v1' | 'verify-tae-event-v1';

const VERIFIER_PROFILE_BY_MUTATION = {
  'param-field-set': 'verify-param-field-v1',
  'param-row-upsert': 'verify-param-row-v1',
  'param-row-delete': 'verify-param-row-v1',
  'gparam-field-set': 'verify-gparam-field-v1',
  'fmg-entry-upsert': 'verify-fmg-entry-v1',
  'fmg-entry-delete': 'verify-fmg-entry-v1',
  'emevd-source-change': 'verify-emevd-source-v1',
  'bnd4-child-replace': 'verify-bnd4-child-v1',
  'script-plaintext-change': 'verify-script-text-v1',
  'map-entity-upsert': 'verify-msb-entity-v1',
  'map-entity-delete': 'verify-msb-entity-v1',
  'flver-material-slot-set': 'verify-flver-material-slot-v1',
  'tpf-texture-replace': 'verify-tpf-texture-v1',
  'material-property-set': 'verify-material-property-v1',
  'vfx-field-set': 'verify-fxr-field-v1',
  'behavior-transition-upsert': 'verify-esd-transition-v1',
  'tae-event-upsert': 'verify-tae-event-v1',
} as const satisfies Record<NativeMutationExpectation['kind'], NativeVerifierProfileId>;

type TypeEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false;
type AssertTrue<T extends true> = T;
type _WriteOperationsMatchEditorMutations = AssertTrue<TypeEqual<WriteOperationId, EditorMutation['kind']>>;
type _EditorMutationsMatchNativeExpectations = AssertTrue<TypeEqual<EditorMutation['kind'], NativeMutationExpectation['kind']>>;

interface NativeRoundTripExpectation {
  readonly planId: string;
  readonly documentHandle: string;
  readonly expectedSourceRevision: string;
  readonly beforeImage:
    | { kind: 'present'; outerHash: string; recoveryPointId: string }
    | { kind: 'absent'; recoveryPointId: string };
  readonly stagedOuterHash: string;
  readonly expectedMutation: NativeMutationExpectation;
  readonly verifierProfileId: NativeVerifierProfileId;
  readonly expectedSiblingHashes: Readonly<Record<string, string>>;
  readonly allowedChangedRegionIds: readonly string[];
}
```

每个 `NativeMutationExpectation.kind` 必须绑定固定 verifier profile；不存在通用 `unknown` payload 或调用方自定义 Bridge command。

提交顺序固定为：

```text
final stale guard
→ create present/absent-aware recovery point
→ stage native outer artifact
→ seal main-only roundtrip plan
→ Patch Engine replace/create
→ verify committed outer hash == staged hash
→ Bridge reopen outer
→ domain semantic verify
→ sibling/unchanged-region verify
→ success
```

任一验证失败：

```text
return failure to WorkspaceTransaction
→ rollback recovery point
→ verify before image restored
→ expose sanitized summary to renderer
```

renderer 不能构造 roundtrip expectation、Bridge command、locator 或恢复凭据。

`beforeImage.kind = 'absent'` 的 rollback 只能删除本事务刚创建、仍位于已复核 Patch target boundary 内且 committed hash 与本事务记录一致的 overlay；随后必须再次验证目标不存在。任一 identity/hash/boundary 不一致都进入 `rollback-failed`，不得宽泛删除目录或同名文件。

### 15.3 未实现、只读、延期和失败

这些状态必须如实显示，但不能成为永久逃避链路的理由：

- 产品终局要求可编辑的领域必须拆出 D0–D10 断点任务；
- 明确延期的能力不得用相邻功能的实现冒充已经打通；
- UI 只显示已打通的操作；
- 后续能力开放后必须从最早缺失的 D 阶段继续，而非制造假按钮。

---

## 16. 当前错误实现必须如何替换

| 当前入口 | 已知错误 | 后续任务必须完成的替换 |
| --- | --- | --- |
| `apps/desktop/src/renderer/src/navigation/domainNavigation.ts` | 以 `resourceKind` 和路径把物理文件分到领域 | 改为只映射 `EditorCatalogSummary`；若仍存在 `domainForFile` 则任务失败 |
| `apps/desktop/src/renderer/src/navigation/DomainNavigationBar.tsx` | 接收 files 并显示物理数量 | 只接收 `DomainSummary[]`；顶部无数量 |
| `apps/desktop/src/renderer/src/navigation/resourceFamilies.ts` | 固定 `event/map/param/msg/menu/...` 物理家族 | 从领域栏 production 依赖中移除；只允许 Files 高级过滤复用物理 taxonomy |
| `apps/desktop/src/renderer/src/navigation/WorkspaceResourceBar.tsx` | 把扫描文件数直接显示在顶部 | 从 `App.tsx` production shell 断开；由 `DomainNavigationBar(EditorCatalogSummary.domains)` 取代 |
| `apps/desktop/src/renderer/src/format/uiText.ts` | 可能按 `resourceKind` 过滤当前列表 | 物理格式文案仅用于 Files/details，不参与语义 domain 或 route |
| `apps/desktop/src/renderer/src/App.tsx` | 语义领域继续渲染全局资源浏览器 | PARAM/GPARAM/Text/Event 直接挂载对应成熟工作台；Files 才挂物理浏览器 |
| `apps/desktop/src/renderer/src/workbench/selectEditor.ts` | `.bak` 被允许进入 Param；目录优先 | artifact role 优先；`.bak` History-only；confirmed format 优先 |
| `apps/desktop/src/renderer/src/workbench/ParamWorkbench.tsx` | 三栏、错误卡、物理文件标题 | Smithbox 四栏（初值，以 REF-01 实测为准）、局部错误、逻辑库标题 |
| `apps/desktop/src/renderer/src/editors/FmgWorkbenchPanel.tsx` | 只有 Entries/Content，缺 language/container/file list 与 Tools | 替换成 Smithbox Text 完整选择链和四栏工作台（初值，以 REF-01 实测为准） |
| `apps/desktop/src/renderer/src/editors/EmevdFourViewPanel.tsx` | 该文件仍在磁盘上，但主工作树 `App.tsx` 已不引用它（历史接线只存在于 `.claude/worktrees/` 残留中）；历史上它把流程/指令/DSL/Hex 当成默认四视图 | 保持断开；确认 `App.tsx` 无任何 production 引用后不新增引用；默认改为 DarkScript3 式 source editor，Hex 仅开发诊断。**注意：** 四视图 UI 断开的治理冲突见 §0.3——未取得 scope 裁定时不得执行断开动作，也不得删除该文件或宣布底层能力失效 |
| `apps/desktop/src/main/ipc.ts` | 非存在 staging root 进入 Bridge allowedRoots | 复用 main-owned root preparation helper；只读不传 staging |
| `apps/desktop/src/renderer/src/agent/AgentSidebar.tsx` | 旧控制台或非 TRAE 构图 | 48px/header + conversation + bottom composer；无语音 |
| `apps/desktop/src/renderer/src/workbench/selectEditor.test.ts` | 可能把“按目录分派”和 `.bak` 正向路由钉成正确行为 | 删除旧正向断言，加入 History-only、confirmed-format-first 和 unique-route 负向矩阵 |
| `apps/desktop/e2e/playwright/tests/renderer.spec.mjs` | 可能把物理目录顺序、物理数量和常驻资源浏览器钉成验收目标 | 改为 catalog domain、带单位逻辑数量、成熟工作台和 Files-only 物理浏览器验收 |

禁止在旧错误路径旁新增一套未接 production 的组件。测试必须证明生产入口已经切换。

---

## 17. 视觉、可访问性、响应式和性能验收

### 17.1 五项视觉审查

> **责任归属：** 五项审查是主观视觉判断，执行者是用户/调用方（人工），不是 flash Agent。实施 Agent 的职责是产出审查所需证据——同尺寸参考截图与 SoulForge 对照截图、结构清单（pane 数/顺序/栏宽/行高/Tools 位置/选择链），并在报告里写明「已产出五项审查所需证据」。Agent 不得在报告里宣称「五项审查通过」，也不得把自身宣告通过当作任务完成条件；人工审查未通过时，问题退回产生差异的原 UI 卡。

#### Copy

把参考工具和 SoulForge 并排。检查栏数、顺序、表头、工具位置、行高、滚动和选择链。结构性差异即阻断。

#### Density

同尺寸视口中，SoulForge 可见的有效 table/row/field 数量应与 Smithbox 接近。若因 padding、卡片或大标题显著减少，任务失败。

#### Swap

临时交换相邻 pane 的视觉位置进行审查；若用户不能立即辨认哪栏是 Params/Rows/Fields/Tools，说明层级不清。

#### Squint

缩小或模糊观察，主选择、当前 pane、主要操作和错误状态仍应清晰，不得由大量卡片争抢注意力。

#### Grayscale

灰度下仍能通过位置、边界、字重和图标区分选择、dirty、warning 和 error；不能只依赖颜色。

### 17.2 三个质量支柱

| 支柱 | 通过条件 | 阻断示例 |
| --- | --- | --- |
| Frictionless | 从领域入口到 table/row/field 不超过成熟工具的选择层级 | 先选物理文件、再选编辑器、再选 table |
| Quality Craft | 与参考工具结构一致、token 化、键盘可达、200% 可用 | 卡片化、硬编码散落、焦点丢失 |
| Trustworthy | 能力和错误真实、Change Review 可审查、失败可恢复 | 假按钮、空表掩盖解析失败、巨型错误卡 |

### 17.3 窗口与缩放

必须验证：

```text
1024px
1280px
1440px
1920px
200% system/browser zoom
340 / 440 / 620px Agent widths
```

窄窗口策略：

- 先收起低频 Tools；
- 再允许 Inspector overlay；
- Agent 在中央编辑器不足 560px 时 overlay；
- 不把 pane 垂直堆成移动端卡片；
- 关键表格继续支持水平滚动或列收缩。

### 17.4 键盘与 ARIA

- pane header、list、grid、tree、editor、toolbar 使用正确语义；
- 方向键改变列表选择；
- Enter 激活；Escape 返回上层或关闭临时 overlay；
- resizer 支持键盘并声明当前值；
- `focus-visible` 不得被 hover 颜色覆盖；
- 状态变化使用适当 live region，不朗读流式输出的每个 token；
- 200% 缩放无控件遮挡。

### 17.5 性能

- PARAM Rows、Fields、Text Entries、Event Outline 必须分页或虚拟化；
- renderer 不接收完整无限制容器；
- 切换父项取消旧请求；
- 流式 Agent 只更新当前消息；
- 每栏独立滚动，不让整个主工作台重排；
- 搜索使用稳定 debounce 和请求序列号避免旧结果覆盖新选择。

---

## 18. Flash Agent 机械实施手册

### 18.1 本节不增加外部前置条件

`BASE-00 / REF-01 / CAT-05 / PARAM-10B` 等编号只是本文内部技术步骤。本文被交付为实现任务时，Agent直接在调用方给定范围内按本节推进，不得自行增加任务匹配或审批流程。

只有以下情况允许停下：当前步骤依赖的上一技术步骤实际失败；缺少必须由用户选择的输入；更高优先级规则明确禁止某项操作。停止报告必须写明具体失败命令、错误和仍可继续的部分，不能写“缺少前端任务”。

### 18.2 每卡字段和文件标记

`[CREATE]` 表示该精确文件必须新建；`[MODIFY]` 表示修改现有文件；未列出的文件不得修改。每张实现卡都必须按顺序执行：先负向测试 → 类型/数据层 → production wiring → UI → 命令验证 → 截图。

每张卡自动继承以下默认字段；卡片正文只覆盖不同项，实施 Agent 不得自行补充范围：

- **Prerequisites**：只依赖第 18.3 节 DAG 中指向本卡的已完成技术步骤。
- **Forbidden**：卡片 `Allowed` 未逐字列出的所有仓库文件、治理数据、真实游戏资产、本机工具目录和其他人的未提交改动。
- **Input**：上一技术步骤产出的 typed DTO、main-owned handle 和 capability snapshot；不得以路径、`unknown` 或 renderer 自造状态替代。
- **Output**：卡片明确列出的 production contract、测试和截图；不得只产出 demo、fixture 页面或未接线组件。
- **IPC order**：renderer request → preload typed facade → trusted main handler → core/Bridge；响应按相反方向返回脱敏 DTO。没有 IPC 的卡不得新增 IPC。
- **Failure**：任一 decoder、边界、revision、capability、Bridge、复读或视觉验收失败均失败关闭；保留其他可浏览内容，不伪装空数据。
- **Rollback**：只反向撤销本卡触碰的文件；写入卡还必须验证 WorkspaceTransaction 恢复点恢复 before image。不得 reset、删除或覆盖卡外改动。
- **Non-claims**：typecheck、静态测试、synthetic fixture、截图或单一 raw parser 通过，均不代表 native roundtrip、writer authority、发布或整个产品完成。

通用验证基线：

```text
npm run typecheck
npm run test:renderer-unit
npm run test:desktop-security
npm run test:desktop-ipc-contract
```

涉及 renderer 生产路径的卡再运行 `npm run test:renderer-e2e`；涉及原生格式的卡再运行该格式对应的 `bridge:verify:*` 或本文指定的新命令。

### 18.3 固定技术 DAG

```text
BASE-00 → REF-01 → SCHEMA-02 → NATIVE-03 → DOCSTORE-04
DOCSTORE-04 → CAT-05 → ROUTE-06 → ROOT-07
ROUTE-06 → SHELL-09
SHELL-09 → PARAM-10A → PARAM-10B → PARAM-10C
SHELL-09 → GPARAM-11A → GPARAM-11B → GPARAM-11C
SHELL-09 → TEXT-20A → TEXT-20B → TEXT-20C
SHELL-09 → EVENT-30A → EVENT-30B → EVENT-30C
SHELL-09 → CONTAINER-40 → SCRIPT-41
SHELL-09 → MAP-50A → MAP-50B → MAP-50C
SHELL-09 → MODEL-51A → MODEL-51B → MODEL-51C
SHELL-09 → TEXTURE-52A → TEXTURE-52B → TEXTURE-52C
SHELL-09 → MATERIAL-53A → MATERIAL-53B → MATERIAL-53C → MATERIAL-53D → MATERIAL-53E
SHELL-09 → VFX-54A → VFX-54B → VFX-54C
SHELL-09 → BEHAVIOR-55A → BEHAVIOR-55B → BEHAVIOR-55C
SHELL-09 → ANIMATION-56A → ANIMATION-56B → ANIMATION-56C
SHELL-09 → AGENT-60A → AGENT-60B → AGENT-60C → AGENT-60D
全部目标卡 → VISUAL-70 → ACCEPT-99
```

边说明：

- SHELL-09 只依赖 ROUTE-06（唯一 WorkbenchRoute），**不依赖 BND4-08**：SHELL-09 是 catalog 驱动的渲染外壳改造，BND4-08 是 native 容器 read/rebuild 基础，二者无数据依赖，不得因 BND4-08 阻塞全部 UI 外壳。
- BASE-00 的完成条件（desktop typecheck 归零，见 §18.4 Done）是**所有会修改或新增 renderer 文件的 UI 卡**的隐式前置：调用方派发任何编辑器/Agent UI 卡时，必须先确认 BASE-00 已完成，否则该 UI 卡不得开始。
- `BND4-08 → CONTAINER-40`：CONTAINER-40 依赖 BND4-08 的 read/rebuild 产物（§18.18 的测试条款保留此依赖）。

严禁在 CAT-05 完成前先用物理文件分组实现 SHELL-09。

### 18.4 BASE-00 — 恢复可信基线

- **Current**：本规范编写前的已记录 desktop typecheck 快照为 69 条 `ParamWorkbench.tsx` 错误，首个根错误是 `selectedRowId is not defined`。**该数字是历史快照**：工作树有大量未提交的前端改动，近期提交已接通字段枚举，实际数字必然不同。执行本卡时必须重跑并记录实时结果，任何 UI 卡都不得引用本节历史数字判断现状。当前工作树可能已有其他人的未提交代码；全部视为用户内容。
- **Allowed**：无文件修改。
- **Steps**：记录 `git status --short`；运行通用验证基线；记录失败，不删除、不 reset、不覆盖既有改动。
- **Tests**：按顺序执行 `npm run typecheck`、`npm run test:renderer-unit`、`npm run test:desktop-security`、`npm run test:desktop-ipc-contract`；逐条保存 exit code 和首个根错误。
- **Done**：得到开始时文件清单和逐命令结果；后续只归因于本任务实际触碰的文件。任何编辑器 UI 卡开始前，desktop typecheck 必须归零；错误边界或截图不能替代。

### 18.5 REF-01 — 成熟工具参考基线

- **Allowed**：无仓库文件修改；截图只进任务临时/交付产物区。
- **Steps**：打开 Smithbox PARAM、GPARAM、Text、Map、Model、Texture、Material、Files；打开 DarkScript3 Event；记录第 2.4 节全部测量。
- **Outputs**：每个页面一张完整参考截图、一份 pane/控件/密度清单、一份与本文 §6–§11 初值逐项对照的结构差异清单；不得只截局部。
- **Tests**：每张截图必须能同时看见完整窗口、全部 panes、页面标题和非空样本；检查文件实际存在、分辨率非 0、对应页面名称与清单一致；结构差异清单必须覆盖 pane 数、顺序、栏宽、行高、Tools 入口五项。
- **Done**：所有后续 UI 卡都能引用同尺寸参考图；与本文初值冲突的结构项已按 §2.4 步骤 8 在相应卡内同步更新本文，或已明确标注「该卡未对照参考程序实测」。

### 18.6 SCHEMA-02 — 闭合 shared 类型与 decoder

- **Allowed**：`[CREATE] packages/shared/src/editor-catalog.ts`；`[MODIFY] packages/shared/src/editor-protocol.ts`；`[MODIFY] packages/shared/src/index.ts`；`[MODIFY] packages/shared/package.json`。
- **Input/Output**：第 4、5、12、14 节的 closed union → exported types + runtime decoders。
- **Steps**：实现 `EditorDomainId`、format candidate/confirmed stack、catalog、capability、route、load/transaction state、selection context；所有 decoder 拒绝 absolute path 和 unknown extra fields。
- **Tests**：`[CREATE] packages/shared/src/editor-catalog.test.ts`；在 shared package 新增精确 `test:editor-catalog-schema` 命令。
- **Done**：`npm run typecheck -w @soulforge/shared` 和 `npm run test:editor-catalog-schema -w @soulforge/shared` 通过；preload/renderer 不出现 `unknown` DTO。

### 18.7 NATIVE-03 — Bridge 确认格式栈和 main-only locator

- **Allowed**：`[CREATE] packages/core/src/editing/nativeDocumentLocator.ts`；`[MODIFY] packages/shared/src/bridge-protocol.ts`；`[MODIFY] bridge/SoulForge.Bridge/BridgeCommandService.cs`；`[MODIFY] bridge/SoulForge.Bridge/BridgeDaemonHost.cs`；`[CREATE] packages/core/src/testing/runNativeDocumentLocatorSmoke.ts`；`[MODIFY] packages/core/package.json`；`[MODIFY] package.json`。
- **Input**：main-issued resource handle；**Output**：outer resource identity、ordered Bridge-confirmed layers、每层 binder entry id/index/name/hash；renderer 只得 opaque document handle。
- **Steps**：suffix/path 只生成 candidate；Bridge probe 生成 confirmed stack；container role 与 byte format 分开；同 child 冲突失败关闭。
- **Tests**：新增 root 命令 `test:native-document-locator` 并运行 `npm run test:native-document-locator`；覆盖 DFLT→BND4→PARAM、KRAK runtime blocked、loose format、重复 child name、冲突 leaf、路径脱敏。

### 18.8 DOCSTORE-04 — owner-bound DocumentStore 与 typed IPC

- **Allowed**：`[MODIFY] packages/core/src/editing/editorDocumentStore.ts`；`[MODIFY] packages/core/src/editing/editorMutationService.ts`；`[MODIFY] packages/shared/src/editor-protocol.ts`；`[MODIFY] apps/desktop/src/main/ipc.ts`；`[MODIFY] apps/desktop/src/main/rendererDto.ts`；`[MODIFY] apps/desktop/src/preload/index.ts`；`[MODIFY] packages/core/src/testing/runEditorDocumentStoreSmoke.ts`。
- **API**：严格实现第 14.4 节的 `open/get/page/readContent/apply/close` 六个签名；所有请求/响应为 named DTO，不保留 `Promise<unknown>` 旁路。
- **Security**：ownerKey 由 main 从 trusted `webContents` 和 workspace session 派生，renderer 永远不能传入；猜中其他窗口 handle 也必须拒绝。
- **Tests**：`npm run test:editor-document-store`、`npm run test:editor-mutation-service`、desktop IPC/security；覆盖 stale revision、cancel、TTL、bounded page、cross-sender rejection。

### 18.9 CAT-05 — EditorCatalog builder 和 Sekiro 固定规则

- **Allowed**：`[MODIFY] packages/shared/src/types.ts`；`[MODIFY] packages/core/src/workspace/scanWorkspace.ts`；`[MODIFY] packages/core/src/workspace/resourceKinds.ts`；`[CREATE] packages/core/src/workspace/editorCatalog.ts`；`[CREATE] packages/core/src/testing/runEditorCatalogSmoke.ts`；`[MODIFY] packages/core/package.json`；`[MODIFY] package.json`；`[MODIFY] apps/desktop/src/main/rendererDto.ts`。
- **Input**：physical index、artifact role、confirmed stack、capability snapshot；**Output**：`EditorCatalogSnapshot` 和脱敏 summary。
- **Steps**：scanner 只新增 artifact/source variant/projection 基础标记，不改变现有物理 `ResourceKind`；在 core 实现 priority、overlay/base effective variant、backup/history、sidecar projection、hidden、library/bank/document key 和 conflict；不能调用 renderer helper。
- **Tests**：新增 root 命令 `test:editor-catalog` 并运行 `npm run test:editor-catalog`；“34 GParam + primary + backup”是 §4.5 的磁盘样本快照，验收时必须按当时挂载 workspace 经 Bridge 实测的动态样本数替换；语义断言不变：primary 得到 Param 1 library、每个实测 GParam 得一个 bank、History 1；TPF→Texture；未知→Files。

### 18.10 ROUTE-06 — 唯一 WorkbenchRoute

- **Allowed**：`[MODIFY] apps/desktop/src/renderer/src/workbench/selectEditor.ts`；`[MODIFY] apps/desktop/src/renderer/src/workbench/selectEditor.test.ts`；`[MODIFY after SCHEMA-02] packages/shared/src/editor-catalog.ts`。
- **Steps**：改为 artifact-role prefilter → 对 primary/base 才允许显式 Open With → confirmed leaf/child → read capability → candidate → Files；删除目录优先和 `.bak` PARAM helper。
- **Required tests**：`.bak` History-only；GParam 非 Param；TPF 非 Text；candidate 非 ready；hidden 无 route；每个输入恰好一个 route。
- **Done**：旧测试“`.bak 仍是 param`”和“按资源目录分派”已被反向测试替换。

### 18.11 ROOT-07 — Bridge allowed-root 生命周期

- **Allowed**：`[CREATE] apps/desktop/src/main/bridgeRoots.ts`；`[CREATE] scripts/verify-bridge-roots-gate.mjs`；`[MODIFY] apps/desktop/src/main/ipc.ts`；`[MODIFY] package.json`。
- **API**：`prepareBridgeRoots(session, operation: 'read'|'stage')`；read 只返回已存在 verified roots；stage 执行 mkdir→realpath→boundary check 后加入 staging。
- **Tests**：新增 root 命令 `test:bridge-roots` 并运行 `npm run test:bridge-roots`；覆盖 staging 初始不存在、readonly 不创建、stage 安全创建、symlink/越界拒绝、所有 Bridge handler 使用 helper。
- **Done**：不得再把 non-existing path 交给 Bridge。`scripts/verify-bridge-roots-gate.mjs` 必须接入治理层验证调度（`scripts/verify/tiers.mjs`），由治理层统一执行，不得只作为本文局部验收的孤岛脚本。

### 18.12 BND4-08 — 通用 container read/rebuild 基础

- **Allowed**：`[MODIFY] bridge/SoulForge.Bridge/Bnd4NativeDocument.cs`；`[MODIFY] bridge/SoulForge.Bridge/Bnd4NativeWriter.cs`；`[MODIFY] bridge/SoulForge.Bridge/DcxNativeDocument.cs`；`[MODIFY] bridge/SoulForge.Bridge/BridgeCommandService.cs`；`[MODIFY] packages/core/src/editing/saveContainerChild.ts`；`[MODIFY] packages/core/src/transactions/workspaceTransaction.ts`；`[MODIFY] packages/core/src/backup/restorePoint.ts`。
- **Read**：outer DCX→BND4→stable entries，分页返回；**Write**：typed child mutation→rebuild parent→stage outer；present/absent recovery point。
- **Tests**：`npm run bridge:verify:bnd4-writer`、`npm run bridge:verify:bnd4-transaction`、`npm run test:writer-failure-matrix`；注入 reopen failure 并验证 present hash 恢复、新建 overlay 在 absent rollback 后消失。

### 18.13 SHELL-09 — Catalog 驱动 full-bleed shell

- **Allowed**：`[MODIFY] apps/desktop/src/renderer/src/navigation/domainNavigation.ts`；`[MODIFY] apps/desktop/src/renderer/src/navigation/DomainNavigationBar.tsx`；`[CREATE] apps/desktop/src/renderer/src/navigation/domainNavigation.test.ts`；`[MODIFY] apps/desktop/src/renderer/src/navigation/WorkspaceResourceBar.tsx`；`[MODIFY] apps/desktop/src/renderer/src/navigation/resourceFamilies.ts`；`[MODIFY] apps/desktop/src/renderer/src/format/uiText.ts`；`[MODIFY] apps/desktop/src/renderer/src/format/uiText.test.ts`；`[MODIFY] apps/desktop/src/renderer/src/App.tsx`；`[MODIFY] apps/desktop/src/renderer/src/styles.css`；`[MODIFY] apps/desktop/e2e/playwright/tests/renderer.spec.mjs`。
- **Steps**：领域栏仅接 `DomainSummary[]`；删除物理计数；语义领域不渲染全局 resource browser；Files 独占物理浏览；editor full-bleed；pane 独立滚动。
- **Negative source tests**：无 `domainForFile`、`filterFilesForDomain(files)`、`visibleFiles.length` 领域计数。
- **Done**：顶部无 `PARAM 36`，PARAM 入口直接打开逻辑库。

### 18.14 PARAM 任务系列（10A → 10B → 10C）

#### PARAM-10A — primary read

- **Allowed**：`[MODIFY] bridge/SoulForge.Bridge/ParamNativeDocument.cs`；`[MODIFY] bridge/SoulForge.Bridge/BridgeCommandService.cs`；`[MODIFY] packages/core/src/editing/paramBridgeCommit.ts`；`[MODIFY] apps/desktop/src/main/ipc.ts`；`[MODIFY] apps/desktop/src/preload/index.ts`；`[CREATE] apps/desktop/src/renderer/src/workbench/ParamWorkbench.test.tsx`。
- **Flow**：Catalog primary handle→Bridge outer open/extract→Param pages→DocumentStore→bounded DTO；Mod DFLT 不依赖 base mount/staging。
- **Tests**：`npm run bridge:verify:param`、`npm run test:param-metadata-native`、renderer unit；backup 不读、失败非 empty。

#### PARAM-10B — Smithbox 四栏 UI（初值，以 REF-01 实测为准）

- **Allowed**：`[MODIFY] apps/desktop/src/renderer/src/workbench/ParamWorkbench.tsx`；`[MODIFY] apps/desktop/src/renderer/src/styles.css`；`[MODIFY] apps/desktop/e2e/playwright/tests/renderer.spec.mjs`；`[MODIFY after PARAM-10A] apps/desktop/src/renderer/src/workbench/ParamWorkbench.test.tsx`。
- **Steps**：实现 Params/Rows/Fields/Tools 20/29/35/16（初值，以 REF-01 实测为准）、虚拟行、字段类型控件、父选区清理、局部错误和真实 tools gating。
- **Negative DOM**：无 `.gparam.dcx`、`.bak`、物理路径、Evidence、Hex、三栏标题。
- **Tests**：`npm run test:renderer-unit`、`npm run test:renderer-e2e`；断言四栏（或 REF-01 实测结构）同时存在、比例/min-width、父选区清理、独立滚动、虚拟 row、字段类型控件、局部失败和同尺寸截图。

#### PARAM-10C — write/roundtrip

- **Allowed**：`[MODIFY] bridge/SoulForge.Bridge/ParamNativeWriter.cs`；`[MODIFY] packages/core/src/editing/paramBridgeCommit.ts`；`[MODIFY] packages/core/src/editing/editorMutationService.ts`；`[MODIFY] packages/core/src/transactions/workspaceTransaction.ts`；`[MODIFY] packages/core/src/backup/restorePoint.ts`；`[MODIFY] apps/desktop/src/main/ipc.ts`。
- **Flow**：typed field/row mutation→outer stage→sealed expectation→Patch→Bridge reopen→semantic/sibling verify→rollback。
- **Tests**：`npm run test:param-field-mutation`、`npm run test:param-field-write-matrix`、`npm run test:container-param-writeback`；raw fixture 不替代 outer-chain test。

### 18.15 GPARAM 任务系列（11A → 11B → 11C）

#### GPARAM-11A — native read 与 bank catalog

- **Allowed**：`[CREATE] packages/shared/src/gparam-editor.ts`；`[CREATE] bridge/SoulForge.Bridge/GparamNativeDocument.cs`；`[MODIFY] bridge/SoulForge.Bridge/BridgeCommandService.cs`；`[MODIFY] bridge/SoulForge.Bridge/BridgeDaemonHost.cs`；`[CREATE] packages/core/src/testing/runNativeGparamSmoke.ts`；`[MODIFY] apps/desktop/src/main/ipc.ts`；`[MODIFY] apps/desktop/src/preload/index.ts`；`[MODIFY] packages/core/package.json`；`[MODIFY] package.json`。
- **Flow**：confirmed GPARAM handle → Bridge native open → stable map bank/group/field/value IDs → bounded pages → DocumentStore；多个磁盘文件只成为 `draw-graphics-parameters` 的 banks。
- **Tests**：新增 root 命令 `bridge:verify:gparam`，运行 `npm run bridge:verify:gparam`；该命令调用 `runNativeGparamSmoke.ts` 编译产物并覆盖 loose GPARAM、DCX GPARAM、invalid header、bounded page、banks 去重和绝对路径脱敏（banks 数量按当时实测样本数断言，不写死 34）。
- **Done**：Bridge 返回可复读的 typed GPARAM document；不能借 PARAM parser，也不能把 read failure 显示为空 bank。

#### GPARAM-11B — Smithbox Graphics Param 工作台

- **Allowed**：`[CREATE] apps/desktop/src/renderer/src/workbench/GparamWorkbench.tsx`；`[CREATE] apps/desktop/src/renderer/src/workbench/GparamWorkbench.test.tsx`；`[MODIFY] apps/desktop/src/renderer/src/App.tsx`；`[MODIFY] apps/desktop/src/renderer/src/styles.css`；`[MODIFY] apps/desktop/e2e/playwright/tests/renderer.spec.mjs`。
- **Steps**：照搬 Smithbox `Banks | Groups | Fields/Values | Tools`，比例 18/24/42/16（初值，以 REF-01 实测为准）；父级改变清理所有下游选区；bank 名称为主、物理文件名只在 metadata details。
- **Negative DOM**：无 PARAM table、`.bak`、全局资源浏览器、证据、Hex 或假写入按钮。
- **Tests**：`npm run test:renderer-unit`、`npm run test:renderer-e2e`；断言四栏（或 REF-01 实测结构）、banks 数按当时实测样本数、下游清理、独立滚动、read-only gating 和 Smithbox 同尺寸截图。
- **Done**：所有 confirmed 样本只在 Banks 第一栏出现，切换 bank/group 时字段和值稳定更新且各栏独立滚动。

#### GPARAM-11C — typed write 与 roundtrip

- **Allowed**：`[CREATE] bridge/SoulForge.Bridge/GparamNativeWriter.cs`；`[CREATE] packages/core/src/editing/gparamBridgeCommit.ts`；`[CREATE] packages/core/src/testing/runNativeGparamWriterSmoke.ts`；`[MODIFY] bridge/SoulForge.Bridge/BridgeCommandService.cs`；`[MODIFY] bridge/SoulForge.Bridge/BridgeDaemonHost.cs`；`[MODIFY] apps/desktop/src/main/ipc.ts`；`[MODIFY] packages/core/package.json`；`[MODIFY] package.json`。
- **Flow**：`gparam-field-set` → source storage profile（loose/DCX/container）→ native writer → outer stage → sealed expectation → Patch → reopen → field/sibling verify → rollback on failure。
- **Tests**：新增 root 命令 `bridge:verify:gparam-writer`，运行 `npm run bridge:verify:gparam-writer`；该命令调用 `runNativeGparamWriterSmoke.ts` 编译产物并分别覆盖 loose、DCX、container child，注入 reopen failure 并验证 before image。
- **Done**：只有通过 11C 的 storage profile 才显示字段编辑控件；不存在通用 bytes replace fallback。

### 18.16 Text 任务系列（20A → 20B → 20C）

#### TEXT-20A — FMG read 与语言/容器目录

- **Allowed**：`[MODIFY] bridge/SoulForge.Bridge/FmgNativeDocument.cs`；`[MODIFY] apps/desktop/src/main/ipc.ts`；`[MODIFY] apps/desktop/src/preload/index.ts`；`[CREATE] apps/desktop/src/renderer/src/editors/FmgWorkbenchPanel.test.tsx`。
- **Flow**：Text library → language bank → item/menu container → FMG table → paged entries/content；language/container IDs 来自 Bridge metadata，不从 `msg/` 路径猜。
- **Tests**：`npm run bridge:verify:fmg`、`npm run test:fmg-reference-integrity`、renderer unit；覆盖真空表、parse failure、语言缺失、重复 FMG ID、TPF route rejection。
- **Done**：选择链每一级都有 typed ID；失败不返回 `0 entries`。

#### TEXT-20B — Smithbox Text 工作台

- **Allowed**：`[MODIFY] apps/desktop/src/renderer/src/editors/FmgWorkbenchPanel.tsx`；`[MODIFY after TEXT-20A] apps/desktop/src/renderer/src/editors/FmgWorkbenchPanel.test.tsx`；`[MODIFY] apps/desktop/src/renderer/src/styles.css`；`[MODIFY] apps/desktop/e2e/playwright/tests/renderer.spec.mjs`。
- **Steps**：实现 `Languages/Containers/File List | Text Entries | Text Content | Tools`，比例 24/30/30/16（初值，以 REF-01 实测为准）；支持 IME、Unicode、按 ID/文本搜索、独立滚动和父级切换清理。
- **Negative DOM**：`menu/**/*.tpf.dcx` 不出现；无物理目录 tab、主区 evidence/hex 和未接线 Tools。
- **Tests**：`npm run test:renderer-unit`、`npm run test:renderer-e2e`；完成 language→container→table→entry→content，全链键盘/IME/Unicode、无匹配与真空表分离、Smithbox 同尺寸截图。
- **Done**：用户能连续完成 language → container → table → entry → content，结构与 Smithbox 同尺寸对照一致。

#### TEXT-20C — FMG write 与 cross-language 验证

- **Allowed**：`[MODIFY] bridge/SoulForge.Bridge/FmgNativeWriter.cs`；`[MODIFY] packages/core/src/editing/fmgBridgeCommit.ts`；`[MODIFY] apps/desktop/src/main/ipc.ts`。
- **Flow**：`fmg-entry-upsert/delete` → msgbnd/DCX rebuild → sealed expectation → Patch → Bridge reopen → target/cross-language/sibling verify → rollback。
- **Tests**：`npm run test:fmg-reference-integrity` 加 outer-chain transaction cases；注入 duplicate ID、encoding failure、reopen failure 和 sibling change；raw `bridge:verify:fmg` 只作为 read prerequisite。
- **Done**：只有支持该 language/container storage profile 的操作显示编辑；未知字段变化阻止提交。

### 18.17 Event 任务系列（30A → 30B → 30C）

#### EVENT-30A — Bridge full document 与 source projection

- **Allowed**：`[MODIFY] bridge/SoulForge.Bridge/EmevdNativeDocument.cs`；`[MODIFY] bridge/SoulForge.Bridge/BridgeCommandService.cs`；`[MODIFY] packages/core/src/editing/emevdFullDocument.ts`；`[MODIFY] apps/desktop/src/main/ipc.ts`；`[MODIFY] apps/desktop/src/preload/index.ts`。
- **Flow**：confirmed outer handle → Bridge DCX/EMEVD open → events/instructions/strings → full document revision → DarkScript-compatible source projection + outline DTO。
- **Negative architecture**：production EMEVD open 不导入 TypeScript DCX parser，不以 prepared temp path 作为 Patch target。
- **Tests**：`npm run bridge:verify:emevd`、`npm run test:emevd-full-document`；覆盖 partial projection、unknown instruction、bounded outline 和绝对路径脱敏。

#### EVENT-30B — DarkScript3 source workbench

- **Allowed**：`[MODIFY] apps/desktop/src/renderer/src/editors/EventSourceWorkbenchPanel.tsx`；`[CREATE] apps/desktop/src/renderer/src/editors/EventSourceWorkbenchPanel.test.tsx`；`[MODIFY] apps/desktop/src/renderer/src/App.tsx`；`[MODIFY] apps/desktop/src/renderer/src/styles.css`；`[MODIFY] apps/desktop/e2e/playwright/tests/renderer.spec.mjs`；`[MODIFY] apps/desktop/package.json`；`[MODIFY] package-lock.json`。
- **Dependencies**：在 `apps/desktop/package.json` 加入 exact 版本 `@codemirror/state@6.7.1`、`@codemirror/view@6.43.8`、`@codemirror/language@6.12.4`、`@codemirror/search@6.7.1`、`@codemirror/commands@6.10.4`、`@codemirror/autocomplete@6.20.3`、`@lezer/highlight@1.2.3`，并更新根 lockfile。
- **Steps**：实现 files/outline 260px、source flex、optional inspector 320px、bottom Problems/Output；行号、折叠、高亮、查找替换、跳转、gutter、dirty tab 全部接真实状态。
- **Negative DOM**：`EmevdFourViewPanel` 不再被 `App.tsx` production 引用；Flow/Hex/Raw Bytes 不在默认 viewport。
- **Tests**：renderer unit/E2E；对照 DarkScript3 截图；键盘、IME、large source、diagnostic gutter 和多 tab dirty 状态。

#### EVENT-30C — compile、Patch 与 native reread

- **Allowed**：`[MODIFY] bridge/SoulForge.Bridge/EmevdNativeWriter.cs`；`[MODIFY] packages/core/src/editing/emevdBridgeCommit.ts`；`[MODIFY] packages/core/src/editing/emevdPlanCommit.ts`；`[MODIFY] apps/desktop/src/main/ipc.ts`。
- **Flow**：source/DSL compile → `emevd-source-change` → native outer stage → sealed expectation → Patch → Bridge reopen → event/instruction semantic verify → rollback。
- **Tests**：`npm run test:emevd-plan-production` 加 outer-chain success/reopen-failure/sibling-change cases；`bridge:verify:emevd` 不能单独完成写卡。
- **Done**：修改目标始终是 outer source resource；compile 失败只进 Problems，保留编辑文本，不产生 staged artifact。

### 18.18 Container 与 Script 任务

#### CONTAINER-40

- **Allowed**：`[MODIFY] apps/desktop/src/renderer/src/editors/Bnd4WorkbenchPanel.tsx`；`[CREATE] apps/desktop/src/renderer/src/editors/Bnd4WorkbenchPanel.test.tsx`；`[MODIFY] apps/desktop/src/renderer/src/styles.css`；`[MODIFY] apps/desktop/e2e/playwright/tests/renderer.spec.mjs`。
- **Steps**：实现第 10.1 节四栏（初值，以 REF-01 实测为准）、child projection、metadata/tools、typed child mutation UI。
- **Tests**：`npm run bridge:verify:bnd4-writer`、`npm run bridge:verify:bnd4-transaction`、renderer unit/E2E；若 BND4-08 未通过，本卡停止在该技术依赖，不扩大本卡文件范围。

#### SCRIPT-41

- **Allowed**：`[MODIFY] packages/shared/src/script-container.ts`；`[MODIFY] packages/core/src/script/plaintextScriptEntry.ts`；`[MODIFY] packages/core/src/script/plaintextScriptEdit.ts`；`[MODIFY] apps/desktop/src/main/ipc.ts`；`[MODIFY] apps/desktop/src/preload/index.ts`；`[MODIFY] apps/desktop/src/renderer/src/editors/ScriptContainerPanel.tsx`；`[CREATE] apps/desktop/src/renderer/src/editors/ScriptContainerPanel.test.tsx`；`[MODIFY] apps/desktop/src/renderer/src/styles.css`；`[MODIFY] apps/desktop/e2e/playwright/tests/renderer.spec.mjs`。
- **Steps**：container/source-disassembly/symbols/tools；encoding/BOM/newline/NUL 明示；bytecode 不伪装可编译。
- **Tests**：`npm run test:script-container-evidence`、`npm run test:plaintext-script-write`、renderer unit/E2E。

### 18.19 MAP/ASSET 独立卡

这些格式必须分别实施。每个 `A` 只完成 native read + bounded DTO，每个 `B` 只完成 Smithbox 工作台，每个 `C` 只完成 typed mutation + native roundtrip。终局目标包含下列 C 卡；A/B 期间 UI 隐藏写控件，但不得把隐藏状态报告为整个领域完成。

#### MAP-50A — MSB read

- **Allowed**：`[MODIFY] packages/shared/src/scene-ir.ts`；`[MODIFY] bridge/SoulForge.Bridge/MsbNativeDocument.cs`；`[MODIFY] packages/core/src/editing/msbBridgeRead.ts`；`[MODIFY] apps/desktop/src/main/ipc.ts`；`[MODIFY] apps/desktop/src/preload/index.ts`。
- **Output**：map/entity tree、stable entity IDs、transform/reference pages；**Tests**：`npm run bridge:verify:msb-all`，invalid/partial MSB 不能成为 empty scene。

#### MAP-50B — Smithbox Map workbench

- **Allowed**：`[MODIFY] apps/desktop/src/renderer/src/editors/MsbScenePanel.tsx`；`[CREATE] apps/desktop/src/renderer/src/editors/MsbScenePanel.test.tsx`；`[MODIFY] apps/desktop/src/renderer/src/App.tsx`；`[MODIFY] apps/desktop/src/renderer/src/styles.css`；`[MODIFY] apps/desktop/e2e/playwright/tests/renderer.spec.mjs`。
- **Output**：resource tree → viewport → inspector → tools；选择、gizmo、属性和 camera 与 Smithbox 流程对照；writer 未就绪时无保存动作。
- **Tests**：`npm run test:renderer-unit`、`npm run test:renderer-e2e`；tree/viewport/inspector 联动、无 writer action、resize/keyboard 和 Smithbox Map 对照截图。

#### MAP-50C — MSB write

- **Allowed**：`[MODIFY] bridge/SoulForge.Bridge/MsbNativeWriter.cs`；`[MODIFY] packages/core/src/editing/msbBridgeCommit.ts`；`[MODIFY] apps/desktop/src/main/ipc.ts`。
- **Flow/Tests**：`map-entity-upsert/delete` → outer stage/Patch/reopen/sibling verify/rollback；`npm run bridge:verify:msb-writer` 加 reopen-failure before-image 恢复。

#### MODEL-51A — FLVER read

- **Allowed**：`[CREATE] packages/shared/src/flver-editor.ts`；`[MODIFY] packages/shared/src/index.ts`；`[MODIFY] bridge/SoulForge.Bridge/FlverNativeDocument.cs`；`[MODIFY] apps/desktop/src/main/ipc.ts`；`[MODIFY] apps/desktop/src/preload/index.ts`。
- **Output/Tests**：mesh/material-slot/bounds pages；`npm run bridge:verify:flver-multi`；unknown layout 保持 partial，不伪装空模型。

#### MODEL-51B — Smithbox Model workbench

- **Allowed**：`[MODIFY] apps/desktop/src/renderer/src/editors/FlverWorkbenchPanel.tsx`；`[CREATE] apps/desktop/src/renderer/src/editors/FlverWorkbenchPanel.test.tsx`；`[MODIFY] apps/desktop/src/renderer/src/App.tsx`；`[MODIFY] apps/desktop/src/renderer/src/styles.css`；`[MODIFY] apps/desktop/e2e/playwright/tests/renderer.spec.mjs`。
- **Output**：model tree → viewport → inspector/tools；材质槽选择与 viewport 高亮同步；无大卡片和物理文件总表。
- **Tests**：`npm run test:renderer-unit`、`npm run test:renderer-e2e`；mesh/material-slot selection、viewport highlight、partial model、keyboard 和 Smithbox Model 对照截图。

#### MODEL-51C — FLVER material-slot write

- **Allowed**：`[CREATE] bridge/SoulForge.Bridge/FlverNativeWriter.cs`；`[CREATE] packages/core/src/editing/flverBridgeCommit.ts`；`[CREATE] packages/core/src/testing/runNativeFlverWriterSmoke.ts`；`[MODIFY] apps/desktop/src/main/ipc.ts`；`[MODIFY] packages/core/package.json`；`[MODIFY] package.json`。
- **Flow/Tests**：`flver-material-slot-set` → Patch/reopen/sibling verify/rollback；新增 root `bridge:verify:flver-writer` 并运行 `npm run bridge:verify:flver-writer`，该命令调用 writer smoke 编译产物。

#### TEXTURE-52A — TPF/DDS read

- **Allowed**：`[CREATE] packages/shared/src/tpf-editor.ts`；`[MODIFY] packages/shared/src/index.ts`；`[MODIFY] bridge/SoulForge.Bridge/TpfNativeDocument.cs`；`[MODIFY] bridge/SoulForge.Bridge/DdsCodec.cs`；`[MODIFY] apps/desktop/src/main/ipc.ts`；`[MODIFY] apps/desktop/src/preload/index.ts`。
- **Output/Tests**：texture list、preview token、dimensions/format/mipmap metadata；`npm run bridge:verify:tpf-multi`；`menu/**/*.tpf.dcx` 必须进入 Texture 而非 Text。

#### TEXTURE-52B — Smithbox Texture workbench

- **Allowed**：`[MODIFY] apps/desktop/src/renderer/src/editors/TpfWorkbenchPanel.tsx`；`[CREATE] apps/desktop/src/renderer/src/editors/TpfWorkbenchPanel.test.tsx`；`[MODIFY] apps/desktop/src/renderer/src/App.tsx`；`[MODIFY] apps/desktop/src/renderer/src/styles.css`；`[MODIFY] apps/desktop/e2e/playwright/tests/renderer.spec.mjs`。
- **Output**：bank/list → preview → metadata/tools；预览失败保留列表；writer 未就绪时隐藏 replace。
- **Tests**：`npm run test:renderer-unit`、`npm run test:renderer-e2e`；texture selection/preview/metadata、preview failure isolation、no fake replace 和 Smithbox Texture 对照截图。

#### TEXTURE-52C — texture replace

- **Allowed**：`[CREATE] bridge/SoulForge.Bridge/TpfNativeWriter.cs`；`[CREATE] packages/core/src/editing/tpfBridgeCommit.ts`；`[CREATE] packages/core/src/testing/runNativeTpfWriterSmoke.ts`；`[MODIFY] apps/desktop/src/main/ipc.ts`；`[MODIFY] packages/core/package.json`；`[MODIFY] package.json`。
- **Flow/Tests**：`tpf-texture-replace` → validate dimensions/format/color-space/mipmap → Patch/reopen/rollback；`npm run test:dds-convert-writeback`；新增 root `bridge:verify:tpf-writer` 并运行 `npm run bridge:verify:tpf-writer`。

#### MATERIAL-53A — MTD/MATBIN read

- **Allowed**：`[CREATE] packages/shared/src/material-editor.ts`；`[MODIFY] packages/shared/src/index.ts`；`[MODIFY] bridge/SoulForge.Bridge/MtdNativeDocument.cs`；`[MODIFY] bridge/SoulForge.Bridge/BridgeCommandService.cs`；`[MODIFY] bridge/SoulForge.Bridge/BridgeDaemonHost.cs`；`[CREATE] packages/core/src/testing/runNativeMtdSmoke.ts`；`[MODIFY] apps/desktop/src/main/ipc.ts`；`[MODIFY] apps/desktop/src/preload/index.ts`；`[MODIFY] packages/core/package.json`；`[MODIFY] package.json`。
- **Output/Tests**：material/property/value pages；新增 root `bridge:verify:mtd` 并运行 `npm run bridge:verify:mtd`；MATBIN 无确认 parser 时留 Files，不借 MTD parser。

#### MATERIAL-53B — Smithbox Material workbench

- **Allowed**：`[CREATE] apps/desktop/src/renderer/src/editors/MaterialWorkbenchPanel.tsx`；`[CREATE] apps/desktop/src/renderer/src/editors/MaterialWorkbenchPanel.test.tsx`；`[MODIFY] apps/desktop/src/renderer/src/App.tsx`；`[MODIFY] apps/desktop/src/renderer/src/styles.css`；`[MODIFY] apps/desktop/e2e/playwright/tests/renderer.spec.mjs`。
- **Output**：material list → properties/values → tools；unknown property 可见但不可编辑，不能丢弃。
- **Tests**：`npm run test:renderer-unit`、`npm run test:renderer-e2e`；property grouping/value type/unknown readonly/independent scroll 和 Smithbox Material 对照截图。

#### MATERIAL-53C — material property write

- **Allowed**：`[CREATE] bridge/SoulForge.Bridge/MtdNativeWriter.cs`；`[CREATE] packages/core/src/editing/materialBridgeCommit.ts`；`[CREATE] packages/core/src/testing/runNativeMtdWriterSmoke.ts`；`[MODIFY] bridge/SoulForge.Bridge/BridgeCommandService.cs`；`[MODIFY] apps/desktop/src/main/ipc.ts`；`[MODIFY] packages/core/package.json`；`[MODIFY] package.json`。
- **Flow/Tests**：`material-property-set` → unknown preservation → Patch/reopen/rollback；新增 root `bridge:verify:mtd-writer` 并运行 `npm run bridge:verify:mtd-writer`。

#### MATERIAL-53D — MATBIN read

- **Allowed**：`[CREATE] bridge/SoulForge.Bridge/MatbinNativeDocument.cs`；`[MODIFY] bridge/SoulForge.Bridge/BridgeCommandService.cs`；`[MODIFY] bridge/SoulForge.Bridge/BridgeDaemonHost.cs`；`[CREATE] packages/core/src/testing/runNativeMatbinSmoke.ts`；`[MODIFY] apps/desktop/src/main/ipc.ts`；`[MODIFY] apps/desktop/src/preload/index.ts`；`[MODIFY] packages/core/package.json`；`[MODIFY] package.json`。
- **Output/Tests**：复用 `material-editor.ts` 的 material/property DTO，但 `formatId` 保持 `matbin`；新增 root `bridge:verify:matbin` 并运行 `npm run bridge:verify:matbin`；不得借 MTD parser 或把 suffix 当确认。

#### MATERIAL-53E — MATBIN write

- **Allowed**：`[CREATE] bridge/SoulForge.Bridge/MatbinNativeWriter.cs`；`[CREATE] packages/core/src/editing/matbinBridgeCommit.ts`；`[CREATE] packages/core/src/testing/runNativeMatbinWriterSmoke.ts`；`[MODIFY] bridge/SoulForge.Bridge/BridgeCommandService.cs`；`[MODIFY] apps/desktop/src/main/ipc.ts`；`[MODIFY] packages/core/package.json`；`[MODIFY] package.json`。
- **Flow/Tests**：`material-property-set` 按 MATBIN storage profile 重建 → Patch/reopen/unknown preservation/rollback；新增 root `bridge:verify:matbin-writer` 并运行 `npm run bridge:verify:matbin-writer`。

#### VFX-54A — FXR read

- **Allowed**：`[CREATE] packages/shared/src/vfx-editor.ts`；`[MODIFY] packages/shared/src/index.ts`；`[CREATE] bridge/SoulForge.Bridge/FxrNativeDocument.cs`；`[MODIFY] bridge/SoulForge.Bridge/BridgeCommandService.cs`；`[MODIFY] bridge/SoulForge.Bridge/BridgeDaemonHost.cs`；`[CREATE] packages/core/src/testing/runNativeFxrSmoke.ts`；`[MODIFY] apps/desktop/src/main/ipc.ts`；`[MODIFY] apps/desktop/src/preload/index.ts`；`[MODIFY] packages/core/package.json`；`[MODIFY] package.json`。
- **Output/Tests**：effect/node/field tree；新增 root `bridge:verify:fxr` 并运行 `npm run bridge:verify:fxr`；unknown node layout 为 partial/blocked。

#### VFX-54B — Smithbox-style VFX workbench

- **Allowed**：`[CREATE] apps/desktop/src/renderer/src/editors/VfxWorkbenchPanel.tsx`；`[CREATE] apps/desktop/src/renderer/src/editors/VfxWorkbenchPanel.test.tsx`；`[MODIFY] apps/desktop/src/renderer/src/App.tsx`；`[MODIFY] apps/desktop/src/renderer/src/styles.css`；`[MODIFY] apps/desktop/e2e/playwright/tests/renderer.spec.mjs`。
- **Output**：resource tree → editor/preview → inspector → tools；已知/未知 node 状态明确。
- **Tests**：`npm run test:renderer-unit`、`npm run test:renderer-e2e`；known/unknown node、selection chain、preview isolation、no fake graph 和参考截图。

#### VFX-54C — FXR write

- **Allowed**：`[CREATE] bridge/SoulForge.Bridge/FxrNativeWriter.cs`；`[CREATE] packages/core/src/editing/vfxBridgeCommit.ts`；`[CREATE] packages/core/src/testing/runNativeFxrWriterSmoke.ts`；`[MODIFY] bridge/SoulForge.Bridge/BridgeCommandService.cs`；`[MODIFY] apps/desktop/src/main/ipc.ts`；`[MODIFY] packages/core/package.json`；`[MODIFY] package.json`。
- **Flow/Tests**：仅已知布局允许 `vfx-field-set`；新增 root `bridge:verify:fxr-writer` 并运行 `npm run bridge:verify:fxr-writer`；unknown changed region、reopen failure 均回滚。

#### BEHAVIOR-55A — ESD read

- **Allowed**：`[CREATE] packages/shared/src/behavior-editor.ts`；`[MODIFY] packages/shared/src/index.ts`；`[MODIFY] bridge/SoulForge.Bridge/EsdNativeDocument.cs`；`[MODIFY] apps/desktop/src/main/ipc.ts`；`[MODIFY] apps/desktop/src/preload/index.ts`。
- **Output/Tests**：state/condition/transition pages；`npm run bridge:verify:esd`；容器 child identity 稳定。

#### BEHAVIOR-55B — Behavior workbench

- **Allowed**：`[MODIFY] apps/desktop/src/renderer/src/editors/EsdWorkbenchPanel.tsx`；`[CREATE] apps/desktop/src/renderer/src/editors/EsdWorkbenchPanel.test.tsx`；`[MODIFY] apps/desktop/src/renderer/src/App.tsx`；`[MODIFY] apps/desktop/src/renderer/src/styles.css`；`[MODIFY] apps/desktop/e2e/playwright/tests/renderer.spec.mjs`。
- **Output**：resource/state tree → state/transition editor → inspector → tools；不按 action 目录分类。
- **Tests**：`npm run test:renderer-unit`、`npm run test:renderer-e2e`；machine/state/transition selection、partial error isolation、no action-path routing 和参考截图。

#### BEHAVIOR-55C — ESD transition write

- **Allowed**：`[CREATE] bridge/SoulForge.Bridge/EsdNativeWriter.cs`；`[CREATE] packages/core/src/editing/esdBridgeCommit.ts`；`[CREATE] packages/core/src/testing/runNativeEsdWriterSmoke.ts`；`[MODIFY] apps/desktop/src/main/ipc.ts`；`[MODIFY] packages/core/package.json`；`[MODIFY] package.json`。
- **Flow/Tests**：`behavior-transition-upsert` → container rebuild/Patch/reopen/rollback；新增 root `bridge:verify:esd-writer` 并运行 `npm run bridge:verify:esd-writer`。

#### ANIMATION-56A — TAE read

- **Allowed**：`[CREATE] packages/shared/src/animation-editor.ts`；`[MODIFY] packages/shared/src/index.ts`；`[MODIFY] bridge/SoulForge.Bridge/TaeNativeDocument.cs`；`[MODIFY] apps/desktop/src/main/ipc.ts`；`[MODIFY] apps/desktop/src/preload/index.ts`。
- **Output/Tests**：animation/event/timeline pages；`npm run bridge:verify:tae`；invalid time ranges 为 partial/error。

#### ANIMATION-56B — Animation workbench

- **Allowed**：`[MODIFY] apps/desktop/src/renderer/src/editors/TaeWorkbenchPanel.tsx`；`[CREATE] apps/desktop/src/renderer/src/editors/TaeWorkbenchPanel.test.tsx`；`[MODIFY] apps/desktop/src/renderer/src/App.tsx`；`[MODIFY] apps/desktop/src/renderer/src/styles.css`；`[MODIFY] apps/desktop/e2e/playwright/tests/renderer.spec.mjs`。
- **Output**：resource/animation tree → timeline/editor → inspector → tools；不按 chr/action 目录分类。
- **Tests**：`npm run test:renderer-unit`、`npm run test:renderer-e2e`；animation/event/timeline selection、invalid range display、no path routing 和参考截图。

#### ANIMATION-56C — TAE event write

- **Allowed**：`[CREATE] bridge/SoulForge.Bridge/TaeNativeWriter.cs`；`[CREATE] packages/core/src/editing/taeBridgeCommit.ts`；`[CREATE] packages/core/src/testing/runNativeTaeWriterSmoke.ts`；`[MODIFY] apps/desktop/src/main/ipc.ts`；`[MODIFY] packages/core/package.json`；`[MODIFY] package.json`。
- **Flow/Tests**：`tae-event-upsert` → container rebuild/Patch/reopen/time/sibling verify/rollback；新增 root `bridge:verify:tae-writer` 并运行 `npm run bridge:verify:tae-writer`。

### 18.20 Agent 任务系列（60A → 60B → 60C → 60D）

#### AGENT-60A — dock shell 与欢迎区

- **Allowed**：`[MODIFY] apps/desktop/src/renderer/src/agent/AgentSidebar.tsx`；`[MODIFY] apps/desktop/src/renderer/src/agent/agentSidebarRender.test.tsx`；`[CREATE] apps/desktop/src/renderer/src/agent/AgentDockResizer.tsx`；`[CREATE] apps/desktop/src/renderer/src/agent/AgentDockHeader.tsx`；`[CREATE] apps/desktop/src/renderer/src/agent/AgentConversationViewport.tsx`；`[CREATE] apps/desktop/src/renderer/src/agent/AgentWelcome.tsx`；`[MODIFY] apps/desktop/src/renderer/src/styles.css`；`[MODIFY] apps/desktop/src/renderer/src/App.tsx`。
- **Steps**：实现 48px header / minmax conversation / bottom composer grid；340/440/620px、4px resizer、16px keyboard resize、workspace persistence 和小空间 overlay；只使用第 12.4 节固定欢迎文案。
- **Tests**：idle 440×900 截图；340/620、Ctrl+J、drag/keyboard resize、overlay、hide/show 不清状态；无旧 task panel/tool count/session count。

#### AGENT-60B — 三层 Composer

- **Allowed**：`[CREATE] apps/desktop/src/renderer/src/agent/AgentComposer.tsx`；`[CREATE] apps/desktop/src/renderer/src/agent/AgentParticipantBar.tsx`；`[CREATE] apps/desktop/src/renderer/src/agent/AgentContextChipList.tsx`；`[CREATE] apps/desktop/src/renderer/src/agent/AgentPromptEditor.tsx`；`[CREATE] apps/desktop/src/renderer/src/agent/AgentComposerToolbar.tsx`；`[CREATE] apps/desktop/src/renderer/src/agent/agentComposerState.test.ts`；`[MODIFY] apps/desktop/src/renderer/src/agent/AgentSidebar.tsx`；`[MODIFY] apps/desktop/src/renderer/src/agent/agentSidebarRender.test.tsx`；`[MODIFY] apps/desktop/src/renderer/src/styles.css`。
- **Steps**：participant / prompt+chips / toolbar 三层；IME composing 禁止 Enter 发送；toolbar 固定 `@ | # | attachment | model | plan | send/stop`；每项按真实 callback/capability gating。
- **Tests**：Enter/Shift+Enter/IME、auto-grow 40vh cap、空输入 disabled、streaming stop；源码和 DOM 均不存在 `microphone|MediaRecorder|getUserMedia|speech recognition|audio IPC`。

#### AGENT-60C — selection context、资源引用和流式任务

- **Allowed**：`[CREATE] packages/shared/src/agent-ui.ts`；`[MODIFY] packages/shared/src/index.ts`；`[MODIFY] apps/desktop/src/main/ipc.ts`；`[MODIFY] apps/desktop/src/preload/index.ts`；`[CREATE] apps/desktop/src/renderer/src/agent/AgentContextPicker.tsx`；`[CREATE] apps/desktop/src/renderer/src/agent/AgentResourceReferencePicker.tsx`；`[CREATE] apps/desktop/src/renderer/src/agent/AgentMessageList.tsx`；`[MODIFY after AGENT-60A] apps/desktop/src/renderer/src/agent/AgentConversationViewport.tsx`；`[MODIFY] apps/desktop/src/renderer/src/agent/AgentSidebar.tsx`；`[MODIFY] apps/desktop/src/renderer/src/agent/agentSidebarRender.test.tsx`。
- **Steps**：实现第 12.8/12.11 节 decoder、selection snapshot freeze、opaque attachment token、bounded message pages、strict event seq、scroll threshold 和 resume；把 `selectedFilePath/contextLabel` production props 替换为 `EditorSelectionContext`。
- **Tests**：切换 editor 不改变已发送 snapshot；跨 sender token/handle 拒绝；绝对路径、raw parser/Hex 不进入 DTO 或 DOM；重复/倒序 seq 不重放。

#### AGENT-60D — tool activity、审批和二级抽屉

- **Allowed**：`[CREATE] apps/desktop/src/renderer/src/agent/AgentApprovalCard.tsx`；`[CREATE] apps/desktop/src/renderer/src/agent/AgentToolActivityRow.tsx`；`[CREATE] apps/desktop/src/renderer/src/agent/AgentSecondaryDrawer.tsx`；`[CREATE] apps/desktop/src/renderer/src/agent/AgentScrollToBottom.tsx`；`[MODIFY after AGENT-60A] apps/desktop/src/renderer/src/agent/AgentConversationViewport.tsx`；`[MODIFY] apps/desktop/src/renderer/src/agent/AgentSidebar.tsx`；`[MODIFY] apps/desktop/src/renderer/src/agent/agentSidebarRender.test.tsx`；`[MODIFY] apps/desktop/src/renderer/src/styles.css`；`[MODIFY] apps/desktop/src/main/ipc.ts`。
- **Steps**：tool call 默认单行折叠；Change Review 是消息流唯一强边界卡；模型/工具/历史迁到 drawer；关闭 dock 不取消 main-owned task；stop 只停当前生成。
- **Tests**：保存 conversation/tool-running/approval/failure 四态截图；审批显示 operation/target/diff/impact/validation/backup/rollback；提交失败显示 stage 和 rollback 结果；巨型错误卡不得替换 sidebar。

### 18.21 VISUAL-70 与 ACCEPT-99

- **VISUAL-70 Allowed**：无文件修改；产出五项审查所需证据——五种宽度的同尺寸对照截图、结构清单、200% 缩放与键盘/Narrator 观测记录（全部进临时产物区）；五项审查由用户/调用方执行（§17.1）。人工审查发现差异时退回产生差异的原 UI 卡，只使用该卡已列 Allowed，修复后重新运行 VISUAL-70 证据产出。
- **ACCEPT-99 Allowed**：无文件修改；运行通用基线、所有已修改格式的 native 命令、renderer E2E，并把第 19 节逐项勾选后的结果交给用户/调用方确认——第 19 节含主观视觉项的勾选属于人工验收，Agent 只报告可自动验证项的实测结果。
- **Done**：生产入口、数据层、UI、负向测试和截图全部成立；typecheck、单测、截图或 fixture 单项通过均不足以完成。

---

## 19. 强制验收矩阵

### 19.1 当前 PARAM/GPARAM 样本

- [ ] 顶部不存在 `PARAM 36`；
- [ ] 顶部领域栏没有无单位数量；
- [ ] PARAM 第一栏是内部 tables；
- [ ] PARAM viewport 中不存在 `.gparam.dcx`；
- [ ] 普通列表、搜索和标签中不存在 `.bak/.prev`；
- [ ] 点击 PARAM 打开 primary GameParam；
- [ ] GameParam 显示 `1 library`；
- [ ] GPARAM 文件只在 GPARAM Banks 中出现；
- [ ] GPARAM read 未成立时不渲染假工作台；
- [ ] History & Recovery 可找到 backup；
- [ ] 未挂载原版时，Mod 侧 DFLT primary 仍可读；
- [ ] Bridge 不收到不存在的 allowed root。

### 19.2 Smithbox 对照

以下结构项的判定基准是 REF-01 实测清单（§2.4 步骤 8）：实测与本文初值冲突时以实测为准并在卡内同步本文，未对照参考程序实测的卡必须明确标注「未实测」。

- [ ] PARAM 是 `Params | Rows | Fields | Tools`（或 REF-01 实测结构）；
- [ ] GPARAM 是 `Banks | Groups | Fields/Values | Tools`（或 REF-01 实测结构）；
- [ ] Text 是 `Languages/Containers/File List | Entries | Content | Tools`（或 REF-01 实测结构）；
- [ ] 每栏独立滚动；
- [ ] 搜索、表头、工具位置和选择层级与 Smithbox 一致；
- [ ] 同尺寸有效数据密度接近；
- [ ] 不存在卡片套卡片、巨型欢迎标题和主区证据卡；
- [ ] 参考截图与 SoulForge 对照截图已保存。

### 19.3 其他成熟编辑器

- [ ] Container 是 `Containers | Entries | Preview/Source/Bytes | Metadata/Tools`，且 child 只产生受确认的语义投影；
- [ ] Script 是 `Container | Source/Read-only Disassembly | Symbols/Metadata | Tools`，bytecode 不伪装可编辑源码；
- [ ] Map 是资源树、viewport、inspector、tools，交互顺序与 Smithbox 一致；
- [ ] Model 是模型资源树、viewport、属性 inspector，材质槽选择能定位关联项；
- [ ] Texture 是 texture bank/list、预览、metadata/tools，`menu/**/*.tpf.dcx` 只能到此或 Files；
- [ ] Material 是材质列表、属性/值编辑和真实 Tools；
- [ ] Behavior、Animation、VFX 各自使用已确认格式的专用工作台，未确认资源留在 Files；
- [ ] 只有 Files 显示物理目录、绝对层级的脱敏投影和无专属编辑器资源；
- [ ] 任一编辑按钮出现时，对应 typed mutation、native rebuild、Patch、复读和回滚验收同时成立。

### 19.4 Event 与 Agent

- [ ] Event 打开即进入 DarkScript3 式 Source Editor；
- [ ] Event 有 files/outline、source、optional inspector、bottom Problems；
- [ ] 用户不可见“EMEVD 四视图”；
- [ ] Agent 常驻右侧且可折叠、拖宽、持久化；
- [ ] Agent 空闲态、消息流和 Composer 构图与 TRAE 一致（参考图缺失时按 §12 初值口径，勾选时标注「未对照 TRAE 实测」）；
- [ ] 不存在旧任务控制台、工具清单、会话计数和推荐问题；
- [ ] 不存在麦克风、语音占位、权限、音频 IPC 或语音测试；
- [ ] 所有可见 Composer 控件有真实功能测试。

### 19.5 状态与安全

- [ ] 真实空表与解析失败可区分；
- [ ] 局部失败不清空其他内容；
- [ ] 未实现能力不出现可用按钮；
- [ ] Evidence、Hex、parser dump、绝对路径不进入默认 editor/Agent DOM；
- [ ] Change Review 显示操作、目标、diff、影响、验证、备份、回滚；
- [ ] 提交后原生复读失败触发自动回滚；
- [ ] renderer 无文件系统权限；
- [ ] 原版目录只读；
- [ ] writer 只写 main staging；
- [ ] 用户 Mod 提交只经 Patch Engine。

### 19.6 可访问性与响应式

- [ ] 1024/1280/1440/1920 可用；
- [ ] 200% 缩放无遮挡；
- [ ] 340/440/620px Agent 无溢出；
- [ ] pane resizer 支持鼠标和键盘；
- [ ] 所有列表、树、表格、编辑器和 toolbar 可仅用键盘操作；
- [ ] focus-visible 清晰；
- [ ] 选择、dirty、warning、error 不只依赖颜色。

---

## 20. 完成定义

单个前端任务只有同时满足以下条件才能报告完成：

1. 改动没有超出调用方交付的目标和允许文件范围。
2. 生产入口已经替换，不是平行 demo。
3. 负向测试先于或伴随实现落地。
4. typecheck 和相关 unit/integration/E2E 全部通过。
5. 与 Smithbox/DarkScript3/TRAE 的同尺寸截图对照已产出，且人工对照确认通过（Agent 只负责产出截图与清单，不负责宣布通过）。
6. Copy、Density、Swap、Squint、Grayscale 已由用户/调用方人工审查通过（§17.1）。
7. 未引入假能力、绝对路径泄露或 renderer 文件系统权限。
8. 可编辑操作完成适用的 D0–D10 闭环。
9. 失败状态可行动，且不会清空无关可浏览内容。
10. 明确记录能力限制，不把 fixture/static/UI 通过冒充 native/release 完成。

绿色 typecheck、测试数量或错误边界截图不能单独证明完成。

---

## 21. 本文档自身的修改边界

本次规范重写只允许修改：

```text
D:\Repository\SoulForge\docs\frontend-renovation\front-end.md
```

不得修改当前工作树中的代码、临时文件或其他文档。

提交前只执行：

1. 核对第 2 节本机工具路径存在；
2. 以 UTF-8 严格读取本文；
3. 搜索并确认本文没有保留以下错误目标：
   - 把 Smithbox 降格为非约束参考；
   - 物理目录一级导航；
   - 顶部物理文件计数；
   - `.bak` 正常 Param route；
   - 独立 Agent 窗口；
   - EMEVD 四视图；
   - 语音功能；
4. 运行 `git diff --check -- docs/frontend-renovation/front-end.md`；
5. 确认除本文外没有文件因本次任务发生变化；
6. 确认本文未改动 `docs/governance/` 下任何文件（本文对治理冲突只作标注与处置指示，不直接改治理数据）；
7. 本文如有更新，以仓库既有 CRLF 约定保存（修改不改变整文件换行风格，避免 diff 全文件变色）。

`D:\mystream\Sekiro Shadows Die Twice\tools` 只是当前机器上的强制 UI 参考库，不是 runtime、Bridge authority、安装包输入或自动导入源。
