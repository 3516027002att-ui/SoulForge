# SoulForge 加载、PARAM、地图与动作预览修复任务交接手册

> 写作日期：2026-08-27
>
> 目标读者：接手本任务、但对 SoulForge、FromSoftware 格式、Electron/Bridge 数据流和当前脏工作树都不熟悉的下一位 agent。
>
> 本文不是完成报告。它是诊断证据、当前代码状态、逐步实施方案、验证清单和防跑偏约束。

## 执行入口：低能力接手者只按这个控制器推进

不要试图一次记住全文。先读本节和第 0 节，完成 preflight；进入某个阶段前，只回读该阶段引用的诊断章节。每完成一条就让 runner 写状态，禁止靠聊天记忆打勾。

```text
A0 隔离当前伪 PASS 证据并修复验收信任根
 -> A1 恢复可构建
 -> A2 冻结独立 corpus/oracle、格式规则和性能计划
 -> B PARAM 正确性
 -> C PARAM 热路径
 -> D 地图 DTO/几何/路由
 -> E 地图生命周期/真实交互
 -> F 角色单骨架/动作
 -> G 启动增量生命周期
 -> H 同一快照全量验收
```

进入控制器前先构造一个**完整输入存在性结果**，不允许只检查 runner/state：

```ts
interface RequiredA0InputsV1 {
  candidateRunner: "present-readable"|"missing"|"unreadable";
  corpusManifest: "present-readable"|"missing"|"unreadable";
  currentState: "present-readable"|"missing"|"unreadable";
  evidenceDirectory: "present-readable"|"missing"|"unreadable"|"not-addressable";
  negativeFixtureManifest: "present-readable"|"missing"|"unreadable";
  dirtyWorktreeApproval: "valid"|"missing"|"invalid";
}

interface DirtyWorktreeApprovalV1 {
  schema: "mission1-dirty-worktree-approval-v1";
  exactConfirmationText: "授权你继承当前冻结 dirty worktree，并按 mission1 继续修改产品代码。";
  userMessageRawSha256: string;
  userMessageRawArtifactSha256: string;
  approvalSourceSnapshotSha256: string;
  recorderTaskIdentity: string;
  editSessionId: string;
  approvedAtUtc: string;
  artifactSha256: string;           // canonical payload不含本字段
}
```

前五项的固定路径分别是候选 `scripts/verify-mission1-acceptance.mjs`、mission corpus、`output/mission1-evidence/current-state.json`、该 state 声明的 evidence directory、以及 `testdata/mission1/runner-negative-fixtures.v1.json`。若 current state 缺失、不可读或还不能通过精确 schema 校验，evidence directory 必须记为 `not-addressable`，禁止凭目录扫描挑一份旧 evidence；这同样固定进入 A0。任一项缺失、不可读、schema/identity 不明或 evidence directory 指向 repo/app-data 允许根之外，都固定选择 A0；不能把 corpus/evidence 缺失解释为“已经通过”“环境可选”或跳到 A1/A2。候选 runner/manifest 尚不存在时，A0 先做静态施工；只有候选 runner 可运行以后，才允许 `--bootstrap` 原子生成全 FAIL state。

`dirtyWorktreeApproval` 是写入前置，不是 Gate 证据。若它缺失/无效，agent 仍可做上述只读分类，但必须在任何 quarantine、runner 或产品写入前停下，并要求用户回复上面固定确认句；语义近似但不同的消息不由低能力agent自行解释。main保存原始UTF-8消息artifact并逐byte核对固定句、hash和当时snapshot。用户只说“暂停另一个 agent 写入”不等于授权新 agent 继承并修改这些代码。approval只需在该editSession第一次写入前与snapshot完全相等；之后每批自身改动记录before/after snapshot和owned paths。若第一写入前已漂移，或后续出现不在本editSession owned batches中的外部变化，approval失效并停止；自身已记录的改动不要求用户每次重复确认。

唯一推进算法：

```text
先核对 RequiredA0InputsV1 和第 0.8 节冻结 identity
  |
  +-- dirtyWorktreeApproval 缺失/无效
  |     -> 只读停止；向用户请求明确继承授权；不得创建quarantine/runner/state
  |
  +-- runner/corpus/current-state/evidenceDir/negative manifest 任一缺失、不可读或identity未知
  |     -> 固定进入A0静态施工；旧state任何PASS不可读
  |     -> 候选runner可运行后只可--bootstrap全FAIL；缺失项不是skip/N/A
  |
  +-- 命中已隔离 runner/current-state/corpus，或 runner 自测非零
  |     -> 固定进入 A0；旧 state 的 PASS 一律不读取、不继承
  |     -> 保留旧文件供取证，不在原地把旧 PASS 改成 FAIL
  |
  +-- current-state identity 与当前源码不同
  |     -> 先验证旧 state canonical hash；失败即A0
  |     -> 保留旧 artifact，执行第 24.2 节 stageInputRegistry/--resume算法
  |     -> registry 不认识任一变化时固定回到 A0；不得自行猜受影响阶段
  |
  `-- identity 相同且state可信：按 A0,A1,A2,B,C,D,E,F,G,H 找第一个 status != PASS 的阶段
        |
        +-- 读该阶段“入口/步骤/退出”和引用诊断
        +-- 只做该阶段
        +-- 跑该阶段 runner
        +-- FAIL: 留在原阶段，只执行 firstFailure.nextActionCode 对应的静态步骤
        `-- PASS: 进入紧邻下一阶段；不得跳跃
```

`current-state.json` 的任何 PASS只能由**已经通过 A0 全部负例自测和独立审查**的 `scripts/verify-mission1-acceptance.mjs`计算。文件名相同、脚本存在或旧 state写着PASS都不构成信任。第0.8节列出的当前runner已被证实fail-open，它生成的所有`output/mission1-evidence/**`只能作为反例，永远不能被后续runner导入为PASS。A0候选runner第一次`--bootstrap`只可创建全FAIL state；随后以冻结反例真实回放、atomic-write crash fixture和独立审查artifact计算A0。A0 PASS后，A1和A2各自在自己的最终snapshot重新运行退出断言；A2改了runner registry/schema/runtime input或状态算法就会使A0失效，必须先回A0重审，不能把“验收面修改”和“让产品测试变绿”混在同一编辑批次。禁止继承隔离state、候选runner审查前的结果或修改前的A1 PASS。

每次准备停止或报告前只问一个问题：

```text
同一次阶段 H run 是否显示 G0,G1,G2,G3,G4,G5,G6,G7 全部 PASS？
  YES -> 才能使用“整体完成”模板
  NO  -> 第一行必须写“局部进展，整体未完成”，继续第一个 FAIL 的静态 nextActionCode
```

以下十条是最容易混淆的判断，答案固定，不再解释：

| 看到什么 | 结论 |
|---|---|
| `gov next` 只给一个 slice | 只说明治理认领范围，不说明本任务完成 |
| structured diagnostic | 只有 corpus manifest expected=unavailable 才可能 PASS；expected=loaded 一律 FAIL |
| synthetic/fixture 绿 | 只证明 fixture；不能让 native/UI Gate PASS |
| canvas 非黑/模型计数到了 | 不能证明 G4/G5；必须真实 m10 mask/depth/oracle/pointer artifact |
| 黄色骨架或一块 body mesh | G6 FAIL |
| main JSON 变小 | 不能证明 Bridge static DTO；C# skin/skeleton counter 必须为 0。**但当前这两个 counter 从不自增，恒为 0，见 0.4.2——直接读它们等于恒真判据，必须先让它们真的会加** |
| cache hit/Promise 去重 | 不能证明 native session；C# parser counter 和顺序重开必须通过 |
| 18 个历史地图失败已分类 | 不等于修复；所有 oracle-renderable identity 必须 loaded |
| 手工/常量 CharacterAssemblyContext | G6 FAIL；必须有 PARAM 行/真实 selection provenance |
| 手工跑过旧脚本 | 只能诊断；Gate 只认阶段 H 聚合 runner 当次结果 |
| `code present: G2..G6` 或源码字符串命中 | 这是明确伪证据；对应 Gate FAIL |
| governance/native/UI 子命令非零但外层写 PASS | runner fail-open；G0/G7 FAIL，所有本轮 PASS 作废 |

如果本文后文一句话看起来允许与此表相反的结论，按第 0.1 节权威顺序处理，不要选宽松解释。

## 0. 权威执行契约：先读，全文最高优先级

这一节不是建议，是接手者的执行合同。本文后续若有旧措辞、示例、近似行号或多个候选方案与本节冲突，以本节为准。根 `AGENTS.md`、治理 JSON/CLI 和真实格式证据的优先级仍高于本文；发现冲突必须停下记录冲突，不能自行选择最省事的解释。

本文中的规范词按以下含义使用：

- **必须**：不满足就不能进入下一阶段，也不能声明对应链路完成。
- **禁止**：即使截图、单测或耗时数字变好也不得采用。
- **诊断性示例**：只帮助定位，不授权更换本节锁定的架构。
- **局部完成**：只允许声明某一个 Gate 通过，不能写“本任务完成”。
- **整体完成**：第 0.4 节全部硬 Gate 在同一源码快照上通过，且没有关键 `skipped`、`not run`、`uncovered`、`candidate` 或 `fixture-only`。

### 0.1 权威顺序和定位规则

执行时按以下顺序裁定事实：

1. 根 `AGENTS.md`、`docs/governance/*.json`、当次 `gov help/next/status` 输出。
2. 当前源码、协议 schema、测试注册表和 `package.json` 中真实存在的脚本。
3. 本节锁定的架构和 Gate。
4. 本文后续诊断、测量和步骤。
5. 文件名、函数名和行号示例。

本文行号都是 2026-08-27 工作树的近似定位，不是修改目标。接手者必须先用 `rg` 找符号，再读调用方和被调用方；禁止按行号盲改。命令名必须先从当前 `package.json` 或 `gov help` 核对，不能凭本文拼写不存在的脚本。

> **【先确认你打开的是哪一个 `mission1.md`】（2026-08-27 实测）**
>
> 工作树里有**两个** `mission1.md`，内容不同：
>
> | | 路径 | 字节 | sha256 前 8 | git 状态 |
> |---|---|---|---|---|
> | **权威** | `锐评/mission1.md` | 会变，见下 | **勿用于校验** | **被忽略**（`.gitignore:101` 的 `锐评/`，`git check-ignore -v` 实测命中） |
> | 陈旧分叉 | `msssion/mission1.md` | 423680 | `353a18d3` | `?? msssion/`——**未跟踪，但也没被忽略** |
>
> 权威档那两格故意不填死值：**你每编辑一次它就变一次。** 本框刚写下时实测 487145 / `52857007`，把本框自己加进去之后立刻变成 489703 / `7e7c317f`——两次测量之间只有「插入本框」这一个动作，2558 字节的差额就是本框本身。所以任何写进本文的字节数或 hash，一旦用来校验本文，都是过期值；判别一律用上面那条 `grep -c` 命令。陈旧档相反，没人动它，`423680 / 353a18d3` 可以当身份锚点，也可以用来发现有人误改了它。
>
> `msssion` 是 `mission` 拼错产生的孤立目录：实测 `git grep -n "msssion"` 零命中，仓库里没有任何脚本或文档引用它。
>
> **判别命令**（不要用字节数判断，字节数会随你自己的编辑变化）：
>
> ```
> grep -c "24\.9\.0" 锐评/mission1.md msssion/mission1.md
> ```
>
> 实测权威档 `3`、陈旧档 `0`。**输出 0 的那个不是权威档，立刻关掉。**
>
> 顺带消除一个误解：**在本仓库「被 gitignore」不等于「草稿」。** 实测 `docs/frontend-renovation/front-end.md:2601`、`docs/frontend-renovation/radiant-white-implementation-report.md:3`、`docx/build-addressing-spec.py:136` 三处**跟踪中**的文件都在引用 `锐评/` 下的材料，把权威材料放在忽略目录是本仓库既有惯例。不要因为它被忽略就去找一个「更正式」的副本——`msssion/` 正是这样被找出来的那种东西。
>
> **合并方向是单向的，没有任何内容需要从陈旧档捞回来。** 实测标题集合：陈旧档 154 个、权威档 164 个，**陈旧档独有 0 个**，权威档独有 10 个。
> 未测：标题是子集**不等于**正文是子集——我只比对了标题行，没有逐段比对正文。若你确实要引用陈旧档里的某一段，先自己 diff 那一段再用。
>
> **git 上的不对称最危险，这两条都要记住：**
>
> - 权威档对 git 不可见 ⇒ **它没有任何 git 回滚**。改错了只能手工删掉你新加的段落，`git checkout` / `git restore` 都救不了它。本文自身就处在这个处境里，所以对本文的每次编辑都要小步、可辨识。
> - 陈旧分叉**会被 `git add -A` 收进提交**。收口时若习惯性 `git add -A`，你会把一份过期任务书提交进仓库，而真正的任务书仍然对 git 隐身——事后从提交历史里看，唯一存在的任务书就是那份错的。
>
> **禁止**：编辑 `msssion/mission1.md`；把它 `git add`；为了「统一」而擅自删除它——删除属于不可逆操作，先问委托方。

### 0.2 任务边界

这是一个跨链路修复，不是七个可任选其一的小任务。必须最终闭合：

```text
磁盘/容器
  -> C# Bridge 原生解析与 session
  -> main/core 资源身份与生命周期
  -> IPC/DTO 有界投影
  -> renderer semantic state
  -> Three.js/GPU projection
  -> pick/TransformControls/写回
```

允许按第 15 节分阶段提交局部结果，但除非所有硬 Gate 通过，不得因为 PARAM、地图索引或角色中的任意一项看起来改善就停止。用户点名的样本是回归入口，不是特例授权。以下行为都属于隐性特例，同样禁止：

- 按名称前缀、骨骼数 467、mesh 数、动画时长、固定目录位置或“前四个部件”切换特殊代码路径。
- 把样本值改写成常量、阈值或启发式，却不出现字面 `c0000`/`m10_00_00_00`。
- 让所有未知输入 fail-closed，而真实成功路径只对样本测试中的手工 DTO 成立。

### 0.3 锁定的架构决策：不要再自行选方案

接手者不需要重新发明以下设计，也不得从后文的“例如/或”中挑一个更弱版本：

1. **BND 热路径**：Bridge production command 固定名为 `list-bnd4-entries`，直接复用 `Bnd4NativeWriter.GetCachedBinder`。它只列 entry identity/metadata/diagnostics，默认不计算所有 child content hash；不得运行 no-op rebuild、CRUD probe 或 layout validation。`extract-bnd4-child` 必须命中同一个 binder cache identity，并为被提取 child 返回/缓存 content hash。
2. **PARAM authority**：不得新增 TypeScript production PARAM parser。现有 Bridge `read-param-document` 的原生解析结果必须进入有界 parsed session；index 默认不带 row hash，page 只序列化请求的物理行。缓存最终 JSON 而 Bridge 每页仍全量 parse，不算实现 session。
3. **PARAM identity**：物理 `rowIndex + expected id + expectedDataHash` 是读写身份。任何 `Map<id,row>`、先折叠再判重、或只在当前 CSV 批次判重都不合格。
4. **地图静态投影**：新增 Bridge command `read-map-static-geometry`。C# 直接生成 renderer-independent 静态几何 chunk，生产路径不调用 skinning、不构建 bones/skeleton、不返回角色 FLVER DTO。main 禁止 spread 原始 bundle。
5. **地图几何 oracle**：`mapMeshGeometry.ts` 保留为独立差分/oracle 工具，不再承担 production 的第二次全量 merge。Bridge 输出必须和成熟实现逐 mesh/index 差分一致。
6. **地图模型路由**：IPC 必须携带 MSB `modelType/resourceKind`，不得从名称推断。type 0 的真实 FLVER 成功路径必须可用；真实存在资源的 type 1/2 不能统一伪装成 `UNSUPPORTED`。type 5 HKX 若尚无可信渲染投影，可返回专属 collision diagnostic，但不能冒充完整地图已显示。
7. **Gizmo 生命周期**：只把当前 `binding.target` 直接挂到与对应 `InstancedMesh` 相同的 `root`；切换、clear、dispose 时卸载旧 target。禁止把全部 target 加入 scene，也不要增加语义不明的第二层 anchor。必须覆盖非 identity root 的 local/world 矩阵测试。
8. **角色装配**：使用显式、URI-based `CharacterAssemblyContext`。body part 到 leader bone 的按名重映射在 renderer-independent core/main 语义层完成；renderer 只接收一个 leader skeleton bundle。weapon/特殊 attachment 使用明确挂点，不混进 body slots。
9. **角色失败契约**：缺 assembly context 时可以返回 `CHARACTER_ASSEMBLY_CONTEXT_REQUIRED`，但同一改动必须提供至少一条由真实索引资源构建 context 并成功显示完整角色的 production 路径。全输入都报该错误不算修复。
10. **动画资源**：独立 `AnimationPlaybackContext` 中的 `animationContainerUri` 与 `skeletonContainerUri` 必须由资源图/调用方显式传入；Bridge 不扫描邻近目录猜文件，静态 bind-pose 预览不要求伪造动画 context。
11. **缓存边界**：不可变内容 cache key 必须包含完整内容身份和对应的 `pathSourceGeneration`；`workspaceSessionGeneration` 只属于 owner/publish guard，`sceneGeneration` 只属于场景提交 guard，`rendererContextGeneration` 只属于 GPU context，四者禁止互换或写成无类型的 `generation`。in-flight、parsed native session、wire payload、GPU resource、failure backoff 是五种不同生命周期，禁止用一个长期 `Map` 混装。地图统一使用 24.12 的 `ResourceCacheKeyV1` canonical SHA；动画统一使用 24.18 的完整 cache key，不能退回名字或短 `resourceKey`。
12. **写回边界**：所有用户 Mod 写入仍经 Patch Engine。renderer 无绝对路径，Bridge writer 只能写 main 的 staging root。

若真实证据证明上述决策本身错误，接手者必须先写出反证、影响面和替代协议，并让用户裁定；不能静默偏航。

### 0.4 整体完成硬 Gate

| Gate | 必须证明 | 最低证据 | 任何以下状态均为失败 |
|---|---|---|---|
| G0 源码与产物身份 | 所有测试针对同一最终源码快照；C# smoke 使用该快照 publish 的 Bridge | source snapshot、Bridge exe 路径与 SHA-256、命令日志 | 旧日志、旧 DLL、只 build 未 publish、源码在验证后又改动 |
| G1 可构建基线 | TypeScript、Bridge、renderer 产物均成功 | `typecheck`、`bridge:build`、`build` exit 0 | “仓库原有错误”但无 clean-HEAD 对照证据 |
| G2 启动生命周期 | 首屏不读内容；增量 hash、取消、前台让步、明确加载状态有效 | 自动化计数 + 冷/热真实工作区测量 | 只加动画、只延迟任务、后台继续抢占前台 |
| G3 PARAM | 大表 index/page 快；一次 session 只 parse 一次；重复 ID 精确写回；真实 138 表 no-op（**限定 mod-side DFLT，见 0.4.1**） | synthetic + 真实 corpus + parse/serialize/IPC 计数；**必须独立核对 `corpusVerified === corpusTotal && corpusFailed === 0`，`bridge:verify:param` 退出 0 不是 G3 证据** | 只缓存 JSON、默认 index 带 hash、真实 smoke skipped；**把 mod-side 的 138/138 当成 PARAM 全量通过；把 game-side 的 `DCX_DOCUMENT_READ_FAILED` 当成 PARAM 解析缺陷去改 parser** |
| G4 地图几何与路由 | m10 type-0 全量 oracle 正确；`m002021` 在锁定 16 MiB 下成功；type route 诚实 | 499 type-0 全量 outcome manifest、所有 oracle-renderable 项成功、0 mismatch/越界 | 只测 7 个、把历史 18 失败仅分类不修、提高帧上限、隐藏坏面、统一 unsupported |
| G5 地图交互与性能 | 加载中可操作；完成后 frame/pick 可用；真实 pointer Gizmo 写回一次 | Electron/WebGL 行为 smoke + frame/long-task/pick/gizmo 数据 | source regex、只看非黑 canvas、只在空场景拖拽 |
| G6 角色与动作 | 显式 context 成功装配完整身体；单 leader；真实 clip 可播放；无错误正权重映射 | c0000 真实成功路径 + 通用第二样本或 corpus 分类 + CPU/GPU skin | 只有黄色骨架、硬编码四 slot、所有输入 fail-closed |
| G7 回归与写回 | 现有编辑、Patch Engine、备份/回滚、治理验证未破坏 | 公开回归、相关 native smoke、writeback/rollback、governance tier | fixture 冒充 native、关键项未覆盖仍宣称完成 |

Gate 判定只有 `PASS` 或 `FAIL`。`skipped`、缺语料、机器不支持 WebGL、未实现、只人工观察、只跑 fixture、只列诊断，都必须记为 `FAIL` 或“局部未完成”；不得用 `N/A` 把用户明确要求的验收项移出范围。

FAIL 另带 `failureKind=implementation|regression|environment_blocked|corpus_changed`，所以“本机缺 WebGL/审计工具”和“产品断言错误”不会混为一个根因；但两者都意味着尚未取得用户要求的真实验收，不能提升为 PASS。

每个阶段结束可以只报告该阶段 Gate。整体完成前必须重新在最终源码快照上运行 G0-G7 所需验证；历史通过结果只用于诊断，不能继承。

#### 0.4.1 「138/138」只在 mod-side DFLT 成立，game-side 是另一条曲线

PARAM 的解析成功率**取决于容器来源**，不是一个单一数字。本文档其他位置（第584-585、1617、1745-1746行）出现的「138/138 读取」「138/138 no-op byte-identical」全部只在 mod 侧成立，接手者必须把它读成有限定条件的结论：

- **mod-side**：`mods/param/gameparam/gameparam.parambnd.dcx`，DCX 为 **DFLT**，不需要 Oodle，实测 138/138。
- **game-side**：原版目录下的 parambnd，DCX 为 **KRAK**。缺 Oodle 运行时连条目表都读不出来，实测 86/138，失败项报 `DCX_DOCUMENT_READ_FAILED: 尚未挂载 Sekiro 原版游戏目录；KRAK 只能进行原始字节读取，不能解压`。

`apps/desktop/src/main/ipc.ts:715-718` 的注释已经把这件事写清楚了，直接引用：

```text
oodleRuntimeRoot 必须传：game-side 的 parambnd 是 KRAK 压缩，缺 Oodle 运行时
连条目表都读不出（实测 `DCX_DOCUMENT_READ_FAILED: 尚未挂载 Sekiro 原版游戏
目录；KRAK 只能进行原始字节读取，不能解压`）。mod-side 是 DFLT 不需要它，
但用户迟早会打开 game-side，两者必须都能工作。
```

两条容易踩的坑：

1. **`DCX_DOCUMENT_READ_FAILED` 不是 PARAM 解析缺陷，不要去改 PARAM parser。** 它是缺 Oodle 运行时根。复现 game-side 必须显式传 `oodleRuntimeRoot`；Bridge daemon 不读环境变量，靠 env 传不进去。低能力接手者最典型的错误是看到 86/138 就去修 `ParamNativeDocument.cs`，那里没有 bug。
2. **现有 smoke 结构上不可能覆盖 game-side。** `packages/core/src/testing/runNativeParamSmoke.ts:72` 把 corpus 钉死在 mod 侧相对路径 `../../mods/param/gameparam/gameparam.parambnd.dcx`，且**整个文件没有任何 `oodle` 字样**（实测 grep 零命中），既不接收也不转发 `oodleRuntimeRoot`。所以它的 138/138 永远只是 DFLT 那条曲线。要让 G3 覆盖 game-side，必须给这个 smoke 增加显式 oodle 根参数与 game-side corpus 入口，而不是期待它「已经测了」。

G3 的最低证据因此要求独立核对 `corpusVerified === corpusTotal && corpusFailed === 0` 三个计数，并明确标注这一轮跑的是哪一侧容器。`runNativeParamSmoke.ts:309-312` 只在 `verified === 0` 时抛错、不断言 `failed.length === 0`；只要有一张表通过、其余全失败，它仍然退出 0。**`npm run bridge:verify:param` 退出 0 不构成 G3 证据**，必须读计数本身。

#### 0.4.2 G4 两端都是空的：计数器恒 0，判据是四路 OR

G4 目前有两个**互相独立**的空洞。只修一个仍然是假绿，接手者必须一起处理。

**空洞一：`SkinCalls`/`SkeletonCalls` 从不自增。** 实测这三个 counter 在整个主工作树的全部出现位置：

```text
MapStaticGeometryService.cs:9,10,11    声明
MapStaticGeometryService.cs:53,54,55   归零
MapStaticGeometryService.cs:101        ParseCount++    <- 只有这一个会加
BridgeCommandService.cs:1681,1693      读出并放进 telemetry
```

`ParseCount` 确实在 `:101` 自增；**`SkinCalls` 和 `SkeletonCalls` 在仓库任何位置都没有 `++`、`+=` 或 `Interlocked` 写入**（已按这三种形式分别 grep，零命中）。所以第104行和第1666行要求的「counter 证明 static 路径 skin/skeleton 构建为 0」是**由构造恒真**的：它们被声明成 0、归零成 0、读出来是 0，与 static 路径究竟有没有调用 skinning 毫无关系。

修法不是删掉这条判据，而是先让它有意义：在真正执行 skinning／构建 bones 的每个入口自增对应 counter，然后这条「必须为 0」才第一次具备判别力。**没有做这一步之前，不允许把 telemetry 里的 `skin: 0, skeleton: 0` 写进任何 G4 证据。** 验证方式按第0.4节末尾的通则——故意在 static 路径里插一次 skinning 调用，counter 必须变成非 0 且 G4 必须变红；做不到这个负向用例就说明 counter 仍是装饰。

**空洞二：runner 的 G4 是四路 OR，最后一路与被测能力无关。** `scripts/verify-mission1-acceptance.mjs:235-238`：

```js
checks.G4 = fileContains('bridge/SoulForge.Bridge/BridgeCommandService.cs', 'read-map-static-geometry') ||
  fileContains('bridge/SoulForge.Bridge/FlverNativeDocument.cs', 'MapStaticGeometry') ||
  fileContains('apps/desktop/src/main/ipc.ts', 'read-map-static-geometry') ||
  fileContains('apps/desktop/src/main/ipc.ts', 'readMapPartMesh');
```

实测：第三路恒假（`ipc.ts` 里 `read-map-static-geometry` 零命中），第四路恒真（`readMapPartMesh` 命中 1 次）。`readMapPartMesh` 是**旧的、要被删掉的**那条路径。于是 G4 的实际语义是「旧路径还在就算通过」，与新 static 路径是否接通完全无关。**把 `MapStaticGeometryService.cs` 整个删掉，G4 依然绿。** 更糟的是：按第1666行要求删除旧 production 路径以后，第四路才会转假——也就是说**正确的修复会让这条判据变红**，形态和第24.16.2节那条「惩罚正确修复」的测试完全一样。

这两个空洞叠加的后果，是 G4 在「命令有实现但零 production 调用」这个当前状态下报绿。已实测确认零调用：`apps/desktop/src`（main + preload + renderer，排除测试）下引用 `read-map-static-geometry` 的文件数为 **0**，引用 `list-bnd4-entries` 的文件数同样为 **0**；而两者都有完整的 C# 实现（`BridgeCommandService.cs:1563` / `:157`）、daemon 白名单（`BridgeDaemonHost.cs:544` / `:534`）和协议类型（`bridge-protocol.ts:119` / `:100`）。这就是第537、637行所说状态的确切度量。**「实现完毕但未接线」在 grep 判据下与「已完成」不可区分**，这是本文档所有 `fileContains` 判据的共性缺陷（见第18节禁令）。

顺带一处同形问题，G3 也踩了：`:227-228` 的 `hasListBnd` 用 `list-bnd4-entries || listContainerParams` 兜底，而 `listContainerParams` 在 `ipc.ts` 命中 1 次，于是 `hasListBnd` 恒真。G3 因此只由 `hasParamSession` 单独决定。

### 0.5 验证证据必须绑定身份

每次性能或正确性 smoke 必须写结构化记录，至少包含：

```text
startedAt / finishedAt
gitHead
gitStatus
dirtyTrackedPatchSha256
trackedChangesArtifactSha256
untrackedSourceFiles[] = { path, sha256 }
exactCommand
environment = { OS, CPU, RAM, GPU, buildConfig, frameLimit }
bridgeExecutable = { absolutePath, sha256, lastWriteTimeUtc }
corpus = { logicalUri, sourceSha256, fileSize }   # 不复制真实资产
cacheState = cold | warm
runIndex
exitCode
durations/counters/assertions
failures[] = { resourceIdentity, diagnosticCode, detail }
assertionResultManifestSha256 / artifactManifestSha256
A0/A2 reviewedAuthorityRootSha256 / independentReviewArtifactSha256
```

只写“通过”“明显更快”“大约 60 FPS”不是证据，也禁止手工创建一个长得像上述结构的 JSON 冒充执行记录。

接手者必须实现唯一聚合 runner：

```text
tracked script: scripts/verify-mission1-acceptance.mjs
package entry:  npm run test:mission1-acceptance
local output:   output/mission1-evidence/<UTC>-<sourceSnapshotSha256>/
```

`output/` 已被忽略，runner 不得把真实游戏资产、绝对私有路径内容或大 payload 写入 Git。runner 必须：

1. 自己 spawn 每条验证命令，捕获原始 stdout/stderr、exit code、开始/结束时间、直接子进程 PID 和应用主动上报的 Electron/Bridge PID；不能只读取接手者提供的“已通过日志”。Windows 短命后代进程枚举只作辅助诊断，不作为单独 PASS 条件。
2. 对 stdout/stderr 和每个结果 JSON 计算 SHA-256，最后生成 summary manifest；summary 只能由 runner 根据子进程结果计算 PASS/FAIL。
3. 在每个子测试前后重新计算 source snapshot。它包含 `git rev-parse HEAD`、全部 tracked dirty patch、所有非 ignored 未跟踪文件的 path+hash，不按扩展名筛选；`node_modules/dist/bin/obj/output/release` 等 ignored build 产物不作为源码，但每项 assertion读取的 ignored runtime input必须在 registry单独声明并锁定，Bridge exe也单独锁定。
4. 若子测试期间任一 tracked/untracked source identity 改变，立即让整个 run 非零失败；修完后从头开始阶段 H，禁止拼接绿灯。
5. 直接调用子测试的机器输出 schema，拒绝 `skipped/not-run/N/A/candidate/fixture-only`；拒绝缺 assertion/counter/corpus identity 的“exit 0”。
6. 对 C# native telemetry 读取真实 parser 入口计数，而不是 TypeScript cache hit 计数。PARAM/BND/FLVER 的 parse、validate、session open/hit/evict/close 都带 correlation id、`workspaceSessionGeneration`、相关`pathSourceGeneration`与daemon identity；禁止一个裸generation字段。
7. 最后重新执行 G0-G7 判定；聚合入口不存在、任何子项只能人工确认、或 runner 自身测试未通过时，G0/G7 失败。

runner 之外手工执行的任何命令只能用于诊断，不能让 Gate 从 FAIL 变 PASS。即使同名子脚本单独 exit 0，阶段 H 仍必须由聚合 runner 重新执行；这消除了“人工跑一个旧脚本后填 Gate”的入口。

runner 自身必须有 fixture 测试，证明它会拒绝：伪造旧日志、子命令 skip、执行中源码变化、Bridge hash 不符、corpus hash 不符、手写 PASS、缺失 UI artifact 和子命令非零。

测试之后只要相关源码、publish 产物、环境配置或 corpus 发生变化，原记录就失效。修改 C# 后的固定顺序是：

```text
bridge:build -> bridge:publish -> 记录被选择 exe 的绝对路径/SHA-256 -> native smoke
```

禁止只执行 `bridge:build` 后继续使用旧 Release publish。若声称失败是“仓库既有”，必须用只读的 clean `HEAD` 对照日志或此前同快照证据证明；主观判断不算。

`gov seal` 不执行验证，不能替代 runner。只有当当次治理 CLI 明确要求封存、`test:mission1-acceptance` 在最终快照全绿、且 seal 引用该不可变 artifact manifest 时才执行 seal；否则只报告治理状态，不擅自改 Gate/authority。

### 0.5.1 锁定真实 corpus，不允许自动换样本

仓库已有 `testdata/corpus/sekiro-1.6.corpus-manifest.json`，先复用其 schema/验证器；它未保存本任务的人类可读资源映射，因此新增一个**语料元数据**而不是平行进度文档：

```text
testdata/corpus/mission1-sekiro-acceptance.manifest.json
```

manifest只保存logical URI、relative source identity、size、SHA-256、游戏版本、resource role、m10 model/placement inventory、成熟oracle availability/expected diagnostic和已证实计数；禁止复制真实资产。FLVER oracle每个mesh还必须保存`meshOrdinal`、display profile ID、原生`selectedFaceSetOrdinals[]`、rule ids/source index bits/逐FaceSet`CullBackfaces`、按该顺序展开后的`triangleCount`与`triangleListSha256`，从而能发现错误LOD/FaceSet选择或culling丢失。它必须覆盖gameparam、m10 MSB及其499个type-0 source decision和全部part placement identity、`m002021`、`o000100`、`c1000`、c0000 leader/body part、两个anibnd、动作id 10，以及第16.7节确定性选择的**总计10个（含c0000/c1000）** character static samples。精确schema/count不变量见24.3。

该 manifest 必须在 A2、继续修改 B-G 之前冻结一次。当前交接树已经含有未验证的 PARAM/地图/角色/启动改动，因此不得把“当前 production 输出”伪装成修改前 oracle；expected outcome 只能来自不调用 SoulForge production parser 的三份外部原始证据：文件系统 relative identity+SHA-256、Andre.SoulsFormats 独立 parse/inventory、至少一个第 4.6 节成熟工具的黑盒可用性。manifest 保存三份 artifact hash和生成器源码 hash；三者不一致时 outcome=`disputed` 且 Gate 失败，不能投票取最方便结果。clean `HEAD` 只用于性能/回归对照，也不能决定 native expected outcome。

生成后先运行独立 verifier 从原始 artifact 重算 manifest，再审阅 diff；阶段 B 之后 runner 只能 verify，禁止自动 rebaseline。任一 hash/数量变化都先让 Gate 失败并报告 `CORPUS_IDENTITY_CHANGED`；接手者不得自行重建 manifest 来让测试恢复绿色。确为用户资产/版本变化时必须让用户裁定新 manifest。这样 expected outcome 不由被测 production code 循环定义。

真实游戏根始终只读。acceptance runner 同时使用三层防护：Bridge `allowedRoots` 包含游戏根但 `writableRoots` 明确不含；原生只读 smoke 前后验证 manifest 输入 hash/size/mtime；通过 ProcMon/ETW 或等价 Windows 文件 I/O trace 记录已上报 SoulForge/Electron/Bridge PID 对解析后最终路径位于游戏根的 write/create/truncate/rename/delete/set-end-of-file 事件。任一层失败都使 G7 失败；事件审计不可用时记 `environment_blocked`，仍不能整体完成，但要与产品断言失败区分。写回 smoke 只对 test temp root 的副本执行，并额外运行现有 `test:bridge-write-boundary` 和 path final-resolution/hardlink escape 测试。

### 0.6 并发和编辑批次

根 `AGENTS.md` 的并发检查不是启动时做一次。每个编辑批次前、测试后准备继续编辑前、提交/交接前都必须重新执行：

```powershell
git status --short --branch
node scripts/gov.mjs status
```

同时核对目标文件自上次读取后是否被外部修改。发现另一个 agent 在 `main` 写同一批文件时立即停止写入；stale claim 必须按 `recoveryTrigger` 产生可复核证据，不能只说“看过了”。

### 0.7 当前仓库绝对不能怎么处理

以下是本文写作时的交接快照，不是接手时可直接继承的事实；必须用紧随其后的只读命令重新核对。当前仓库状态不是干净基线。

- 当前分支：`main`，跟踪 `origin/main`。
- 用户在 2026-08-27 明确暂停执行 agent 写入后，冻结快照为：34 个已跟踪文件被修改，另有 10 个非 ignored 未跟踪源码/测试文件；HEAD 为 `91c1276828e3c19998fffd72a9231ab287e09618`。这句话只证明旧执行者已暂停，**不等于**授权后来的产品实现者继承 dirty worktree。
- `git diff --binary --no-ext-diff HEAD -- .` 的原始 stdout 为 282070 bytes，SHA-256 为 `6DBE4426525C854D46D25E56EC9800274415D2EAB040B97AF5616013D5302C6D`。这只是冻结审计身份，不是可继承的 PASS；接手时必须重新捕获。
- 这些改动都属于本次任务，不要 `git reset --hard`，不要 `git checkout -- <file>`，不要用远端文件覆盖本地文件。
- 当前没有正在运行的构建、测试或 smoke 命令。系统中长时间存在的 `@playwright/mcp` Node 进程是常驻服务，不是卡住的 SoulForge 命令。
- 最后几项 PARAM 修改是在停止前刚写入的，尚未重新执行 `typecheck`、Bridge build、测试或前端 build。因此，接手后的第一项动作不是继续堆代码，而是先确认当前半成品能够编译，并只修复与本任务有关的编译错误。

以上归属说明是交接事实，不替代根 `AGENTS.md` 的并发/用户确认。全新 task 或不继承本线程用户消息的 agent 第一次看到这些非本人改动时，必须先停止写入，请用户逐字回复`DirtyWorktreeApprovalV1.exactConfirmationText`。确认后由main侧写入ignored evidence目录的typed artifact及原始消息bytes。只有“暂停旧agent”“审查代码”“修改mission1”或上下文推断均不合格。确认等待期间回来后重新跑`git status`/`gov status`；第一次写入前approval snapshot必须与当前相等。开始editSession后用owned before/after batches区分自身改动和外部漂移；发现外部变化即停，不通过修改approval hash掩盖。
- `runBridge` 的真实 smoke 必须使用本次 Release publish 产物。只运行 `npm run bridge:build` 不保证 Node smoke 使用了新 Bridge。修改 C# 后，在真实 smoke 前必须执行 `npm run bridge:publish` 并核对 executable hash。
- 不要释放或抢占治理面板中 stale 的 `W-REL-D-GAMELOAD-01`。先运行治理 CLI，根据 `recoveryTrigger` 核对。stale 不等于可抢占。

接手后先执行以下只读检查：

```powershell
cd D:\Repository\SoulForge
git status --short --branch
git diff --check
node scripts/gov.mjs status
node scripts/gov.mjs next
node scripts/gov.mjs help
```

把三条治理输出原文和 SHA-256 放入首次 source snapshot；同时记录 `docs/governance/*.json`、相关 schema、`scripts/verify/tiers.mjs` 和 `package.json` 所属 git blob/dirty hash。若输出与本文阶段/命令冲突，阶段 A1 直接 FAIL 并列冲突，不得把治理检查降为形式动作。

如果发现另一个 agent 正在 `main` 上写同一批文件，立即停止写入，按根 `AGENTS.md` 的并发规则处理。不要在共享 `main` 上互相覆盖。

clean-HEAD 对照只能放在系统临时目录下新建的 `SoulForge-mission1-worktrees/<uuid>`。创建前记录 resolved absolute root；清理只用 `git worktree remove <exact-path>`，随后确认 Git 不再登记。禁止 `git clean`、跨 shell 拼路径、通配递归删除或对当前 `D:\Repository\SoulForge` 执行 checkout/reset。若 resolved target 不在上述临时根内，停止清理并保留目录供人工处理。

### 0.8 当前执行成果隔离：这些 PASS 已经作废

用户暂停执行 agent 后，三名互不复用结论的只读审查者分别审了验收控制器、native/core/PARAM 和 renderer/map。以下 identity 是本次交接修订所见的**冻结反例**；它们只帮助下一位 agent确认自己面对的是同一批错误成果，不能被当作阶段进度：

| 对象 | 冻结 identity | 已证实的问题 | 固定处置 |
|---|---|---|---|
| `scripts/verify-mission1-acceptance.mjs` | 18737 bytes；SHA-256 `523913D315AC09148A7DB54FBCC16F7807C1CF1DF22065D7894B93E0949C63F8` | `--selftest` 实际非零：`selftest: G2 should be FAIL in initial state`；G2-G6 以源码字符串存在判 PASS；G7 可在治理 child exit 1 时 PASS；snapshot、artifact、atomic state write 均不合格 | A0先保存原始 bytes/hash，再把这些真实 bytes加入 negative replay fixture；随后重写信任根，不允许局部加一个 if 掩盖 |
| `output/mission1-evidence/current-state.json` | 2747 bytes；SHA-256 `A81F928B67CD100D0BA81438B5B22AF81089261D24BD171DF7252E324D7CBC59`。**顶层文件已漂移，现值 `0B09C217BE6800D27EB065712CCF796ADE5018F48CEE579E85403CA2AED471E7`（同为 2747 bytes）。冻结 bytes 仍可从 `output/mission1-evidence/2026-08-27T03-06-11-753Z-91c1276828e3/current-state.json` 原样取回，实测 hash 命中。** | G0-G7 全写 PASS；G2-G6 detail 为 `code present`；G7 child `exitCode:1`；`sourceSnapshotSha256`实际混用 summary hash；`stateSha256`不能自洽验证 | 整份 state 永久不可信；保存原始 bytes后由新 runner原子替换成新 schema全 FAIL state，禁止逐字段改成 FAIL后继续用。**取隔离副本时用上面那个 run 目录里的路径，不要用顶层文件——顶层已不是冻结 identity，直接拿会让 A0 的 hash 校验红在一个假原因上。** |
| `testdata/corpus/mission1-sekiro-acceptance.manifest.json` | 4720 bytes；SHA-256 `F0A083426868D7872324D6CBB5E14BAAC05F5D6AD9F27AAD84A4B345C1807B4E` | `entryCount=22` 但 `entries.length=10`；源 hash 是 `0000...` 至 `9999...` 占位；三方证据和 generator hash 为 `pending`；499 个 type-0 没有逐 identity/mesh oracle | 作为 `CORPUS_PLACEHOLDER_REJECTED` 负例；不得补几个真实 hash后沿用其 expected outcome，必须按 24.3 从冻结输入重建并独立 verify |
| 当前 tracked 产品 diff | 282070 raw bytes；SHA-256 `6DBE...0C6D` | 包含可复用半成品，也包含 production unreachable、fail-open、错误 owner/identity 与多骨架路径 | 不 reset、不整体回滚；按第3节逐能力分类，A0/A1后由阶段 B-G逐条收敛 |

冻结时 10 个未跟踪文件的 identity 如下。接手者若发现任一不同，不得说“还是同一批改动”；按 24.2 的 `stageInputRegistry` 重新计算受影响阶段：

| 路径 | bytes | SHA-256 |
|---|---:|---|
| `apps/desktop/src/renderer/src/scene/flverSkeletonMapping.test.ts` | 3023 | `7D483536E9686494D546C38BAACDCF0495FF7350B11DFEC6599618BE6B89A3EA` |
| `apps/desktop/src/renderer/src/scene/flverSkeletonMapping.ts` | 7376 | `37361F51CA9E259CB1144488DDEE3479B74447EE7E38F036403EAFC9CD8D8073` |
| `apps/desktop/src/renderer/src/scene/mapModelLoadScheduler.test.ts` | 1551 | `16A43EAC28B73A293DC653461AE106A64022EA74FBE21FBDA8D69653E2A81E62` |
| `apps/desktop/src/renderer/src/scene/mapModelLoadScheduler.ts` | 3535 | `9391E2041AF3CB285441CE6B054703159FD9B6B8B32A9AFBDA2D396A0D39B58C` |
| `bridge/SoulForge.Bridge/MapStaticGeometryService.cs` | 15896 | `E75D81DC56A4C74340B1F50EDCC1EAB8B6E34208CF992D96C84D6DA26D686C60` |
| `packages/core/src/character/characterAssembly.ts` | 9630 | `565B349CB8486967FA64C938D854898A3A906EA2B9CE1B0C061D0B3ECF7D6B9F` |
| `packages/shared/src/character-assembly.ts` | 3290 | `83F8DC51DDBE4BB2D34DD494C272605D38A4BC9CEBF53110A1392BE8BC6C8DBD` |
| `packages/shared/src/flver-preview.ts` | 5151 | `012AF86789D0353C1F726B3DC3BB266B349BD43BE162F9F90F51EF926BDB5AA3` |
| `scripts/verify-mission1-acceptance.mjs` | 18737 | `523913D315AC09148A7DB54FBCC16F7807C1CF1DF22065D7894B93E0949C63F8` |
| `testdata/corpus/mission1-sekiro-acceptance.manifest.json` | 4720 | `F0A083426868D7872324D6CBB5E14BAAC05F5D6AD9F27AAD84A4B345C1807B4E` |

#### 0.8.1 `sourceSnapshotSha256` 不是源码 hash，新鲜度锚点是装饰性的

上表把这条写成「`sourceSnapshotSha256`实际混用 summary hash」。措辞太轻，实测后果要重一档，而且它直接决定第58-71行那条「current-state identity 与当前源码不同 → 固定选择 A0」的判据能不能执行。

实测：顶层 state 在 03:06→06:06 之间被 runner 又写了 6 次（精确 30 分钟节奏，06:06 后停止）。拿冻结那份和现值逐字段比，54 个字段只有 5 个不同：`generatedAt`、`evidenceDir`、`stateSha256`、`summarySha256`、`sourceSnapshotSha256`。

关键在于 **`dirtyTrackedPatchSha256` 两份完全相同**（`6dbe4426…302c6d`），也就是源码根本没变；而名字里写着 `sourceSnapshot` 的字段变了。原因在 `scripts/verify-mission1-acceptance.mjs:351`：

```js
sourceSnapshotSha256: summary.summarySha256,
```

它是 run summary 的 hash，而 summary 里含每个子命令的 `durationMs`（`:332`）和 stdout/stderr hash（`:343`）。所以这个字段**在源码逐字节不变时每跑一次都会变**。它测的是「这次运行」，不是「这份源码」。

由此得到两个必须写进 A0 的结论：

1. **不能用 `sourceSnapshotSha256` 判断源码是否漂移。** 照第71行字面执行会恒定得到「不同」，于是永远进 A0 却拿不到任何真实漂移信息；反过来，一个想证明「我什么都没改」的人也永远无法用它自证。判据在这个字段上是不可判定的，不是偏严也不是偏松。
2. **`--bootstrap` 路径和真实运行路径给同名字段填了不同的量。** `:443` 用的是正确的 `snap.dirtyTrackedPatchSha256`，`:351` 用的是 summary hash。实测 bootstrap state 满足 `sourceSnapshotSha256 === dirtyTrackedPatchSha256`，真实运行的 state 不满足。拿这两种 state 比这个字段等于比两个不同的东西，且它们在源码相同时也永不相等。

可用的源码 identity 是三元组 `gitHead` + `dirtyTrackedPatchSha256` + `untrackedSourceFiles`。runner 内部 `:250-253`（snapshotStable）和 `:478-480`（drift）用的就是这个三元组，**唯独对外发布的字段用错了**——所以这不是设计缺失，是发布层的一处具体 bug，A0 重写时按内部已有的三元组对齐即可。

但这个三元组自己还有一个洞，接手者必须一起补，否则只是换了个地方假绿：`:66` 是 `git diff --no-color`，**不带 `--cached`**。已用一次性 scratch repo 的负向用例实测：把一个已跟踪文件改掉并 `git add` 之后，`git diff` 为 0 字节、`git diff --cached` 为 121 字节、`git ls-files --others --exclude-standard` 为 0 字节（staged 之后它不再算 others）。**该文件同时逃过三个采集器。** 这就是上表「snapshot漏 staged」的确切形态和大小。修法是把 `--cached` 的 patch 一并纳入 identity，不是把 untracked 扫描范围扩大——扫描范围解决不了 staged 这个缝。

另外注意 `:70-80` 的 untracked 扫描只覆盖 `apps`/`packages`/`bridge`/`scripts`/`testdata` 五个目录、`:85` 只认 6 种扩展名。落在这之外的新增源文件不进 identity。记录这一点是为了避免接手者以为「untracked 已经全覆盖」；本文档所在的 `锐评/` 目录本身也在覆盖范围之外（且被 `.gitignore:101` 忽略）。

最后一条，也是本节最反直觉的：**这 6 次重跑里 8 个 Gate 全部保持 PASS。** 对照 `bootstrap-1787766730711/current-state.json` 是 G0-G7 全 FAIL。也就是说 Gate 结论与它声称锚定的源码快照之间没有真实耦合——冻结 runner 不仅会造伪 PASS，还会在自己的新鲜度字段变动时把伪 PASS 原样复制下去。任何「state 里写着 PASS 且时间戳很新」的组合都不构成证据。

A0 的隔离顺序固定，不允许删除、移动或覆盖在先：

```text
1. capture source snapshot S0；确认用户的暂停写入仍有效且工作树没有继续漂移。
2. 读取 runner、corpus、current-state 和 current-state.evidenceDir 中每个普通文件的原始 bytes；拒绝 symlink/reparse。
3. 在 ignored 的 output/mission1-evidence/quarantine/<UTC>-<runnerSha>/ 下以 exclusive create复制原始 bytes。
4. 为每个副本重读并验证 byteLength+SHA-256；写 quarantine-manifest，标明 trust="REJECTED_DIAGNOSTIC_ONLY"。
5. 不删除原文件；先用隔离 bytes运行全部 negative replay，证明新判定器会拒绝它们。
6. 只有 negative replay全拒绝后，才允许修 runner/schema/corpus；旧 evidenceDir 永不成为新 registry的搜索输入。
7. 新 runner完成独立审查后，以全新 schema写 temp state，fsync文件和父目录，再 atomic rename替换 current-state；隔离副本保留。
```

A0 最低负例矩阵每一行都必须实际执行，不能只在测试名里出现：

| 负例 | 必须得到的结果 |
|---|---|
| 原冻结 `current-state.json` | `LEGACY_STATE_SCHEMA_REJECTED`；0 个 Gate可导入 |
| `fileContains()`/源码字符串作为 G2-G6 artifact | `ASSERTION_ARTIFACT_TYPE_MISMATCH` |
| child exit非零而外层/child JSON写 PASS | `CHILD_NONZERO`，对应 assertion/Gate FAIL |
| `entryCount != entries.length`、重复占位 hash、`pending` generator/tool/Andre字段 | `CORPUS_PLACEHOLDER_REJECTED` |
| 旧 Bridge exe存在但无本轮 publish provenance | `BRIDGE_BUILD_PROVENANCE_MISSING` |
| staged diff、任意目录未跟踪文件、中文路径或 reparse被 snapshot遗漏 | `SOURCE_SNAPSHOT_INCOMPLETE` |
| result nonce、source identity、runtime input、corpus或Bridge hash来自旧 run | `ARTIFACT_REPLAY_REJECTED` |
| result JSON手写 PASS但无原始 stdout/stderr/typed measurement | `ASSERTION_EVIDENCE_INCOMPLETE` |
| 直接覆盖 current-state、截断 temp、state hash错误或崩溃发生在rename前 | 旧可信 state保持原字节；新 state不发布 |
| registry不认识的源码输入发生变化 | `STAGE_INPUT_UNMAPPED`，固定回到 A0；不得猜阶段 |

A0 退出不是“runner看起来更严格”。它必须由一个未参与实现的全新 agent拿上述冻结 bytes主动攻击；所有负例被拒绝、new state初始全 FAIL、runner自身仍以产品 Gate未通过而非零退出，才允许发布 `A0=PASS`。旧 runner生成过的 PASS即使哈希相同，也没有任何祖先/兼容迁移路径。

## 1. 任务真正的完成标准

本任务不是“让截图看起来好一点”，也不是“给慢函数套一个缓存”。完成必须同时满足以下条件：

1. 工作区基础 UI 尽快可操作，首次轻量索引不等待全量哈希、容器验证、原生预览或语义分析。
2. 后台索引是增量的、可取消的、可汇报进度的，并且会给前台 PARAM/地图/角色读取让出磁盘和 CPU。
3. `AtkParam_Npc`、`SpEffectParam` 等大表快速出现完整行索引；搜索、滚动和选择不反复跨 IPC；选中行才加载必要页字节。
4. PARAM 读取和写回尊重真实物理行身份，重复 ID 不得被 `Map<id,row>` 折叠或写错行。
5. `m10_00_00_00` 的真实 FLVER 三角形索引、位宽、strip/list、restart 和 winding 语义正确，不再出现放射长三角。
6. 大地图按资源类型正确路由，模型复用、渐进上传和资源释放合理；不能减少显示数量、隐藏坏面或只抬 IPC 帧上限。
7. TransformControls 的 attach 对象必须属于 scene graph；加载中和加载后都能稳定选择、拖拽、旋转和缩放，并在拖拽结束时写回 semantic document。
8. `c0000 / a000_000010` 使用正确的主骨架、部件骨骼重映射和显式动画容器，完整角色身体可见，蒙皮结果有限且不退化。
9. 不针对 `m10_00_00_00`、`c0000`、`a000_000010`、`AtkParam_Npc` 写特例。
10. 所有 Mod 资源写入仍经过 Patch Engine；renderer 不得到真实绝对路径；C# Bridge 仍是原生格式 production authority。

## 2. 状态标记说明

本文使用以下标记，接手者必须按字面理解：

- **真实证实**：在本机 Sekiro 真实语料或 Andre.SoulsFormats/Smithbox 行为 oracle 上做过只读差分/测量。
- **代码已写且已验证**：当前工作树中已有实现，并且在该实现之后跑过相应测试。
- **代码已写但未验证**：当前工作树中已有实现，但实现之后尚未重新构建或测试。
- **待实施**：诊断已经闭合，但代码还没有完成。
- **待测量**：有合理风险判断，但不能当成已证实根因；必须先加指标再决定实现。

## 3. 当前工作树中已经存在的改动

本节描述的是用户暂停执行 agent 后，两个代码审查 agent 对第 0.8 节冻结快照的逐调用链结论。状态只允许：`可复用半成品`、`反向跑偏/必须拆除`、`未接 production`、`未实现`；这里没有任何一项可以提升 Gate 或 native authority。

### 3.1 工作区启动和索引

相关文件：

- `packages/core/src/workspace/scanWorkspace.ts`
- `apps/desktop/src/main/ipc.ts`
- `apps/desktop/src/renderer/src/App.tsx`
- `apps/desktop/src/renderer/src/styles.css`
- `apps/desktop/src/renderer/src/staging/documentReset.ts`

已存在的可复用半成品：首屏 scan 能先做轻量发现，main 能在返回首屏后启动后台索引，renderer 已有加载阶段反馈和部分 abort/yield 点。

冻结实现的反向问题：

- `apps/desktop/src/main/ipc.ts` 用 `globalThis.__previousFileMap` 保存前次文件，未绑定 workspaceId，也不跨进程持久化；两个工作区的同名、同 size/mtime 文件可能错误复用。
- `workspaceSessionGeneration` 被固定为 `1`，不是每次open递增的提交 guard；旧后台结果仍可能污染当前会话。
- 后台仍会全量 hash，写回刷新又调用普通 `scanWorkspace`；热启动和写回后的 I/O 目标尚未达成。
- `workspace.analyze` 在已有 index 时可返回 `parsedFiles=0`，把文件数量记作 inspected，可能绕过真正 semantic/native analysis；不能把这个短路当作“分析复用完成”。

状态：**partial + 反向跑偏**。保留轻量 discovery/UI 反馈，拆除全局 file map、固定`workspaceSessionGeneration`和虚假 analyze completion；按 24.4 重新接到 workspace-scoped 持久 fingerprint、可续 hash 和统一优先队列。

### 3.2 PARAM

相关文件：

- `bridge/SoulForge.Bridge/ParamNativeDocument.cs`
- `bridge/SoulForge.Bridge/ParamNativeWriter.cs`
- `bridge/SoulForge.Bridge/BridgeCommandService.cs`
- `packages/core/src/editing/paramBridgeCommit.ts`
- `packages/core/src/param/paramdefLayout.ts`
- `apps/desktop/src/main/ipc.ts`
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/src/renderer/src/App.tsx`
- `apps/desktop/src/renderer/src/workbench/ParamWorkbench.tsx`
- `packages/shared/src/editor-protocol.ts`
- `packages/core/src/testing/runParamFieldWriteMatrixSmoke.ts`
- `packages/core/src/testing/runNativeParamSmoke.ts`
- `packages/core/src/testing/runParamdefLayoutSmoke.ts`

已存在的可复用半成品：

- 修正 Sekiro PARAM 32 位布局的真实 12 字节行头。
- 修正 long64 单行 PARAM 在旧 ParamType 副本仍存在时的行宽歧义。
- 增加 `headerOnly` 和 `expectedRowDataSize`。
- 行索引和 payload 页拆分，行列表使用虚拟滚动。
- 元数据异步加载，不阻塞行列表。
- C# `ParamNativeDocument.ResolveExistingRowIndex` 已能在给定 `rowIndex` 时核对 ID，并可核对 `expectedDataHash`。
- main 增加 PARAM 文档 LRU 和容器解包缓存。

冻结实现的反向问题：

- main 的 row DTO仍是 `{id,dataBase64,dataHash,name}`，没有把 `rowIndex`传到 preload/renderer；page byte map仍为 `Map<number,string>` 并按 `row.id`写，重复 ID覆盖。
- Yapped fallback同样按 ID建立索引；`readContainerParamRowIndex`最终只返回 id/name。
- `ParamWorkbench`明确采用“重复 ID取第一个匹配”的旧约定，因此 C# 下层即使支持物理行，上层仍会选错/写错。
- BND cache仍以 path/mtime/size为主要 identity，无 owner/reader lease；listing用 `Bnd4NativeDocument.Read`时仍复制并 hash所有 child。PARAM page若只是 main缓存最终 JSON而 Bridge重复 parse，性能根因没有消失。

状态：**C# 物理行 CAS 是可复用半成品；端到端 row identity、native session和轻量 BND listing均未完成**。早先 138 表 no-op只证明当时旧快照的读取/no-op诊断，冻结工作树在此后已经变化，不能继承“已验证”。必须先让 `rowIndex + expectedId + expectedDataHash`贯穿所有 DTO/Map/key，再做热路径；不得用 renderer first-match补丁维持兼容。

### 3.3 地图与 FLVER

相关文件：

- `bridge/SoulForge.Bridge/FlverNativeDocument.cs`
- `bridge/SoulForge.Bridge/NativeLeafPayload.cs`
- `bridge/SoulForge.Bridge/BridgeCommandService.cs`
- `bridge/SoulForge.Bridge/MapStaticGeometryService.cs`（未跟踪）
- `apps/desktop/src/main/mapMeshGeometry.ts`
- `apps/desktop/src/main/ipc.ts`
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/src/renderer/src/editors/MsbScenePanel.tsx`
- `apps/desktop/src/renderer/src/editors/MsbScenePanel.test.tsx`
- `apps/desktop/src/renderer/src/scene/threeSceneController.ts`
- `apps/desktop/src/renderer/src/scene/modelResourcePool.ts`
- `apps/desktop/src/renderer/src/scene/modelResourcePool.test.ts`
- `apps/desktop/src/renderer/src/scene/mapModelLoadScheduler.ts`（未跟踪）
- `apps/desktop/src/renderer/src/scene/mapModelLoadScheduler.test.ts`（未跟踪）
- `apps/desktop/src/renderer/src/scene/runThreeSceneFunctionalSmoke.ts`
- `packages/shared/src/flver-preview.ts`（未跟踪）

已存在的可复用半成品：

- Bridge 已出现 `read-map-static-geometry` 和 `MapStaticGeometryService` 隔离实现，可作为 D 阶段重构起点。
- 曾用 Andre/SoulsFormats 对部分 FLVER triangle strip/list、restart、winding、16/32 位索引做过独立差分；该 oracle思路应保留。
- 相同模型请求去重。
- 渐进模型调度与逐帧任务队列。
- `InstancedMesh` 和 GPU `BufferGeometry` 资源池。
- 对象列表虚拟化。

冻结实现的关键跑偏：

- production **完全没有调用** `read-map-static-geometry`。preload仍只暴露旧 `readMapPartMesh`，`MsbScenePanel`仍单次请求完整 base64，main 的旧 handler仍逐 mesh全量读取/合并，并把索引强制解释为 `Uint16Array`。真实 32-bit index因此仍可生成长三角/尖刺。
- Bridge static service自身先把全部 positions/normals/UV/indices flatten到内存，再切 chunk；不是 24.9/24.10 要求的可恢复 streaming decoder。cursor只是可伪造的 `mesh:tri` base64，未绑定daemon/session owner、source hash/`pathSourceGeneration`、完整resource cache key，预算也不是实际序列化 wire bytes。
- `FlverNativeDocument`对多个`Flags==0`静默取首个、缺主FaceSet回退第一个；8-bit/EdgeCompressed只返回null而没有结构化diagnostic，`CullBackfaces`未进入DTO。**动手前必读 §24.9.0：`FSFlags`/`CullBackfaces` 这两个符号在 SoulForge 仓库里解析不出来（`csproj` 零 PackageReference，Bridge 是自写解析器），它们的真值只能从本机 DSAnimStudio 4.9.9 的 `SoulsFormats.dll` 元数据取；`FSFlags.EdgeCompressed == 0x40000000`，与 `FlverNativeDocument.cs:85` 那个 `TypeEdgeCompressed = 0xF0`（顶点类型，不是 FaceSet flag）差 2²⁶ 倍。**它的restart边界`mesh.VertexCount < 65535`与成熟实现一致，不能再把这条正确条件误诊为根因；真正未闭合的是该条件没有进入版本化rule/边界oracle，且triangle-list输出前没有完整index bounds验证。旧差分不能替当前production实现背书。
- 冻结实现的`TriangulateFaceSet`把strip奇数步输出成`(b,a,c)`并注释为SoulsFormats-compatible；本机DSAnimStudio 4.9.9所带`SoulsFormats.FLVER2.FaceSet.Triangulate`实际输出`(c,b,a)`。两者是同一三角形的循环置换，光栅画面/法向绕序可能一样，但canonical triangle-list bytes和SHA-256不同；如果生产者用前者、Andre oracle用后者，24.3/24.9会永久互相打脸。D阶段必须按24.9的成熟实现顺序修正，不能为了沿用当前测试expected继续保留`(b,a,c)`。
- `mapModelLoadScheduler.resolved`长期保存完整 wire payload，key只有 modelName，dispose不取消底层请求；GPU pool无 owner/refcount，短 base64会补零，material/texture释放不完整。
- placement仍只绑定一个 mesh/instance，没有 placement→全部 chunks/cells的一对多 identity；pick仍扫描全部 placement；Gizmo只能更新一个 binding且没有多 chunk原子回滚。
-现有 headless `FakeRenderer`/source-regex测试没有真实 GPU、真实 pointer或 native asset，不能证明地图已修。

状态：**Bridge隔离 helper存在，但 production unreachable；旧生产路径仍是 P0 根因，static helper本身也仍 eager/fail-open**。D阶段先修 FLVER语义和 typed route并让旧 API不可达，随后才能复用 scheduler/InstancedMesh骨架；不得把“命令存在”写成 G4 PASS。

### 3.4 动作/角色

相关文件：

- `apps/desktop/src/renderer/src/editors/FlverViewer.tsx`
- `apps/desktop/src/renderer/src/editors/TaeWorkbenchPanel.tsx`
- `apps/desktop/src/renderer/src/editors/TaeWorkbenchPanel.test.tsx`
- `apps/desktop/src/renderer/src/scene/threeSceneController.ts`
- `apps/desktop/src/renderer/src/scene/flverSkeletonMapping.ts`（未跟踪）
- `apps/desktop/src/renderer/src/scene/flverSkeletonMapping.test.ts`（未跟踪）
- `packages/core/src/character/characterAssembly.ts`（未跟踪）
- `packages/shared/src/character-assembly.ts`（未跟踪）
- `packages/shared/src/action-continuous-sampler.ts`
- `packages/core/src/action/taeAnimationBridge.test.ts`
- `packages/core/src/testing/runAnimationPlaybackClockSmoke.ts`

已存在的可复用半成品：`CharacterAssemblyContext`类型、一个 hierarchy/name remap helper、HKX parent/reference pose、连续 sampler和部分 CPU skin断言已经出现。

冻结实现的关键跑偏：

- `read-chrbnd-flver-preview`仍为每个 FLVER分别构建 bundle/bones，并以最大 bone count启发式选 leader；不是显式 context指定的单 leader。
- core remapper带 `@ts-nocheck`且没有 production调用点；renderer的 `FlverViewer`/controller仍为不同 FLVER建立独立 skeleton，已有 smoke甚至断言“多 skeleton namespace保持独立”，这是必须翻转的 negative test。
- main对 c0000仍硬编码 `bd_m_9000/am_m_9000/lg_m_9000/hd_m_9510/wp_a_0300`目录项；这不是 PARAM/用户 selection provenance，其他装备/角色会跑偏。
- animation/skeleton container仍靠相邻目录/文件名猜；DTO没有 `coordinateSpaceId/unitScale/conversionRuleSha256`，转换 helper留在 renderer，每帧 playback time会驱动 React重算。
- 冻结的`flverSkeletonMapping.ts`和`threeSceneController.ts`把FLVER的“XZY”标签直接交给Three或实现为`qx*qz*qy`。这与本机DSAnimStudio 4.9.9所带SoulsFormats的实际`ComputeLocalTransform`不等价：后者在System.Numerics行向量约定下为`S*Rx*Rz*Ry*T`，转成本文统一列向量后必须是`T*Ry*Rz*Rx*S`，对应旋转四元数`qy*qz*qx`。当前helper是反向实现，不能作为24.16的oracle；先翻转其negative test，再接单leader骨架。**本段结论已于2026-08-27经Node与C#双侧独立oracle实测确认，替换值、四个改动点、以及“现有测试会惩罚正确修复”的处理办法全部落在§24.16.1–24.16.3，动手前先读那三节，不要在这里自己推。**

状态：**类型/helper存在但未接 production；当前多 skeleton、硬编码 parts和目录猜测是反向实现**。F阶段应复用已写的纯算法测试素材，但必须先把正向断言改成单 leader、显式 context与一次性 selection provenance，再接生产链。

### 3.5 验收 runner 与 corpus

相关文件：

- `scripts/verify-mission1-acceptance.mjs`（未跟踪）
- `testdata/corpus/mission1-sekiro-acceptance.manifest.json`（未跟踪）
- `output/mission1-evidence/current-state.json`（ignored local artifact）

状态：**P0 反向跑偏，必须先执行 A0**。这里不是“runner覆盖不够完整”，而是验证信任根本身能制造伪 PASS：snapshot漏 staged/任意目录未跟踪文件，corpus verifier只看字段非空，G2-G6只看源码字符串，G7忽略治理 exit 1，state直接覆盖且hash语义错误。第0.8节已冻结精确bytes/hash；后续不得从旧 state恢复任何 PASS，也不得在产品 B-G上继续写之前只给 runner加更多字符串。

## 4. 已完成的验证和不可夸大的证据

### 4.0 工具链：裸 `dotnet` 构建不了本仓库（2026-08-27 实测）

**本节必须在任何 C# 改动之前读完。** 它不是环境介绍，是一个会让你把「环境问题」误诊成「代码问题」、并做出真回归的陷阱。

直接跑标准命令会失败：

```powershell
dotnet build bridge/SoulForge.Bridge/SoulForge.Bridge.csproj
```

```text
error NETSDK1045: The current .NET SDK does not support targeting .NET 10.0.
Either target .NET 6.0 or lower, or use a version of the .NET SDK that supports .NET 10.0.
```

**实测原因：PATH 上的 dotnet 是 6.0.428（`dotnet --list-sdks` 只有这一个），而 `SoulForge.Bridge.csproj` 的 `TargetFramework` 是 `net10.0`。** 仓库根的 `global.json` 写 `{"sdk":{"version":"6.0.100","rollForward":"latestMajor","allowPrerelease":true}}`，`latestMajor` 也滚不到一个没安装的 SDK。本机 `dotnet --list-runtimes` 最高只有 `Microsoft.NETCore.App 8.0.21`。

**禁止的「修法」：把 `csproj` 的 `TargetFramework` 从 `net10.0` 降到 `net6.0`/`net8.0`。** 那是真回归，不是修环境。同样禁止改 `global.json` 的版本号去迁就 PATH 上的 SDK。

**正确做法：所有 C# 构建都走 npm 脚本，不要直接调 `dotnet`。**

```powershell
npm run bridge:build      # 实测通过：Build succeeded, 0 Error(s)
npm run bridge:publish
```

原因在 `scripts/run-dotnet.mjs:5-11`：它按顺序解析 `process.env.SOULFORGE_DOTNET` → `%LOCALAPPDATA%\SoulForge\dotnet\dotnet.exe` → 裸 `dotnet`。**本机实测 `SOULFORGE_DOTNET` 未设置，但私有 SDK 存在**：

```text
C:\Users\ASUS\AppData\Local\SoulForge\dotnet\dotnet.exe   --version → 10.0.301
```

所以 `npm run bridge:build` 能过、裸 `dotnet build` 过不了，二者的差别**只是 dotnet 可执行文件不同**，与代码无关。若哪天 `npm run bridge:build` 也报 NETSDK1045，先查这个私有 SDK 目录还在不在，不要动 `csproj`。

**本节顺带修正一个会让你误判的测量口径。** §4.1 记录历史构建是「exit 0，约 62 个 warning」。现在的真实数字是 **64 warning**，但更要紧的是：

| 命令 | 实测结果 |
|---|---|
| `npm run bridge:build`（增量，已 up-to-date） | `0 Warning(s)`，0.79–0.94 秒 |
| 同命令加 `--no-incremental`（强制全量） | **`64 Warning(s)`**，6.86 秒 |

**增量命中时它恒报 0 warning。** 所以「`bridge:build` exit 0 且 0 warning」不能作为「C# 编译干净」的证据——那和「改完源码不强制重建、半截增量产物被 buildinfo 当成最新」是同一个坑：假红假绿都会看起来像判据自己的 bug。要测 warning 必须显式加 `--no-incremental`。另外 MSBuild 会把每条 warning 打印两次（编译时 + 末尾汇总），grep 计数要除以 2，或者直接读末尾的 `N Warning(s)`。

64 条 warning 的归属（已折半去重，全部是 nullable 相关 `CS86xx`/`CS87xx` 加 2 条 `CS0652`）：

| 位置 | 条数 |
|---|---|
| `bridge/SoulForge.Bridge/Havoc/**`（vendored HKX 库） | **56** |
| `MapStaticGeometryService.cs` | 2 |
| 其余零散 | 6 |
| `BridgeCommandService.cs` | **0** |
| `FlverNativeDocument.cs` | **0** |
| `ActionAnimationSemantics.cs` | **0** |

**这张表的用法：你要改的三个主文件当前都是 0 warning。** 改完再跑 `--no-incremental`，如果你的文件冒出 warning，那是你引入的，不能推给「仓库既有」。反过来，`Havoc` 子树那 56 条不要去修——它是 vendored 第三方代码，动它属于超范围。

`bin/`、`obj/` 已被 `.gitignore:95-96` 忽略，构建和强制重编都不会弄脏已跟踪文件（实测 `git status --porcelain -- bridge/` 前后一致）。

未测：`npm run bridge:publish` 本轮**没有运行过**。§4.1 与 §16 多处要求「真实 native smoke 必须使用本次 Release publish 产物」，那条链本次未验证；`bridge:build` 只产出 `bin/Debug/net10.0/win-x64/`，与 publish 目标路径不同，不能互相顶替。

### 4.1 只有历史诊断，没有当前 PASS

旧快照早先运行过：

```powershell
npm run bridge:build
```

当时结果：exit 0，约 62 个 warning。它发生在冻结改动完成前，且没有通过现行 G0 provenance绑定，因此只能帮助定位，不是 G1 PASS。**「62」这个数字现已实测更新为 64，且必须加 `--no-incremental` 才测得到——增量命中时同一命令恒报 0 warning。别拿 0 warning 当「编译干净」的证据。归属表和裸 `dotnet` 为什么会 NETSDK1045 见 §4.0。**

早先运行过：

```powershell
npm run test:param-field-write-matrix
```

当时结果：exit 0。覆盖的是当时版本的标准 32 位 synthetic、原位 upsert、add/delete fail-closed；此后 PARAM协议和实现已经修改，不能继承。

真实 `gameparam.parambnd.dcx` smoke 的历史记录：

- 138/138 表读取成功。
- 138/138 no-op byte-identical。
- 0 failure。
- `default_AIStandardInfoBank`：40 行，行宽 128。
- `default_EnemyBehaviorBank`：22 行，行宽 128。
- `MenuColorTableParam`：81 行，行宽 4。

这些数字仍可作为回归定位线索，但缺当前 source snapshot、当前 publish Bridge和新 runner typed artifact；统一标记 `historical-diagnostic-only`。

**「138/138」还有一层限定，比 `historical-diagnostic-only` 更要紧：它只在 mod-side DFLT 容器上成立，game-side 是 KRAK，实测 86/138。** 别把它当成「曾经达到过、照着跑一遍就能复现」的数字——复现取决于你打开的是哪个容器，以及有没有传 `oodleRuntimeRoot`。完整对照见 §0.4.1。

#### 4.1.1 基线红：1/837，不是你造成的

你大概会在很早的时候跑一次渲染层单测。**它现在就是红的，在你动手之前。**

```powershell
node scripts/run-renderer-unit-tests.mjs
```

实测 `tests 837 / suites 155 / pass 836 / fail 1`，退出码 1，JSON 摘要 `"code": "RENDERER_UNIT_TESTS_FAILED"`。

失败的那一条是 `apps/desktop/src/renderer/src/editors/TaeWorkbenchPanel.test.tsx:535`，用例名 `问题4-A：预览一次读取并校验完整角色 bundle，不再逐 mesh 重启 Bridge`。**它与骨骼、旋转、地图、PARAM 全都无关，也不是你改出来的。**

但它**不是噪声，也不是腐坏的门禁**——测试在脏树里被提前写到了源码前面，钉的是一个还没实现的新约定。**这条红在你的作业范围内，要修的是源码不是断言**，四个改动点和两个「已在仓库里、不要重写」的现成件都在 §24.16.3。动手前读那一节。

**这条红有一个立刻会咬人的副作用：套件退出码不能用作任何扰动实验的测量口径。** 它恒为 1，会把所有相位盖成同一个值，让你把「判据是活的」误判成「判据是死的」。判据必须下沉到目标用例自己那一行的 `✔`/`✖`；找不到那一行要当**测量失效报错**，不能当通过。

已测 / 未测，别混：

| 命题 | 状态 |
| --- | --- |
| 脏树上 837/836/1、失败用例身份 | **已实测**（三个定位口径互相印证，见 §24.16.3） |
| `TaeWorkbenchPanel.tsx` 这一轮没被改过 | **已实测**（`git status --porcelain` 只有 `.test.tsx` 是 M） |
| HEAD 版本那条断言能被源码满足 | **已实测**（HEAD 第 536 行带 `index`，源码 `:720`/`:755` 正好匹配） |
| **整个套件在干净 HEAD 上是绿的** | **未测。** 只验证了那一条断言在 HEAD 会通过，没跑过 HEAD 全量——别把它当成「HEAD 是绿的」 |

### 4.2 当前所有 runner PASS 作废，产品链尚未验证

停止前最后一轮 PARAM 修改之后，没有重新运行：

- `npm run typecheck`
- `npm run bridge:build`
- `npm run bridge:publish`
- `npm run test:param-field-write-matrix`
- `npm test`
- `npm run build`

此外，冻结 runner曾运行并把 G0-G7全部写成 PASS，但其自身 `--selftest`实际失败，G7治理子结果为 exit 1，G2-G6只是源码字符串。**这比“尚未运行”更危险：这些 PASS已经被证实为伪证据并永久作废。** 下一位 agent不得把当前工作树称为“已通过”，也不得将旧 logs/current-state/Bridge exe迁移到新状态。

### 4.3 权限/authority 边界

- synthetic 通过不等于 Sekiro native-verified。
- 单个真实表通过不等于全部 PARAM writer authority。
- 真实只读差分不等于写回能力已经验证。
- `m10` 数百万索引差分正确，只证明几何投影语义，不证明 viewport 帧率、加载交互或 Gizmo 已完成。
- CPU skin smoke 正确，只证明映射算法可行，不证明当前 renderer 已使用该算法。
- `flver-multi-skeleton-pose-batch` 若仍断言多个 body FLVER保持独立 skeleton，只能登记为当前错误设计的 **negative characterization**；它必须先红、再由单 leader生产测试替代，绝不是 G6正证据。
- `read-map-static-geometry`字符串/命令存在只证明隔离代码写入工作树；preload/main/renderer无调用时，G4仍 FAIL。

### 4.4 What already exists：必须复用，禁止平行重建

| 已有能力 | 当前位置/责任 | 本任务如何复用 | 禁止的平行实现 |
|---|---|---|---|
| C# native authority | `BridgeCommandService`、各 NativeDocument/Writer | 所有 DCX/BND/PARAM/FLVER/HKX production 解析继续落在 Bridge | renderer/main 的第二套原生 parser |
| BND binder cache骨架 | `Bnd4NativeWriter.GetCachedBinder` | 保留底层一次 parse能力，但把 path/mtime/size key升级为source hash+`pathSourceGeneration` identity并包进workspace-session owner/reader lease；listing去掉eager child hash | main 缓存 JSON掩盖Bridge重复解包，或把当前全局dictionary直接称为session |
| EMEVD session 生命周期范式 | core/Bridge 现有 EMEVD session 代码 | 只借鉴完整content key、typed owner、close/evict状态机；PARAM仍按24.6明确区分workspace session与path source generation | 复制 EMEVD 数据模型、沿用其裸generation字段或把 PARAM 塞进 EMEVD session |
| OperationLog/WorkspaceDataRepository | main/core 持久化边界 | 扩充可读 file catalog 和`fingerprintStoreGeneration/pathSourceGeneration` | 新增旁路 JSON/SQLite 索引库 |
| PARAM index/page UI骨架 | `ParamWorkbench` 与 main/preload IPC | 保留本地搜索、虚拟滚动和按页加载；删除first-match，令rowIndex贯穿并修Bridge/session/状态机 | 一次少载行、禁用编辑换速度，或继续以ID作Map key |
| FLVER index oracle | `mapMeshGeometry.ts` 与历史 Andre差分 | 只保留为独立oracle/差分投影；production FaceSet/streaming由Bridge唯一负责 | renderer/main再次生产合并整个模型，或让oracle代码选择production FaceSet |
| Bridge static geometry半成品 | `MapStaticGeometryService`、`read-map-static-geometry` | 保留typed DTO/命令外壳，重做streaming cursor、owner lease、wire framing后接入唯一production route | 因命令存在就保留旧`readMapPartMesh`双轨生产 |
| 地图 scheduler/GPU pool半成品 | `mapModelLoadScheduler`、`modelResourcePool` | 删除resolved wire retention；加入typed resource key、readyManifest、subscriber owner和geometry/material独立refcount | 每个part独立IO/parse/BufferGeometry，或短payload补零 |
| InstancedMesh 场景投影 | `threeSceneController` | 保留实例化；增加placement→all chunks/cells identity transaction，修selection/Gizmo并在测量后做cell分组 | 每个part一个Mesh、默认隐藏实体，或一placement只记录最后chunk |
| TransformControls 与 semantic mutation | `threeSceneController`、现有 editor callback | 保留交互入口，拖动结束只走一次现有 semantic mutation | objectChange 每帧写 Patch/React 全树 |
| Character helper与连续动作 sampler | shared/core character/action代码 | 去掉`@ts-nocheck`并先验证纯remap，再由production resolver生成一次性context；每帧只采样一个leader pose | 硬编码parts、最大骨骼数leader、每个body part独立retarget/sampler |
| 旧 acceptance runner/corpus | 冻结hash见0.8 | 只作为negative replay输入，不复用其判定、state或expected outcome | 在旧fileContains Gate上继续补条件，或从placeholder manifest补写expected值 |
| Patch Engine/备份/回滚 | main/core 现有写入边界 | 所有编辑写回继续走原路径并补回归 | Bridge/renderer 直接覆盖 Mod 文件 |

复用不等于不改：若已有 helper 的语义错误，应在其权威边界修正并让所有调用方收敛，不能保留新旧两条 production 路径长期并存。

### 4.5 NOT in scope：这次明确不做，但不得借此逃避 Gate

- 不重写整个编辑器框架、React 状态库或 Three.js renderer；本任务只改与九类故障有直接数据流关系的边界。
- 不把 WebGL2 全量迁移到 WebGPU；WebGL2 必须先满足真实验收，WebGPU 可另立任务。
- 不实现完整 HKX collision 编辑/写回。type 5 的正确路由、资源身份和诚实 diagnostic 在本任务内，伪装成已渲染不允许。
- 不新增未经真实语料验证的 PARAM add/delete/变长 writer authority；现有同宽物理行编辑必须保持。
- 不为其他 FromSoftware 游戏承诺 native authority；实现不得硬编码 Sekiro 样本，但验收范围仍是本机 Sekiro。
- 不复制 DSMapStudio、Smithbox 或 SoulsFormats 的不兼容源码；只做公开行为、数据语义和测量对照。
- 不做营销式 UI 改版。清晰的阶段/进度/取消/失败反馈属于本任务，纯视觉重排不属于。
- 不在第一次测量前凭空承诺绝对毫秒数字；但固定测量协议、保存 baseline、证明相对改善和交互无长任务属于本任务。

任何接手者若要扩大或缩小以上范围，必须先说明它会改变哪个 Gate，并取得用户裁定。不能在最终报告里用“NOT in scope”移走用户明确要求的真实 canvas、Gizmo、角色成功路径或大表性能。

### 4.6 成熟工具对照协议：比较实现行为，不比较截图

在阶段 C/D/F/G 动手前，先清点 `D:\mystream\Sekiro Shadows Die Twice\tools`：记录实际工具名、版本、exe/dll SHA-256、许可证和能够完成的工作流。不要假定目录里一定是某个版本的 Smithbox/DSMapStudio。公开 SoulsFormats/Andre.SoulsFormats 只作为格式/几何 oracle；不复制受限源码。

对照必须在相同 corpus hash 和第 17 节机器状态下完成：

| 对照链路 | 必须观察/测量 | 要回答的问题 | 禁止的替代品 |
|---|---|---|---|
| 工作区/项目打开 | 首个可操作时间、后台 IO 时间线、文件 read/hash 数 | 成熟工具把哪些发现放首屏，哪些延迟；是否复用 catalog | 只比 loading 动画或总启动秒数 |
| BND/PARAM | gameparam list、AtkParam_Npc/SpEffectParam first rows/page、进程 IO/CPU/内存 | binder 是否长驻；翻页是否重解包/全量 parse；行 identity 如何保持 | 只测裸 PARAM parser |
| 地图资源 | m10 first visible/fully loaded、同模型重复实例、draw calls/frame、内存增长 | static DTO 是否含 skin；模型/GPU 资源如何去重；场景如何分组/裁剪 | 只看最终实体计数或截图 |
| FLVER 语义 | positions、16/32-bit indices、strip/list/restart/winding、bounds | SoulForge 每个 semantic array 是否与成熟 parser 一致 | 猜矩阵、调 far plane、只看无尖刺 |
| Gizmo | 大图 loading/loaded 下 pick、drag、semantic writeback | 控制对象在哪个坐标空间；拖动期间何时写权威文档 | 空场景 controller 单测 |
| 角色装配 | leader/parts/attachments、bone remap、完整 body、clip container | 装备 context 从哪里来；是否单 leader；动画容器如何选择 | 扫目录猜默认装备 |
| 生命周期 | 关闭/重开资源、切工作区、源文件变化后的 IO/parse/GPU/heap | 哪些cache跨editor/workspace session存活；path source、scene、renderer context各怎样失效 | 只演示并发 Promise 去重 |

行为对照的输出必须包含“观测事实”和“我们的设计结论”两个字段，禁止把反编译猜测写成事实。能用 ProcMon/ETW/进程 I/O counter、日志、公开 API 或可重复 stopwatch 证明的就保存原始输出；无法观察内部实现时只写“黑盒行为显示……”，不得声称知道其缓存类或线程模型。

comparator 按 workflow 选择，不要求一个工具包办全部：PARAM 工具必须能打开同一 gameparam/大表，地图工具必须能打开同一 m10 并浏览，动作工具必须能打开 c0000/目标 clip。先对目录中所有候选执行 capability probe并保存结果；能够完成同一工作流的候选都测5次probe，正式阈值使用其中最快P50的工具，禁止故意挑较慢工具。正式 comparator 也按第17节跑20次，并使用第24.3节 `MatureToolAdapterV1` 的 typed machine artifact。UI坐标、截图、视频和逐步event log只供诊断，不能单独产生PASS。没有任何候选具备对应adapter/capability时，固定返回 `MATURE_TOOL_ADAPTER_UNAVAILABLE` 并使 comparator 项失败；绝不能换一个只会看文件列表的工具冒充。

对照不是要求逐项复制成熟工具。若 SoulForge 的固定架构以更小改动达到相同/更好的可观察行为，保留 SoulForge 方案；若对照反驳第 0.3 节决策，按该节的用户裁定流程处理。

## 5. 工作区启动慢：完整诊断

### 5.1 数据流

```text
renderer mountWorkspace
  -> IPC workspace.scan
    -> main 清理旧会话/Bridge pool
    -> openWorkspaceSession
    -> scanWorkspace(includeContentHashes=false)
  -> renderer 得到基础文件表
  -> main 立即 startBackgroundWorkspaceIndexing
       -> 第二次完整 walk/stat
       -> 顺序 SHA-256 全部文件
       -> DB replace / diagnostics / RAG
  -> renderer 恢复或默认选中文件
       -> 通用 resource.preview / inspect
  -> PARAM/地图/动作专用工作台同时发自己的原生读取
```

### 5.2 已证实的数据

本机 mods 工作区：

- 文件数约 270。
- 总内容约 726,112,002 bytes。
- 无哈希 discovery 实测约 14.9 ms。
- 顺序 SHA-256 全量约 1657.6 ms。
- 第二轮 discovery + 全量 SHA 总计约 1672.5 ms。

结论：十几秒体验不能归咎于“270 个文件的目录枚举”。真正问题是首屏刚返回，后台全量哈希、通用原生 preview、专用编辑器读取和可能重复的 workspace analysis 同时争用资源。

### 5.3 精确代码点

- `apps/desktop/src/renderer/src/App.tsx` 中 `mountWorkspace`，约 1996-2007：等待 `workspace.scan` 后才进入工作台。
- `apps/desktop/src/main/ipc.ts` 中 workspace scan handler，约 2915-2991。
- `apps/desktop/src/main/ipc.ts` 中 `startBackgroundWorkspaceIndexing`，约 1816-1947。
- `packages/core/src/workspace/scanWorkspace.ts` 中 `walkDirectory`，约 186-220。
- 同文件 `addIndexedFile`，约 102-175。
- `App.tsx` 中恢复默认选中，约 2034-2044；`selectFile` 约 2254-2297。
- `packages/core/src/preview/openResourcePreview.ts` 中通用 preview/inspect/structured export。
- `ParamWorkbench.tsx` 约 508-535：mount 后列容器 PARAM。

### 5.4 当前实现的正确方向

- 首屏使用 `includeContentHashes:false`。
- 全量索引从同步门移到后台。
- renderer 有更明确的加载状态。

这些方向保留，不要回退成同步全量哈希。

### 5.5 仍存在的正确性缺陷

> **2026-08-27 实测更正：本节原文描述的缺陷已经不存在，照原文动手会打崩整个工作区扫描。动手前必读本框。**
>
> 原文写的是「`addIndexedFile` 在哈希失败的 catch 中仍会 `return`」。实测 `packages/core/src/workspace/scanWorkspace.ts`：
>
> - **hash 失败路径已经是下面「正确语义」规定的样子。** `:140-152` 的 catch 里，非 abort 失败会 `diagnostics.push({severity:'warning', code:'FILE_HASH_FAILED', ...})` 并赋给 `fileDiagnostics`，然后**继续往下走**到 `:155` 的 `files.push({...})`；`sha256` 靠 `:170` 的 `...(sha256 ? { sha256 } : {})` 自然缺省。abort 由 `:143` 的 `if (options.signal?.aborted) throw error;` 单独重抛。这条不需要再改。
> - **`addIndexedFile` 里唯一还留在 catch 中的 `return` 在 `:122`，那是 stat 失败路径（`FILE_STAT_FAILED`），它必须留着。** 弱 agent 按原文去找「catch 里的 return」只会找到 `:122` 这一处，删掉它就是删错地方。
>
> **删掉 `:122` 的实测后果（已用扰动-还原实跑，非推断）：**
>
> `npx tsc -p packages/core/tsconfig.json --noEmit --pretty false` 报 3 条错，全部指向本文件：
>
> ```text
> scanWorkspace.ts(124,8): error TS18048: 'fileStat' is possibly 'undefined'.
> scanWorkspace.ts(167,11): error TS18048: 'fileStat' is possibly 'undefined'.
> scanWorkspace.ts(168,14): error TS18048: 'fileStat' is possibly 'undefined'.
> ```
>
> （这三个是删掉一行后的行号；对应删除前的 `:125` `if (!fileStat.isFile())`、`:168` `size: fileStat.size`、`:169` `mtimeMs: fileStat.mtimeMs`。第一个解引用是 `:125` 的 `isFile()`，不是 `size`。）
>
> **真正的陷阱在这三条错之后。** 让 TS18048 消失最省事的写法是把 `fileStat` 改成 `fileStat!`，或者给它标 `as Stats`。那样 typecheck 转绿，而运行期行为是：任何一个 stat 失败的文件（被占用、权限不足、扫描中被删、symlink 悬空）都会在 `:125` 对 `undefined` 调 `.isFile()` 抛 `TypeError`。
>
> 这个抛出**没有任何兜底**，实测调用链：`walkDirectory:220` 的 `await onFile(absolutePath)` 外面没有 try（该函数只有 `:195` 一个 try，包的是 `readdir`）；`scanWorkspace:30-49` 顶层也没有 try（全文四个 try 分别在 `:113` stat、`:140` hash、`:195` readdir、`:226` `pathIsDirectory`）。所以单个文件 stat 失败会让 `scanWorkspace` 整体 reject，表现是**工作区一个文件都打不开**，而不是少一个文件。
>
> **禁止的三种改法：** ① 删 `:122` 的 `return`；② 用 `fileStat!` / `as Stats` 消掉 TS18048；③ 把 `let fileStat;` 改成 `let fileStat: Stats = {} as Stats` 之类的假初值（那会让坏文件带着 `size: undefined` 进 catalog，把崩溃换成静默脏数据）。
>
> **本节下面的「正确语义」四条仍然是对的规格，保留它作为验收判据；但它描述的是已实现状态，不是待办。** 唯一还没做的是第四条（写回前再现算哈希）——那条属于 Patch Engine 写回路径，不在 `scanWorkspace` 里，别在本文件找。
>
> 未测：`FILE_STAT_FAILED` 与 `FILE_HASH_FAILED` 在真实 Sekiro 工作区里的实际触发频率；full scan 用 `indexedFiles = full.files` 覆盖首屏索引这一步本身有没有别的丢文件路径（本次只测了 `addIndexedFile` 内部）。

正确语义：

- discovery 成功就保留 `IndexedFile`。
- hash 是 enrichment，不是文件存在性的前置条件。
- 非 abort 的 hash 失败应附 `FILE_HASH_FAILED`，`sha256` 缺省。
- 真正写回前再现算哈希；失败时结构化拒绝，不静默写。

### 5.6 下一步实施：增量索引

不要只把全量哈希再延迟 500 ms。应实现持久化 fingerprint 复用。

固定实现契约：

1. 在现有 OperationLog/WorkspaceDataRepository 边界增加按 workspace 读取旧 file catalog 的 API；先用 `rg` 确认当前命名，不新建第二套索引数据库。
2. 首轮 discovery 为每个文件收集metadata投影；持久fingerprint的精确字段以24.4为准（relative path、size、mtime/ctime ns、file identity、path generation和continuity），不要把这里的摘要另做一套schema。
3. 用标准化 `relativePath` 查旧记录。
4. 新文件、任一fingerprint字段变化、Patch Engine/连续watcher事件标dirty，或USN/watcher continuity不可信时重新SHA。
5. 只有24.4 continuity=PROVEN且完整fingerprint相等时复用旧`sha256`。
6. 删除项从新 catalog 中自然消失，但不能因为 hash 失败消失。
7. 后台 hash 每处理有限字节或一个文件后检查 cancellation，并允许前台原生读取提升优先级。
8. 工作区切换时取消旧 session 的 hash；不要等待一个不可取消的旧任务很久。
9. `workspace.analyze` 复用同 session 已生成的 catalog；不要再走一遍 `analyzeWorkspace` 全扫描。
10. 专用编辑器已接管的资源，不要在选中时再跑一次无用的通用 structured preview。通用 prefix 可以保留，重型 inspect/export 应按 editor capability 延迟或复用。

缓存判新鲜不能只依赖path。`workspaceSessionGeneration`只防旧异步提交，不参与warm fingerprint命中；持久fingerprint使用24.4的`fingerprintStoreGeneration + pathSourceGeneration + metadata + continuity`。Patch Engine成功写回必须bump该`pathSourceGeneration`；watcher/USN连续时逐path标dirty，journal gap则全store标UNKNOWN并后台重hash。对等长、恢复时间戳和进程关闭期间写回不能只依赖length+mtime。

### 5.7 启动测试

必须新增自动化测试：

1. 270 文件首屏 scan 不读取任何文件内容。
2. 同目录第二次启动，0 个未变化文件重新 hash。
3. 改 1 个文件，只 hash 1 个。
4. hash 失败的文件仍存在于 live 和 persisted index，并带诊断。
5. 切工作区取消旧 hash。
6. 前台 PARAM/地图/角色请求期间，后台 hash 能让步。
7. `workspace.analyze` 不触发第二份同目录全扫描。
8. 记录以下时间而不是只测总函数：shell 可见、文件列表可见、默认编辑器可操作、后台索引完成。

## 6. PARAM：格式语义诊断

### 6.1 Standard32 的真实行目录

Sekiro 的该家族不是“末行没有行头”，也不是 `[dataEnd,name,id]`。

每个物理行都有 12 字节行头：

```text
[ id: int32, dataOffset: uint32, nameOffset: uint32 ]
```

行目录起点：

- 常规布局：`0x30`
- 扩展头布局：`0x40`

行宽：

- 多行时由相邻 `DataOffset` 差值推导。
- 单行时没有相邻 offset，必须使用可证明的边界或已验证 PARAMDEF 行宽。
- header `0x00` 不是可靠的数据结束边界，不能拿它替代物理 `DataOffset`。

32 位布局当前只开放同一物理行、同宽数据原位覆盖。add/delete、ID 改写、字符串区重排没有真实验证时必须 fail-closed。

### 6.2 Long64 单行的 ParamType 重定位

真实 corpus 中有 7 张单行表保留旧 ParamType 副本，同时 header 指向后面的新副本：

- `DyingEffectParam`
- `EnemyCommonParam`
- `EquipParamAccessory`
- `GameSystemParam`
- `GraphicsParam`
- `MenuParam`
- `TentativePlayerParam`

例：`DyingEffectParam`

- firstData = 88
- 真实 row width = 32
- 旧 ParamType 从 120 开始
- 新 ParamType 从 142 开始

如果直接用新 ParamTypeOffset - firstData，会把旧类型字符串吞进行数据。正确策略：

1. 无 hint 且检测到旧副本时，返回 `PARAM_ROW_SIZE_REQUIRED`。
2. `headerOnly` 只读取 typeName + dataVersion。
3. main 从已校验 metadata package 中按 typeName + dataVersion 找唯一 row width。
4. 带 `expectedRowDataSize` 重读。
5. no-op rebuild 必须保留原文件中的旧/新两份字符串和未知 gap，确保 byte-identical。

### 6.3 停止前刚落下的未验证修改

下一位 agent 必须先检查这些改动是否编译：

- `ParamNativeDocument.Read` 现在把 `expectedRowDataSize` 传给 `ReadStandard32`。
- Standard32 多行会核对 PARAMDEF width 与相邻 offset；单行可使用 hint。
- `readParamDocumentWithMetadata` 的 header DTO 加入 `dataVersion`。
- helper 改为按 `candidate.document.typeName + candidate.document.version` 选择 row width；只有唯一 width 才重试。
- 容器 page/index/metadata/full 四个原先直连 `runBridge('read-param-document')` 的入口已改走 helper。
- ParamWorkbench -> App -> preload -> main 的容器字段、行名、行级写回加入 `expectedRowDataSize`。
- core `paramBridgeCommit` 支持把可选 `expectedRowDataSize` 送入 writer。
- `runParamFieldWriteMatrixSmoke.ts` 新增两个相同 ID 的 Standard32 synthetic：id-only 写应拒绝，rowIndex+hash 写第二行只改第二行。

这些改动之后没有跑过任何构建，先验证再继续。

## 7. PARAM：性能与数据生命周期诊断

### 7.1 大表本身并不慢

内存基线：

`AtkParam_Npc`

- 4090 行
- row width 464
- 文件约 2,027,531 bytes
- Read median 约 1.234 ms
- Verify 约 4.373 ms
- 完整索引 envelope+JSON 约 10.354 ms
- 20 行 envelope 约 1.174 ms

`SpEffectParam`

- 7790 行
- 文件约 8,824,847 bytes
- Read 约 12.058 ms
- Verify 约 19.972 ms
- 索引 JSON 约 19.552 ms

结论：裸 PARAM 解析不是“读取行数据……”长时间停住的主因。主因是容器目录命令过重、重复解包/解析、跨进程全量 JSON、每页请求不复用 parsed session。

### 7.2 容器列表用了错误级别的命令

`apps/desktop/src/main/ipc.ts` 的 `resource.listContainerParams` 仍调用通用 `read-dcx-document`。

`read-dcx-document` 不只是列 BND 条目。它还进行 DCX/BND round-trip、no-op rebuild、CRUD/字段保留/layout guard 等验证。这些应该用于 validate/smoke，不该成为 UI 左栏热路径。

真实测量：

- mods DFLT gameparam：重型命令 median 约 425.01 ms。
- 直接使用 `Bnd4NativeWriter.GetCachedBinder`：cold 约 24.55 ms，warm 约 0.18 ms。
- 原版 KRAK：重型命令约 129.72 ms；轻量 cold 约 21.45 ms，warm 约 0.15 ms。

待实施：新增轻量 production command，名称固定为 `list-bnd4-entries`。

它只应返回：

- entry index/id/name/size
- container/source identity
- 必要的格式/诊断

默认 `includeContentHashes:false`，不得为显示左栏遍历并哈希全部 child。`extract-bnd4-child` 对实际选择的 child 计算/返回 content hash；若显式 validate 命令请求全量 hash，必须与 UI 热路径分开。

它不应执行 no-op rebuild、CRUD probe 或 layout validation。`extract-bnd4-child` 应与它复用同一 Binder cache/session。

完成判据不是“接口存在”，而是同一容器的 `list -> extract -> second list` 只发生一次 DCX inflate/BND parse。counter 必须在 C# DCX inflate 和 BND parse 的真实入口递增，并输出session、`workspaceSessionGeneration`、`pathSourceGeneration`、correlation id；TypeScript `runBridge`调用数不能冒充native parse count。断言cold为1、同source hash/`pathSourceGeneration`的warm仍为1、Patch Engine bump该path后下一次变为2。只在main缓存listing JSON不合格。

### 7.3 每页请求仍重复解析全表

当前 renderer 已经做对了一半：

- 首次只请求完整 id/name 索引。
- 本地搜索。
- 虚拟滚动。
- 选中行时取 20 行 payload 页。
- metadata 独立异步加载。

但 Bridge 每次页请求仍可能：

```text
ReadAllBytes -> parse entire PARAM -> VerifyRoundTrip -> serialize rows -> main 裁页
```

正确方案：复用 EMEVD session 的生命周期模式，在 Bridge 内为现有 `read-param-document` 权威解析增加 Param document session；不要复制 EMEVD 解析器，也不要在 main 新建第二套 native document。

session key 固定包含：

```text
workspace persistent identity + canonical source identity + container entry identity
+ sourceHash + pathSourceGeneration + metadata layout identity
```

production `runBridge` 当前按 workspace/root 复用单个 NDJSON daemon，但 daemon 内 `maxConcurrency=2`。session token是随机opaque id，不编码路径；server entry绑定daemon/source key，多workspace/window identity存在各自owner lease。page请求按24.6核对persistent identity、`workspaceSessionGeneration`、window、purpose和`pathSourceGeneration`，只读同一不可变native document并支持并发。daemon重启、LRU eviction、workspace dispose或source hash/`pathSourceGeneration`变化后返回精确expired/stale code，main只允许显式reopen一次，不能无限透明重试。缓存设置明确entry/byte budget、idle TTL和close/dispose，不允许无界static dictionary。

外部投影固定为：

- index projection：只返回 rowIndex/id/name，协议默认 `includeRowHashes:false`，调用方不传参数时也不得带 hash。
- page projection：按物理 rowIndex/page 返回请求行 bytes + dataHash，不序列化页外行。
- full/validate projection：仅供显式验证或确有需要的完整读取，不进入滚动、选择或翻页热路径。

首次创建 session 时执行一次 native structural validation；byte-identical/no-op 验证由真实 smoke 显式执行。翻页不得重复任一全表验证。parse counter 固定放在 C# `ParamNativeDocument.Read`/实际 parser 入口，validate counter 放在 structural validation 入口，serialized-row counter 放在 Bridge page DTO 构造处；都输出session token、owner lease、`workspaceSessionGeneration/pathSourceGeneration`和correlation id。一次 open + N 次 page 必须为 parse=1、structuralValidation=1、每次 serializedRows<=pageSize；close/evict/stale-token 事件也进入 trace。只观察 UI 变快或只数 main cache hit 不算通过。

### 7.4 索引里的 dataHash 浪费近一半 JSON

真实 payload：

- `AtkParam_Npc`：带 hash 634,477 B；不带 315,457 B，减少 50.3%。
- `SpEffectParam`：带 hash 1,345,043 B；不带 737,423 B，减少 45.2%。

写回只需要当前页/当前行 hash。因此：

- index DTO 的 hash 应可选，默认 `includeRowHashes:false`。
- page DTO 必须带每行 dataHash。
- renderer 在页合并时补 hash。
- 没有 page payload/hash 的行不得提交写回。

### 7.5 payload omitted 会形成重试风暴

`ParamWorkbench.tsx` 的选中页 effect 目前以 `loadedRows[selectedRowIndex]?.dataBase64` 作为“是否加载过”的唯一判断。

如果 Bridge 正确返回 `payloadsIncluded=false`，行仍无 `dataBase64`，effect 因 `loadedRows` 更新会再次触发，反复请求同页。

修复：维护 page request state：

```text
idle | loading | loaded | omitted | failed
```

key 至少包含：container hash + entry index + page + page size。`omitted/failed` 不自动重试；只在用户显式 retry、资源 hash 变化或表重开后重试。

## 8. PARAM：重复 ID 和 CSV 必须收口

### 8.1 为什么 ID 不能作为行主键

真实 corpus 有 10 张表、26 组重复 ID。PARAM 的 ID 是语义字段，不保证全局唯一。编辑器必须把物理 rowIndex 作为 UI identity，并用 dataHash 做并发保护。

正确写回标识：

```text
rowIndex + expected id + expectedDataHash
```

规则：

- 有 rowIndex：检查范围、当前位置 id、hash，然后写该物理行。
- 无 rowIndex：只有该 id 在表内唯一时才允许兼容。
- 无 rowIndex 且 id 重复：结构化拒绝，不能默认第一个或最后一个。

### 8.2 当前剩余的静默错误

`apps/desktop/src/main/ipc.ts` 约 8554 和 8742 仍有：

```ts
new Map(full.rows.map((row) => [row.id, row]))
```

这会把重复 ID 折叠为最后一个物理行。

`packages/core/src/param/containerParamEdit.ts` 也有按 `Map<number,...>` 聚合行的逻辑，必须一起审计。

### 8.3 CSV 的正确兼容设计

新导出格式应显式包含物理身份：

```csv
rowIndex,id,name,<field ids...>
```

导入规则：

1. 新 CSV 有 rowIndex：按 rowIndex 找物理行，再核对 id；写 mutation 时带 rowIndex + expectedDataHash。
2. 旧 CSV 只有 id：如果该 id 唯一，允许兼容；如果重复，整条记录结构化拒绝并告诉用户重新导出带 rowIndex 的 CSV。
3. 不得把 occurrence 临时顺序猜成 identity，除非格式明确存了 occurrence 并核对当前表没有结构变化。
4. 行名导入和字段导入都使用同一规则。
5. 批量 mutation 经过 Patch Engine，不能旁路写文件。

### 8.4 必须补的 PARAM 回归

Bridge/synthetic：

1. Standard32 `0x30` 和扩展 `0x40` 行目录。
2. 两个相同 ID、不同 payload：id-only mutation 拒绝。
3. 指定第二行 rowIndex+hash，只改第二行。
4. hash 不符拒绝。
5. 7 张 relocated ParamType 单行：无 hint 返回 `PARAM_ROW_SIZE_REQUIRED`；headerOnly 给 type/version；带 width no-op byte-identical；字段写回只改真实 row bytes。
6. writer 重读必须继续带 width hint。

Renderer：

1. 4090 行只发一次 index 请求。
2. metadata 慢时行列表先出现。
3. DOM 行节点有界。
4. 搜索、滚动不发 IPC。
5. 选中行只请求所在 20 行页。
6. payload omitted 不无限重试。
7. 两个同 ID 可分别选中、高亮和写回。

CSV：

1. 两个同 ID 完整 export/import round-trip 不折叠。
2. 旧 id-only CSV 遇重复 ID 结构化拒绝。

## 9. 地图尖刺：32 位误解已由历史差分证实，但当前 production 仍未修复

### 9.1 根因

冻结production的旧多mesh合并路径仍把所有FLVER index buffer当作`Uint16`。真实FLVER FaceSet可以使用16位或32位索引。32位字节流被拆成两个16位值后，会生成错误的远距离顶点引用，表现就是贯穿地图的放射长三角、尖刺和射线。另有已审出的FaceSet静默fallback、EdgeCompressed无诊断、CullBackfaces丢失和缺index bounds验证；它们也必须按24.9失败关闭，不能因32位主样本已解释就忽略。当前restart的`vertexCount < 65535`判断本身匹配成熟实现，保留并纳入rule/golden boundary test，不准“修”成永远启用或永远禁用。

这不是相机 near/far、剔除距离或材质问题。隐藏异常面、限制距离、改线框都属于掩盖。

### 9.2 当前正确实现方向

`apps/desktop/src/main/mapMeshGeometry.ts`的`decodeIndices/mergeMapMeshGeometry`存在按`indexSize`解码、按mesh vertex base重定位并升级Uint32的oracle/helper方向，但冻结renderer仍从旧production API取完整payload；helper正确不等于最终链路正确。

`apps/desktop/src/renderer/src/scene/modelResourcePool.ts` 也按 indexSize 创建 Three BufferAttribute。

Bridge中已有若干实现尝试：

- triangle list
- triangle strip 展开
- primitive restart
- winding/degenerate 处理
- 16/32 位索引

### 9.3 真实差分证据

`m10_00_00_00_000010.flver` 与本机 Smithbox/Andre.SoulsFormats 行为 oracle 差分：

- 3171 个 position float，0 mismatch。
- 5316 个 triangle-list index，0 mismatch。
- 0 越界。
- maxIndex = 1056。
- vertexCount = 1057。

最大 7 个模型、26 mesh 差分：

- 2,016,825 个 position 值全部一致。
- 2,336,949 个 index 全部一致。
- 0 mismatch。

抽样 179 个 m10 mapbnd 未见 strip。strip 支持仍必须保留，但该地图尖刺的主因是 32 位索引误解。

这些尝试尚未按24.9规则registry/streaming cursor接入production，并且当前`read-map-static-geometry`不可达。上述真实差分是历史诊断，不是冻结实现的G4证据。

### 9.4 下一位 agent 的正确动作

不要重新“试矩阵”或调坐标。先按24.9把FaceSet选择、source index位宽、restart/winding与bounds fail-closed，再按24.10将流式static route贯穿Bridge→main→preload→renderer并让旧API不可达。验收硬条件：每个mesh所有source/local index均在界内、chunk重组与Andre差分0 mismatch，且真实canvas满足16.6.1；仅helper差分通过不算。

## 10. 地图加载慢：真正瓶颈是 DTO、IPC 和资源生命周期

### 10.1 真实 m10 全量测量

`m10_00_00_00`：

- MSB model 总数 864。
- type 0 map piece：499。
- type 1 object：180。
- type 2 character：39。
- type 5 collision：146。
- parts 总数约 7404。

对 499 个 type-0 模型做只读扫描：

- 成功 481。
- 18 个为缺文件、非 FLVER 容器或 overlay 失败。
- 并发 8、Bridge frame 32 MiB，总 wall time 14.674 s。
- 3050 meshes。
- 10,888,812 vertices。
- 单模型 P50 约 122 ms。
- P90 约 426 ms。
- P99 约 501 ms。

Bridge JSON 总量约 903,769,757 bytes：

- 实际静态几何 base64 约 554,448,048 chars。
- 地图 viewport 不消费的 boneWeights/boneIndices 约 348,449,648 chars，占约 38.6%。

最大 `m10_00_00_00_002021.mapbnd.dcx`：

- 25 meshes。
- 完整 JSON 19,888,380 bytes。
- 默认 16 MiB Bridge frame 稳定返回 `BRIDGE_OUTBOUND_FRAME_TOO_LARGE`。
- 去掉地图不需要的 skin 数据后，静态几何约 12,406,112 chars，低于 16 MiB。

结论：不能只把 frame limit 从 16 MiB 调到 32 MiB。正确修复是地图静态投影不构建、不传输蒙皮和骨架。

### 10.2 精确重复数据链

`BridgeCommandService.cs` 的 `read-map-part-flver-preview` 路径仍调用通用 `BuildFlverMeshBundle`，它会计算并返回：

- boneWeights
- boneIndices
- bones/skeleton
- 原始 per-mesh payload

`apps/desktop/src/main/ipc.ts` 的 `resource.readMapPartMesh` 随后又把 `raw.data` spread 到结果，同时追加 `mergeMapMeshGeometry(meshes)` 的合并 base64。

因此 Electron IPC 同时携带：原 meshes + bones + 合并 geometry。renderer 实际只消费合并字段。

### 10.3 必须新增地图专用 DTO

固定新增 Bridge command `read-map-static-geometry`，定义 renderer-independent static payload，不复用角色 FLVER preview DTO：

```ts
interface MapStaticGeometryPage {
  sessionToken: string;
  cursorToken: string;
  nextCursorToken: string|null;
  complete: boolean;
  chunks: []|[MapStaticGeometryChunk];
}

interface MapStaticGeometryChunk {
  chunkId: string;
  resourceCacheKeySha256: string;       // 必须等于24.12完整ResourceCacheKeyV1 canonical SHA
  meshOrdinal: number;
  materialIndex: number;
  modelLocalTransformSha256: string;
  selectedFaceSetOrdinals: number[];
  faceSetTriangleSpans: Array<{faceSetOrdinal:number;ruleId:string;firstTriangleInChunk:number;triangleCount:number;firstTriangleInFaceSet:number}>;
  sourceTriangleStart: number;
  triangleCount: number;
  vertexCount: number;
  positionsBase64: string;
  localIndicesBase64: string;
  sourceVertexIndicesBase64: string;
  localIndexElementBytes: 2;
  sourceVertexIndexElementBytes: 4;
  normalsBase64?: string;
  uv0Base64?: string;
  localBounds: { min: [number, number, number]; max: [number, number, number] };
  coordinateSpaceId: string;
  mapCoordinateContractPayloadSha256: string;
  rawContentSha256: string;
}
```

上面只展示诊断章节需要的字段轮廓；24.10的`MapStaticChunkV1`、NDJSON framing、owner/session/cursor状态与little-endian规则是唯一施工schema，禁止把这里的简写另建第二套DTO。

map session/cursor token都是随机opaque id；daemon侧record按24.10绑定daemon、owner/window/persistent workspace+session、source hash/`pathSourceGeneration`、完整resource cache key、meshPlan与不可变decoder state。token本身不编码triangle ordinal或路径。重复cursor返回相同payload hash，跨session、乱序、伪造或过期cursor结构化拒绝；daemon crash后旧token不得在新进程误命中。session使用byte budget/TTL/cancellation，不能为了499个模型把全部解包文档永久留在C# heap。

Bridge 的静态地图路径：

1. 解析 FLVER 一次。
2. 不调用 `GetMeshSkinning`。
3. 不构建 skeleton/bones。
4. 只输出 positions/indices/normals/uv/material group/bounds。
5. 使用 `MapStaticGeometryPage` 的 session + cursor pull 协议；每个序列化后的完整 JSON response frame 必须小于 8 MiB，应用默认 Bridge outbound limit 继续锁定为 16 MiB。
6. chunk边界只切在完整三角形之间，indices重映射为chunk-local dense uint16；`sourceVertexIndicesBase64`固定uint32 LE，保存local vertex→原mesh vertex index，使测试能按`sourceTriangleStart`重组并与oracle完全差分。source FaceSet的16/32位是单独metadata，旧`indexSize/indexElementBytes`含混字段直接拒绝。没有remap就不得声称分块语义相同；把一个base64字符串切字段不算chunking。
7. main 不再 `{...raw.data}`，也不再调用 production `mergeMapMeshGeometry(meshes)`；只验证并转发 static page/chunk。
8. renderer 每收到一个 chunk 就可解码/上传，不能等待整模型所有 chunk 到齐后再开始。
9. session 在完成、取消、超时、工作区切换和 Bridge 崩溃时均可释放；失败只保留小诊断。

Bridge 测试必须直接计数并断言 `GetMeshSkinning=0`、skeleton build=0、FLVER parse=1。DTO schema 测试必须拒绝 bones、boneWeights、boneIndices、原始 `meshes` 和绝对路径字段。只在 main 删除这些字段而 Bridge 仍计算，不算通过。

渐进生成的内存契约也必须计数：session可持有一次native FLVER document，但不得预先构造全模型flattened arrays/DTO/base64/chunks。每次cursor request只从24.9 decoder当前状态投影一个triangle window，response写出后释放编码buffer。native telemetry必须证明`encodedChunksResident<=1`、`peakEncodedWireBytes<2*MAX_STATIC_TRANSPORT_BYTES_EXCLUSIVE`；多页resource要求`firstChunkResponseAt < finalChunkBuildStartedAt`，单页resource只检查预算，地图级要求first GPU geometry早于all-resources complete。测试以m002021和全量m10观察working set/GC；首response前出现全模型JSON/indices数组即`EAGER_WIRE_MATERIALIZATION`。

### 10.4 wire payload 和 GPU payload 现在双份常驻

`mapModelLoadScheduler.ts` 中 `MapModelLoadCache` 把 resolved base64 geometry 长期保存。

`modelResourcePool.ts` 同时保留 GPU `BufferGeometry`。

结果是数百 MiB wire payload 与 GPU buffer 双份驻留，持续制造 GC 压力。

正确生命周期：

- in-flight cache：只在请求进行中去重 Promise。
- GPU resource pool：上传成功后按 model/content hash 持有 geometry/material/refcount。
- wire payload：上传成功立即释放。
- failure cache：只保留小型结构化诊断和退避时间，不保留大 payload。
- 场景关闭/工作区切换：释放 refcount 为 0 的 GPU 资源、取消 pending 请求和 frame tasks。

内存验收使用 Playwright 所连 Chromium 的 CDP `HeapProfiler.collectGarbage` 两次并 `takeHeapSnapshot`。每个 wire envelope 带小型 `wirePayloadId/contentHash` 供 trace；上传完成后 snapshot 中不得再有 completed id 的 envelope，也不得有从 scheduler cache、React state、resolved Promise、闭包或 failure cache 经 `positionsBase64/indicesBase64` 属性边可达的大字符串。报告输出 retained type、bytes 和完整 retainer path；只看一个 Map 的 size 或只调一次 `gc()` 不合格。允许 pending chunk 存在，但 completed retained wire 总量仍受第 17.3 节 `32 MiB` 上限。

当前 `FrameTaskQueue` 每帧约 6 ms 只会在任务之间让步。如果一个任务内部同步 decode/upload 12 MiB，它仍会造成长帧。固定实现为：base64 decode/typed-array validation 在 renderer worker 完成并以 transferable ArrayBuffer 返回；renderer thread 每个 queue task 只创建/上传一个有界 geometry chunk。若单 chunk 的 GPU upload P95 仍超过 6 ms，Bridge chunk byte budget 继续减小；禁止只改队列预算或把同步 decode 包进一个 task。

## 11. 地图资源路由必须按 MSB model type

当前 preload 的 `readMapPartMesh(msbUri, modelName)` 不传 model type，main 只查：

```text
map/<mapId>/<model>.mapbnd.dcx
```

这只覆盖 type 0 map piece。

正确请求必须显式携带 `modelType` 或 `resourceKind`，不要从名字猜：

| MSB model type | 前缀示例 | 正确资源 |
|---|---|---|
| 0 map piece | `m*` | `map/<mapId>/<longName>.mapbnd.dcx` |
| 1 object | `o*` | `obj/<model>.objbnd.dcx` |
| 2 character | `c*` | `chr/<model>.chrbnd.dcx` |
| 5 collision | `h*` | HKXBHD/HKXBDT collision 投影 |

真实存在：

- `obj/o000100.objbnd.dcx`
- `chr/c1000.chrbnd.dcx`

路由验收锁定如下：

- type 0：枚举 m10 的全部 499 个模型；成功项必须走 mapbnd 静态 FLVER，失败的 18 项逐一归类为缺文件、容器无 FLVER、overlay 失败或其他精确诊断，禁止静默过滤。
- type 1：至少用真实 `o000100` 证明 objbnd 内 FLVER 可进入同一静态几何协议；真实资源存在时返回统一 `UNSUPPORTED` 是失败。
- type 2：至少用真实 `c1000` 证明 chrbnd 的地图静态投影可用；此处只做地图实体静态几何，不复用 TAE 角色装配状态。
- type 5：在可信 HKX collision renderer 完成前返回专属 `COLLISION_PROJECTION_UNAVAILABLE`，响应必须保留 model identity/source URI/诊断；不得标为 FLVER parse failure，也不得画 proxy 后声称是真实碰撞。
- 未知 model type：返回包含原始数值的 `MSB_MODEL_TYPE_UNSUPPORTED`，不得按名称前缀猜资源目录。

请求去重 key 必须是24.12完整`ResourceCacheKeyV1`canonical SHA，包含map/model type、resource edge/source/entry、overlay+path source generation、model-local和格式/坐标规则；同名不同类型不得碰撞。

shared diagnostic registry 固定区分：

```text
MAP_MODEL_SOURCE_MISSING
MAP_MODEL_CONTAINER_NO_RENDERABLE_FLVER
MAP_MODEL_OVERLAY_RESOLUTION_FAILED
MAP_MODEL_NATIVE_PARSE_FAILED
COLLISION_PROJECTION_UNAVAILABLE
MSB_MODEL_TYPE_UNSUPPORTED
```

manifest 为每个 m10 model identity 记录成熟 oracle 是否存在可渲染几何和唯一预期 outcome。oracle 能成功读取几何的 identity 只允许 `loaded`；任何 diagnostic 都使 G4 失败。只有 oracle 同样确认源缺失/无 renderable FLVER 的 identity 才允许前两种 unavailable outcome。`OVERLAY_RESOLUTION_FAILED` 和 `NATIVE_PARSE_FAILED` 永远是待修失败，不得因为“已分类”变为 PASS。type 1 `o000100`、type 2 `c1000` 固定 expected=`loaded`；type 5 才允许 `COLLISION_PROJECTION_UNAVAILABLE`。

`m003000/m003001.mapbnd.dcx` 只含 HKX 时，应返回结构化 unavailable/collision diagnostic，不能把它伪装成 FLVER 失败或偷偷画 proxy 当“真实地图”。

旧 API `readMapPartFlverPreview` 和新 API `readMapPartMesh` 并存。完成新 typed route 后，从 production preload surface、main handler、Bridge advertisement 和所有 production 调用点删除旧 API/DTO/command；若 oracle 测试需要旧转换逻辑，只能保留为不可从 renderer/IPC 到达的 test helper。

## 12. 地图加载完成后卡：先测 draw，再做空间组织

当前相同模型使用 `InstancedMesh` 是正确方向，不要回退成每个 part 一个 `Mesh`。

必须先记录每帧：

- draw calls
- rendered triangles
- visible instance count
- CPU render/update ms
- GPU frame ms
- raycast ms
- semantic React commit count

一个潜在的二级问题是：同一模型的所有 instance 如果放在覆盖整张地图的单个 `InstancedMesh`，整体 bounding sphere 可能始终与视锥相交，导致远处 instance 也参与绘制。只有指标确认后，再按空间 cell 拆 instance batch；geometry/material 仍共享，不复制 GPU 顶点数据。

推荐空间组织：

- 按 map block 或固定世界空间 cell 聚类。
- 每个 model+cell 一个 instance batch。
- bounds/raycast broadphase 使用 cell BVH 或网格索引。
- 精确选择在 broadphase 后才做三角/instance 检测。

不要为了帧率减少实体数量或默认隐藏类别。collision 未实现时可以结构化显示“未加载碰撞投影”，但不能谎称地图已完整显示。

## 13. Gizmo 几乎不可用：存在确定性 scene-parent 错误

### 13.1 根因

`threeSceneController.ts` 的 `addInstanceBatch` 为每个 placement 建立 `Object3D target`，但只把 `InstancedMesh` 加入 root，target 没有加入 scene graph，因此 `target.parent === null`。

`setSelected`/TransformControls 初始化后直接：

```ts
transformControls.attach(target)
```

Three.js `TransformControls` 在 pointerDown 会无条件调用：

```ts
this.object.parent.updateMatrixWorld()
```

因此拖拽起始确定性异常。这不是“大地图太慢导致偶发手感差”，而是对象生命周期契约错误。

### 13.2 正确修复

不要把 7404 个空 target 全挂入 root，避免增加每帧 scene traversal。

固定实现一个 selection-target 生命周期 helper，不新增第二层 anchor：

1. 选择 instance 时，先 detach controls 并从旧 batch root 移除旧 `binding.target`。
2. 从semantic authority经冻结adapter得到MSB placement矩阵`P`并只分解`P`；instance matrix是`P*N`，合法时可能含shear，禁止直接分解。
3. 把当前且仅当前 `binding.target` 直接 `batch.root.add(target)`，使 target 与对应 `InstancedMesh` 共享同一个 parent/坐标空间。
4. `TransformControls.attach` 前断言 `target.parent === batch.root`；断言失败返回结构化内部诊断，不继续 pointerDown。
5. 切换选择、clear、dispose、工作区切换都调用同一个 detach/remove helper；旧 target 最终必须 `parent === null`。
6. TransformControls 异步模块晚到时，比较workspace session、`selectionGeneration + sceneGeneration + rendererContextGeneration + resourceCacheKeySha256 + controlsEpoch + target identity`，只attach当前tuple，过期Promise不得复活旧选择。
7. `dragging-changed=true` 禁用 orbit controls，并在 pointer pick 路径锁住当前 selection。
8. `objectChange`把target的batch-root-local placement矩阵`P'`逐binding右乘其immutable`N`后写成instance matrix`P'*N`，事务性更新bounds/spatial revisions；不得触发全场React state或Patch mutation。
9. `dragging-changed=false` 恢复 orbit controls，并只提交一次最终 transform 到 renderer-independent semantic document；保存仍走现有 mutation/Patch Engine。
10. 无论batch root是否有平移、旋转和非均匀缩放，`P`的semantic往返及每个完整`P*N` instance matrix都必须保持；禁止把world matrix当local matrix或丢掉N。

### 13.3 必须补真实交互测试

现有 source regex 测试抓不到这个 bug。以下完整序列必须全部覆盖：

```text
select instance
-> assert attached object.parent != null
-> pointerdown on gizmo
-> objectChange several times
-> pointerup / dragging false
-> instance matrix changed smoothly
-> semantic part transform changed once
-> orbit control re-enabled
-> selection unchanged
```

再覆盖：加载中选择、模型上传后保持选择、切换选择、删除/clear、异步 TransformControls 初始化、旋转和缩放。

## 14. 角色/TAE：当前多骨架设计是错误契约

### 14.1 现状错误

当前动作预览仍大致执行：

```text
每个 body part 建自己的 skeleton
每帧对每个 part 做 HKX -> part FLVER retarget
每个 part 独立更新 pose
```

这会把同一个角色拆成多个独立坐标/骨架空间。错误部件可能缩在原点，用户只看到一团黄色关节；隐藏骨架只能隐藏症状，不能修复身体。

### 14.2 正确契约：单一 leader skeleton

以角色主 chrbnd 的 `c0000` skeleton 作为 leader：

1. 只输出一份 leader bones、bind matrices 和 inverse bind matrices。
2. 对每个 body part 的 FLVER skin index：
   - part bone index -> part bone name
   - exact bone name -> leader bone index
   - 重写 boneIndices 到 leader index space
3. 所有 body mesh 的 `skeletonId` 指向 leader model id。
4. HKX pose 每帧只 retarget 到 leader 一次。
5. 所有 part mesh 共享同一个 Three `Skeleton`/bone texture。
6. 正权重 influence 找不到 leader bone 时 fail-closed，并报告 part/mesh/vertex/bone name；不能映到 bone 0。
7. 零权重槽位的无效 index 可以忽略，但不能把正权重缺失静默吞掉。
8. FLVER bone local matrix必须使用24.16锁定的SoulsFormats行向量到Three列向量转换；禁止因为XML写着“XZY”就直接调用`Euler(...,"XZY")`或组合`qx*qz*qy`。**正确值是四元数`qy⊗qz⊗qx`、Three order字符串`'YZX'`（实测three@0.172.0六个order全枚举后唯一命中，不是推导）；`'YZX'`不在`threeSceneController.ts:152`的类型union里，四个改动点必须一次改全。禁止把这条读成“只要不写XZY就行”——另有两个已在仓库里的错误约定（`qx⊗qz⊗qy`、`qy⊗qx⊗qz`）同样不满足本条。完整清单见§24.16.1。**

“同名”不自动证明 bind space 相同。装配时还必须：

- 由各自 FLVER hierarchy 计算 part/leader 同名骨骼的 bind-world matrix，重复名称为 ambiguous 并拒绝。
- 对每个正权重映射计算候选 `partToLeader_i = leaderBindWorld * inverse(partBindWorld)`；同一body part所有候选必须在矩阵元素absolute error `<=1e-4`内收敛到同一个刚性/仿射 correction。identity只是常见特例，不是先验要求。若不收敛，不能直接套leader inverse，也不能调一个全局缩放；先按成熟工具/格式证据判定它是attachment还是需要不同shader契约。
- 每个 SkinnedMesh 使用该part的统一 `partToLeaderBind` 作为明确mesh/root bind transform及其inverse，但共享leader `Skeleton`/bone texture和leader boneInverses。
- CPU bind-pose skin 后的位置必须回到原 raw vertex，最大误差 `<= max(1e-5, modelAabbDiagonal*1e-5)`；动画 CPU/GPU 再做第 16.7 节对比。

这组断言防止“索引按名改了，但 inverse bind 仍来自错误 part skeleton”的第二种原点团/爆炸问题。

### 14.3 真实 c0000 证据

本次真实 context 恰好解析出四个 body part + leader；“四个”是语料观测，不是 production slot 常量：

- leader bones：467。
- meshes：54。
- vertices：122,071。
- 所有正权重使用骨骼按名称映射到 leader：0 missing、0 ambiguous、0 out-of-range。
- 正权重骨骼 union：113。
- 113/113 都能映射到 `a000_000010` HKX。

真实 CPU skin smoke：

- unmapped influence = 0。
- non-finite vertex = 0。
- bind raw extent 约 `[1.378, 1.812, 0.457]`。
- 动画中点 extent 约 `[2.94, 2.30, 2.75]`。

验收同时使用通用不变量和样本 oracle：全部顶点 finite；所有正权重和为有效值；动画/绑定 AABB 对角线比值落在 `[0.1, 10]`；`c0000` 的 bind/中点 extent 分别落在上述实测值的 `+-25%` 区间。容差只存在于测试，不得进入 production 分支。使用 `<1e9` 一类无意义上限不合格。

### 14.4 删除目录猜测装配

`discoverDefaultCharacterPartPaths()` 当前会扫描目录并猜：

- `am9000`
- `bd9000/9040`
- `fc0210`
- `hd9510`
- `lg9000`
- `wp_a0300`

这不是正确角色装配上下文。

问题：

- `hd_m_9510` 的正权重骨骼含 leader 不存在的 `HD_L/R_*`。
- `wp_a_0300` 使用 `Blade01/Sheath01/Sheath_master` 等 weapon attachment 骨骼，不应作为 body part 直接并入 body skeleton。
- TAE/chrbnd 本身不包含完整 CharaInit/equipment preset。

固定定义 shared/core 中的 URI-based `CharacterAssemblyContext`。下面只是诊断章节里的**必需语义子集**，不是允许另建的第二套 wire schema；production 必须直接使用 24.15/24.18 的完整 selection、source/entry identity、generation 和 conversion 字段。字段名可按现有协议命名调整，但语义不得缺失：

```ts
type AssemblyProvenance =
  | {
      kind: "param-field";
      paramUri: ResourceUri;
      table: string;
      rowIndex: number;
      fieldId: string;
      paramSourceContentSha256: string;
      paramEntryIdentitySha256: string;
      paramPathSourceGeneration: number;
      paramOverlayResolutionGeneration: number;
      expectedDataHash: string;
    }
  | {
      kind: "explicit-selection";
      selectionEventId: string;
      selectionNonceSha256: string;       // 只保存已由main消费验证后的hash，不传raw nonce
      selectedResourceUri: ResourceUri;
      selectedSourceContentSha256: string;
      selectedEntryIdentity: string;
      selectedPathSourceGeneration: number;
      selectedOverlayResolutionGeneration: number;
      selectionRevision: number;
      consumedPurpose: "leader"|"attachment"|"animation"|"skeleton"|"param-row";
    }
  | {
      kind: "resource-graph-edge";
      edgeId: string;
      relation: "character-model" | "animation-skeleton";
      fromResourceUri: ResourceUri;
      resolverRuleHash: string;
      resolvedSourceContentSha256: string;
      resolvedEntryIdentitySha256: string;
      resolvedPathSourceGeneration: number;
      overlayResolutionGeneration: number;
    };

interface CharacterAssemblyContext {
  workspacePersistentIdentityHash: string;
  workspaceSessionId: string;
  workspaceSessionGeneration: number;
  contextIdentitySha256: string;
  leaderModelUri: ResourceUri;
  leaderProvenance: AssemblyProvenance;
  bodyParts: Array<{
    slot: string;
    resourceUri: ResourceUri;
    provenance: AssemblyProvenance;
  }>;
  attachments: Array<{
    resourceUri: ResourceUri;
    attachBoneName: string;
    provenance: AssemblyProvenance;
  }>;
}

interface AnimationPlaybackContext {
  workspacePersistentIdentityHash: string;
  workspaceSessionId: string;
  workspaceSessionGeneration: number;
  animationContainerUri: ResourceUri;
  animationSourceContentSha256: string;
  animationPathSourceGeneration: number;
  animationOverlayResolutionGeneration: number;
  animationEntryIdentitySha256: string;
  skeletonContainerUri: ResourceUri;
  skeletonSourceContentSha256: string;
  skeletonPathSourceGeneration: number;
  skeletonOverlayResolutionGeneration: number;
  skeletonEntryIdentitySha256: string;
  typedAnimationId: number;
  actionPhysicalBindingIdentitySha256: string;
  animationProvenance: AssemblyProvenance;
  skeletonProvenance: AssemblyProvenance;
  sourceCoordinateSpaceId: string;
  outputCoordinateSpaceId: string;
  conversionRuleVersion: string;
  conversionRuleSha256: string;
  unitScaleFloat64BitsHex: string;
}
```

固定数据流：

1. core/main 从 CharaInitParam/equipment PARAM 的已验证物理行字段或真实 UI 选择事件构建 context；每个 URI 带上面可核查的 provenance。自动打开 c0000 时必须能追到具体 paramUri/table/rowIndex/fieldId/hash；不得把硬编码 URI 包装成 provenance，也不得以目录中“存在什么”反推装备。
2. main 在资源图中解析 URI；renderer 不接触绝对路径，Bridge 不扫描邻居。
3. FromSoftware parts 命名规则只用于把已有 model id 解析为资源名，例如 `<PREFIX>_<GENDER>_<equipModelId:D4>.partsbnd.dcx`，不能用来猜 model id。
4. renderer-independent 语义层把每个 body part 的正权重 bone index 按 exact bone name 重映射到 leader index，生成单 leader bundle。
5. weapon/特殊 head attachment 走 `attachments` 的明确挂点，不混入 bodyParts。
6. 缺 context 返回 `CHARACTER_ASSEMBLY_CONTEXT_REQUIRED`；缺单个 URI、重复骨名或正权重映射失败分别返回可定位到 slot/resource/mesh/vertex/bone 的诊断。
7. 静态角色显示只需要 `CharacterAssemblyContext`；选择动作时再要求独立 `AnimationPlaybackContext`。禁止为了显示 bind pose 强造动画 URI，也禁止从角色装配对象里猜动作容器。
8. 同一提交必须提供 production context resolver 的真实成功路径。仅由测试手工 new 一个 context、或所有 UI 输入都返回 required，均不通过 G6。

### 14.5 动画容器必须显式

`a000_000010` 不在通用 `c0000.anibnd.dcx` 的动作集合里。真实成功路径需要：

- animation container：`c0000_a000_lo.anibnd.dcx`
- skeleton container：`c0000.anibnd.dcx`
- animation id：10

显式传这两个容器后，真实读取约 346 ms，得到：

- 146 HKX bones
- 112 tracks
- duration 约 0.6667 s

IPC `readTaeAnimationClip` 目前如果只传 animId 并让 Bridge 猜邻居文件，会失败。DTO 必须显式携带 animationContainerUri 和 skeletonContainerUri；main 负责在已索引资源图中解析，Bridge 不扫描用户目录猜文件。

### 14.6 动作加载性能

不要让每个 body part 重复：

- 读取同一 chrbnd
- DCX 解压
- FLVER parse
- skeleton 构建
- HKX retarget map 构建
- JSON 序列化完整 bones

固定 session/cache 边界：

- chrbnd source hash -> parsed FLVER bundle session
- leader skeleton name map 只建一次
- part -> leader remap 在加载时一次性预计算
- animation container hash + anim id -> clip/tracks
- HKX bone -> leader map 只建一次
- 每帧只采样 clip 并更新 leader pose

同地图 static DTO 一样，角色 mesh payload 上传 GPU 后释放 base64 wire 副本。

性能测试必须对顺序重开和并发重开都计数。同一 `workspaceSessionGeneration` 内，首次打开允许每个唯一 chrbnd/partsbnd/animation container 各 parse 一次；关闭再重开同一角色不得重复磁盘读取/解包/parse，任一资源的source hash/`pathSourceGeneration`变化后必须重新解析。只做 concurrent Promise 去重而顺序重开仍重复，不算 cache 完成。

## 15. 强制实施顺序与阶段 Gate：不得跳阶段

每一阶段都执行同一个闭环：

```text
入口检查并发/源码身份
  -> 记录改前失败与计数
  -> 最小范围实现
  -> 单元/协议/synthetic
  -> publish（若改 C#）
  -> 对应真实 smoke
  -> 记录改后证据和剩余失败
  -> 再查并发/工作树
```

规则：

1. 入口条件不满足，不编辑下一阶段文件。
2. 退出条件有一项 skipped/未覆盖/失败，只能继续修本阶段或记录“本阶段未完成”，不得进入最终完成声明。
3. 发现诊断与真实语料不符，先更新本文中的事实和测试 oracle，再改实现；禁止把测试阈值放宽到通过。
4. 任何 C# 改动后的真实 smoke 都执行 build -> publish -> executable hash 核对。
5. 每个编辑批次前和退出前重复第 0.6 节并发检查。
6. 一个阶段通过不授权停止；完成阶段 H 前只能报告局部进展。

### 阶段 A0：先取得dirty继承授权，再隔离伪 PASS 并修复验收信任根

入口：先按本节顶部的`RequiredA0InputsV1`分类。只有有效`DirtyWorktreeApprovalV1`证明用户明确授权新实现者继承冻结dirty工作树、且执行agent没有恢复写入，才允许产生任何写入；否则停在只读等待。runner/corpus/state/evidence/negative manifest任一缺失或第0.8节 identity命中、任何现存 acceptance runner自测非零，都固定留在A0。此阶段只允许修改 acceptance runner、它的 schema/negative fixtures、根 package入口和 ignored evidence目录；禁止借 A0修改 PARAM、地图、角色、启动实现。

1. 按第0.8节复制旧 runner/corpus/state/evidence原始bytes到 quarantine并重读验hash；不删除或覆盖原件。
2. 用24.1逐字实现完整 source snapshot：binary HEAD diff涵盖staged+unstaged，全部nonignored untracked用NUL路径和UTF-8 byte排序，拒绝symlink/reparse和读时变化。
3. 建立24.2固定全量 assertion registry、`stageInputRegistry`、typed artifact validator、canonical state hash、`--bootstrap`和`--resume`。G2-G6不得有源码字符串/文件存在性 assertion；G7不得有任何override。
4. 每个assertion只按真实child exit、typed result、runtime input identity和raw artifact算PASS；Gate只做AND。Bridge必须由本轮publish provenance绑定当前source snapshot，不能因固定exe存在而PASS。
5. state只通过same-directory temp+flush/fsync+atomic replace发布；故障注入覆盖写前、写中、flush后、rename前/后。旧可信state要么完整保留，要么完整换成新state，不能出现半JSON。
6. 将冻结runner/state/corpus逐项喂给negative fixtures；实际spawn selftest，不接受测试名、注释或未执行的lambda充数。
7. 交给一个从未参与实现、`fork_turns=none`的全新审查agent；只提供根`AGENTS.md`、本文、A0 diff和quarantine bytes，让其主动伪造/删除/重放证据。dispatcher按24.2保存spawn/wait receipt、raw输出和`IndependentReviewArtifactV1`；随后让用户确认该snapshot+artifact hash。实现者自己写的review JSON无效。

退出：新runner `--bootstrap`原子生成`A0..H=FAIL,G0..G7=FAIL`；每个第0.8节负例实际运行并得到指定拒绝码；selftest exit 0；独立攻击者无法用旧log、placeholder corpus、旧Bridge、child exit 1、源码字符串、漏文件、state截断或未知source mapping制造PASS。随后runner在同一A0最终snapshot重跑A0 assertion并发布`A0=PASS,A1..H=FAIL,G0..G7=FAIL`。若A0之后修改runner engine、registry、artifact/state schema、Gate映射或runtime-input规则，A0立刻失效，先回本阶段重审；不得继续产品阶段。

### 阶段 A1：先让当前半成品重新可构建

入口：A0由可信runner显示PASS；保存当前`git status`、source snapshot和第一次完整失败日志，不改/删冻结工作树。

1. 运行 `git diff --check`。
2. 运行 `npm run typecheck`。
3. 只修当前任务引入的类型错误。
4. 运行 `npm run bridge:build`。
5. 运行 `npm run test:param-field-write-matrix` 并保存原始结果；这一步是阶段 B 的行为基线，不是 A1 的构建退出条件。若它失败且修复需要改变 PARAM 语义，只记录静态 action code `B_PARAM_SEMANTICS`，不要在 A1 改算法。
6. 不要在此阶段顺手重构地图或 UI。

特别检查停止前新增的 `expectedRowDataSize` 是否贯穿了所有 interface：ParamWorkbench props、App callback、preload bridge、main handler、core commit wrapper。

阶段 A1只允许由一条实际compiler/test error驱动的签名、类型、import、参数透传或断言修正；每个diff hunk在阶段日志中引用error code + file:line。禁止在A1新增cache/session/命令、改算法、改CSS、改性能阈值或顺便重构。若第一次命令全绿，A1不产生产品diff。需要语义修改才能修的错误留给对应B-G阶段，并把行为assertion保持FAIL，不要扩大A1。

退出：可信runner在同一最终snapshot亲自spawn `git diff --check`、`npm run typecheck`、`npm run bridge:build`、`npm run build`，四项exit 0且typed/raw artifacts完整，才发布`A0=PASS,A1=PASS,A2..H=FAIL`。`test:param-field-write-matrix`当次结果必须作为B的诊断存在，但非零不授权A1改PARAM语义；它对应静态action `B_PARAM_SEMANTICS`。若称构建错误为仓库既有，必须在disposable clean-HEAD对照中复现；不能凭文件不在本次关注范围就忽略。

### 阶段 A2：冻结独立验收输入，不再改写 A0 runner

入口：A0/A1均由可信runner显示PASS；B-G production行为尚未继续修改。A0已固定runner engine、完整assertion registry和state算法，A2不能为了corpus方便改弱它们。

1. 按第0.5.1/24.3用filesystem + Andre + mature tool生成mission corpus，并用不共享expected-outcome逻辑的独立verifier重算；`disputed`保持FAIL。
2. 实现并冻结`face-set-rules.v1.json`与`map-resource-edges.v1.json`的schema、producer、generator/verifier identity；这些registry来自多样本native/成熟工具证据，不从SoulForge production输出反推。
3. 固化clean-head baseline harness、第17节阈值和24.19 canonical seeded schedule；此时不要求产品Gate成功，但scenario/run数/比较规则不能由B-G实现者改写。
4. 完成所有corpus schema count invariant：`entryCount===entries.length`、499 type-0逐identity、逐mesh FaceSet/triangle oracle、角色样本精确集合、三方artifact与generator/verifier源码hash；placeholder/pending固定FAIL。
5. runner必须继续因产品Gate尚未通过而非零；若corpus完成后G2-G7突然全绿，说明trust root仍fail-open，回A0。
6. corpus/registry/schedule由一个不同于A0 reviewer、A0/A2/product实现者且`fork_turns=none`的全新agent攻击性审查；尝试换样本、删除失败项、重放旧mature artifact和使用SoulForge输出决定expected值。按24.2保存外部receipt/raw artifact，并让用户确认精确snapshot+artifact hash；runner不能自签。

退出：corpus generator/verifier逐字段一致，争议项明确保持FAIL；规则/resource-edge registry有typed identity和独立证据；schedule canonical bytes/hash冻结；独立攻击无法让换样本/删失败/placeholder/replay通过。先逐hash验证A0 trust-root authority manifest完全未变；A2各spec的`requiredArtifactRoles`还必须包含当前snapshot上的`diff-check/typecheck/bridge-build/renderer-build` raw artifacts并由parent predicate要求exit 0，这只是A2进入后续施工的构建前置，不伪造一次新的A1 result。然后`STAGE(A2)`仍只请求A2 registry IDs，发布`A0=PASS,A1=PASS,A2=PASS,B..H=FAIL`。禁止用“重跑A0/A1 assertions”绕过24.2的STAGE requested-ID精确集合；H才用FINAL_H重新执行G1。A2之后修改corpus expected outcome、规则registry、resource-edge registry、scenario、schedule或阈值会使A2失效；修改runner trust root则同时使A0失效。两者都不能和“让产品测试变绿”的代码混在同一编辑批次。

### 阶段 B：PARAM 正确性先收口

入口：阶段 A0/A1/A2 已通过；真实 gameparam只读源和写回临时副本身份已记录。

1. 修 CSV 的重复 ID。
2. 审计 `containerParamEdit.ts` 的所有 `Map<id,row>`。
3. 完成 relocated ParamType synthetic 和真实 7 表 smoke。
4. `npm run bridge:publish` 后再跑真实 smoke，避免旧 DLL 假结果。
5. 保证读取和 writer 重读都带已裁定 row width。

退出：重复 ID synthetic 和真实重复 ID physical-row 写回均只改变目标行；138/138 读取、138/138 no-op byte-identical、7 张 relocated ParamType 均通过；所有失败逐表列出，0 个静默跳过。真实写回只对临时副本并走 production Patch/transaction 边界。

### 阶段 C：PARAM 热路径性能

入口：阶段 B 的物理行语义稳定；先记录重型 list、裸 parse、index、page、renderer first rows 的 cold/warm baseline。

1. 实现轻量 BND entry listing。
2. 与 extract 共享 binder session。
3. 实现 Param document session。
4. index 不带 hash，page 只带请求行。
5. 修 payload omitted 重试状态机。
6. 用 `AtkParam_Npc` 和 `SpEffectParam` 记录 cold/warm 分段耗时。

退出：`list-bnd4-entries` 默认 0 child hash、选中 extract 返回 hash，且 binder 复用计数测试通过；一次 Param session 的 N 页请求满足 parse=1/validate=1；默认 index 0 row hash；page 只序列化 pageSize 行；`omitted/failed` 行为测试证明不会自动重试；两个真实大表的行列表、搜索、滚动、选择仍可编辑并按第 17 节协议给出结果。只测 Bridge 微基准不通过。

### 阶段 D：地图静态 DTO 和路由

入口：固化当前 499 type-0 inventory、历史 481 success/18 failure identity，并用 Andre/成熟工具为 499 项生成 expected outcome manifest；历史失败数不是允许失败预算。

1. 新增 static map DTO，Bridge 不计算 skin/skeleton。
2. main 删除 raw spread 和重复 meshes。
3. 默认 16 MiB 下验证 `m002021` 成功。
4. IPC 请求加入 modelType/resourceKind。
5. 实现 mapbnd/objbnd/chrbnd/HKX 的明确 route 和结构化诊断。
6. 删除旧的重复 preview API。

退出：Bridge counter 证明 static 路径 skin/skeleton 构建为 0（**前置条件：先按 0.4.2 让 `SkinCalls`/`SkeletonCalls` 真的会自增，并用「故意插一次 skinning 调用 → counter 非 0 且判据变红」的负向用例证明它有判别力。counter 当前恒 0，直接引用等于什么都没证**）；每帧小于 8 MiB且默认 outbound limit 保持 16 MiB；m002021 成功；499 type-0 全量逐 identity 符合 manifest，所有 oracle-renderable 项重组后 0 mismatch/0 越界，只有 oracle 证实缺失/无 FLVER 的项可 unavailable；type 1 `o000100` 和 type 2 `c1000` 真实成功；type 5 返回专属 collision diagnostic；preload/main/Bridge 不再有可达的旧地图 preview production 路径。

### 阶段 E：地图生命周期和交互

入口：阶段 D 的几何数据已可信；先记录 heap/wire/GPU、long task、frame、pick 和 Gizmo 失败 baseline。

1. in-flight cache 与 GPU pool 分离。
2. 上传后释放 wire payload。
3. decode/upload 分 chunk 或 worker。
4. 修 selected target parent。
5. 拖动期间不 commit React；拖动结束一次写 semantic document。
6. 测 draw calls/triangles 后再决定是否做空间 cell batching。

退出：同一live `sceneId/sceneGeneration/rendererContextGeneration`与同一完整resource cache key中，同模型并发/顺序placement请求不重复IO/parse/GPU geometry；scene关闭后refcount=0的GPU geometry按池策略释放，不把释放后的重建误报为重复placement；上传并完成GC observation后大base64不再从scheduler/React state/闭包可达；chunk decode/upload不产生超过第17节阈值的长任务；真实Electron/WebGL在加载中可移动/选择；加载后frame/pick数据合格；非identity root上真实pointer move/rotate/scale都只在drag end写一次semantic transform。只调用controller方法而不发pointer event不通过。

### 阶段 F：角色单骨架和显式动作容器

入口：记录当前 c0000 的 mesh/bone/payload/IO/parse 计数以及失败截图/像素证据；context 来源可追溯。

1. 删除目录猜测默认部件。
2. 定义 assembly context。
3. body part skin indices 预重映射到 leader。
4. 只构建/更新一个 leader Skeleton。
5. 显式 animation/skeleton container DTO。
6. 固化真实 CPU/GPU skin bounds smoke。

退出：production resolver 能从真实资源图生成 `CharacterAssemblyContext`；c0000 完整 body 使用单 leader、正权重 0 missing/ambiguous/out-of-range、CPU/GPU 顶点 finite、bounds 在 oracle 容差；a000_000010 使用显式两个容器并真实播放；c1000 走相同通用 FLVER/leader 静态路径成功；并发和顺序重开计数均证明无重复 parse。黄色骨架隐藏不算身体成功。

### 阶段 G：启动增量生命周期

入口：资源读取链已稳定，先按第 17 节采集 cold/warm startup baseline 和前后台 IO 时间线。

1. 持久化 file fingerprint API。
2. 增量 hash。
3. foreground priority/cancellation。
4. workspace.analyze 复用 catalog。
5. 专用 editor 跳过重复通用 preview。
6. 固化 TTUI 和后台完成时间。

退出：首屏 discovery 的内容读取计数为 0；warm 启动未变化文件 hash=0；单文件变化 hash=1；hash failure 文件仍在索引；切换工作区可取消；前台 PARAM/地图/角色请求期间后台任务按优先级让步；`workspace.analyze` 不二次扫描；真实 UI 的 shell/files/editor-ready/background-complete 四个时间点都有固定证据。

### 阶段 H：最终集成和声明

入口：A0、A1、A2、B-G各自退出条件通过，没有关键未覆盖项。

1. 冻结最终源码快照，记录第 0.5 节 identity。
2. 若 C# 有改动，重新 publish 并锁定 Bridge executable hash。
3. 在该快照上执行第 16 节全部公开、治理、native、Electron/WebGL、写回/回滚和性能验证。
4. 任何失败都回到对应阶段；修复后整个 H 从头重跑，不能拼接不同源码快照的绿灯。
5. 对照 G0-G7 逐项判定 PASS/FAIL；只有全部 PASS 才可使用第 22 节整体完成模板。

退出：G0-G7 全部 PASS；0 个关键 skipped/not-run/uncovered；最终报告能从每个数字追溯到同一 source snapshot 的结构化记录。

这样排序的原因：当前最先失败的是验收信任根，不先完成A0，任何“已通过”都没有意义；随后恢复可构建基线并冻结独立corpus/规则。PARAM是最后修改且端到端identity断裂的区域；地图static DTO又是m002021硬失败前置；角色单骨架依赖通用FLVER payload/skeleton契约稳定；启动优化最后做可以避免性能测量被正在改动的资源链干扰。

## 16. 最终验证矩阵

本节每一项都是阶段 H 的硬门禁。接手者必须新增一个根聚合入口 `npm run test:mission1-acceptance`（可编排现有脚本，不复制测试逻辑），并让它在本机真实语料缺失、任一子项 skipped、Bridge identity 不匹配或关键浏览器能力不可用时非零退出。现有通用测试允许在其他环境 skip，但本次本机验收入口不允许。

### 16.1 每轮最低快速验证

```powershell
npm run typecheck
npm run bridge:build
npm run test:param-field-write-matrix
```

修改 renderer/React/底层逻辑后必须重新：

```powershell
npm run build
```

### 16.2 公开全量回归

```powershell
npm run typecheck
npm test
npm run bridge:verify:synthetic
npm run build
```

### 16.3 治理层

```powershell
node scripts/verify.mjs --tier governance
```

不要在最新主题域改动尚未提交时随意 seal Gate；fingerprint 锚定 HEAD。按当次 `node scripts/gov.mjs help` 操作。

### 16.4 Bridge publish

```powershell
npm run bridge:publish
```

真实 native smoke 前打印 `runBridge` 最终选择的 executable 绝对路径，并记录该文件 SHA-256/mtime。它必须等于本次 `bridge:publish` 生成的 `bridge/SoulForge.Bridge/bin/Release/net10.0/win-x64/publish/SoulForge.Bridge.exe` identity；不一致直接失败。

### 16.5 PARAM 真实 smoke

硬断言：

- 138/138 表读取。
- 138/138 no-op byte-identical。
- 7 张 relocated ParamType 单行表。
- 32 位三张表行数/行宽。
- `AtkParam_Npc` 4090 行。
- `SpEffectParam` 7790 行。
- 重复 ID 表 physical row 写回。
- 同 session 连续读取 index + 至少 10 个不同 page：native parse=1、structural validate=1、每次 serializedRows<=pageSize。
- 默认 index request 不传 `includeRowHashes` 时仍为 0 个 row hash。
- `omitted/failed` page 在 1 秒 observation window 内不会自动重发；显式 retry 恰好重发一次。

记录分段时间：binder list、extract、PARAM parse、index serialize、Bridge IPC、renderer first rows、selected page。

### 16.6 地图真实 smoke

以只读游戏根：

```text
D:\mystream\Sekiro Shadows Die Twice\Sekiro
```

硬断言：

1. `m10_00_00_00` 499 个 type-0 model 全部被枚举；历史 481 个成功和 18 个失败 identity 全部进入 manifest。最终所有 oracle-renderable identity 必须成功，只有 oracle 证实缺源/无 FLVER 的项可 unavailable。数量/hash 变化直接报 `CORPUS_IDENTITY_CHANGED`，不能当场更新基线。
2. `m002021` 在默认 16 MiB frame 成功，payload不含bones、boneWeights、boneIndices或原始角色mesh bundle；它仍必须包含24.10已验证的dense static `localIndices`和`sourceVertexIndices`。
3. 每 mesh index `< vertexCount`。
4. 对所有成功 type-0 的 positions、triangle indices、primitive count 做 Andre oracle 差分：index 0 mismatch，position 在格式量化容差内 0 mismatch。
5. 不自定“长边阈值”。从相同 oracle 几何计算每模型 world-space AABB、最大边长和 P50/P95/P99 边长，SoulForge 与 oracle 在浮点容差内一致；再做真实 canvas 检查。
6. 首批模型出现时相机仍能操作。
7. 加载结束后记录 draw call、triangle、CPU/GPU frame time。
8. 真正 pointer drag Gizmo，验证 semantic transform 写回。
9. model type 0/1/2/5 按第 11 节规则验收；真实 `o000100`、`c1000` 必须成功，type 5 必须是专属 collision diagnostic。
10. Bridge static counter：skin=0、skeleton=0；每个唯一 FLVER session parse=1；每个 response frame `< 8 MiB`，配置的 outbound limit 仍精确为 16 MiB。
11. chunk 重组后与未分块 oracle 的 vertex/triangle/material-group/bounds 一致；禁止只断言 JSON 字段数量。

必须扩展真实 Electron/Playwright/WebGL smoke。不能只检查“canvas 非黑”：必须同时做 canvas 像素占用/连通区域、几何 depth/world-bounds 统计、相机移动前后图像变化、选择高亮，以及向 TransformControls handle 发送真实 pointerdown/move/up。测试场景必须包含非 identity map root，并覆盖加载尚未完成和加载完成两种时机。

#### 16.6.1 固定 canvas 与 Gizmo 判定算法

不要让测试作者自己挑截图和阈值。acceptance 模式固定 viewport `1280x720`、DPR `1`、vertical FOV `50 degrees`、禁用随机抖动/自动曝光。使用 manifest 中 oracle world AABB 唯一计算：`center=(aabb.min+aabb.max)*0.5`，`radius=0.5*length(aabb.max-aabb.min)`；radius 非 finite 或 `<=0` 固定失败 `ORACLE_AABB_DEGENERATE`。相机方向固定为归一化 `[1,0.65,1]`，`distance=1.25*radius/tan((50 degrees)/2)`，`cameraPosition=center+direction*distance`，target=center，`near=max(0.001,radius*1e-4,distance-2*radius)`，`far=distance+2*radius`。禁止改用最大边长、一半最大边长、平均边长或实现自己的 bounding sphere，因为这些会改变 framing 和像素阈值。

同一个 production scene 做两次 render：

1. 正常材质 pass，保存 PNG；必须有模型像素，相机平移/旋转后至少 5% viewport 像素发生变化。
2. 临时 `overrideMaterial` 的 unlit double-sided geometry/depth validation pass；只覆盖材质，不替换 geometry/object transform。独立 oracle geometry 用相同 Three/WebGL raster state 另渲一张 mask/depth。

机器断言：foreground mask coverage在`[2%,95%]`；SoulForge/oracle mask IoU `>=0.98`。depth pass写view-space正深度`d=-viewPosition.z`为float32，不使用硬件nonlinear depth；comparison normalization唯一为`n=(d-near)/(far-near)`，只比较两张mask共同foreground且两侧`d`都finite、`near<=d<=far`的像素，任一foreground像素NaN/Inf/越界先FAIL，随后normalized absolute error P95 `<=0.001`。background清零但不进入分位数。

world AABB不能在oracle coordinate为0时除0。对每轴的min/max各用混合容差：`abs(actual-expected) <= max(1e-5, 1e-5*max(abs(expected), oracleAxisExtent))`，且actual/expected/extent都必须finite、extent>=0；同时比较center和extent，防止min/max同向漂移。截图只供人工复核，PASS来自mask/depth/bounds数字。若真正格式量化要求更宽容差，必须由oracle差分证据和用户裁定修改，测试作者不能临时调大。

Gizmo E2E 禁止 debug IPC 直接改 transform：

```text
按第 24.21 节冻结算法取得唯一 target identity；第一个 target 失败时不换样本
-> 从 validation ID buffer 取得该 target 的稳定像素质心
-> page.mouse.click 产生真实 pick/selection
-> 从 gizmo validation ID buffer 取得当前 mode/axis handle 的稳定像素质心
-> page.mouse.down
-> 沿固定方向移动 10 个等距 step、总计 80 CSS px
-> page.mouse.up
```

每种 translate/rotate/scale 都在非 identity root 运行。事件 trace 必须出现 `dragging=true`、至少 2 次 objectChange、期间 orbit disabled/selection identity 不变/semantic commit=0、pointerup 后 `dragging=false`、orbit enabled、semantic commit=1。最终 local matrix 与 pointer delta 的方向一致，重新从 semantic scene projection 后 instance matrix 不跳变。加载中用第一批 geometry 到达且 `complete=false` 的窗口执行同一序列；不能等加载结束后伪称“加载中”。

### 16.7 角色/动作真实 smoke

样本：`c0000 / a000_000010`。

硬断言：

- leader 467 bones。
- 对当前记录的 corpus hash，semantic bundle 为 54 meshes、122,071 vertices；若 corpus hash 变化，先重新建立成熟 oracle，不能放宽成“>0”。
- positive-weight bone remap：0 missing、0 ambiguous、0 out-of-range。
- `a000_000010` HKX -> leader 的正权重骨骼 113/113 映射成功；其他 clip 缺轨时才允许带精确原因的 bind-only 诊断。
- CPU/GPU skin 顶点全部 finite。
- 通用 bounds 比值与 c0000 的 `+-25%` oracle 区间按第 14.3 节通过。
- 动画容器明确为 `c0000_a000_lo.anibnd.dcx`，骨架容器明确为 `c0000.anibnd.dcx`。
- 同一个 chrbnd/FLVER/clip 不发生重复 IO/parse。
- context 每个 URI 有合法 provenance；production resolver 可成功产生 context，测试不得只手工构造 DTO。
- renderer 收到一份 leader skeleton，所有 body mesh 的 skin index 已处于 leader index space。
- c0000 bind extent 和动画中点 extent 在第 14.3 节 oracle 的 `+-25%`，production 无样本判断分支。
- 第二真实样本固定使用 `c1000` 验证同一 FLVER/leader 静态路径；若它不需要 equipment context，应以空 bodyParts/明确 leader 的合法 context 成功，而不是走 c0000 分支。
- metamorphic 防特例测试：把相同合法 fixture/corpus 临时副本映射到随机 URI/model identity，经显式 context 打开，骨骼重映射和几何结果必须不变；production 源码不得读取骨骼数、mesh 数、时长或目录顺序来选择算法。

再做 10 个真实 character static sample，不能由实现者手挑：Andre inventory 先按 `{single/multi FLVER, bone-count quartile, has32BitIndex}` 分 bin，每个非空 bin 取 content SHA-256 字典序最小项，直到 10 个；c0000/c1000 之外不足再按全体 SHA 顺序补齐。选择结果写入冻结 corpus manifest。每个样本经相同 production resolver/native FLVER/leader/GPU static path，所有 oracle-renderable mesh 成功、index/bounds/finite 一致。动作 clip 深度验收仍以有明确容器证据的 c0000 为主，不为其他样本猜动画。

角色 E2E 必须从 workbench 的真实 `c0000` 选择动作开始，acceptance mode 禁用任何 test-only context injector。trace 必须显示 `contextSource=production-resolver`，并逐 URI 给出 paramUri/table/physical rowIndex/fieldId/dataHash、真实 selectionEventId，或经第24.18节验证的resource-graph edgeId/ruleHash；出现 `manual-test-context`、无源 `default` 或常量 URI 直接失败。固定相机由第 14.3 节 CPU-skinned oracle bounds frame-to-fit，在 bind pose 和动作中点分别将 production GPU body 与独立 CPU skin geometry 做 validation mask/depth 对比：mask coverage `[2%, 80%]`、IoU `>=0.95`、共同 foreground normalized depth error P95 `<=0.01`。同时保存正常材质截图。只有黄色 skeleton、一个巨大替代 quad、或手工 context 均无法单独满足 geometry count、bounds、mask/depth 和 resolver trace。

runner 还必须运行仓库现有 native 入口：

```powershell
npm run test:native-preview
npm run test:workspace-completeness
```

这些现有 smoke 不覆盖 Electron 点击、真实 canvas、Gizmo 和本任务新增性能预算，因此不能替代前述专门 smoke。

### 16.8 启动真实 smoke

硬断言：

- cold 启动与 warm 启动分别按第 17 节采样，记录 shell/files/editor-ready/background-complete。
- 首屏 discovery 对 270 文件的 content-read/hash 计数为 0。
- warm启动未变化文件hash=0；变更1个文件后hash=1；Patch Engine等长写回使该path的`pathSourceGeneration`递增并重新hash。
- 人工注入一个 hash 读取失败，文件仍出现在 live/persisted catalog 且带 `FILE_HASH_FAILED`。
- 切换 workspace 后旧 session 在超时内取消；旧任务不能覆盖新 catalog。
- 在后台索引期间打开 AtkParam_Npc、m10 和 c0000，前台 first-visible 延迟不出现后台任务造成的优先级反转。

### 16.9 编辑、写回和回滚

硬断言：

- PARAM 重复 ID 目标物理行、地图 part transform 都经现有 semantic mutation -> Patch Engine -> staging/transaction 写入。
- 写回前expected source hash/`pathSourceGeneration`以及对象自身revision/transform hash中任一冲突都会结构化拒绝；不能覆盖外部变化。
- 成功写回生成现有体系要求的备份/审计；回滚后 byte identity 或 semantic identity 恢复。
- renderer IPC payload 不含绝对路径，Bridge writer 未获得 Mod 工作区直写权限。
- 所有真实写回使用游戏资产的临时副本；原版游戏根只读，测试结束清理临时产物。

### 16.10 失败关闭测试

必须逐项主动注入：Bridge超时/崩溃、workspace切换取消、stale session token、`workspaceSessionGeneration/pathSourceGeneration/sceneGeneration/rendererContextGeneration`分别改变、resource cache key字段改变、DCX/BND/FLVER损坏、chunk丢失/乱序、GPU upload失败、WebGL context loss、TransformControls异步晚到、正权重骨名缺失、animation container不匹配、Patch hash冲突。

每个注入必须同时断言：请求停止或可重试、资源释放、诊断含稳定 code 和 resource identity、UI 不无限 loading、不自动重试风暴、不发生用户资产写入。任何静默失败都是 critical gap，G7 失败。

### 16.11 Gate 到机器证据的唯一映射

`test:mission1-acceptance` 的代码内保存下表，不接受命令行传入 `--force-pass/--accept-skip/--reuse-log` 一类开关：

A0/A2 assertion的`gate=null`不是可选测试：阶段H先重新运行A0 trust断言，并重新verify A2 frozen corpus/rule/schedule及两份独立审查/用户确认artifact；任一失败使`H/overallStatus=FAIL`。它们不硬塞进某个Gx，避免把runner独立审查错误标成产品Gate；但没有trust PASS时即使G0-G7各自事实都绿，也禁止整体完成。A1/B-G/H的产品assertion全部必须映射下表某一Gate，且每个Gate required ID集合非空并与24.2静态registry精确相等。

| Gate | runner 必须亲自执行/收集 |
|---|---|
| G0 | runner fixture 自测、source before/after manifest、Bridge publish path/hash、corpus verify、环境 manifest |
| G1 | `git diff --check`、`npm run typecheck`、`npm run bridge:build`、`npm run build` 的原始输出与 exit 0 |
| G2 | 第 16.8 节 startup E2E/counters + 第 17 节 20-run artifact |
| G3 | PARAM synthetic/CSV/duplicate writer、138 表 native、session counters、真实 UI/performance artifact |
| G4 | 499 outcome manifest、全量 native oracle、static DTO schema/frame/counter、type 0/1/2/5 route |
| G5 | map Playwright/WebGL validation pass、loading/loaded frame/heap/pick、三种真实 pointer Gizmo trace |
| G6 | production resolver trace、c0000/c1000、CPU/GPU skin oracle、显式 clip、IO/parse/performance counters |
| G7 | 公开全量回归、失败注入、Patch/writeback/rollback、游戏根 write audit、`test:bridge-write-boundary`、governance tier |

runner 只根据当次子进程的raw observation、parent-owned predicate和artifact schema判定；child不得提交status/pass，人工报告、早先日志和 `gov seal` 不能输入 PASS。任何一格required assertion空集、缺artifact、artifact hash不在summary、schema字段缺失或snapshot不同，整格FAIL。Gate由`spec.gate`字段聚合，不用字符串prefix猜；A0到G阶段的诊断绿灯不写Gate PASS，只有H同一process tree的新鲜结果能更新Gate。

## 17. 固定性能验收协议

### 17.1 对照版本和机器状态

性能结果必须在同一台机器、相同电源模式、相同分辨率/DPR、相同 GPU、相同 corpus hash、相同 Release 配置上比较三组：

1. **clean-head baseline**：在 disposable git worktree 构建当前 `HEAD`，不 reset 当前脏树。
2. **final SoulForge**：阶段 H 冻结的最终源码/publish identity。
3. **mature comparator**：`D:\mystream\Sekiro Shadows Die Twice\tools` 中能完成同工作流的工具，记录工具名、版本/文件 hash和实际操作步骤。

关闭录屏、调试器、DevTools、实时杀毒扫描例外和其他重负载应用；不得为了 SoulForge 单独关闭安全软件。记录 CPU/RAM/GPU/Windows build、电源计划、显示尺寸、Electron/Node/.NET 版本。baseline 和 final 的测量顺序交替进行，避免永远让 final 独占更热的 OS 文件缓存。

这里的 `cold` 固定指 **process/application cold**，不是伪称 OS page cache cold：

- 结束 SoulForge 与 Bridge 进程。
- 每轮使用新的测试专用 app-data/index/cache 根；不得删除用户真实缓存。
- Bridge daemon、parsed session、GPU pool 均为空。
- OS page cache 不强行清除，状态记为 `uncontrolled`。

`warm` 固定指：同一 `workspaceSessionId/workspaceSessionGeneration`、相关source hash/`pathSourceGeneration`不变，资源已经成功打开一次；关闭对应 editor 后再次打开。保留 owner 仍存活的 binder/parsed cache；GPU resource 是否保留必须服从有界 pool/refcount 策略并在结果中标明 hit/miss，不能为制造 warm 数字泄漏 refcount。任何把后台工作延后到 warm 测量结束之后的做法都不算 warm 完成。

每个 workflow/state 至少 20 个成功或失败 run；失败 run 计入失败率和耗时分布，不得删除。排序后用 nearest-rank：`P50 = x[ceil(0.50*n)-1]`，`P95 = x[ceil(0.95*n)-1]`。不做 outlier trim；若外部干扰导致整轮无效，必须保留原记录并另开一整轮，不能只删慢样本。

runner 用 A2 冻结的`acceptancePlanSnapshotSha256`作为固定seed输入，按24.19预先写出每个scenario/cache所需全部cohort（baseline/final/mature/background active-idle/instrumentation on-off）的20轮确定性交错schedule；不适用的cohort不凭空运行。clean HEAD、A2、final与mature各自source/executable snapshot只记录在每个run artifact中，绝不能参与或重排共同schedule。开始后不能重排或挑选。每个run的进程事件、marker和raw metric samples立即append到raw JSONL，并进入summary hash。只有检测到system sleep、电源计划变化、GPU driver reset或**harness自身**崩溃才能判整批invalid；comparator被测程序crash计失败run。最多重跑一整批，原批仍保留并在报告解释。普通慢run、后台索引活跃、GC、解析失败都不是可删除的“环境异常”。

### 17.2 分段埋点

每条请求使用同一个 correlation id，main 用 monotonic clock、renderer 用 `performance.now()`，通过明确事件对齐以下阶段：

```text
disk open/read
DCX inflate
BND entry list/extract
native parse / native session hit
semantic projection
JSON/base64 serialization
Bridge frame transfer
Electron IPC transfer
renderer decode
GPU upload
first rows / first geometry / first complete body
editor-ready
fully loaded
steady-state CPU/GPU frame
long task count/max
pick latency
gizmo pointer-to-visual latency
semantic commit count
retained JS wire bytes / GPU unique resource count
```

埋点分两层。版本间的硬预算/相对比较只能使用同一个**外部黑盒 harness**：同一 Playwright/Electron 启动器、同一用户动作、同一 monotonic wall clock、同一 CDP/ETW 采集，不修改 clean HEAD 或 final 源码；clean HEAD 缺某个工作流时按固定超时记失败 run，不能换成更简单动作。final 新增的内部阶段事件只用于解释瓶颈和计数，不与 clean HEAD 的外部秒表混成相对数字。内部埋点本身必须可禁用；runner 对 final 的同一代表性操作各跑 20 次 internal instrumentation on/off，要求总 wall-time P95 overhead `<=2%`。不从正式结果人工扣除；超过就改成批量缓冲/更轻计数器后重测。

后台让步测试必须记录 background queue 的 pending/processed/cancel counters，证明测量窗口内后台工作真实存在；把后台任务暂停到测量结束会得到 `BACKGROUND_WORK_DEFERRED` 并失败。

### 17.3 不得擅自放宽的预算

下表是本任务 Gate 预算。若受硬件/成熟工具事实反证影响需要修改，必须把原始 20-run 数据交给用户裁定；接手者无权自己放宽。

| Workflow | 最终硬预算 |
|---|---|
| 工作区 cold editor-ready | P95 `<= 3.0 s`；仅当24.19 `relativeComparable=true`时再要求`<=60%` clean-head baseline；shell/files必须早于editor-ready |
| 工作区 warm editor-ready | P95 `<= 1.5 s`；未变化文件 hash=0 |
| 后台索引对前台影响 | PARAM/map/action first-visible 的 P95 相对“后台空闲”恶化 `<= 15%` |
| AtkParam_Npc/SpEffectParam cold first rows | P95 `<= 1.0 s`，完整 row index 已可搜，不是截断数据 |
| PARAM warm first rows | P95 `<= 250 ms`；selected page P95 `<= 100 ms` |
| PARAM search/scroll/select handler | P95 `<= 16.7 ms`，单次 long task `< 50 ms` |
| m10 cold first browsable geometry | P95 `<= 5.0 s`，此时 camera/pick event 可处理 |
| m10 fully loaded | 有可比baseline时P95 `<=60%` clean-head；无可比baseline则该相对项`NOT_COMPARABLE`且不得用timeout代替；无论哪种都要求绝对P95`<=45 s`且不慢于mature comparator P95的`2x` |
| m10 加载中 frame | CPU frame P95 `<= 33.3 ms`，renderer long task max `< 100 ms` |
| m10 加载后相机 frame | CPU 和 GPU frame P95 各 `<= 20 ms`；visible entity 不减少 |
| m10 pick / Gizmo | pick P95 `<= 50 ms`；pointer-to-visual P95 `<= 33.3 ms`；drag end semantic commit 恰好 1 |
| c0000 cold first complete body | P95 `<= 3.0 s`；不能以 skeleton-first 代替 body-first |
| c0000 warm complete body | P95 `<= 750 ms`；unique source 的 read/inflate/parse 计数不增加 |
| a000_000010 clip ready | cold P95 `<= 1.5 s`，warm P95 `<= 300 ms` |
| wire memory | map/character GPU 上传并两次 test GC 后，completed base64 payload 无强引用；retained wire bytes `<= 32 MiB` |

`first browsable` 的自动化定义是：真实模型三角形已经进入 canvas，camera pointer/keyboard 输入在 100 ms 内产生可观察 view-matrix/pixel 变化，且 selection request 可返回；只有 grid、loading 文本或 proxy 不算。

`first complete body` 的自动化定义是：context 声明的全部 bodyParts 已装配，非 skeleton 像素占用和 CPU/GPU bounds 均通过；先画一块 mesh 或隐藏黄色骨架不算。

性能改善不得以减少 rows/models/parts/meshes、排除 18 个失败 identity、降低渲染分辨率、关闭材质类别、延迟到下一次操作或提高 frame limit 获得。

表中任何“相对baseline”都受24.19的marker capability前置约束；`NOT_COMPARABLE`不等于PASS，也不允许阻塞其他绝对/成熟工具预算求值。若mature comparator adapter不可用，对应比较项为`environment_blocked`并使整体性能Gate未完成，不能删掉绝对预算或拿clean-head timeout替代。

### 17.4 测试流图

```text
A0 TRUST ROOT
  explicit dirty-worktree approval
    -> required-input classification
    -> canonical source snapshot + trackedChanges/raw artifacts
    -> quarantine + machine negative-fixture manifest
    -> child raw observations -> parent predicates
    -> derived assertion manifest -> atomic state
    -> external independent review artifact + user hash confirmation

A2 ACCEPTANCE INPUT ROOT
  filesystem + Andre + mature evidence joined by source/entry hash
    -> corpus + FaceSet/resource-edge/coordinate/conversion registries
    -> closed performance scenarios/schedule
    -> different external review artifact + user hash confirmation

WORKSPACE OPEN
  |
  +-- discovery(no content read) --> FILES VISIBLE --> EDITOR READY
  |                                  |
  |                                  +-- continuity probe (USN/watcher)
  |                                        |-- PROVEN + unchanged: reuse
  |                                        |-- changed: continuation hash once
  |                                        `-- gap/cancel/fail: keep file; rehash/diagnostic
  |
  +-- SELECT PARAM
  |     `-- BND content entry + window owner lease
  |          -> PARAM content entry + window owner lease
  |          -> physical index --> local search/virtual list
  |                          `--> exact page --> rowIndex/hash CAS --> Patch Engine
  |
  +-- SELECT MAP
  |     `-- canonical placement/model identity
  |          -> verified resource-edge envelope + model-local/coordinate hashes
  |          -> ResourceCacheKey
  |          -> static FLVER owner + meshPlan/cursor
  |          -> stdout-only bounded NDJSON pages (all meshes/material spans)
  |          -> worker strict decode -> GPU upload
  |          -> transactional readyManifest + geometry/material pools
  |          -> all-chunk placement bindings/cells
  |                 |-- camera + broadphase/exact pick
  |                 `-- selected target -> dragSession
  |                       |-- success: revision+transform-hash CAS exactly once
  |                       `-- abort/conflict/late chunk: transactional rollback or authority reproject
  |
  `-- SELECT ACTION
        `-- nonce-protected selection reservation transaction
             -> CharacterAssemblyContext --> native FLVER parts --> leader remap
             |                              `--> one Skeleton/GPU body
             `-> ActionSelectionRecord + explicit skeleton edge/selection
                    -> full-identity decoded clip cache -> one retarget plan -> one leader pose/frame

FINAL H
  rerun A0 trust + verify A2 artifacts + spawn every G0-G7 assertion
    |-- any FAIL -> earliest semantic owner stage by (stageRank,order), clear it and later checkpoints
    `-- fresh gate AND + stable final snapshot -> H/overall PASS
```

每条箭头都必须有成功测试、取消/失败测试和资源释放断言。测试只命中数据层却没有经过右侧真实 UI/GPU 分支，不能覆盖对应 UX Gate。

### 17.5 Failure-mode 矩阵

| 生产故障 | 必须有的测试 | 必须处理 | 用户可见结果 | 阻断阶段/Gate |
|---|---|---|---|---|
| dirty继承未授权或只说“旧agent暂停” | 缺失/错误消息hash、snapshot漂移 | 只读停止，要求逐字授权 | 不产生任何写入 | A0/overall |
| runner伪PASS/child自报status/旧artifact replay | 冻结runner+逐字段删除+nonce/source/hash重放 | parent predicate派生FAIL，0 Gate导入 | 精确reason code | A0/H |
| state写入中崩溃 | temp/write/flush/rename/parent-flush各边界退出 | 只能读旧完整或新完整state | 可恢复，不出现半JSON | A0/H |
| source snapshot变了但无法列changed path | 同HEAD二次dirty内容、HEAD对象缺失、unmapped path | trackedChanges差分；未知固定A0 | `STAGE_INPUT_UNMAPPED` | A0 |
| corpus三方证据来自不同文件/entry | 交换mature artifact与container child | source+entry canonical join拒绝 | `CORPUS_EVIDENCE_SOURCE_MISMATCH` | A2/G0 |
| discovery 文件可见但 hash 读取失败 | 注入 read error | 保留 catalog、sha 缺省、可重试 | `FILE_HASH_FAILED`，非无限 loading | G2 |
| 进程关闭期间等长写回/USN gap | 恢复mtime、journal截断、watcher overflow | continuity UNKNOWN，后台强制重hash | 文件先可见但不复用旧hash | G2 |
| workspace快速切换 | 旧session延迟完成 | cancel + workspaceSessionGeneration guard | 新workspace不被旧结果覆盖 | G2 |
| BND cache stale | 等长Patch写回 | pathSourceGeneration bump、binder/child/session失效 | 新内容出现或冲突诊断 | G2/G3 |
| owner lease跨window/purpose或double close | 两window共享content entry并交叉page/close | exact scope+capability拒绝，计数不负 | `*_OWNER/WINDOW/CAPABILITY_*` | G3/G4/G6 |
| PARAM page token stale | session evict 后翻页 | 拒绝旧 token、显式 reopen 一次 | 稳定诊断，不 retry storm | G3 |
| PARAM 重复 ID 写回 | 两行同 ID，写第二行 | rowIndex/hash 精确 CAS | 只改第二物理行 | G3/G7 |
| Bridge timeout/crash | 请求中终止进程 | 取消 in-flight、释放 session、有限 retry | 可重试错误，viewport 仍响应 | G3-G6 |
| FaceSet规则0命中/多命中 | registry 0/multiple rule fixture | fail-closed，不选first | 精确unsupported/ambiguous | G4 |
| FLVER 损坏/缺 entry | 真实/构造坏容器 | 保留 model identity、分类失败 | 模型级诊断，其他模型继续 | G4 |
| 旧完整base64 preview仍可达 | preload/main/Bridge production route trace | 删除旧route，static命令唯一 | 不再产生双payload | G4 |
| NDJSON日志混stdout/CRLF/恰8MiB | golden bytes、7fffff/800000边界、Unicode/error frame | stdout-only LF，transport严格<8MiB | framing diagnostic，不截断 | G4 |
| cursor跨session重放、TTL与reader竞态 | forged/retry/BUILDING TTL/close barrier | token+owner+source绑定，active不evict | 可重试或精确expired | G4 |
| 第一个mesh后提前complete/material span缺失 | 多mesh多FaceSet/material真实/fixture | meshPlan全覆盖、唯一terminal、span重组 | 单模型FAIL，不显示半模型 | G4/G5 |
| chunk丢失、重复、乱序 | 协议注入 | requestId下sequence固定0、cursor chain/meshPlan/sourceTriangle span/content hash校验，拒绝不完整GPU commit | 单模型失败，可重试 | G4/G5 |
| readyManifest缺pool key/复用旧path或scene epoch | pool eviction与ResourceCacheKey/lifetime字段逐个变化 | ready事务全有或全rollback，再reload | 不出现半模型/陈旧模型 | G5 |
| 多subscriber中第一个unsubscribe | 同scene/跨scene两个lease交错关闭 | 最后scene-owner lease才release GPU | 另一订阅者持续可见 | G5 |
| GPU upload/context loss | mock upload reject + WebGL context loss | dispose partial buffers、重建或明确失败 | viewport 恢复/明确错误 | G5/G6 |
| TransformControls晚到 | 切换selection后resolve import | selectionGeneration+sceneGeneration+controlsEpoch guard | 旧target不复活 | G5 |
| 旧drag objectChange或晚到chunk | dragSession/epoch错、拖动中新增第3 chunk | 事件绑定当前controls object；binding原子加入或abort | 不撕裂、不晚提交 | G5 |
| Gizmo CAS revision相同但transform hash变了 | 外部更新hash/sceneGeneration barrier | revision+hash+sceneGeneration原子CAS | 冲突后authority重投影 | G5/G7 |
| 非 identity root 拖拽 | root 有 TRS，三种 gizmo mode | local/world 往返、一次 commit | 对象不跳变、selection 保持 | G5/G7 |
| wire payload 残留 | 完成上传后 heap snapshot | 清 Promise/React/cache 引用 | 无 UI 变化，内存下降 | G5/G6 |
| selection event replay/nonce错/多record半消费 | 双consume barrier、第二record失败、reserve超时 | nonce CAS + reserve/commit/rollback | 可重试且0半消费 | G6 |
| assembly context 缺失 | production UI 无 context | fail-closed，不目录猜测 | `CHARACTER_ASSEMBLY_CONTEXT_REQUIRED` | G6 |
| 正权重骨名缺失/重复 | part fixture +真实分类 | 拒绝该 part/bundle，报告精确 influence | 不映 bone 0、不缩成原点 | G6 |
| animation/skeleton 容器不匹配 | 显式传错 URI | identity/schema 校验 | bind-only 或明确错误 | G6 |
| decoded clip用旧conversion/source identity | rule/unit/hash/pathSourceGeneration逐字段改变 | full canonical key miss；FAILED退避 | 不返回旧pose，明确诊断 | G6 |
| baseline弱marker或NOT_COMPARABLE绕过 | 窗口出现、child伪comparability、baseline timeout | parent外部marker；固定两种comparisonMode | 性能predicate明确FAIL/替代全验 | G2/G5/G6 |
| 用户文件在编辑中外部变化 | 写前改变 source hash | Patch CAS 拒绝、保留 staged edit | 冲突提示，可重新载入 | G7 |

上表任一行若同时“无自动化测试、无错误处理、用户只能看到静默卡住/错误画面”，就是 **critical gap**。存在一个 critical gap 即禁止整体完成。

## 18. 明确禁止的“修复”

下一位 agent 不得采用以下手段：

- 对 `m10_00_00_00`、`c0000`、`a000_000010`、`AtkParam_Npc` 写 ID 特例。
- 按前缀、骨骼/mesh/vertex 数、动画时长、目录顺序或“前 N 个 slot”写等价隐性特例。
- 把历史测试、另一个 dirty snapshot 或旧 Bridge publish 的结果冒充当前源码验证。
- 把关键 native/Electron/WebGL smoke 记为 skipped/N/A 后仍宣称整体完成。
- 只跑单次 warm 测量、删除慢/失败 run、自己放宽第 17 节阈值或把极宽 bounds 当“合理”。
- clamp index、丢弃大三角、限制 far plane、默认 wireframe 来隐藏坏几何。
- 为了帧率减少 part/model/row 数量。
- **顶点数超 Uint16 上限就只画第一个 mesh。** `apps/desktop/src/main/ipc.ts:4537` 现状即此：`if (totalVertexCount + vertexCount > 65535) return null;`，调用方（`:4604`、`:4664`）拿到 `null` 后退回单 mesh0，**不产生任何 diagnostic**。用户看到的是一个安静地少了几何的地图，而不是一个报错。这属于「减少显示内容来让代码不报错」，与上一条同类。修法是按真实 `indexSize` 升级到 Uint32 并重定位，`apps/desktop/src/main/mapMeshGeometry.ts` 的 `decodeIndices`/`mergeMapMeshGeometry` 已经是这个方向的正确实现——它当前是孤岛（`ipc.ts` 不 import 它），把它接进生产路径即可，不要在 `ipc.ts` 里重写第二套。
- **用「字节长度能被 2 整除」代替索引位宽判断。** `ipc.ts:4535` 只有 `if (idx.length % 2 !== 0) return null;`，而 32 位索引缓冲的字节长度同样能被 2 整除，于是 `:4538` 的 `new Uint16Array(...)` 会把它整体错读——每个 32 位索引的高半字被当成一个独立索引。**Bridge 已经在同一个响应对象里给出了 `indexSize` 字段**（`BridgeCommandService.cs:1537`，与 `indicesBase64` 相邻，取值 16 或 32），而 `ipc.ts` 全文对 `indexSize` 零引用（实测 grep count 0）。`FlverNativeDocument.cs:740` 的注释明确写着「索引位宽仍由 face set 的 IndexSize 决定，不允许调用方猜测」，`:723` 还提供了 `GetMeshIndexSize()`。所以这不是「信息不可得」，是**手里有权威字段却改用推断**。
- **让注释承诺一个代码里不存在的 guard。** 上面那两处的注释（`ipc.ts:4493-4494`）写的是「总顶点超 65534（Uint16 索引上限）或**索引非 16 位时**退回 mesh0」。前半句在 `:4537` 有对应实现（阈值实际写的是 65535，与注释的 65534 也不一致）；**后半句在代码里根本没有对应的判断**。这比缺 guard 更危险：审查者读到注释会认为已经处理，于是不再核对。凡是注释声称有校验的地方，必须有一条能实际跑红的负向用例证明它存在；写不出这个用例就把注释删掉，不要留一个假承诺。
- 只提高 Bridge frame size，不减少错误 DTO。
- 只从 main 输出删除 bones，而 Bridge 仍执行 skin/skeleton 计算。
- 把一个完整 base64 字符串切成几个 JSON 字段，假装成流式 chunk。
- 只把队列 budget 设为 6 ms，但单个 decode/upload task 仍同步阻塞几十毫秒。
- 从一个 cache Map 删除 payload，却让 React state、Promise、闭包或第二个 cache 继续持有它。
- type 1/2 的真实资源存在却统一返回 `UNSUPPORTED`，或把所有失败伪装成 collision unavailable。
- 把所有 part target 都挂 scene，换来 Gizmo 可用但增加 7404 个每帧 traversal 节点。
- 只挂到 scene/root 后不测试非 identity root 的 local/world matrix。
- 用 source regex、直接调用 controller method 或只断言 callback 次数代替真实 pointer drag。
- 继续扫描角色目录并硬选 `9000/9510/210`。
- 把 weapon 当 body part 合并。
- 正权重骨骼映射失败时回落到 bone 0。
- 每个 body part 每帧独立 retarget。
- 让所有角色都返回 `CHARACTER_ASSEMBLY_CONTEXT_REQUIRED`，却没有 production resolver 的真实成功路径。
- 只做并发 Promise 去重，顺序重开仍重复 IO/解包/parse。
- 用 `Map<id,row>` 表示 PARAM 权威行表。
- 先用 Map 折叠重复 ID 再检查“唯一”，或只检查 CSV 批次而不检查目标 PARAM 全表。
- 只在 main 缓存 PARAM JSON，Bridge 翻页仍全量 parse/validate/serialize。
- 提供 `includeRowHashes:false` 参数但默认调用仍带 hash。
- 每翻一页重新验证整张 PARAM。
- hash 失败就从索引丢文件。
- 只用 path+size+mtime 且 Patch Engine/watcher 不 bump generation。
- renderer 直接读文件或获得绝对路径。
- 在 Patch Engine 外修改用户 Mod 资源。
- 从 Smithbox/DSMapStudio 复制不兼容许可证源码。可以对照行为和格式语义，不能复制实现。
- 在最终报告列出真实 canvas、Gizmo、角色成功路径或回滚未覆盖，同时仍写“任务完成”。

## 19. 常见陷阱

### 19.1 smoke 仍在用旧 Bridge

症状：源码看起来已修，真实 smoke 仍给旧诊断。先执行：

```powershell
npm run bridge:publish
```

再确认 `runBridge` 实际选择的 executable。

### 19.2 cache 命中了陈旧容器

BND cache 若只看 length+mtime，等长快速写回可能误命中。Patch Engine 成功后必须主动失效 container children、binder、extracted child、param session、GPU/wire cache。

### 19.3 React effect 重试风暴

依赖对象在每次请求后更新，而成功条件又始终不成立，会无限重发。对 page、model、clip 都要有显式 request state 和稳定 request key。

### 19.4 “加载完成”不等于“可以编辑”

验收必须包含加载中相机移动、选中、Gizmo pointer drag、拖动结束写回，而不是只看最终计数。

### 19.5 Instancing 不自动等于高帧率

geometry 复用正确，但过大的实例 bounds、过多 material/mesh draw call、GPU fill/triangle 数仍可能卡。先用 renderer.info 和 GPU timing 测量，再做空间 batching。

## 20. 当前文件清单

已修改：

```text
apps/desktop/src/main/ipc.ts
apps/desktop/src/renderer/src/editors/FlverViewer.tsx
apps/desktop/src/renderer/src/editors/MsbScenePanel.test.tsx
apps/desktop/src/renderer/src/editors/MsbScenePanel.tsx
apps/desktop/src/renderer/src/editors/TaeWorkbenchPanel.test.tsx
apps/desktop/src/renderer/src/scene/modelResourcePool.test.ts
apps/desktop/src/renderer/src/scene/modelResourcePool.ts
apps/desktop/src/renderer/src/scene/runThreeSceneFunctionalSmoke.ts
apps/desktop/src/renderer/src/scene/threeSceneController.ts
apps/desktop/src/renderer/src/staging/documentReset.ts
apps/desktop/src/renderer/src/styles.css
bridge/SoulForge.Bridge/BridgeCommandService.cs
bridge/SoulForge.Bridge/BridgeDaemonHost.cs
bridge/SoulForge.Bridge/FlverNativeDocument.cs
bridge/SoulForge.Bridge/NativeLeafPayload.cs
bridge/SoulForge.Bridge/ParamNativeDocument.cs
bridge/SoulForge.Bridge/ParamNativeWriter.cs
package.json
packages/core/src/action/taeAnimationBridge.test.ts
packages/core/src/bridge/runBridge.ts
packages/core/src/editing/paramBridgeCommit.ts
packages/core/src/index.ts
packages/core/src/param/paramdefLayout.ts
packages/core/src/testing/runAnimationPlaybackClockSmoke.ts
packages/core/src/testing/runNativeParamSmoke.ts
packages/core/src/testing/runParamFieldWriteMatrixSmoke.ts
packages/core/src/testing/runParamdefLayoutSmoke.ts
packages/core/src/workspace/scanWorkspace.ts
packages/shared/src/action-continuous-sampler.ts
packages/shared/src/bridge-protocol.ts
packages/shared/src/editor-protocol.ts
packages/shared/src/index.ts
scripts/verify-synthetic-core-fixtures.mjs
scripts/verify/tiers.mjs
```

冻结快照未跟踪（以第0.8节10项hash为准）：

```text
apps/desktop/src/renderer/src/scene/flverSkeletonMapping.test.ts
apps/desktop/src/renderer/src/scene/flverSkeletonMapping.ts
apps/desktop/src/renderer/src/scene/mapModelLoadScheduler.test.ts
apps/desktop/src/renderer/src/scene/mapModelLoadScheduler.ts
packages/shared/src/flver-preview.ts
bridge/SoulForge.Bridge/MapStaticGeometryService.cs
packages/core/src/character/characterAssembly.ts
packages/shared/src/character-assembly.ts
scripts/verify-mission1-acceptance.mjs
testdata/corpus/mission1-sekiro-acceptance.manifest.json
```

不要漏掉未跟踪文件，也不要把它们当临时垃圾删除。`git status`的路径数量随接手时变化；这份清单是审计快照，不是删除/覆盖指令。任何新增未跟踪文件必须先归属到stageInputRegistry，否则A0 FAIL。

## 21. 接手者的第一天操作清单

按顺序执行，不要跳：

1. 先完整阅读根`AGENTS.md`、本文“执行入口”和第0节；不要先通读全文。先验证`DirtyWorktreeApprovalV1`。当前用户的“暂停执行agent写入”只冻结快照，不是产品继承授权；没有逐字授权就只读停下询问。因为当前runner/state/corpus是冻结反例，**第一阶段固定是A0，不读取旧state的任何PASS**。
2. 获得授权后，执行`git status --short --branch`、`node scripts/gov.mjs status`、`node scripts/gov.mjs next`、`node scripts/gov.mjs help`；把原文和hash写进A0 snapshot。发现其他agent在main写入立即停止。
3. 按第0.8节先隔离runner/corpus/state/evidence原始bytes，再按24.1建立source snapshot；不要先跑产品build，不要先改dirty源码。
4. 执行A0负例矩阵和runner selftest；旧current-state、源码字符串、placeholder corpus、旧Bridge、child非零、state截断都必须实际FAIL。A0未PASS不得执行A1产品修复。
5. A0通过后，按A1只修真实compiler/test错误；运行`git diff --check`、`typecheck`、`bridge:build`、`build`并绑定同一snapshot。
6. A2才冻结独立corpus、FaceSet/resource-edge registry和seeded schedule；corpus/规则/schedule审查者与A0审查者、产品实现者都必须不同。
7. 按B收口physical row identity/duplicate ID，再按C实现BND/Param session；每次只读当前`firstFailure.nextActionCode`对应卡。
8. 按D实现static typed route、全量oracle和streaming cursor并删除旧production map preview；只要旧API仍可达，G4 FAIL。
9. 按E实现wire/GPU owner生命周期、multi-chunk/cell identity、真实pick和三种pointer Gizmo；FakeRenderer/source-regex不算退出。
10. 按F实现显式CharacterAssemblyContext、single leader、正权重CPU/GPU skin和显式animation/skeleton container；不得保留硬编码默认parts作为production fallback。
11. 按G实现workspace-scoped persisted fingerprint、continuation hash、取消/优先级和catalog复用；区分session generation与fingerprint generation。
12. 按H冻结最终snapshot，从头运行`test:mission1-acceptance`、公开回归、native/Electron/WebGL、写回/回滚、性能和治理层；任何失败回对应阶段，不能拼快照。

每完成一步，都记录“源码/产物 identity、改前指标、改后指标、具体语义断言、失败样本”。不要只写“优化了”“修复了”。

## 22. 最终声明模板

先填写 trust/Stage/Gate 表。只有A0/A2在H中重新验证PASS、`H=PASS`、`overallStatus=PASS`、G0-G7都PASS，且每个结果都能链接到同一最终source snapshot的结构化证据，才可把标题写成“整体完成”：

```text
源码快照：gitHead、dirty patch hash、untracked hashes、Bridge executable path/hash。
信任根：A0 runner/negative/atomic-state独立审查artifact+用户确认hash；A2 corpus/rule/schedule独立审查artifact+用户确认hash。
阶段：A0/A1/A2/B/C/D/E/F/G/H PASS；overallStatus PASS。
Gate：G0 PASS / G1 PASS / G2 PASS / G3 PASS / G4 PASS / G5 PASS / G6 PASS / G7 PASS。
启动：冷/热首屏可交互时间，后台索引时间，增量 hash 数量。
PARAM：AtkParam_Npc/SpEffectParam cold/warm first rows、page、search/scroll、重复 ID 写回。
地图正确性：m10 全量 model/part 数、499 项 expected/actual outcome、所有 oracle-renderable 成功数、oracle position/index diff、越界数、oracle 边长/bounds diff。
地图性能：first visible、fully loaded、draw calls、triangles、CPU/GPU frame、pick/gizmo latency。
动作：leader bones、meshes/vertices、unmapped influences、non-finite vertices、bounds、clip load time。
写回：Patch Engine、备份、回滚、并发 hash 保护。
回归：typecheck/test/bridge synthetic/build/governance/native smoke 的真实退出状态。
非关键未覆盖：只能列第 4.5 节明确不在范围的增强项；不得含任一 G0-G7 要求。
```

只要A0/A2 trust复验失败、H/overall FAIL、任一Gate FAIL、任一关键smoke skipped/not-run、存在critical gap或验证后源码又变化，报告标题和第一句都必须写“局部进展，整体未完成，当前不可作为可用修复验收”，随后先列trust/overall，再按G0-G7顺序列PASS/FAIL、失败Gate、最后成功步骤、完整失败输出位置、下一条唯一动作。禁止写百分比、“基本完成”“只差环境验证”“ready except”或把失败Gate塞进“非关键未覆盖”；不得在正文后半段再暗示整体已经完成。

## 23. 交接书攻击性盲测记录

这一节只证明“低能力接手者是否容易误读本文”，不证明 SoulForge 产品代码、性能或真实语料 Gate 已通过。

曾经让同一个已审过旧版的 agent 再审修订版；该方法带有记忆和确认偏差，结果已作废，不作为证据。之后每轮都换用全新、无对话上下文、只获得本文路径的低能力模拟 agent：

| 轮次 | 当时结论 | 它找到的主要可钻空间 | 文档修订 |
|---|---|---|---|
| 独立盲测 1 | YES | 证据可手写、dirty snapshot 可漂移、corpus 可换、UI/Gizmo 主观、diagnostic 可代成功 | 增加唯一 runner、snapshot guard、mission corpus、确定性 UI、diagnostic registry |
| 独立盲测 2 | YES | manifest 基线可由被测实现影响、native counter 可放错层、假 chunk 先全量构造、硬编码 URI 可伪装 context、部分验收过脆 | 三方独立 oracle、C# 真入口 telemetry、渐进编码峰值约束、PARAM/selection provenance、写审计与可执行性修正 |
| 独立盲测 3 | YES | 大多数所谓漏洞已是明令违约，但 1800 行认知负担仍会让低能力 agent 忘记硬契约；runner 建得太晚 | 新增顶部执行控制器和阶段 A2，把 fail-closed runner/corpus 冻结提前到所有产品优化之前 |
| 独立盲测 4 | NO | 在禁止伪造、篡改 oracle、跳 Gate 和违反明确禁令的前提下，未找到仍可合理双解的条款 | 当前版本通过“交接清晰度”盲测 |
| 独立盲测 5 | YES | A2 runner/schema/oracle 仍可能由实现者自建自验；A1 语义测试与退出冲突；source 文件分类、baseline、成熟工具成功信号、Gizmo样本和角色 provenance仍可双解 | 明确独立审查批次、固定 source/runner/assertion算法，修正A1与baseline，新增第24节逐算法施工卡和确定性样本/provenance规则 |
| 独立盲测 6 | YES | 冻结runner真实selftest失败却写全PASS；恢复阶段无映射、session/fingerprint generation混淆、hash让步可O(n²)、FaceSet production非流式、cursor reader/TTL、wire framing、placement/坐标、owner lease、ready manifest、Gizmo abort、selection replay、clip conversion key和不可比较baseline仍有双解 | 新增A0隔离信任根和冻结反例；按三份代码审查重写当前状态；补齐stageInputRegistry、generation/continuation、streaming FaceSet/NDJSON/session、placement/resource-edge/map coordinate、lease/manifest/Gizmo CAS、animation cache和relativeComparable算法 |
| 独立盲测 7 | YES | A0缺corpus/evidence/approval分支；独立review可自签；snapshot不能求changed paths；state/Gate/child status可伪PASS；corpus可换源；多mesh/material、NDJSON边界、journal gap、owner scope、identity/self-hash、subscriber lease、Gizmo CAS、selection事务、clip key和NOT_COMPARABLE仍未闭合 | 新增完整A0输入/approval、外部review receipt+用户确认、trackedChanges/artifact/checkpoint派生state和parent predicate；补齐三方source join、全mesh/material terminal、strict NDJSON、continuity、owner capability、canonical envelope、复合cache/subscriber事务、drag session双CAS、selection reserve、clip full key及两种固定性能模式 |

独立盲测4的`NO`只对它看到的当时版本成立，随后更严格的全新审查者仍找到合理双解，因此它不能作为最终结论。独立盲测7明确为`YES`，所以当前表中**没有有效的最终清晰度PASS**；本轮修订完成后必须换一个从未读过本文、`fork_turns=none`的新实例复审，只有它明确`NO`才能追加新行并声明“当前文档交接清晰度通过”。任何`NO`都不能永久给后续版本背书；每次实质修订后都重审。曾启动但因HTTP 400没有产生审查内容的实例不计轮次。文档无法阻止有意篡改测试的人，实际防线仍是固定acceptance registry、negative fixtures、源码/产物identity、独立oracle和不同身份审查者。

## 24. 低能力接手者算法施工手册：遇到算法时照着做，不要自行简化

本节是第 15 节各阶段的逐算法展开。它不是可选参考。后续接手者看到“实现 session”“渐进加载”“重映射”“增量索引”“独立 verifier”这类短语时，必须来到本节按对应算法卡实施。若现有类型名与伪代码不同，可以调整名字；输入语义、状态迁移、不变量、复杂度和失败行为不得调整。

### 24.0 所有算法卡的统一使用规则

每次只实现一张卡，按以下固定顺序：

```text
1. 用 rg 找到“权威输入的生产者”和“输出的全部消费者”
2. 画出当前调用链，记录当前计数/失败
3. 先加输入解码、状态机和不变量测试
4. 再写最小实现
5. 跑该卡列出的单元/集成/真实 smoke
6. 检查时间复杂度、峰值内存和释放计数
7. 更新阶段 artifact；失败则停在本卡，不跳下一卡
```

每张卡都要在实现日志中填写：

```text
algorithmId
ownerLayer = bridge | main/core | renderer-worker | renderer-gpu | acceptance
inputType / outputType
sourceIdentity / workspaceSessionGeneration / pathSourceGeneration / sceneGeneration-or-null / rendererContextGeneration-or-null / correlationId
beforeCounters / afterCounters
invariants[]
failureCode
tests[]
```

禁止事项：

- 不要把伪代码整段塞进一个 500 行函数。按现有模块边界拆成“解码/验证、状态、投影、资源释放”几个小函数，但不要为每十行新建 class。
- 不要把 Bridge 应做的 native 解析搬到 TypeScript；也不要把 renderer 的 GPU 对象搬进 core/main DTO。
- 不要吞异常后返回空数组。空资源和解析失败必须可区分。
- 不要在循环内反复 `find/filter/spread/JSON.stringify` 全集合。先建索引，再做一次线性扫描。
- 不要通过扩大上限、减少数据或跳过失败项使测试变绿。
- 算法输出进入下一层之前必须完成边界验证；下一层不得猜缺失字段。

统一复杂度符号：

```text
F = 工作区文件数
E = BND entry 数
R = PARAM 物理行数
V = 单 mesh 顶点数
I = 单 face set 原始 index 数
T = 输出三角形数
P = 地图 placement/part 数
M = 唯一模型数
B = 骨骼数
K = 正权重 influence 数
```

除非算法卡另说，允许复杂度为 `O(F+E+R+V+I+P+B+K)`；任何在同一模型到达时重新扫描全部 P、每一页重新扫描/解析全部 R、每个 part 重建全部 B 的实现都要先停下，因为它会形成用户看到的灾难性下降。

### 24.1 A0-1：source snapshot 的唯一规范算法

目标：任何一次 Gate 只能使用同一份源码；测试中途改文件必须立即使整轮证据失效。

不要让接手者自行决定“哪些改动算源码”。固定输入集合如下：

1. `git rev-parse HEAD` 的 40 位 commit id。
2. `git diff --binary --no-ext-diff HEAD -- .` 的原始字节，覆盖 staged 与 unstaged tracked 变化。
3. `git ls-files --others --exclude-standard -z` 返回的全部非 ignored 未跟踪文件；不按扩展名筛选。
4. `package.json`、lockfile、治理 JSON、测试 schema 若已 tracked，天然包含在 HEAD/diff 中，不另造例外。
5. ignored 的 `node_modules/dist/bin/obj/output/release` 不纳入源码 snapshot；实际 Bridge exe、Electron bundle和 corpus manifest分别作为 product/corpus identity 单独记录。

规范化数据结构固定为：

```ts
interface MissionSourceSnapshotV1 {
  schema: "mission1-source-snapshot-v1";
  gitHead: string;
  trackedPatch: { byteLength: number; sha256: string };
  trackedChanges: Array<{
    pathPosix: string;
    status: "A"|"M"|"D"|"T";
    headMode: string;
    worktreeMode: string;
    headBlobOid: string;
    worktreeKind: "regular"|"deleted";
    worktreeByteLength: number|null;
    worktreeSha256: string|null;
  }>;
  untracked: Array<{ pathPosix: string; byteLength: number; sha256: string }>;
}
```

逐步算法：

```text
captureSourceSnapshot():
  headBytes = spawnExact("git", ["rev-parse", "HEAD"])
  require exitCode == 0
  head = trimOneTrailingNewline(headBytes.stdout)
  require /^[0-9a-f]{40}$/

  patchBytes = spawnExact("git", ["diff", "--binary", "--no-ext-diff", "HEAD", "--", "."])
  require exitCode == 0

  rawChangesBytes = spawnExact("git", ["diff", "--raw", "-z", "--no-renames", "--no-ext-diff", "HEAD", "--", "."])
  require exitCode == 0
  parsedChanges = parseGitRawZWithoutLocaleOrShell(rawChangesBytes.stdout)
  require every status is one of A/M/D/T; unresolved U and unexpected R/C fail closed
  trackedChanges = []
  for change in parsedChanges sorted by path UTF-8 bytes:
      validate path with the same lexical/reparse/final-path rules used below
      if status == D:
          append modes/headBlobOid and {worktreeKind:"deleted",byteLength:null,sha256:null}
      else:
          open the exact non-reparse regular worktree file without following links
          hash bytes once through stable handle; fstat before/after
          append modes/headBlobOid + worktree byteLength/SHA-256

  namesBytes = spawnExact("git", ["ls-files", "--others", "--exclude-standard", "-z"])
  require exitCode == 0
  names = splitByNul(namesBytes.stdout)
  require names contains no empty/interior NUL/path traversal

  untracked = []
  for path in sortByUtf8BufferCompare(names):
      require path is relative, normalized, contains no '..' segment, NUL or alternate separator escape
      lexical = resolve(repoRoot, path)
      require lexical remains under repoRoot before any filesystem dereference
      linkStat = lstat(lexical) without following the directory entry
      require linkStat is a regular file and not a symbolic link
      on Windows inspect FILE_ATTRIBUTE_REPARSE_POINT/FileAttributeTagInfo on lexical itself
      if any reparse tag is present: fail SOURCE_UNTRACKED_REPARSE_POINT; never call realpath/read
      finalPath = realpath/final-path of the already proven non-reparse regular file
      require finalPath remains under repoRoot
      bytes = read exact file bytes through a no-follow/opened handle where platform supports it
      fstat same handle before and after read; require file identity/size/mtime unchanged
      append {pathPosix, byteLength, sha256(bytes)}

  object = {schema, gitHead, trackedPatch:{...}, trackedChanges, untracked}
  canonicalJson = JSON with fixed field order, UTF-8, LF, no indentation
  snapshotSha256 = sha256(canonicalJson)
  persist canonicalJson, patchBytes and rawChangesBytes as immutable artifacts in this run
  return {object, snapshotSha256, artifactHashes}
```

重要细节：

- `spawnExact` 使用 executable + args，`shell:false`；禁止把路径拼成 shell 字符串。
- 路径排序**唯一**允许 `Buffer.compare(Buffer.from(pathA,"utf8"), Buffer.from(pathB,"utf8"))`；禁止 `localeCompare`、当前区域排序、大小写折叠或 Unicode normalization，因为它们与 UTF-8 原始字节序不等价。
- 顺序必须是“词法边界检查 -> `lstat`/Windows reparse attribute -> 拒绝链接 -> final path -> open/read”。禁止先 `realpath` 再检查 symlink；那已经跟随了链接。Windows adapter若无法读取 `FILE_ATTRIBUTE_REPARSE_POINT`，snapshot 固定 FAIL `SOURCE_REPARSE_CHECK_UNAVAILABLE`，不得假设安全。
- tracked patch 哈希原始 bytes，不先把 CRLF 改 LF；否则 Windows 上会把不同工作树算成同一身份。
- `trackedPatch.sha256`证明整份binary patch没有漂移；`trackedChanges[]`专门让`--resume`能计算路径差。两者必须同时存在且由runner交叉核对：重放`trackedChanges`对应的工作树bytes/mode后所得当前raw path set必须一致。禁止只保存patch总hash后凭文件名猜阶段，也禁止只保存path而漏掉同路径内容二次变化。
- `git --raw -z`解析器按NUL和Git raw grammar读原始bytes，不把输出先转成按行字符串；`--no-renames`使rename明确成为D+A两条路径。merge conflict/unmerged状态固定`SOURCE_UNMERGED`，不得继续验收。
- 每个子命令开始前和结束后都重新调用；任何字段不同，结果固定为 `SOURCE_CHANGED_DURING_RUN`，丢弃本轮全部 PASS。
- snapshot 算法自己的 fixture 必须覆盖 staged、unstaged、untracked、空格/中文路径、CRLF、文件执行中变化和 symlink/reparse point。

`diffSnapshot(old,current)`不允许从两个总hash反推路径：

```text
require old canonical snapshot artifact and artifact hash仍存在
if old.gitHead == current.gitHead:
  changedPaths = union(keys(old.trackedChanges), keys(current.trackedChanges),
                       keys(old.untracked), keys(current.untracked))
  keep path iff对应完整record不相等
else:
  require old/new commit object均可读取
  headPaths = parse `git diff --name-status -z --no-renames oldHead..newHead`
  changedPaths = headPaths union上述dirty/untracked record差分
  若命令失败、历史对象缺失或路径解析不唯一，固定返回A0/GIT_HEAD_CHANGE_UNMAPPED
sort changedPaths by UTF-8 bytes; empty set while snapshot hash differs is STATE_SNAPSHOT_DIFF_INCONSISTENT
```

复杂度：读取 diff、每个changed tracked worktree文件与未跟踪文件各一次，`O(sourceBytes)`；snapshot path差分`O(changedPathCount log changedPathCount)`。不得遍历 `node_modules` 或给全部 tracked clean 文件逐个哈希。

### 24.2 A0-2：聚合 runner、artifact、resume 和阶段状态算法

目标：实现者不能给自己手写 PASS，也不能拿旧日志拼接通过。

先定义三个不同对象，禁止混用：

```ts
type AssertionStatus = "PASS" | "FAIL";

interface RawCommandArtifactV1 {
  schema: "mission1-command-artifact-v1";
  runNonce: string;                 // runner 当轮随机 128 bit
  assertionIds: string[];           // 由静态 registry 决定
  exactExecutable: string;
  exactArgs: string[];
  cwd: string;
  startedAtUtc: string;
  finishedAtUtc: string;
  exitCode: number | null;
  timedOut: boolean;
  stdoutSha256: string;
  stderrSha256: string;
  observationJsonSha256?: string;
  sourceBefore: string;
  sourceAfter: string;
  runtimeInputs: Array<{
    role: string;
    canonicalPath: string;
    byteLength: number;
    sha256: string;
  }>;
}

// child唯一可写的机器结果；任何status/pass/gate/stage字段都被schema拒绝
interface ChildObservationEnvelopeV1 {
  schema: "mission1-child-observation-v1";
  runNonce: string;
  assertionId: string;
  observationSchemaId: string;
  payload: unknown;                 // 由observationSchemaId对应的封闭schema验证
}

// 只由parent runner根据predicate计算；child不能生成/提供这个对象
interface DerivedAssertionResultV1 {
  assertionId: string;
  status: AssertionStatus;
  failureKind?: "implementation" | "regression" | "environment_blocked" | "corpus_changed";
  predicateId: string;
  observationSha256: string|null;
  artifactHashes: string[];
  reasonCode?: string;
}

interface AssertionResultManifestV1 {
  schema: "mission1-assertion-result-manifest-v1";
  runKind: "BOOTSTRAP"|"STAGE"|"FINAL_H";
  stage: "A0"|"A1"|"A2"|"B"|"C"|"D"|"E"|"F"|"G"|"H"|null;
  runNonce: string;
  sourceSnapshotSha256: string;
  assertionRegistrySha256: string;
  requestedAssertionIds: string[];
  results: DerivedAssertionResultV1[]; // 与requested IDs一一对应，按(stageRank,order)，不缺/重复
  manifestSha256: string;              // canonical payload不含本字段
}

interface ArtifactManifestV1 {
  schema: "mission1-artifact-manifest-v1";
  runNonce: string;
  sourceSnapshotSha256: string;
  artifacts: Array<{
    role: string;
    relativePathPosix: string;       // 只能位于本轮evidence目录，禁止..、绝对路径、reparse
    byteLength: number;
    sha256: string;
    createdAtUtc: string;
  }>;
  artifactCount: number;             // === artifacts.length
  manifestSha256: string;            // canonical payload不含本字段
}

interface AssertionSpecV1 {
  assertionId: string;
  order: number;                    // 全 registry 唯一正整数
  stage: "A0"|"A1"|"A2"|"B"|"C"|"D"|"E"|"F"|"G"|"H";
  gate: "G0"|"G1"|"G2"|"G3"|"G4"|"G5"|"G6"|"G7"|null;
  nextActionCode: string;           // 静态枚举，不由 child/observation.json 提供
  stageInvocation: ExactAssertionInvocationV1|null;
  finalHInvocation: ExactAssertionInvocationV1|null;
  timeoutMs: number;
  sourceInputs: readonly SourceInputRuleV1[];
  runtimeInputs: readonly RuntimeInputSpecV1[];
  observationSchemaId: string;
  predicateId: string;
  requiredArtifactRoles: readonly string[];
}

interface ExactAssertionInvocationV1 {
  executable: string;                // 静态registry字面值；解析后再锁absolute path/hash
  args: readonly string[];
  shell: false;
  semanticMode: "EXECUTE_STAGE"|"REEXECUTE_FINAL"|"VERIFY_FROZEN_A0"|"VERIFY_FROZEN_A2";
}

type RuntimeInputSpecV1 =
  | {
      role: string;                  // 在该assertion内唯一、非空、静态闭集
      kind: "exact-file"|"executable";
      locator: {source:"repo-relative-literal"|"absolute-literal"|"fixed-env-name";value:string};
      allowedRootRole: "repo"|"build-output"|"game-readonly"|"tools-readonly"|"test-temp";
      required: true;
    }
  | {
      role: string;
      kind: "manifest-expansion";
      manifestLocator: {source:"repo-relative-literal"|"state-json-pointer";value:string};
      entryPathField: string;         // 固定JSON pointer，不允许child选择
      entryHashField: string;
      allowedRootRole: "game-readonly"|"tools-readonly"|"evidence-readonly";
      required: true;
    }
  | {
      role: string;
      kind: "environment-value";
      envName: string;                // registry固定名称；artifact只保存presence/value SHA-256
      required: true;
    };

interface SourceInputRuleV1 {
  kind: "exact-path"|"path-prefix"|"git-head"|"governance-projection";
  value: string;                    // repo-relative POSIX path/prefix；禁止自由 glob/regex
}

interface StageInputRegistryV1 {
  schema: "mission1-stage-input-registry-v1";
  assertions: readonly AssertionSpecV1[];
}

interface StageCheckpointV1 {
  schema: "mission1-stage-checkpoint-v1";
  stage: "A0"|"A1"|"A2"|"B"|"C"|"D"|"E"|"F"|"G"|"H";
  runNonce: string;
  evidenceRunDirectoryName: string;
  passedSourceSnapshotSha256: string;
  sourceSnapshotArtifactSha256: string;
  assertionResultManifestSha256: string;
  artifactManifestSha256: string;
  prerequisiteCheckpointHashes: string[];
  checkpointSha256: string;          // canonical payload不含本字段
}

interface MissionStateV1 {
  schema: "mission1-state-v1";
  runNonce: string;
  runnerTrustRootSha256: string;
  assertionRegistrySha256: string;
  stageInputRegistrySha256: string;
  sourceSnapshotSha256: string;
  sourceSnapshotArtifactSha256: string;
  evidenceRunDirectoryName: string;  // 安全单segment：UTC-sourceHashPrefix-runNonce
  artifactManifestSha256: string;
  assertionResultManifestSha256: string;
  a0IndependentReviewArtifactSha256: string|null;
  a2IndependentReviewArtifactSha256: string|null;
  stageCheckpoints: Record<"A0"|"A1"|"A2"|"B"|"C"|"D"|"E"|"F"|"G"|"H", StageCheckpointV1|null>;
  stages: Record<"A0"|"A1"|"A2"|"B"|"C"|"D"|"E"|"F"|"G"|"H", "PASS"|"FAIL">;
  gates: Record<"G0"|"G1"|"G2"|"G3"|"G4"|"G5"|"G6"|"G7", "PASS"|"FAIL">;
  overallStatus: "PASS"|"FAIL";
  firstFailure: { stage:"A0"|"A1"|"A2"|"B"|"C"|"D"|"E"|"F"|"G"|"H"; assertionId: string; order: number; nextActionCode: string } | null;
  stateSha256: string;
}
```

`BOOTSTRAP`是唯一允许`requestedAssertionIds/results=[]`的manifest且只能发布全FAIL state；`STAGE`的requested集合必须精确等于该stage specs（H不使用`STAGE`，只使用`FINAL_H`）；`FINAL_H`必须等于A0 specs、A2 verify specs和所有`gate!=null` specs的静态并集。child/命令行不能减少集合。manifest validator逐ID检查spec存在、结果predicate/schema/artifact对应，不能用“未请求”隐藏FAIL。A0/A2的`finalHInvocation.semanticMode`必须分别为`VERIFY_FROZEN_A0/VERIFY_FROZEN_A2`，只核对既有外部review、用户确认、authority root与冻结artifact，禁止重生成；A1及B-G在H使用`REEXECUTE_FINAL`重新执行，H自身G0/G7 specs只有`finalHInvocation`。任何应存在的invocation为null、模式错误或两种模式用了不同predicate/schema，runner启动即`ASSERTION_INVOCATION_REGISTRY_INVALID`。`StageCheckpointV1`不是悬空hash：它自己的run directory、artifact manifest、result manifest和source snapshot artifact必须全部可重开并逐hash验证，`checkpointSha256`不自包含；当前state顶部的单个`evidenceRunDirectoryName/artifactManifestSha256`只描述**本次状态发布run**，不能假装同时承载A0到G的旧checkpoint artifacts。

旧schema、缺`runnerTrustRootSha256`的state、或由第0.8节runner生成的state一律只进入quarantine，不参与resume。`evidenceRunDirectoryName`必须是单一安全segment，runner只在固定`output/mission1-evidence/`下做lexical+reparse+final-path检查后打开；按ArtifactManifest逐个stable-handle重哈希，要求runNonce/source/数量/role/path/hash和state引用完全一致。未列出的文件不能补证据，列出但缺失/多出、manifest自hash错误或路径逃逸固定`STATE_ARTIFACT_MANIFEST_INVALID`。候选runner不存在时，接手者直接执行A0静态施工步骤；不创建prebootstrap PASS/路由文件。候选runner可运行后，第一次`--bootstrap`只创建全FAIL state；A0独立审查完成以前，该state仍不能驱动产品阶段。

runner 只允许以下状态迁移：

```text
bootstrap:
  A0..H = FAIL, G0..G7 = FAIL, overallStatus=FAIL
  stageCheckpoints全部null
  firstFailure = A0中order最小的assertion

after A0 implementation + independent review:
  rerun every A0 negative assertion on exact A0-final snapshot
  all pass and frozen bad bytes all rejected -> publish A0=PASS; later stages/Gates remain FAIL
  otherwise retain prior complete state or all-FAIL bootstrap; never publish partial state

after A1:
  require A0 PASS and unchanged runner trust root
  rerun A1 build assertions on exact current snapshot
  A1 = all mapped assertions PASS; later stages remain FAIL；G0..G7仍全部FAIL

after A2:
  require A0/A1 PASS and unchanged runner trust root
  rerun corpus/rule-registry/schedule assertions and prerequisite identities
  A2 = all mapped assertions PASS; later stages remain FAIL；G0..G7仍全部FAIL

after one later stage runner:
  all prior stages must already PASS
  current stage = all mapped assertions PASS ? PASS : FAIL
  later stages remain FAIL；G0..G7仍全部FAIL

stage H:
  recapture final source snapshot
  在同一process tree重新运行每个gate!=null的assertion，不复用阶段checkpoint里的绿灯
  重新运行A0 trust assertions，并verify而非重生成A2 corpus/rule/schedule/review artifacts
  any trust FAIL => H/overall FAIL；Gate仍按自身fresh结果显示，但不能整体完成
  any gate assertion FAIL => H/overall FAIL and corresponding Gate FAIL
  取本轮所有FAIL result中(stageRank,order)最小者作为returnOwner
  若returnOwner属于A0/A1/A2/B..G：清除该stage及以后checkpoint/status，再把控制权退回该stage
  若returnOwner属于H：只令H FAIL；保留A0..G checkpoint，控制权留在H
  all trust + G0..G7 PASS + unchanged final snapshot => H/overall PASS
```

三套状态不能混用：`stageCheckpoints/stages`表示实施顺序以及H发现回归后的唯一返工入口；`gates`只表示阶段H同一最终snapshot的新鲜聚合；`overallStatus`还要求A0/A2 trust重验证和最终snapshot稳定。A0到G期间即使一个测试对应G1/G3，`gates`仍全部FAIL，避免把旧阶段证据拼成最终PASS。每次state发布都从checkpoint和本轮manifest**重新派生**`stages/gates/overall/firstFailure`，调用方不能传这些字段的值。H中某个B阶段assertion重新执行失败时，不能留下`B=PASS,H=FAIL`再让接手者只重跑H；必须按上面的returnOwner原子清除B..H并令`firstFailure`指向该B断言。只有H-own的G0/G7 assertion失败才保持A0..G PASS、H FAIL。

固定阶段序为`stageRank={A0:0,A1:1,A2:2,B:3,C:4,D:5,E:6,F:7,G:8,H:9}`。`order`只在同一阶段内决定断言先后；不同阶段比较必须先比较`stageRank`，再比较`order`。这消除了当前A2断言编号小于A1/G1编号时错误跳到A2的路径。

state一致性验证至少强制：每个PASS stage都有同名且hash可达的checkpoint；每个checkpoint通过其自己的`evidenceRunDirectoryName + runNonce + artifactManifestSha256`递归验证且prerequisite hash顺序精确等于此前PASS checkpoint，不能只在当前run目录搜索同名hash；第一个FAIL stage之后所有stage均FAIL/checkpoint null；H PASS等价于`overallStatus=PASS`；`overallStatus=PASS`等价于A0/A2 trust fresh、G0..G7全PASS且final snapshot未变；`firstFailure===null`当且仅当overall PASS。非H阶段执行后，`firstFailure`是第一个FAIL stage中order最小的未通过spec；FINAL_H失败后，它是上述returnOwner，且stored stage清除结果必须与其stage一致。任何“所有stage PASS但Gate FAIL且firstFailure null”、“A1 final重跑失败却仍保留A1 PASS”、“B仍PASS但H新鲜B断言已FAIL”、checkpoint只剩不可定位hash、artifact manifest缺引用、runNonce不一致或派生值与存储值不同都固定`STATE_DERIVATION_MISMATCH -> A0`。

命令执行伪代码：

```text
runAssertion(spec, runKind):
  before = captureSourceSnapshot()
  require before.hash == runRootSnapshot.hash
  invocation = runKind==STAGE ? spec.stageInvocation : spec.finalHInvocation
  require invocation exists, invocation.shell==false and semanticMode matches registry invariants
  nonce = cryptographicRandom128()
  resultDir = new empty directory under current run / assertionId / nonce
  env = minimal inherited env + MISSION1_RUN_NONCE + MISSION1_RESULT_DIR
  resolve every spec.runtimeInputs path, hash file/executable/config bytes, record role/path/size/hash
  record presence + value SHA-256 for behavior-affecting env vars; never write secret plaintext
  child = spawn(invocation.executable, invocation.args, shell=false, cwd=repoRoot, env)
  stream stdout/stderr directly to new files while hashing; do not buffer unlimited output
  enforce timeout; on timeout kill owned process tree, mark FAIL
  wait for exit and handles to close
  after = captureSourceSnapshot()
  if before != after: FAIL SOURCE_CHANGED_DURING_RUN
  parse only resultDir/observation.json created after startedAt
  require ChildObservationEnvelopeV1 exact, nonce/assertion/schema id exact
  validate payload with spec.observationSchemaId对应的封闭schema；拒绝未知/缺失字段
  reject child control fields status/pass/passed/success/ok/gate/stage/nextAction/nextActionCode
  require every spec.requiredArtifactRole恰有一个本轮raw artifact并核对hash
  require source snapshot、corpus、Bridge和runtime input identity exact
  reject measurements containing skipped/not-run/N/A/candidate/fixture-only
  if ETW/declared file-access audit observes an ignored runtime file not listed by spec: FAIL UNDECLARED_RUNTIME_INPUT
  predicate = parent-owned closed predicateRegistry[spec.predicateId]
  require predicate声明的observationSchemaId与spec完全一致
  compute DerivedAssertionResult from exitCode + timeout + typed facts + raw artifacts
  never read a child-provided conclusion；child即使exit 0，缺一项事实仍FAIL
  reject child fields named nextAction/nextActionCode/order; child cannot steer control flow
  hash raw artifacts and append immutable summary entry
```

`observationSchemaId`和`predicateId`都是A0 trust root中的静态闭集。例如地图frame断言的payload只能给出`frameCount/frameByteLengths/sequence/complete/chunkHashes`等事实；pointer断言只能给出raw pointer/TransformControls/semantic mutation trace；它们不能给出“geometryPassed=true”。每个predicate都有正例、逐必填字段删除、边界值、child exit 0但事实失败、child写`status:"PASS"`的负例。runner启动时验证：schema/predicate双射、每个spec的artifact role非空且唯一、任何schema引用不存在都使A0 FAIL。`RuntimeInputSpecV1`的locator由parent解析：禁止glob、PATH模糊命中、child回传路径或shell展开；先按allowed root做词法/reparse/final-path检查，再用stable handle哈希。`manifest-expansion`先验证manifest自身identity，再逐条展开其精确path+expected hash；空展开、重复path、hash不符或file-access audit看到未声明输入都FAIL。环境值只记录presence和UTF-8 value hash，secret不落明文。

negative fixture也不是注释里的表名，固定机器manifest如下：

```ts
interface RunnerNegativeFixtureManifestV1 {
  schema: "mission1-runner-negative-fixtures-v1";
  fixtures: Array<{
    fixtureId: string;
    exactCommand: {executable:string;args:string[];shell:false};
    inputArtifactRoles: Array<{role:string;sha256:string;byteLength:number}>;
    assertionId: string;
    expectedReasonCode: string;
    forbiddenPassStages: string[];
    forbiddenPassGates: string[];
  }>;
  fixtureCount: number;             // === fixtures.length
  manifestSha256: string;           // canonical payload不含本字段
}
```

manifest至少逐项覆盖第0.8节矩阵，fixture id唯一并按UTF-8排序；每项必须spawn其`exactCommand`并生成独立raw command artifact，不能由一个测试函数循环里只断言名称存在。runner selftest从manifest逐项执行，要求实际reason code完全相等，且`forbiddenPassStages/Gates`保持FAIL。漏一项、输入hash不同、命令未启动、只返回expected字符串或fixtureCount不等都固定`RUNNER_NEGATIVE_FIXTURE_INCOMPLETE`。

#### 24.2.1 canonical state bytes、原子发布与恢复

`stateSha256`不能把自己包含在被哈希对象里。唯一算法：

```text
canonicalStateBytes(stateWithoutHash):
  construct fresh object with schema fields in schema order
  sort only maps whose schema explicitly says UTF-8 key order; arrays retain semantic order
  reject unknown/missing fields, NaN, Infinity, undefined and non-integer numeric identities
  encode compact JSON as UTF-8, no BOM, no trailing newline

publishState(next):
  require next is computed solely from current-run assertion results
  for every newly PASS stage construct StageCheckpointV1 from this run's already-fsynced source/result/artifact manifests
  hash checkpoint payload without checkpointSha256; persist/reopen/verify it inside this exact evidenceRunDirectoryName
  copy only its hash+typed fields into next.stageCheckpoints；never copy old artifacts into the current run to fake reachability
  bytes0 = canonicalStateBytes(next without stateSha256)
  next.stateSha256 = lowercaseHex(SHA-256(bytes0))
  finalBytes = canonical full-state JSON with stateSha256 last
  exclusive-create temp file in current-state parent; temp name includes runNonce
  write all finalBytes; flush userspace buffer; fsync/FlushFileBuffers temp handle; close
  reopen temp and parse; remove stateSha256; recompute and require equal
  atomically replace current-state.json within same directory and volume
  fsync/FlushFileBuffers parent directory where platform supports it
  reopen current-state and require exact finalBytes; only then report published
```

Windows实现必须调用同卷原子replace/rename语义并记录具体API及结果；若当前Node/文件系统不能给出要求的durability，返回`STATE_ATOMIC_REPLACE_UNAVAILABLE`，不能退回`writeFileSync(current-state)`。崩溃fixture在`checkpoint/artifact flush、temp create/write/flush/verify/rename/parent flush`每个边界注入退出：rename前重启必须读到旧完整state，rename后必须读到新完整state；新state引用的每个checkpoint run directory也必须已经durable且可达。启动时遗留temp只按合法prefix、普通非reparse文件、超过TTL且不被当前runNonce持有的精确路径清理；禁止glob递归删除output。任何checkpoint run目录缺失/被改写固定`STATE_CHECKPOINT_ARTIFACT_UNREACHABLE -> A0`，不能把该stage悄悄降FAIL后继续。

#### 24.2.2 `stageInputRegistry` 与 `--resume` 的唯一算法

每条source path必须映射到至少一个assertion，才能声称知道“从哪个阶段恢复”。runner engine、registry、artifact/state schema、Gate映射和negative fixture属于A0 trust root；corpus generator/verifier、expected manifest、FaceSet/resource-edge registry、scenario/threshold/schedule属于A2；产品路径映射到其最早**语义owner阶段**assertion。A1的编译器会读取产品源码，但这不把每次B-G产品编辑都重新归属A1；对应产品阶段仍必须执行自己的build/typecheck验证，H再重跑G1。相同path可以映射多项，按`(stageRank,order)`取最早。

`sourceInputs`只允许exact path/prefix；prefix必须以`/`结尾并按POSIX path segment比较，禁止用`startsWith("apps/foo")`误命中`apps/foobar`。git HEAD变化视为clean tracked tree发生变化，默认回A0；只有runner能从两个已验证Git tree逐path列出changed set且全部映射时才可精确恢复。ignored runtime input变化由实际使用它的assertion失效，不混进source snapshot。

```text
resume():
  oldBytes = read current-state through a non-following stable handle
  validate exact schema, canonical state hash, runnerTrustRootSha256 and artifact references
  if any validation fails: return stage=A0, code=STATE_TRUST_INVALID

  current = captureSourceSnapshot()
  if current.hash == old.sourceSnapshotSha256:
      return first stage in [A0,A1,A2,B,C,D,E,F,G,H] whose status != PASS

  changedPaths = diffSnapshot(oldReferencedSnapshot,current)
  if old referenced snapshot bytes/artifact missing: return A0/SOURCE_ANCESTOR_MISSING
  impacted = empty set
  for changedPath in changedPaths:
      matches = registry assertions whose sourceInputs match changedPath
      if matches empty: return A0/STAGE_INPUT_UNMAPPED
      impacted += matches
  if HEAD changed and exact changed paths cannot be proven: return A0/GIT_HEAD_CHANGE_UNMAPPED

  earliest = assertion in impacted with minimum tuple(stageRank[stage], order)
  invalidAssertions = transitive dependents of impacted plus all later-stage assertions
  construct new state from old; clear earliest.stage及其后checkpoint并把这些stage设FAIL
  gates全部设FAIL，H checkpoint清空，overallStatus=FAIL
  firstFailure = earliest stage中order最小的受影响/必做assertion
  publishState(invalidated state) before executing any assertion
  resume from earliest; revalidate every prerequisite artifact identity
```

dependency graph是静态DAG，runner启动时做拓扑/环检测；child JSON不能声明dependencies。任何A0 trust-root文件变化固定使A0及之后全失效；A2验收输入变化使A2及之后全失效；产品代码变化不能反向重写A2 expected outcome。old state必须引用24.1的canonical snapshot、tracked patch/raw-change artifacts；缺任一项不能算`changedPaths`，固定A0/SOURCE_ANCESTOR_MISSING。`--resume`禁止接受`--stage`、`--pass`、`--ignore-unmapped`、`--accept-old-schema`等人工降级开关。复杂度`O(changedPaths * indexedPrefixDepth + dependencyEdges)`；registry预建exact map和path-segment trie，禁止每次以自由正则扫描全部source×assertion。

固定 assertion registry 不能从命令行覆盖。每项都必须显式保存唯一`order/stage/gate/nextActionCode`；下面是最低registry，编号、ID、stage、gate和action code均为契约。编号按阶段留出区间，不能再出现A2编号排在A1前面。后续只能在同阶段预留区间增加更细断言，不得删除、改名、跨阶段移动或映射到更弱证据：

```text
order | stage | gate | assertionId                              | nextActionCode
010   | A0    | -    | A0.snapshot-negative-fixtures             | FIX_SOURCE_SNAPSHOT_TRUST
020   | A0    | -    | A0.artifact-replay-fixtures               | FIX_ARTIFACT_REPLAY_GUARD
030   | A0    | -    | A0.child-exit-and-typed-artifact          | FIX_RUNNER_FAIL_CLOSED
040   | A0    | -    | A0.state-atomicity                        | FIX_STATE_ATOMICITY
050   | A0    | -    | A0.stage-input-resume                     | FIX_STAGE_INPUT_REGISTRY
060   | A0    | -    | A0.independent-attack-review              | REQUEST_INDEPENDENT_RUNNER_REVIEW
110   | A1    | G1   | G1.diff-check                             | FIX_DIFF_CHECK
120   | A1    | G1   | G1.typecheck                              | FIX_TYPECHECK
130   | A1    | G1   | G1.bridge-build                           | FIX_BRIDGE_BUILD
140   | A1    | G1   | G1.renderer-build                         | FIX_RENDERER_BUILD
210   | A2    | -    | A2.corpus-independent-verifier            | FIX_CORPUS_TRUST
220   | A2    | -    | A2.native-rule-registries                 | FIX_NATIVE_RULE_REGISTRIES
230   | A2    | -    | A2.performance-plan                       | FIX_ACCEPTANCE_PLAN
240   | A2    | -    | A2.independent-attack-review              | REQUEST_INDEPENDENT_INPUT_REVIEW
310   | B     | G3   | G3.param-physical-row-identity            | FIX_PARAM_PHYSICAL_IDENTITY
320   | B     | G3   | G3.param-138-table-native                 | FIX_PARAM_NATIVE_CORPUS
330   | B     | G3   | G3.param-writeback                        | FIX_PARAM_WRITEBACK
410   | C     | G3   | G3.param-native-session                   | FIX_PARAM_SESSION_LIFETIME
420   | C     | G3   | G3.param-large-table-ui                   | FIX_PARAM_UI_HOT_PATH
510   | D     | G4   | G4.map-route-all-types                    | FIX_MAP_TYPED_ROUTING
520   | D     | G4   | G4.map-499-outcomes                       | FIX_MAP_CORPUS_OUTCOME
530   | D     | G4   | G4.map-geometry-oracle                    | FIX_FLVER_GEOMETRY_SEMANTICS
540   | D     | G4   | G4.map-static-dto                         | FIX_MAP_STATIC_DTO
550   | D     | G4   | G4.map-chunk-protocol                     | FIX_MAP_CHUNK_PROTOCOL
610   | E     | G5   | G5.map-loading-interaction                | FIX_MAP_LOADING_RESPONSIVENESS
620   | E     | G5   | G5.map-loaded-frame                       | FIX_MAP_STEADY_FRAME
630   | E     | G5   | G5.map-pick                               | FIX_MAP_PICK
640   | E     | G5   | G5.gizmo-translate                        | FIX_GIZMO_TRANSLATE
650   | E     | G5   | G5.gizmo-rotate                           | FIX_GIZMO_ROTATE
660   | E     | G5   | G5.gizmo-scale                            | FIX_GIZMO_SCALE
670   | E     | G5   | G5.wire-gpu-lifecycle                     | FIX_WIRE_GPU_LIFETIME
710   | F     | G6   | G6.character-context-provenance           | FIX_CHARACTER_CONTEXT
720   | F     | G6   | G6.character-leader-remap                 | FIX_CHARACTER_REMAP
730   | F     | G6   | G6.character-cpu-gpu-skin                 | FIX_CHARACTER_SKINNING
740   | F     | G6   | G6.animation-explicit-containers          | FIX_ANIMATION_CONTEXT
750   | F     | G6   | G6.character-performance                  | FIX_CHARACTER_PERFORMANCE
810   | G     | G2   | G2.discovery-no-content-read              | FIX_DISCOVERY_METADATA_ONLY
820   | G     | G2   | G2.incremental-hash                       | FIX_INCREMENTAL_FINGERPRINT
830   | G     | G2   | G2.workspace-cancel-generation            | FIX_WORKSPACE_CANCELLATION
840   | G     | G2   | G2.foreground-priority                    | FIX_FOREGROUND_PRIORITY
850   | G     | G2   | G2.startup-performance                    | FIX_STARTUP_CRITICAL_PATH
910   | H     | G0   | G0.source-identity                        | RECAPTURE_SOURCE_IDENTITY
920   | H     | G0   | G0.bridge-executable-identity             | REPUBLISH_AND_BIND_BRIDGE
930   | H     | G0   | G0.corpus-identity                        | REGENERATE_AND_VERIFY_CORPUS
940   | H     | G0   | G0.runner-negative-fixtures               | FIX_RUNNER_FAIL_CLOSED
950   | H     | G7   | G7.public-regression                      | FIX_PUBLIC_REGRESSION
960   | H     | G7   | G7.failure-injection                      | FIX_FAILURE_CLEANUP
970   | H     | G7   | G7.patch-writeback-rollback               | FIX_PATCH_ROLLBACK
980   | H     | G7   | G7.game-root-readonly                     | FIX_GAME_ROOT_READONLY
990   | H     | G7   | G7.governance                             | FIX_GOVERNANCE_GATE
```

registry启动验证要求order全局唯一、stage区间与上表一致、ID前缀与非null gate一致。A0/A2是唯一允许`gate=null`的stage；A1/B/C/D/E/F/G/H的每个产品/回归assertion必须映射一个Gate。A0/A2/A1/B..G必须各有合法stage invocation和final-H invocation；H specs的stage invocation固定null、final-H invocation非null；A0/A2 final模式只能verify frozen inputs，其他非H项final模式只能reexecute。G0-G7各自的required assertion ID集合必须与上表精确相等且非空，不能靠空集合AND得到PASS。`firstFailure`先选最小FAIL stageRank，再在该stage按order选最小项；FINAL_H使用同一tuple决定returnOwner并清除对应stage。`nextActionCode`只复制spec静态值。展示层可用版本化只读字典翻译，但不能从child stdout/observation、异常message、对象枚举顺序或人工输入生成next action。

Gate 算法只能是逻辑 AND：

```text
gate(Gx) = PASS iff requiredIds(Gx)非空且每个spec.gate==Gx的fresh H result均PASS
trust    = PASS iff A0 assertions本轮重跑PASS且A2 frozen artifacts/reviews本轮verify PASS
overall  = PASS iff trust PASS、every G0..G7 PASS、H PASS且final source snapshot未变
```

不允许权重、百分比、`allowFailure`、`optional`、`flaky retry until green`。进程因环境缺失失败时 `failureKind=environment_blocked`，仍是 FAIL。

A0/A2的防自证必须分开。A0只审runner engine、registry/state/artifact/snapshot/resume和negative fixture；A2只审corpus、格式规则、resource edge与performance plan。两批分别交给**从未参与编写且不继承本线程上下文**的审查agent，只给根`AGENTS.md`、本文件、对应diff与需要攻击的raw bytes。A0审查者尝试删除assertion、复用旧observation、让child自报PASS、漏source、使用旧Bridge和破坏atomic state；A2审查者尝试交换corpus、删失败identity、用SoulForge输出定oracle、改变schedule。任一被接受，对应阶段不能PASS。产品B-G改动不能与这些审查批次混在一起。

“独立审查”不能是实现者自己写一个`review.json`。固定外部artifact如下：

```ts
interface IndependentReviewArtifactV1 {
  schema: "mission1-independent-review-v1";
  reviewKind: "A0_TRUST_ROOT"|"A2_ACCEPTANCE_INPUTS";
  dispatcherTaskIdentity: string;
  reviewerTaskIdentity: string;
  reviewerForkMode: "none";
  reviewerNonce: string;
  reviewedSourceSnapshotSha256: string;
  reviewedAuthorityRootSha256: string; // A0 trust-root bytes或A2 acceptance-input bytes的canonical manifest hash
  reviewedDiffSha256: string;
  quarantineArtifactHashes: string[];
  attackCases: Array<{
    attackId:string;
    inputArtifactHashes:string[];
    rawReviewerOutputSha256:string;
    observedReasonCode:string;
    bypassAccepted:boolean;
  }>;
  conclusion: "NO_BYPASS_FOUND"|"BYPASS_FOUND";
  startedAtUtc: string;
  finishedAtUtc: string;
  orchestratorDispatchReceiptSha256: string;
  rawFinalMessageSha256: string;
  artifactSha256: string; // canonical payload不含本字段
}

interface ReviewedAuthorityRootManifestV1 {
  schema: "mission1-reviewed-authority-root-v1";
  reviewKind: "A0_TRUST_ROOT"|"A2_ACCEPTANCE_INPUTS";
  files: Array<{repoRelativePathPosix:string;byteLength:number;sha256:string}>;
  ignoredRuntimeInputs: Array<{role:string;canonicalPath:string;byteLength:number;sha256:string}>;
  fileCount: number;
  manifestSha256: string; // canonical payload不含本字段
}

interface UserReviewAcceptanceV1 {
  schema: "mission1-user-review-acceptance-v1";
  reviewKind: "A0_TRUST_ROOT"|"A2_ACCEPTANCE_INPUTS";
  reviewedAuthorityRootSha256: string;
  reviewArtifactSha256: string;
  exactConfirmationText: string;
  userMessageRawSha256: string;
  userMessageRawArtifactSha256: string;
  acceptedAtUtc: string;
  artifactSha256: string; // canonical payload不含本字段
}
```

authority-root manifest的files按UTF-8 path排序并用24.19 canonical规则hash。A0集合精确为runner engine、assertion/stage registry、state/artifact/observation schema、parent predicates、snapshot/resume/atomic publisher、negative fixture manifest+inputs；A2集合精确为corpus generator/verifier及manifest、格式/resource-edge/coordinate/conversion registry、scenario/threshold/schedule和mature adapter identities。任何路径未归类或同一文件跨A0/A2且会改变两边行为都固定FAIL，不能让产品B-G文件混入审查root。

dispatcher先exclusive-create随机review output目录，再通过编排器启动`fork_turns=none`的新task；reviewer只能写该目录，runner自身无生成review artifact的代码路径。dispatcher保存spawn/wait返回的raw receipt和reviewer最终消息；reviewer task identity必须不同于实现者/dispatcher，A0与A2 reviewer也不同。每个attackCase要引用逐项raw输入/输出，不能只有一句“看过了”。`conclusion`必须为`NO_BYPASS_FOUND`且所有`bypassAccepted=false`；否则阶段FAIL。

由于本地agent身份不是密码学签名，A0/A2 PASS还要求用户对`reviewKind + reviewedAuthorityRootSha256 + reviewArtifactSha256`做一次明确确认。dispatcher先向用户显示这三个值并要求逐字回复`确认接受独立审查：<reviewKind> <authorityRootSha256> <reviewArtifactSha256>`；尖括号位置替换成刚显示的精确ASCII值，前后不得附加别的文本。main侧保存上面的`UserReviewAcceptanceV1`及原始UTF-8消息bytes；`exactConfirmationText`必须是替换完成后的期望句，runner逐byte比较并重算两个artifact hash。runner只消费并hash这两个**外部写入**artifact，不能生成、补字段或把自己的selftest当独立审查。`reviewedSourceSnapshotSha256`记录审查发生时的完整上下文，但后续B-G产品修改不使它自动失效；H重算当前A0/A2 authority-root manifest，必须分别等于reviewedAuthorityRootSha256。authority bytes变化、receipt缺失、同一reviewer、用户未确认或确认后review bytes变化，固定`INDEPENDENT_REVIEW_ATTESTATION_INVALID`。这不是让用户判断代码正确，而是证明审查确由不同任务完成且用户接受该具体authority artifact。

### 24.3 A2-3：corpus generator 与独立 verifier 算法

generator 和 verifier 必须是两条不共享“expected outcome 计算”代码的路径。允许共享纯函数 `sha256File`；禁止共享 FLVER/PARAM/MSB inventory parser、资源分类器和 outcome 合并器。

generator 输入：

```text
只读游戏根
冻结的 logical resource list
Andre.SoulsFormats 独立命令输出
Smithbox / Yapped Rune Bear / DSAnimStudio 黑盒 artifact
```

generator 步骤：

```text
for each frozen logical resource in deterministic order:
  filesystemEvidence = {relativePath,size,sha256}
  andreEvidence = invoke independent tool and save raw JSON/hash
  matureEvidence = invoke selected black-box workflow and save machine signal/hash

  if any identity differs:
      outcome = disputed
  else if Andre and mature tool both expose renderable/parseable content:
      outcome = loaded
  else if both independently prove missing source or no renderable FLVER:
      outcome = unavailable with one allowed diagnostic
  else:
      outcome = disputed

write manifest sorted by logicalUri then model identity
never read SoulForge output to choose outcome
```

manifest的count必须是可重算不变量，不是人写摘要。所有先前只写了名字的类型在这里锁死，低能力实现者不得自行补成更弱schema：

```ts
interface CorpusPhysicalIdentityV2 {
  logicalUri: string;
  sourceRelativePathPosix: string;
  sourceByteLength: number;
  sourceSha256: string;
  containerEntry: null|{
    containerSourceSha256: string;
    physicalIndex: number;
    id: number;
    name: string;
    duplicateOrdinal: number;
    extractedContentSha256: string;
  };
}

interface CorpusArtifactIdentityV2 {
  role: "filesystem"|"andre"|"mature";
  producerExecutableOrSourceSha256: string;
  rawArtifactSha256: string;
  byteLength: number;
  targetJoinKeySha256: string;
}

interface CorpusEvidenceJoinV2 {
  target: CorpusPhysicalIdentityV2;
  joinKeySha256: string;
  artifacts: [CorpusArtifactIdentityV2,CorpusArtifactIdentityV2,CorpusArtifactIdentityV2];
  filesystem: {relativePathPosix:string;byteLength:number;sourceSha256:string;containerEntryIdentitySha256:string|null};
  andre: {targetSourceSha256:string;containerEntryIdentitySha256:string|null;inventoryArtifactSha256:string;parseResult:"loaded"|"unavailable"|"failed"};
  mature: {targetSourceSha256:string;containerEntryIdentitySha256:string|null;evidence:MatureEvidenceV1|null;capability:"available"|"unavailable"|"failed"};
  expectedOutcome: "loaded"|"unavailable"|"disputed";
  allowedDiagnosticCode: string|null;
}

interface CorpusSourceEntryV2 {
  identity: CorpusPhysicalIdentityV2;
  resourceRole: "gameparam"|"msb"|"map-model"|"character"|"parts"|"animation"|"skeleton";
  evidenceJoinKeySha256: string;
  expectedOutcome: "loaded"|"unavailable"|"disputed";
  allowedDiagnosticCode: string|null;
}

interface MapMeshOracleV2 {
  meshOrdinal: number;
  materialIndex: number;
  displayProfileId:"sekiro-map-static-highest-detail-v1"|"sekiro-character-preview-highest-detail-v1";
  selectedFaceSetOrdinals: number[];
  ruleIds: string[];
  sourceFaceSetIndexBits: Array<16|32>;
  faceSetCullBackfaces: boolean[];
  faceSetTriangleCounts: number[];
  triangleCount: number;
  triangleListSha256: string;
  vertexCount: number;
  localBounds: {min:[number,number,number];max:[number,number,number]};
}

interface MapModelOracleV2 {
  identity: MapModelIdentityV1;
  evidenceJoinKeySha256: string;
  resourceEdgePayloadSha256: string;
  expectedOutcome: "loaded"|"unavailable"|"disputed";
  allowedDiagnosticCode: string|null;
  meshes: MapMeshOracleV2[];
  meshCount: number;
}

interface MapPlacementOracleV2 {
  identity: MapPlacementIdentityV1;
  nativeRecordSha256: string;
  nativeModelOrdinal: number;
  modelEdgeId: string;
  modelLocalTransformSha256: string;
  gameTransform: {position:[number,number,number];rotationDegrees:[number,number,number];scale:[number,number,number]};
}

interface CharacterSampleV2 {
  characterLogicalIdentity: string;
  leaderEvidenceJoinKeySha256: string;
  contextOracleSha256: string;
  expectedBodyPartIdentities: string[];
  expectedLeaderBoneCount: number;
  expectedMeshCount: number;
  expectedVertexCount: number;
  expectedBodyBounds: {min:[number,number,number];max:[number,number,number]};
}

interface Mission1CorpusManifestV2 {
  schema: "mission1-sekiro-corpus-v2";
  game: "sekiro";
  gameBuildIdentity: string;
  entries: CorpusSourceEntryV2[];
  entryCount: number;                       // 必须 === entries.length
  mapCorpus: {
    mapIdentity: string;
    models: MapModelOracleV2[];
    modelCount: number;                     // === models.length === 499 for frozen m10 sample
    placements: MapPlacementOracleV2[];
    placementCount: number;                 // === placements.length；来自MSB physical parts，不抄UI汇总
  };
  characterStaticSamples: CharacterSampleV2[];
  characterStaticSampleCount: number;       // === length === 10，总数包含强制c0000和c1000
  evidenceJoins: CorpusEvidenceJoinV2[];
  evidenceJoinCount: number;                 // === evidenceJoins.length
  generatorSourceSha256: string;
  verifierSourceSha256: string;
}
```

`characterStaticSamples`总数**精确为10且包含强制c0000/c1000两个**；其余8个由冻结bin策略在候选中按source SHA字节序取最小，跨bin重复identity只算一次并从下一个候选补足。候选不足时corpus FAIL，不能把总数扩成“10+2”或自动降到8。map的499是`MapModelIdentityV1`逐项数组，不是`{count:499}`摘要；每个model保存resource-edge expected outcome和每mesh oracle。placement数组保存24.11的identity、native part/model ordinal、edge id、native TRS、model-local transform hash与source hash；它是24.21确定性Gizmo样本的唯一producer。任何count/数组不等、重复identity、缺ordinal或placeholder/pending值都在schema验证前置阶段失败。

三方join key唯一编码为24.19的uint32-BE length-prefixed UTF-8字段：`[logicalUri,sourceSha256,containerSourceSha256-or-empty,physicalIndex decimal-or-empty,id decimal-or-empty,name,duplicateOrdinal decimal-or-empty,extractedContentSha256-or-empty]`。filesystem/Andre/mature三份证据都必须携带并精确匹配同一`targetSourceSha256`和`containerEntryIdentitySha256`；每个join恰有三个不同role且每类唯一，artifact里的`targetJoinKeySha256`必须相同。成熟工具若打开另一个文件、另一个container child或只给basename，即使画面成功也固定`CORPUS_EVIDENCE_SOURCE_MISMATCH -> disputed`。

每个`MapModelOracleV2.meshes[]`固定保存：`meshOrdinal`、`selectedFaceSetOrdinals[]`（V1默认profile长度恰为1、mesh reference order、无重复）、对应`ruleIds[]`、每个FaceSet source index bits、逐FaceSet `CullBackfaces`、合并后的triangleCount、canonical little-endian uint32 triangle-list SHA、vertex count和local bounds。不存在单数`selectedFaceSetOrdinal`或含义不同的`displayFaceSetOrdinals`字段；旧字段schema直接拒绝。

verifier 必须从原始 artifacts 重新完成以下工作，不能只对 manifest 自身算 hash：

```text
1. 重新哈希 filesystem 输入并核对 relative path/size/hash。
2. 独立解析 Andre raw JSON，重算 model/mesh/vertex/index/bone inventory，并逐 mesh 重算 display FaceSet ordinal列表、triangle count和triangle-list hash。
3. 独立解析 mature-tool machine artifact，重算 capability/outcome。
4. 自己按上述canonical fields做三方 join；source hash和container entry identity必须同时相等，不能只用logical URI/basename。
5. 重算 expected outcome；逐字段比较 generator manifest。
6. 确认固定样本集合无缺项、无额外自动替换项。
7. 任一 mismatch 输出精确 JSON pointer 和两侧值，exit 非零。
```

黑盒成熟工具固定候选：PARAM 优先 `Yapped Rune Bear v2.14.1` 或 Smithbox PARAM editor；地图用 `smithbox`；角色/动作用 `DSAnimStudio-4.9.9[Build 4999]`。先记录实际 exe 路径、文件版本和 SHA-256，再 capability probe。窗口出现不算成功：

- PARAM 成功信号：目标表名可见、row count 与 Andre 一致、首末物理行 identity 可读取。
- 地图成功信号：目标 m10 加载完成事件或自动化可观测实体/几何计数，且固定相机截图/深度 artifact 可取得。
- 角色成功信号：完整非骨架 body coverage、mesh/bone inventory 和目标 clip duration 可取得。

若工具没有稳定机器接口，保留原始自动化视频/截图只能作诊断，不得单独决定 expected outcome；该项为 `disputed`，由用户裁定，而不是让实现者写一个“window opened=true”通过。

成熟工具 adapter 不能临场自由发挥，统一实现以下接口和状态机：

```ts
interface MatureAdapterContextV1 {
  runNonce: string;
  sourceSnapshotSha256: string;
  corpusManifestSha256: string;
  testTempRoot: string;
  gameReadOnlyRootIdentitySha256: string;
  observerArtifactDirectory: string;
}

interface FrozenTargetV1 {
  logicalUri: string;
  sourceContentSha256: string;
  containerEntryIdentitySha256: string|null;
  targetJoinKeySha256: string;
  workflowSelector:
    | {kind:"param";table:string}
    | {kind:"map";mapId:string;fixedCameraArtifactSha256:string}
    | {kind:"character-animation";modelLogicalUri:string;typedAnimationId:number;actionBindingIdentitySha256:string};
}

interface CapabilityResultV1 {
  capability: "CAPABLE"|"UNAVAILABLE"|"FAILED";
  observedExecutableSha256: string;
  supportedEvidenceMethod: "uia"|"exported-json"|"structured-log"|null;
  rawArtifactHashes: string[];
  diagnosticCode: string|null;
}

interface OwnedProcessV1 {
  adapterId: string;
  launchNonce: string;
  rootPid: number;
  ownedPidSet: number[];
  processCreationIdentitySha256: string;
  targetJoinKeySha256: string;
  state: "LAUNCHED"|"OPENING"|"READY"|"EVIDENCE_EXPORTED"|"FAILED"|"CLOSED";
}

interface ReadySignalV1 {
  ready: boolean;
  targetJoinKeySha256: string;
  machineSignalKind: "uia"|"exported-json"|"structured-log";
  rawArtifactHashes: string[];
  diagnosticCode: string|null;
}

interface CloseResultV1 {
  closedOwnedPidSet: number[];
  stillRunningOwnedPidSet: number[];
  touchedPreexistingPidSet: number[]; // 必须为空
  rawArtifactHashes: string[];
}

interface MatureToolAdapterV1 {
  schema: "mission1-mature-tool-adapter-v1";
  adapterId: string;
  workflow: "param"|"map"|"character-animation";
  executable: { canonicalPath:string; sha256:string; fileVersion:string|null };
  launchArgs: string[];                 // 允许 ${CORPUS_PATH} 占位，不允许 shell字符串
  evidenceMethod: "uia"|"exported-json"|"structured-log";
  timeoutsMs: { probe:30000; open:180000; export:60000; close:10000 };
  probe(ctx: MatureAdapterContextV1): Promise<CapabilityResultV1>;
  open(ctx: MatureAdapterContextV1, target: FrozenTargetV1): Promise<OwnedProcessV1>;
  waitReady(process: OwnedProcessV1): Promise<ReadySignalV1>;
  exportEvidence(process: OwnedProcessV1): Promise<MatureEvidenceV1>;
  close(process: OwnedProcessV1): Promise<CloseResultV1>;
}
```

`OwnedProcessV1`是adapter内部状态，不允许child直接声称某PID属于自己：orchestrator在launch前保存同exe的preexisting PID+creation-time集合，launch后用Windows Job Object/父子creation identity登记owned tree；PID复用、无法建立owner边界或`close.touchedPreexistingPidSet`非空都使adapter FAIL。`waitReady.ready`只表示闭集machine signal出现，不能替代`exportEvidence`字段验证；`CapabilityResultV1.UNAVAILABLE`仍使需要该成熟工具比较的Gate未完成，不能自动换成截图。

状态固定：

```text
NEW -> PROBED(capable) -> LAUNCHED -> OPENING -> READY
    -> EVIDENCE_EXPORTED -> CLOSED
任一失败 -> FAILED -> 关闭/终止本 adapter 自己启动的 PID tree -> CLOSED
```

adapter 操作只能是 typed step：`launch`、`uiaInvoke(accessibleId/name)`、`uiaSetValue`、`waitForUiaProperty`、`readUiaProperty`、`readStructuredLog`、`readExportedJson`、`closeOwnedWindow`。禁止用屏幕像素颜色、窗口存在、固定 sleep 或 OCR 文本作为成功 machine signal；坐标 click只可帮助抵达界面，最终 READY/evidence仍必须来自 UIA属性、结构日志或导出数据。

统一输出：

```ts
interface MatureEvidenceV1 {
  schema: "mission1-mature-evidence-v1";
  adapterId: string;
  toolExecutableSha256: string;
  targetLogicalUri: string;
  targetSourceSha256: string;
  targetContainerEntryIdentitySha256: string|null;
  targetJoinKeySha256: string;
  startedAtUtc: string;
  readyAtUtc: string;
  workflowResult:
    | {kind:"param"; table:string; rowCount:number; firstPhysicalRowIdentity:string;lastPhysicalRowIdentity:string}
    | {kind:"map"; mapId:string;geometryReadyState:"COMPLETE";entityCount:number;partCount:number;renderableModelCount:number;fixedCameraMatrixSha256:string;objectIdMaskSha256:string;linearDepthSha256:string}
    | {kind:"character-animation";modelId:string;meshCount:number;boneCount:number;animationId:number;duration:number;nonSkeletonPixelCount:number;bodyCoverageRatio:number;skinnedTriangleCount:number;worldBounds:{min:[number,number,number];max:[number,number,number]};fixedCameraMatrixSha256:string;objectIdMaskSha256:string;linearDepthSha256:string};
  rawArtifactHashes: string[];
}
```

`readySignal:string`、窗口存在或骨架像素都不再是充分字段。map adapter必须在工具自己的complete machine state之后导出固定camera/mask/depth；character adapter必须区分mesh/body material与skeleton overlay，报告非骨架像素、三角形、coverage和finite bounds。adapter无法导出这些字段时该workflow为`MATURE_TOOL_ADAPTER_UNAVAILABLE/disputed`，不能用截图OCR补齐。body coverage定义为`nonSkeletonModelMaskPixels / oracleProjectedBodyMaskPixels`，分母为0即artifact无效；camera/mask/depth identities与raw artifact一起hash。

adapter不负责决定PASS，只采集事实；generator/verifier按同一typed schema独立比较。probe/open/export任一步缺机器字段就返回`MATURE_TOOL_ADAPTER_UNAVAILABLE`，不能降级解析截图。所有count非负整数、duration finite positive、bounds finite且min<=max、hash恰64 hex；否则证据schema失败。关闭先发正常窗口关闭并等10秒，只对记录的owned PID tree执行终止；不得关闭用户原本已打开的同名工具。

复杂度：每份 corpus 原始文件最多哈希一次；generator/verifier 各自解析一次。禁止对 499 个 model 每项重新解压同一个 mapbnd。

### 24.4 G-1：工作区两阶段 discovery + 增量 hash 算法

所有权：目录枚举与 hash 在 core/main；renderer 只接收无绝对路径的索引投影。不要在 React effect 中扫描文件。

数据结构：

```ts
interface FileFingerprintV1 {
  relativePath: string;
  size: number;
  mtimeNs: string;
  ctimeNs: string;
  fileIdentity: string|null;         // volume identity + file id；不可得时为null并使warm复用FAIL
  pathSourceGeneration: number;      // 仅该路径内容失效时递增，跨open持久
}

interface PersistedHashV1 extends FileFingerprintV1 {
  sha256: string;
  lastVerifiedAtUtc: string;
  fingerprintStoreGeneration: number;
}

interface WorkspaceScanGeneration {
  workspaceId: string;
  workspaceSessionGeneration: number; // 每次open递增，只防旧异步结果提交
  fingerprintStoreGeneration: number; // root/schema重建才递增，不因open递增
  abort: AbortController;
}

interface FingerprintContinuityV1 {
  workspacePersistentIdentityHash: string;
  volumeIdentity: string;
  usnJournalId: string|null;
  lastConsumedUsn: string|null;
  watcherEpoch: string;
  cleanShutdown: boolean;
  continuity: "PROVEN"|"UNKNOWN";
  unknownReason: "FIRST_OPEN"|"JOURNAL_UNAVAILABLE"|"JOURNAL_ID_CHANGED"|"JOURNAL_GAP"|"WATCHER_OVERFLOW"|"UNCLEAN_SHUTDOWN"|null;
}

interface HashContinuationV1 {
  workspaceId: string;
  workspaceSessionGeneration: number;
  fingerprint: FileFingerprintV1;
  offset: number;
  openHandle: FileHandle;
  incrementalHasher: Sha256State;     // 进程内opaque对象，不序列化
  queuedSequence: number;
}
```

本卡的三个 generation 不能混用（地图/动作另有`sceneGeneration/rendererContextGeneration`，见24.20）：

- `workspaceSessionGeneration`：每次打开/切换工作区递增，只决定异步结果能否提交；**不参与持久hash命中比较**。
- `fingerprintStoreGeneration`：持久store schema、物理root identity或hash算法改变才递增；正常重开不变。
- `pathSourceGeneration`：Patch Engine成功写回、watcher/USN内容事件、rename/delete/recreate时只对受影响路径递增。单文件变化不能使全部文件失效。

fingerprint store写在现有main-owned `WorkspaceDataRepository`/app-data边界，不写Mod工作区。key必须包含规范化workspace identity（game + 物理overlay/base root identity的hash），不能是一个process-global map。打开另一个workspace即使relative path/size/time相同也不能命中。store更新使用已有事务/原子持久化边界；提交前同时校验`workspaceSessionGeneration`、`fingerprintStoreGeneration`和当前stat fingerprint。

metadata相等只有在“从上次已验证hash到现在的内容事件连续性”也被证明时才可复用。store与每批fingerprint同一事务保存`FingerprintContinuityV1`。Windows优先记录volume USN journal id与已消费USN；watcher只作为低延迟提示，不能单独证明进程关闭期间无变化。打开store时：journal id相同、从`lastConsumedUsn`到当前无gap且上次clean shutdown，才设`PROVEN`；journal不可用、ID改变、记录被截断、watcher overflow或上次进程异常退出都设`UNKNOWN`。`UNKNOWN`不会阻塞FILES_VISIBLE，但后台把所有旧hash视为miss重新读取；全部稳定文件重哈希并原子保存新cursor后才能恢复`PROVEN`。禁止因为size/mtime/ctime/fileId相同就忽略观察窗口外的等长写回。

打开工作区的状态机：

```text
IDLE
  -> DISCOVERING       只 readdir/stat/classify，不 open/read 内容
  -> SHELL_READY       导航、文件列表可用
  -> EDITOR_READY      当前选中资源所需最小读取完成
  -> HASHING_BACKGROUND
  -> BACKGROUND_COMPLETE

任意状态收到新 workspace:
  abort old workspaceSessionGeneration -> OPEN new workspaceSessionGeneration
旧workspaceSessionGeneration的异步结果一律丢弃，不能覆盖新catalog
```

discovery 逐步算法：

```text
openWorkspace(root):
  cancel previous workspaceSessionGeneration
  sessionGen = increment workspaceSessionGeneration
  store = open persisted fingerprints for exact workspace identity
  storeGen = store.fingerprintStoreGeneration; do not increment merely because workspace opened
  continuity = verify persisted journal/watcher cursor before accepting any warm hash
  queue = [root]
  files = []

  while queue not empty:
    abort if signal aborted
    dir = queue.shift()
    entries = readdir(dir, withFileTypes=true)
    sort entries deterministically
    for entry:
      skip only explicit ignored directories from existing policy
      if directory: queue.push(entry)
      if regular file:
        stat once with bigint timestamps
        classify by relative path
        append IndexedFile without sha256, parseStatus=unparsed
      every 256 entries or 8 ms elapsed:
        emit progress batch; await setImmediate/yield

  atomically publish catalog only if workspaceSessionGeneration still current
  emit SHELL_READY/FILES_VISIBLE
  enqueue background hash jobs
```

与当前 `scanWorkspace` 的关键差异：hash 失败不能 `return` 丢掉文件。固定逻辑：

> **2026-08-27 实测更正：下面这段固定逻辑，`scanWorkspace.ts:140-152` 已经实现了，它是验收判据而不是待办。** 本节保留它是为了让增量索引重写时不要退化回「hash 失败就丢文件」。**唯一还留在 catch 里的 `return` 是 `:122` 的 stat 失败路径，它必须留着，删掉会让整个工作区扫描崩溃**——完整实测、三条 TS18048 行号、以及「用 `fileStat!` 消错会把崩溃原样恢复且 typecheck 转绿」这个陷阱，全部写在 §5.5 开头的实测更正框里，动 `scanWorkspace.ts` 前先读那一框。

```text
try hash:
  update same physical file identity with sha256
catch non-abort:
  keep IndexedFile
  sha256 remains absent
  append FILE_HASH_FAILED
```

增量 hash 算法：

```text
for each discovered file:
  fp = {relativePath,size,mtimeNs,ctimeNs,fileIdentity,pathSourceGeneration}
  old = persistedByRelativePath[relativePath]
  if old fingerprint exactly equals fp
     and old.fingerprintStoreGeneration == current fingerprintStoreGeneration
     and workspace identity matches
     and continuity == PROVEN:
      reuse old.sha256; counter.hashReuse++
  else:
      enqueue hash job; counter.hashRead++

start hash job:
  open file through non-following handle; fstat -> exact initial fingerprint
  continuation = {sessionGen,fingerprint,offset=0,handle,new SHA256 state,sequence}

resume continuation after disk-slot acquire:
  fstat same handle; require exact file identity/size/times still equal
  while offset < size:
      check abort/workspaceSessionGeneration before read
      read at exact offset, at most 1 MiB; zero-byte before size is HASH_UNEXPECTED_EOF
      update same incrementalHasher; offset += bytesRead; counter.hashBytesRead += bytesRead
      if foreground queue nonempty:
          stop issuing I/O, release disk semaphore, requeue the SAME continuation, yield
          do not close/reopen from byte 0 and do not create a new hasher
  fstat again; require exact fingerprint unchanged
  digest once; close handle in finally
  commit only if session/store/path generations and current fingerprint still match
```

Node的`crypto.Hash`不需要序列化：让步期间保留同一个hasher和open handle，仅释放“可发起下一次read”的disk semaphore。进程退出/daemon重启时partial continuation直接丢弃并关闭handle；新进程可以从0重读一次，但同一进程内每个稳定文件byte最多读取一次。若实现平台必须关闭handle，让步前也必须使用可克隆/可序列化SHA-256 state；禁止只保存offset却从0重算hash。任何文件在读中变化时丢弃旧continuation，等debounce后为新的`pathSourceGeneration`建立一个新job；不得无限重试同一identity。

优先级固定为：当前用户打开资源 `0`，当前 viewport 后续 chunk `1`，可见列表 metadata `2`，后台 hash `3`，全文分析/RAG `4`。队列使用稳定 `(priority, enqueueSequence)` 排序；同优先级保持 FIFO。最多一个后台磁盘 reader；前台任务到达后，后台在当前 1 MiB chunk 结束时让出。不要通过 `setTimeout(500)` 假装优先级。

Patch Engine成功写回、连续watcher/USN变更、file identity/size/mtime/ctime变化时，只使对应path fingerprint失效。等长且恢复mtime的写回也必须由`pathSourceGeneration` bump强制重哈希。若journal/watcher连续性丢失，无法知道具体path，只能把continuity标UNKNOWN并后台重哈希全部；这属于正确性恢复，不是正常workspace重开的固定成本。`workspaceSessionGeneration`变化只取消旧job/拒绝提交；连续性PROVEN时不能让新session重哈希全部未变文件。root/store schema变化递增`fingerprintStoreGeneration`；journal gap不伪造逐path generation，而以UNKNOWN阻止复用直到重建。

关闭/取消必须遍历所有continuation，abort、等待当前chunk边界、关闭handle并释放disk semaphore恰好一次；正常关闭在所有已消费事件/fingerprint事务落盘后写`cleanShutdown=true`，崩溃fixture不得写。正常完成、文件变化、hash异常、journal gap、watcher overflow、进程关闭期间等长写回和workspace切换测试都断言`openHandles=0, activeDiskReaders=0`。复杂度：discovery `O(F log F)`（目录内排序）；continuity PROVEN的warm hash为`O(F)` metadata比较和`O(changed bytes)`内容读取；UNKNOWN恢复为`O(total stable file bytes)`但在后台可取消/让步；持续前台抢占仍不能重复读取前缀。验收的`warm unchanged hashRead=0`和单文件变化`hashRead=1`仅在连续性PROVEN时成立，gap测试必须证明旧hash不会复用。

### 24.5 C-1：BND listing 与 binder cache 算法

所有权：C# Bridge。main 不得用 JSON cache 冒充 binder cache。

请求、返回与缓存键固定为。owner purpose不是自由字符串，统一闭集和能力矩阵如下：

```text
OwnerPurpose = BND_BROWSE | PARAM_READ | PARAM_EDIT | MAP_STATIC_READ | CHARACTER_READ | ANIMATION_READ

capabilities:
  BND_BROWSE      -> list, extract-explicit-child, close
  PARAM_READ      -> list, extract-param-child, open-param, index, page, close
  PARAM_EDIT      -> PARAM_READ + create-staging-patch（仍不能直写workspace）
  MAP_STATIC_READ -> extract-resolved-flver, open/read/close-map-static
  CHARACTER_READ  -> extract-resolved-character-parts, close
  ANIMATION_READ  -> extract-resolved-animation/skeleton, close

OpenBinderRequest = {
  workspacePersistentIdentityHash,
  workspaceSessionId, workspaceSessionGeneration, webContentsId, ownerPurpose:OwnerPurpose,
  logicalSourceUri, resolvedLayer, sourceContentSha256:string|null, pathSourceGeneration,
  oodleExecutableSha256OrBuiltinIdentity
}

OpenBinderResult = { sessionToken, ownerLeaseId, sourceContentSha256, entryCount }

BinderKey = workspacePersistentIdentityHash
          + logicalSourceUri + resolvedLayer
          + sourceContentSha256 + pathSourceGeneration
          + oodleExecutableSha256OrBuiltinIdentity
```

`sourceContentSha256`来自24.4已验证catalog，或cold open读取DCX时边读边算并在publish前二次确认；不能用path/size/mtime替代。它为null时不得构造含空hash的BinderKey，也不得和任何OPENING请求join：先用随机`ColdOpenTicketId`建立不进content-key lookup的私有OPENING entry，边读边hash，得到可信hash后构造最终BinderKey；锁内若已有exact READY/OPENING final key，则把caller owner原子迁移到该entry并dispose自己多解析的document，否则才发布为该key。任何迁移失败都关闭私有entry，不留空hashcache。新的workspace session可以命中相同BinderKey，但必须获得新的owner lease；session generation不放进content cache key，却放在owner record和每次Acquire校验中。

`OwnerLease`固定包含`leaseId/workspacePersistentIdentityHash/workspaceSessionId/workspaceSessionGeneration/webContentsId/purpose/state/createdAt/lastUsedAt`。同一个不可变content entry可被多个workspace session/window共享，但每个reader/close都必须携带并核对exact lease；一个window绝不能拿另一个window的lease。purpose能力由上表静态判断，不能用`startsWith`或默认allow。

server 返回的 session token 是随机 opaque id，server-side entry 另存 daemonInstanceId 与完整 key；不要把绝对路径编码进 renderer 可见 token。

entry 状态和所有权固定为：

```csharp
enum BinderEntryState { OPENING, READY, CLOSING, EVICTED }

sealed class BinderCacheEntry
{
    public required BinderKey Key;
    public required BinderEntryState State;
    public required Dictionary<string,OwnerLease> Owners; // leaseId -> workspaceSessionId/workspaceSessionGeneration/purpose
    public int ActiveReaders;                     // 只在 cache lock 内增减
    public Task<BinderDocument>? OpeningTask;
    public BinderDocument? Document;
    public CancellationTokenSource? OpenCancellation;
    public bool DisposeRequested;
    public long NativeByteCost;
    public DateTime LastUsedUtc;
}
```

合法迁移只有 `OPENING -> READY -> CLOSING -> EVICTED`、`OPENING -> CLOSING -> EVICTED`。`EVICTED` 不能回到 READY；相同 key 的后续 open 必须创建全新 entry。正常 owner close 可以让 `READY owners=0` 留在有界 LRU 供 warm reopen；eviction、source invalidation、workspace dispose 才把它原子改为 CLOSING，从此拒绝新 owner/reader。

并发 open 算法：

```text
GetOrOpenBinder(request):
  lock cache index briefly
  if READY entry with exact key:
      mint random ownerLeaseId bound to caller workspaceSessionId/workspaceSessionGeneration/purpose
      add owner; touch LRU; counter.sessionHit++; return {token,ownerLeaseId}
  if OPENING entry with exact key:
      mint/add caller owner lease; counter.inFlightJoin++; capture same Task; unlock; await it
  else:
      create OPENING entry with newly minted caller owner lease and one TaskCompletionSource
      insert; unlock
      outside lock: read -> DCX inflate -> BND4 parse exactly once
      on parse success, reacquire lock:
          if state still OPENING and !DisposeRequested:
              publish Document; set READY/byteCost/lastUsed; complete waiters
          else:
              do not publish; set CLOSING; dispose parsed binder outside lock; finalize EVICTED
      on failure: set CLOSING, remove from index, complete waiters with same diagnostic, finalize EVICTED
  run eviction after success, never while holding parse lock
```

reader lease 必须由一个 helper 原子取得，list/extract 不能直接抓 `Document` 引用：

```text
AcquireBinderReader(token, ownerLeaseId, requestWorkspacePersistentIdentity,
                    requestWorkspaceSession, requestWorkspaceSessionGeneration, requestWebContentsId, operation):
  lock cache index
  validate token daemon and entry key
  lookup ownerLeaseId; require persistent identity/session/workspaceSessionGeneration/window全部exact
  require owner lease still OPEN and closed capability matrix authorizes operation
  require entry.state == READY and Document != null
  entry.ActiveReaders++
  capture immutable Document reference; unlock
  return lease whose Dispose reacquires lock and decrements exactly once

ReleaseBinderReader(lease):
  lock; reject double release in debug/test
  ActiveReaders-- ; require ActiveReaders >= 0
  if state==CLOSING && ActiveReaders==0: detach Document for outside-lock dispose
  unlock; dispose detached Document; lock; state=EVICTED; remove exact entry; unlock
```

`list-bnd4-entries`：

```text
opened = GetOrOpenBinder(request)
lease = AcquireBinderReader(opened.sessionToken, opened.ownerLeaseId,
          request.workspacePersistentIdentityHash, request.workspaceSessionId, request.workspaceSessionGeneration,
          request.webContentsId, "list")
try:
  for entry at physical ordinal 0..E-1:
    emit {index,id,name,uncompressedSize,duplicateOrdinal}
    do not extract child bytes
    do not hash child
    do not rebuild/validate writer layout
  return {sessionToken,ownerLeaseId,sourceContentSha256,pathSourceGeneration,entryCount,entries}
finally:
  ReleaseBinderReader(lease)
```

`duplicateOrdinal` 按同一 `(id,name)` 在更早物理 entry 中出现次数计算；不可用 `Map<id,entry>` 折叠。

`extract-bnd4-child`：

```text
lease = AcquireBinderReader(token, ownerLeaseId, request.workspacePersistentIdentityHash,
          request.workspaceSessionId, request.workspaceSessionGeneration, request.webContentsId, "extract-explicit-child")
try:
  validate physical entry index, then verify expected id/name/duplicateOrdinal
  extract only that child
  compute SHA-256 once and memoize under binder entry identity
  return payload + contentHash
finally:
  ReleaseBinderReader(lease)
```

`close-binder-session`输入必须同时携带`sessionToken + ownerLeaseId + workspacePersistentIdentityHash + workspaceSessionId + workspaceSessionGeneration + webContentsId`。owner close在锁内把exact lease从OPEN转CLOSED并删除，只允许成功一次；错误owner、跨窗口、跨workspaceSessionGeneration或double-close返回结构化diagnostic，不能替别人释放。达到entry/native-byte/idle-TTL预算时，从最旧且`owners.size==0 && activeReaders==0`的READY entry开始，先改CLOSING并从lookup摘除，再锁外dispose，最后EVICTED。OPENING/active entry不强杀。workspace/window dispose只删除属于该exact owner scope的leases；entry仍有其他session owner则保持READY，无owner才进入关闭候选。若source invalidation命中BinderKey，则无条件阻止新owner、标DisposeRequested，并等已有reader释放。native parse若不可中断，返回后由publish guard立即丢弃并dispose。daemon退出也走同一显式释放路径；失败cache只保留code/backoff，不保留child bytes。

关于“listing不读取child”的可执行边界：若当前Andre.SoulsFormats BND4 API在cold parse时不可避免地把解压后的entry bytes放入binder对象，可以接受这一次container parse/materialization，但`list-bnd4-entries`投影禁止逐entry复制、hash、base64、writer rebuild或validation；只读取物理ordinal、id/name、已知byte length。telemetry分别记录`binderInflateBytes/binderParseCount/childHashCount/childSerializedBytes`，warm list要求parse不再增加且后二者为0。若库提供metadata-only reader则优先使用，但不得在TypeScript另写BND parser。

复杂度：cold open `O(container bytes + E)`；warm list `O(E)`；extract `O(selected child bytes)`。`list -> extract -> list` 的 DCX inflate/BND parse counter 必须保持 1。

### 24.6 C-2：PARAM native session、index、page 与关闭算法

所有权：原始 bytes、行目录、物理行定位和结构校验在 C# Bridge；main 只持 opaque token/轻量 DTO；renderer 只持 index 和已经访问的 page。禁止三个层各缓存一份完整 rows JSON。

Bridge session 数据结构应等价于：

```csharp
enum ParamSessionState { OPENING, READY, CLOSING, EVICTED }

sealed class ParamSessionEntry
{
    public required string Token;                 // 随机 opaque id
    public required string DaemonInstanceId;
    public required ParamOpenJoinKey OpenJoinKey;  // immutable binder child identity/content hash + metadata authority
    public ParamSourceKey? SourceKey;               // 仅 READY 后非 null；再加入 resolved metadata layout
    public ParamNativeDocument? Document;           // OPENING 必须为 null；READY 后为唯一 immutable authority
    public ParamRowLocator[]? Rows;                  // OPENING 必须为 null；READY 后保留物理顺序和重复 ID
    public required long NativeByteCost;
    public ParamSessionState State;                // OPENING/READY/CLOSING/EVICTED
    public Dictionary<string,OwnerLease> Owners = new(); // leaseId -> workspaceSessionId/workspaceSessionGeneration/purpose
    public int ActiveReaders;
    public DateTime LastUsedUtc;
    public Dictionary<int,string> RequestedRowHashes = new();
}

readonly record struct ParamRowLocator(
    int RowIndex,
    long Id,
    string? Name,
    int DataOffset,
    int DataLength);
```

`OPENING` 的不变量固定为 `SourceKey==null && Document==null && Rows==null && NativeByteCost==0`；`READY` 固定为四者全部存在且 rows 已完成一次结构验证；`CLOSING/EVICTED` 不允许新 reader。`Rows` 在 READY 后必须是数组/只读列表，不能是 `Dictionary<long,Row>`。可以额外建 `Dictionary<long,List<int>> idToPhysicalRows` 支持兼容查询，但数组仍是 authority。任何用 C# `required Document/Rows` 迫使 OPENING 塞占位对象的实现都不符合本状态机。

PARAM reader 也必须锁内验证并递增，固定 helper如下；后面的 index/page 伪代码只能通过它读 Document：

```text
AcquireParamReader(token, ownerLeaseId, requestPersistentWorkspace,
                   requestWorkspaceSession, requestWorkspaceSessionGeneration, requestWebContentsId, operation):
  lock session index
  validate token/daemon/source in the fixed order below
  require state==READY
  lookup ownerLeaseId and require persistent identity/session/workspaceSessionGeneration/window exact
  require OwnerPurpose capability matrix authorizes operation
  require Document != null && Rows != null && SourceKey != null
  ActiveReaders++
  snapshot immutable non-null {Document,Rows,SourceKey}; unlock
  return single-dispose reader lease

ReleaseParamReader(lease):
  lock; decrement exactly once; require ActiveReaders>=0
  if state==CLOSING && ActiveReaders==0: detach native document for outside-lock dispose
  unlock; dispose if detached; finalize EVICTED under lock
```

打开 session 的逐步算法：

```text
openParamSession(request = {
  workspacePersistentIdentityHash,
  workspaceSessionId, workspaceSessionGeneration, webContentsId, ownerPurpose:PARAM_READ|PARAM_EDIT,
  binderSessionToken, binderOwnerLeaseId, physicalEntryIdentity,
  expectedSourceHash, pathSourceGeneration, metadataAuthorityHash
}):
  validate workspace/source/container entry identity
  childLease = GetOrOpenBinderChildContent(
      binderSessionToken,binderOwnerLeaseId,physicalEntryIdentity,exact workspace/window scope)
  # 此 helper 先按 immutable parent binder source hash + pathSourceGeneration + physicalEntryIdentity
  # 在 binder 锁内 join OPENING/READY child；只有 miss winner 才 extract/materialize/hash 一次。
  # loser await 同一 task；READY 返回 binder-owned readonly memory lease + childContentSha256，绝不逐 caller copy byte[].
  verify expectedSourceHash when supplied; mismatch fails before PARAM cache lookup

  openJoinKey = persistent workspace identity + logical source + physical entry identity
              + childContentSha256 + pathSourceGeneration + metadataAuthorityHash
  lock PARAM session index BEFORE header probe or ParamNativeDocument.Read
  if exact openJoinKey aliases a READY entry: acquire owner, release lock and childLease, return
  if exact openJoinKey has OPENING: subscribe to its one inFlight task, release lock and childLease, await
  if miss:
      create random token + OPENING ParamSessionEntry with all nullable authority fields null
      publish exactly one inFlight task; this caller is the winner
  unlock

  winner only, while holding childLease over the shared readonly memory:
      header = read only PARAM header fields needed for typeName/dataVersion/layout family
      widthCandidates = metadata lookup by exact game + typeName + dataVersion
      if Standard32/Long64 single-row requires width:
          if candidates.count != 1: fail PARAM_ROW_SIZE_REQUIRED / PARAMDEF_LAYOUT_AMBIGUOUS
          expectedRowDataSize = candidates[0]
      resolvedKey = openJoinKey + exact resolved metadata layout hash
      telemetry.paramParseStarted++ immediately before ParamNativeDocument.Read(shared readonly memory,...)
      document = ParamNativeDocument.Read(shared readonly memory, expectedRowDataSize)
      telemetry.paramParseCompleted++ only after success
      validate row directory/bounds/row width once
      telemetry.paramStructuralValidation++
      rows = document rows in physical order with rowIndex assigned 0..R-1
      reacquire PARAM lock; require same OPENING entry/task and current source lifetime
      atomically publish SourceKey=resolvedKey,Document,Rows,NativeByteCost then state=READY
      complete all waiters; release childLease in finally
  winner failure/cancel:
      remove exact OPENING alias, complete every waiter with same diagnostic, dispose partial document,
      release childLease, transition CLOSING -> EVICTED; publish no token/owner
  mint a new random param ownerLeaseId bound to persistent identity/session/workspaceSessionGeneration/window/purpose
  return {sessionToken,ownerLeaseId,sourceHash,metadataLayoutHash,rowCount,table metadata}
```

`GetOrOpenBinderChildContent` 的 child entry只允许由 binder cache拥有，保存 immutable readonly memory、content hash、owner/readers/byteCost和有界LRU；PARAM session持 reader lease，不把它再复制进第二个 `byte[]`。其 deterministic failure key包含parent source hash/path generation/physical entry，source改变自然miss。`ParamOpenJoinKey`不能缺child content hash，也不能用mtime/size代替；相同content但不同metadata authority仍不能join。不要在 open 时做 byte-identical rebuild；它属于显式 native validation smoke。不要把 `headerOnly` 计作一次完整 parse 后又完整 parse两遍；telemetry分开记`binderChildMaterialize/binderChildHash/headerProbe/documentParse`。并发32个相同open和顺序`open-close-open`测试必须断言child materialize/hash、header probe、document parse在未evict时各为1；不能只断言最后JSON cache hit。

index projection：

```text
readParamIndex(token, ownerLeaseId, requestPersistentWorkspace, requestSession,
               requestWorkspaceSessionGeneration, requestWebContentsId, includeRowHashes=false):
  lease = AcquireParamReader(token, ownerLeaseId, requestPersistentWorkspace,
            requestSession, requestWorkspaceSessionGeneration, requestWebContentsId, "index")
  try:
    for row in lease.Rows:
        emit {rowIndex,row.id,row.name}
        only if includeRowHashes == true:
            emit lazyRowHash(lease.Document,row)
    telemetry.serializedIndexRows += R
    telemetry.serializedRowPayloads += 0
    return index DTO
  finally:
    ReleaseParamReader(lease)
```

默认请求省略 `includeRowHashes` 时必须等价于 false。index DTO 禁止携带 `dataBase64`；默认也禁止 `dataHash`。

page projection：

```text
readParamPage(token, ownerLeaseId, requestPersistentWorkspace, requestSession,
              requestWorkspaceSessionGeneration, requestWebContentsId, pageIndex, pageSize):
  require pageIndex integer >= 0
  require pageSize in fixed safe range, e.g. 1..200; UI 固定 20
  lease = AcquireParamReader(token, ownerLeaseId, requestPersistentWorkspace,
            requestSession, requestWorkspaceSessionGeneration, requestWebContentsId, "page")
  try:
    R = lease.Rows.length
    start = checked(pageIndex * pageSize)
    if start >= R: return empty page with totalRows=R, not wraparound
    end = min(start + pageSize, R)
    output = new list capacity end-start
    for rowIndex from start to end-1:
        locator = lease.Rows[rowIndex]
        bytes = lease.Document.ReadPhysicalRowBytes(locator)
        require bytes.length == locator.DataLength
        hash = cached requested-row hash or SHA-256(bytes)
        emit {rowIndex,id,name,dataBase64, dataHash:hash}
    telemetry.serializedRowPayloads += end-start
    return {pageIndex,pageSize,totalRows,payloadsIncluded=true,rows}
  finally:
    ReleaseParamReader(lease)
```

若上游的资源预算决定不返回 payload，必须显式 `payloadsIncluded=false` 和稳定 diagnostic，不能返回 `ok=true` 但字段悄悄缺失。page 不能调用 `ParamNativeDocument.Read`、全表 validate、全表 `Select(...).ToArray()` 或先构造 full DTO 再 `Skip/Take`。

token 校验固定顺序：

```text
token not found                         -> PARAM_SESSION_EXPIRED
daemonInstanceId mismatch               -> PARAM_SESSION_EXPIRED
owner lease not found/closed             -> PARAM_SESSION_OWNER_INVALID
persistent workspace/session mismatch    -> PARAM_SESSION_WORKSPACE_MISMATCH
webContentsId mismatch                   -> PARAM_SESSION_WINDOW_MISMATCH
workspaceSessionGeneration mismatch      -> PARAM_SESSION_EXPIRED
pathSourceGeneration/source content mismatch -> PARAM_SESSION_STALE_SOURCE
purpose does not authorize operation      -> PARAM_SESSION_CAPABILITY_DENIED
otherwise acquire reader
```

main 遇到 expired/stale 只允许一次显式 reopen：

```text
request page
  success -> return
  expired and reopenAttempt==0 -> open new session, request same page once
  any second failure -> surface diagnostic; do not effect-loop retry
```

close/evict：`closeParamSession`必须携带`sessionToken + ownerLeaseId + workspacePersistentIdentityHash + workspaceSessionId + workspaceSessionGeneration + webContentsId`，锁内只关闭exact owner lease；跨owner/window/double-close固定拒绝。正常`owners=0`的READY entry可进入有界LRU。达到entry/byte/TTL上限或source invalidation时，在同一锁内把候选改CLOSING并从token lookup摘除，因而与新reader acquire不能交错；若`activeReaders==0`立即锁外dispose，否则由最后一个reader finally dispose。workspace/window切换只关闭该scope的owners；entry无其他owner后才候选evict，不能对仍READY/有reader的entry直接`Map.remove`。PARAM session顶层不再保存单一workspaceSession字段；多owner身份只能存在各自lease里。每个open/acquire/release/close/evict/dispose都有telemetry；正常、序列化异常、hash异常、close竞态、TTL、跨window/double-close和workspace切换测试均断言owner/readers计数守恒。

复杂度：open `O(param bytes + R)` 一次；index `O(R)` 且每行小 DTO；page `O(pageSize * rowWidth)`；N 页不得变成 `O(N*param bytes)`。

### 24.7 B/C-3：PARAM 物理行编辑、重复 ID 和 CSV 两阶段算法

#### 24.7.1 单行 compare-and-swap

写请求必须包含：

```ts
interface ParamPhysicalRowTarget {
  rowIndex: number;
  expectedId: number;
  expectedDataHash: string;
  expectedRowDataSize?: number;
}
```

定位算法：

```text
resolveTarget(document, target):
  require target.rowIndex is present, integer and 0 <= rowIndex < rows.length
  row = rows[rowIndex]
  require row.id == expectedId, else PARAM_ROW_ID_CONFLICT

  actualHash = SHA-256(exact original row data bytes)
  require constant-time/equivalent exact compare to expectedDataHash
  else PARAM_ROW_HASH_CONFLICT
  return physical row
```

production writer/Patch Engine 边界不接受缺 `rowIndex` 的对象，schema decode 时就返回 `PARAM_PHYSICAL_ROW_INDEX_REQUIRED`。旧 UI/旧 CSV 的 ID-only 输入只能先走命名明确的只读兼容解析器：

```text
resolveLegacyIdOnly(frozenSession, expectedId):
  matches = frozenSession.idToPhysicalRows[expectedId]
  if count==0: PARAM_ROW_NOT_FOUND
  if count>1: PARAM_ROW_ID_AMBIGUOUS
  rowIndex = matches[0]
  read exact row through same frozen reader lease
  return full ParamPhysicalRowTarget {rowIndex,expectedId,expectedDataHash,expectedRowDataSize}
```

调用方必须把这个完整 physical target 显式传入正常 validation；legacy resolver本身无写权限、不能调用 Patch Engine，也不能让 writer再次按 ID 搜索。这样兼容旧输入不等于保留第二套 production authority。

然后只在该行固定宽度 byte span 上应用字段 patch。字段编码前验证 Paramdex field offset/type/bit range，所有 field mutation 先在内存副本完成；任一字段失败则整行不写。最终仍由 Patch Engine 把 staging 产物提交，不能直接覆盖源文件。

#### 24.7.2 批量 mutation

批量写必须先全量验证，再一次提交：

```text
phase 1 VALIDATE:
  workingRowByIndex = Map<rowIndex, mutable copy of exact original row bytes>
  for mutation in input order:
      resolve exact physical target
      reject duplicate mutation targeting same rowIndex+field unless values identical
      rowCopy = workingRowByIndex.get(rowIndex) or clone original row exactly once
      encode proposed field bytes into that same rowCopy, so later fields preserve earlier fields
      store rowCopy back under rowIndex
  if any failure: return all diagnostics, write nothing

phase 2 APPLY:
  copy original document once
  for each workingRowByIndex entry sorted by physical data offset:
      compare original/final row bytes and generate exactly one non-overlapping row span patch
  apply those validated row span patches
  verify no spans overlap unexpectedly
  write to Bridge staging root
  reread using same expectedRowDataSize
  assert intended physical rows/fields changed and all other bytes preserved as writer contract requires
  hand staged artifact to Patch Engine transaction
```

禁止边读 CSV 边写文件；那会在第 200 行失败时留下半份修改。

#### 24.7.3 CSV export

固定列顺序：`rowIndex,id,name,<metadata fieldId order>`。`rowIndex` 输出十进制物理序号，不排序；重复 ID 各占独立记录。CSV 使用成熟 parser/writer 库处理引号、逗号、CRLF 和换行，禁止手写 `split(',')`。

```text
for rowIndex 0..R-1:
  row = physical rows[rowIndex]
  decode fields using selected Paramdex layout
  writer.writeRecord(rowIndex,id,name,fields...)
```

#### 24.7.4 CSV import

```text
read header with CSV parser
require id column
detect hasRowIndex
reject duplicate/unknown required column names
open exactly one PARAM session; freeze token + sourceHash + pathSourceGeneration + workspaceSessionId/workspaceSessionGeneration

parse all CSV records to lightweight targets first
compute distinct touched pageIndex values
read each touched page at most once through the frozen token
if any request would reopen/expire or reports a different source identity:
  fail whole import PARAM_IMPORT_STALE_SOURCE; submit zero mutations

for each CSV record with csvLineNumber:
  parse id exactly as safe integer supported by protocol
  if hasRowIndex:
      parse rowIndex; locate physical row; require id agrees
  else:
      lookup all physical rows by id
      require exactly one; repeated id => reject this record
  read current row hash from the already fetched frozen-session page map
  parse every provided field through metadata type parser
  append validated mutation carrying rowIndex+expectedId+expectedDataHash

if any record has error:
  return diagnostics including csvLineNumber/rowIndex/id/fieldId
  submit zero mutations
else:
  submit one Patch Engine batch
```

import 结束前再次核对 session/source identity。任何 eviction 后透明 reopen都不允许，因为那会把不同版本的行混在一批 CAS里；用户必须重新开始导入。复杂度固定为 `O(csvRecords + distinctTouchedPages*pageSize + encodedFields)`，不得逐 CSV 行单独请求一页，也不得为了 hash读取整表 payload。

搜索/滚动不得改变物理 identity。React row key 固定包含 `pathSourceGeneration + table entry identity + rowIndex`，不能只用 id，也不能把`workspaceSessionGeneration`冒充source版本。当前选中项保存 rowIndex；过滤结果只是 rowIndex 数组的视图。

### 24.8 C-4：PARAM renderer 本地搜索、虚拟列表和 page 状态机

renderer 首次只保存轻量 index：

```ts
interface ParamIndexRowView {
  rowIndex: number;
  id: number;
  name: string | null;
  normalizedSearchText: string;
}
```

`normalizedSearchText` 在 index 到达时每行计算一次，例如 `${id}\u0000${name ?? ""}` 的 Unicode lower-case；不要每次键盘输入对每行重复分配多个字符串。

搜索算法：

```text
on index or deferred query change:
  q = trim + lower-case query
  if q empty: visibleRowIndices = [0..R-1]
  else:
      one linear scan over index rows
      append row.rowIndex when normalizedSearchText includes q
  preserve selection by physical rowIndex if still present
  virtualizer receives visibleRowIndices, not cloned row DTOs
```

R 只有数千时 `O(R)` 本地扫描足够；先测 handler P95。不得为了“优化”加 IPC search 或只加载前 N 行。若未来 R 足以超过 16.7 ms，再把相同纯函数移到 worker，不改变数据语义。

page key：

```text
workspaceSessionGeneration | pathSourceGeneration | containerSourceHash |
physicalEntryIdentity | paramSessionToken | paramOwnerLeaseId | pageIndex | pageSize
```

状态机：

```text
idle --select/visible--> loading
loading --success,payloads--> loaded
loading --success,omitted--> omitted
loading --error---------> failed
loading --workspaceSessionGeneration/pathSourceGeneration change or cancel--> idle of new key
omitted/failed --explicit Retry only--> loading
loaded --workspaceSessionGeneration/pathSourceGeneration change------------> idle
```

effect 伪代码：

```text
pageIndex = floor(selectedRowIndex / pageSize)
key = makePageKey(...)
state = pageStates.get(key) ?? idle
if state != idle: return
set loading before issuing IPC
capture requestWorkspaceSessionGeneration + requestPathSourceGeneration + exact paramSessionToken/ownerLeaseId
await readPage
if workspace session/path source/session owner任一stale: discard without state write
if payloadsIncluded: merge rows by rowIndex; set loaded
else: set omitted with diagnostic
catch: set failed with diagnostic
```

`loadedRows` 更新不能再次触发相同 key 请求。用户 Retry 清除的只是该 key 的 terminal state。table重开产生新workspace-session key，source变化产生新path-source key；不要用裸generation，也不要清空其他仍被owner使用的session。

虚拟列表的 DOM 节点上限由 viewport overscan 决定，不能随 R 增长。选择和滚动 handler 只做数组索引/状态更新，不能 stringify 全表、clone 全 rows 或触发 metadata/IPC。

### 24.9 D-1：FLVER FaceSet 解码与 triangle-list 算法

所有权：C# Bridge的`FlverNativeDocument`。main/renderer只接收**当前chunk已经验证的dense triangle-list**；不得再次解释FaceSet、strip、restart、winding或source index位宽。完整triangle-list只允许由独立oracle/helper在测试进程中消费同一cursor生成，production static路径禁止先构造全mesh数组。

#### 24.9.1 版本化规则 registry，不允许“取第一个”

tracked production registry固定为`bridge/SoulForge.Bridge/FormatRules/sekiro-face-set-rules.v1.json`，以embedded resource加载；schema和loader测试固定hash。它只能根据格式字段选择行为，禁止出现modelName、mapId、mesh ordinal、文件hash或corpus logical URI：

```ts
interface FaceSetDisplayProfileV1 {
  profileId: "sekiro-map-static-highest-detail-v1"|"sekiro-character-preview-highest-detail-v1";
  game: "sekiro";
  workflow:"map-static"|"character-preview";
  requiredFlagsExact: 0;                 // FSFlags.None；最高细节、非 motion-blur
  selector: "first-exact-flags-in-mesh-reference-order";
  fallback: "fail";                      // 禁止成熟 helper 的“找不到就 FaceSets[0]”fallback
  evidenceArtifactHashes: string[];
}

interface FaceSetDecodeRuleV1 {
  ruleId: string;
  game: "sekiro";
  internalVersion: { minInclusive:number; maxInclusive:number };
  nativePredicate: {
    triangleStrip: boolean|null;
    flagsMask: number;
    flagsValue: number;
    sourceIndexBits: 16|32|null;          // 见24.9.0：8 不是 EdgeCompressed 的判据
    edgeCompressedFlag: boolean|null;
  };
  primitiveRestart:
    | { mode:"disabled" }
    | { mode:"sentinel-if-parent-vertex-count-less-than"; sentinel:65535; thresholdExclusive:65535 };
  winding: "a-b-c_then_c-b-a_alternating";
  evidenceArtifactHashes: string[];
}
```

A2 producer从Andre.SoulsFormats公开行为probe与成熟地图/角色工具黑盒artifact提炼规则；独立verifier用冻结FLVER重新算每mesh的`selectedFaceSetOrdinals[]/triangleListSha256`。registry顶层必须同时冻结map-static和character-preview两个display profile及共用decode rules；当前两profile选择语义相同但ID/用途不同，未来证据变化不能互相偷换。loader要求：profile/ruleId唯一、workflow与profileId双射、version range/predicate不存在重叠歧义、evidence非空且hash可解析、规则只含上述有限操作。两个Sekiro preview profile的成熟语义都锁死为：在**mesh原生FaceSet引用数组顺序**中选择第一个`Flags == FSFlags.None (0)`；这排除LOD1、LOD2、MotionBlur及它们的组合。找不到即`FLVER_DISPLAY_FACESET_UNSUPPORTED`，绝不fallback到第一个FaceSet；同为None的后续FaceSet也不重复渲染。复数字段仍保留以便未来以新schema/evidence增加profile，但V1要求`selectedFaceSetOrdinals.length===1`。旧实现的`FirstOrDefault` fallback和“把所有匹配FaceSet都加入”必须从production删除。

> **【实测校正 · 上面这条删除指令有一半指向不存在的代码；另有第三个站点绝不能按同样方式改】（2026-08-27 实测）**
>
> 上面一句点了两样要删的东西，实测只有一样存在。**在动手前先读完这个框，否则你会在代码里找一个不存在的东西，或者把第三处改成正好是这条指令要求删掉的形态。**
>
> **（一）「把所有匹配 FaceSet 都加入」：production 里不存在。**
> 实测 `grep -rnE "Where\([^)]*Flags == 0\)" --include=*.cs bridge` 零命中；`grep -nE "foreach.*[Ff]aceSet|AddRange|SelectMany" bridge/SoulForge.Bridge/FlverNativeDocument.cs` 里 `SelectMany` 唯一命中是 `:1483` 的 `GxList!.Items`，与 FaceSet 无关。**不要去找它，不要为了「删掉它」改任何代码。** 这半句是历史描述，留着只为说明 V1 为什么要求 `selectedFaceSetOrdinals.length === 1`。
>
> **（二）`FirstOrDefault` fallback：存在，是两处，而且写法不同——grep 一个模式只能找到一个。**
>
> | 站点 | 位置 | 作用域 | 无匹配时 | 供给字段 |
> |---|---|---|---|---|
> | **C2-A** | `FlverNativeDocument.cs:733`（`GetMeshIndexSize`） | mesh 级 | `?? candidates[0]` | `indexSize` |
> | **C2-B** | `FlverNativeDocument.cs:753-754`（`GetMeshIndicesBase64`） | mesh 级 | `if (selected.FaceSet == null) selected = candidates[0];` | `indicesBase64` |
> | **N4** | `FlverNativeDocument.cs:1184-1186`（回填 mesh 顶点信息） | **文件级** | `fsIndex` 落 `0` → **别的 mesh 的** FaceSet | `indexFormat` |
>
> C2-A 与 C2-B 语义完全相同（「没有 `Flags==0` 就退回本 mesh 引用的第一个 FaceSet」），但**源码形态不同，原因是元素类型不同**：
> - `:730` 是 `.Select(i => _faceSets[i])`，元素是 `FlverFaceSetEntry`。它在 `:1754` 声明为 `internal sealed record`（无 `struct` 关键字 ⇒ 引用类型），所以 `FirstOrDefault` 无匹配返回 `null`，可以用 `??`。
> - `:750` 是 `.Select(i => (Index: i, FaceSet: _faceSets[i]))`，元素是**值元组**。`FirstOrDefault` 无匹配返回 `default` 即 `(0, null)`，**不是 `null`**，所以 `??` 在这里编译不过，只能改判成员 `selected.FaceSet == null`。
>
> 后果：**你 grep `?? candidates[0]` 只会命中 C2-A，grep `== null` 会淹在噪声里。** 要一次找齐这两处，用 `grep -nE "candidates\[0\]" bridge/SoulForge.Bridge/FlverNativeDocument.cs`，实测命中且只命中 `:733` 与 `:754`。
>
> 两处的修法都是：按 §24.9 修正后的伪代码报结构化诊断（`FLVER_DISPLAY_FACESET_UNSUPPORTED`，EdgeCompressed 走前置分类分支），**不是**静默取第一个。注意 `:727`/`:732`/`:746`/`:752` 还有四条更早的 `return 16` / `return null` 早退，它们和本条是不同问题：`return 16` 是**猜**一个位宽，同样属于「手里有权威字段却改用推断」，与 `:2258` 记的 `ipc.ts:4535` 同类。本条只要求你改 `candidates[0]` 这两处；`return 16` 要不要一起改属于 §24.9 的判断，别擅自扩大。
>
> **（三）N4 是独立缺陷，改法与 C2 相反。把它当第三个 C2 站点处理会造成回归。**
>
> `FlverNativeDocument.cs:1183-1186` 原文：
>
> ```csharp
> // 主 face set 的 index 格式：优先 Flags==0，其次第一个。
> var fsIndex = mesh.FaceSetIndices.FirstOrDefault(i => i >= 0 && i < faceSets.Count && faceSets[i].Flags == 0);
> if (fsIndex < 0 && mesh.FaceSetIndices.Count > 0) fsIndex = mesh.FaceSetIndices[0];   // 死代码
> if (fsIndex >= 0 && fsIndex < faceSets.Count) indexFormat = faceSets[fsIndex].IndexSize;
> ```
>
> `mesh.FaceSetIndices` 在 `:1741` 声明为 `IReadOnlyList<int>`，元素是**值类型**，所以 `FirstOrDefault` 无匹配返回 `default(int)` 即 `0`，**不是 `-1`**。`:1185` 的 `fsIndex < 0` 因此恒假，那行**永远不执行**——作者想写的「其次第一个」（退回 `mesh.FaceSetIndices[0]`，本 mesh 自己的 FaceSet）从未生效。
>
> 实测（`Temp/sf-fsflags`，net6.0，复刻 `IReadOnlyList<int>` 形状）：
>
> ```
> no-match     -> 0   (a < 0 ? False)
> match-at-0   -> 0   (b < 0 ? False)
> 两种情形返回值相同（哨兵碰撞): True
> ```
>
> **两个致命点，顺序不能颠倒：**
>
> **① 哨兵碰撞。** 返回 `0` 同时代表「无匹配」和「匹配到 FaceSet 0」，二者不可区分（实测第三行 `True`）。所以**不要**把 `:1185` 改成 `fsIndex <= 0`：`mesh.FaceSetIndices[0]` 且 `Flags==0` 是最常见的正常情形，那样改会把合法命中误判为无匹配，把当前「有时错」变成「常见情形也走 fallback」。正确修法是先判存在性再取值（`Where(...).Select(...)` 后判 `Count == 0`，或换成 `int?`），**而不是给 `fsIndex` 挑一个更好的哨兵值**。
>
> **② 作用域错误，这才是它和 C2 的本质区别。** `:1186` 的 `faceSets` 是 `:1094` 建立的**文件级**列表（`:182 _faceSets = faceSets` 证明与 C2 两站点的 `_faceSets` 同源同一份）。C2-A/C2-B 的 `candidates` 先经 `mesh.FaceSetIndices` 映射，退化目标是**本 mesh 引用的**第一个 FaceSet；N4 落 `0` 拿到的是 `faceSets[0]`，即**整个文件的**第一个 FaceSet，可能属于另一个 mesh。举例：mesh 的 `FaceSetIndices = [5,6,7]` 且都不是 `Flags==0`，则 C2 退到 `_faceSets[5]`，N4 退到 `faceSets[0]`——两者无任何关系。
>
> **所以严禁**把 `:1185` 改成 `?? candidates[0]` 这类形态：那正好是本节开头命令删除的 fallback，等于一边删一边装回去，而且装的是作用域更错的版本。
>
> **（四）跨站点后果：同一个 payload 里的三个字段来自三套算法，没有任何门禁比较它们。**
>
> `BridgeCommandService.cs:1773-1776` 相邻四行同时发出：`indexFormat = mesh.IndexFormat`（← N4，文件级）、`indexSize = document.GetMeshIndexSize(meshIndex)`（← C2-A，mesh 级）、`indicesBase64 = indices`（← C2-B，mesh 级）。下游**分头消费、各信一个**：
>
> - `packages/core/src/export/flverToGlb.ts:119-129` 用 **`indexFormat`** 决定 `Uint16Array` 还是 `Uint32Array`；
> - `packages/shared/src/flver-preview.ts:31,108` 用 **`indexSize`**（类型即 `16 | 32`）；
> - `apps/desktop/src/main/ipc.ts` 对两个字段**都零引用**（实测 grep 空），改用 `:4535` 的 `idx.length % 2 !== 0` 猜——即 §上文 `:2258` 已记的那条。
>
> 于是在「该 mesh 无 `Flags==0` FaceSet 且 `faceSets[0].IndexSize` 与本 mesh 的不同」时：`indicesBase64` 是本 mesh 的字节，`indexFormat` 是别的 mesh 的位宽，**`flverToGlb` 按错宽度解码，每个三角形索引全错**（32 位数据按 16 位读 = 每个索引的高半字被当成独立索引）；而同一时刻 `flver-preview` 用 `indexSize` 解码是对的。**同一份数据在两条路径上一对一错，且预览正确会让你以为导出没问题。**
>
> 实测 `grep -rnE "indexFormat.*indexSize|indexSize.*indexFormat"` 覆盖 `packages apps bridge scripts` 全空 ⇒ **没有任何断言比较这两个字段**。你修完 N4 后要补的门禁就是这一条：同 mesh 上 `indexFormat === indexSize`。**补完后必须先用负向用例证明它会红**——把其中一个字段人为改成另一个值，确认门禁 FAIL，再还原并确认字节级一致；没见过它红过的门禁不算门禁。
>
> **（五）触发条件与可见性。** N4 在解析期对**每个 mesh 无条件执行**（`:1165` 的 `foreach`），早于任何 display-profile 判断，所以它不受 §24.9 那套「找不到就报 UNSUPPORTED」的保护。受影响的正是全部 FaceSet 都 `Flags != 0` 的 mesh——按本节语义即纯 LOD / 纯 MotionBlur / EdgeCompressed mesh。错值还会经 `:1405` 的 meshSamples 流到 `FlverWorkbenchPanel.tsx:190` 的「索引格式」列，**用户可见**，可用来肉眼验证修复。
>
> **未测（照抄前必须自己补）：**
> - 真实 Sekiro corpus 里是否存在「全部 FaceSet 都 `Flags != 0`」的 mesh。**没有它，N4 的错值路径就不会在真机上被触发**，本条严重度要降级为「潜在」。文档其他位置也没有这项统计。
> - 上述 mesh 与 `faceSets[0]` 的 `IndexSize` 是否真的会不同（同为 16 位时 N4 的错值恰好无害）。
> - 文件 `faceSetCount == 0` 时 `indexFormat` 停留在 `:1167` 的初值 `0`，`flverToGlb.ts:123` 的 `(indexFormat === 16 || indexFormat === 32)` 判false ⇒ `indices = null`。**未测**：`buildGlb` 收到 `indices: null` 是抛错还是静默导出无索引网格。若是后者，这是一条独立的静默失败，不要和 N4 混记。
> - `:727`/`:732`/`:746`/`:752` 那四条 `return 16` / `return null` 早退的真机命中率未测。


选择步骤：

```text
selectDisplayFaceSets(mesh, registry, requiredProfileId):
  validate every mesh.FaceSetIndex is in range; one invalid index fails whole mesh
  candidates = referenced FaceSets in physical reference order; do not dedupe by flags
  profile = exact requiredProfileId from frozen registry; require profile.workflow matches caller
  displayCandidates = candidates where uint32(candidate.Flags) == profile.requiredFlagsExact

  # EdgeCompressed 预分类必须放在 None 过滤【之后、报错之前】，否则诊断退化：
  # FSFlags.EdgeCompressed == 0x40000000，与 None(0) 互斥，必然被上面的过滤剔除。
  # 不做这一步的话，"整个 mesh 都是 EdgeCompressed" 和 "这个 mesh 没有 None FaceSet"
  # 会被报成同一个 FLVER_DISPLAY_FACESET_UNSUPPORTED，接手者无法区分。
  if displayCandidates is empty:
      if any candidate has (uint32(candidate.Flags) & 0x40000000) != 0:
          fail FLVER_FACESET_EDGE_COMPRESSED_UNSUPPORTED
          # 不得把 EdgeCompressed bytes 当 uint16；若未来支持，必须新 schema
          # + 独立 decompress oracle。权威侧存在可用解压实现
          # （FLVER2+FaceSet+EdgeIndexCompression），所以这是本项目的显式取舍，
          # 不是"权威也做不到"。
      fail FLVER_DISPLAY_FACESET_UNSUPPORTED
  candidate = displayCandidates[0]       # first in reference order；不是按physical ordinal排序
  rawBits = GetVertexIndexSize(candidate)      # 权威是方法不是字段，见下方实测框
  require rawBits in {16,32} else FLVER_FACESET_INDEX_BITS_UNSUPPORTED
      # rawBits==8 在此处即 UNSUPPORTED。原文那条 `require (rawBits==8) == edgeFlag`
      # 已删除：它在本函数里恒等于 `require rawBits != 8`，且抢先用错误 code 报出。
  rule = resolve exactly one decode rule from InternalVersion + candidate native fields
  0 rule -> FLVER_DISPLAY_FACESET_UNSUPPORTED
  >1 rule -> FLVER_FACESET_RULE_AMBIGUOUS
  selected = [{ordinal,ruleId,primitiveRestart,winding,indexBits:rawBits,
               cullBackfaces:candidate.CullBackfaces}]
  return immutable plan + registrySha256
```

#### 24.9.0 上面契约里四个符号的实测出处（2026-08-27）

原文用了四个仓库内解析不出来的符号：`FSFlags.EdgeCompressed`、`candidate.CullBackfaces`、`candidate effective index-size field`、`documented header fallback`。不要在 SoulForge 仓库里找它们——**实测 `bridge/SoulForge.Bridge/SoulForge.Bridge.csproj` 里零 `PackageReference`、零 `ProjectReference`，SoulsFormats 既没 vendor 也没以包引用，Bridge 是自己写的 FLVER 解析器。** 这四个符号全部属于仓库外权威。

权威文件（本机实测存在）：

```text
D:\mystream\Sekiro Shadows Die Twice\tools\DSAnimStudio-4.9.9[Build 4999]\SoulsFormats.dll
849920 bytes
SHA-256 = 0B8F34797713310369D1E7E2ABB764DCE967D51D49815B79B7DD664495F9CF61
```

**取值方法必须是纯元数据读取，不是加载程序集。** `[Reflection.Assembly]::ReflectionOnlyLoadFrom` 在 Windows PowerShell 5.1 下对这个 DLL 返回 `null`（.NET Framework 载不了它的目标框架），别在那条路上耗时间。可行做法是用 `System.Reflection.Metadata` 的 `PEReader`/`MetadataReader` 只解析 CLI 元数据表——它不执行 DLL 内任何代码，因此对来源不完全可信的第三方 DLL 也是安全的。本节数值即由该方法测得，`ASM=SoulsFormats ver=1.0.0.0`，`TYPEDEF_COUNT=861`。

**`FSFlags` 真实取值**（`SoulsFormats.FLVER2+FaceSet+FSFlags`，全程集仅此一个 `FSFlags` 类型）：

| 成员 | 十进制 | 十六进制 |
|---|---|---|
| `None` | 0 | `0x0` |
| `LodLevel1` | 16777216 | `0x1000000` |
| `LodLevel2` | 33554432 | `0x2000000` |
| `EdgeCompressed` | 1073741824 | **`0x40000000`** |
| `MotionBlur` | 2147483648 | `0x80000000` |

**必踩的坑：`FlverNativeDocument.cs:85` 有个 `private const uint TypeEdgeCompressed = 0xF0;`，它不是 FaceSet flag。** 它是 FLVER2 **LayoutMember 顶点类型**，用在 `:419`（`a.Type == TypeEdgeCompressed`）和 `:1610`。弱 agent grep「EdgeCompressed」第一个撞上的就是它，拿 `0xF0` 当 flag 掩码用会得到恒 false 的判据——与真值差 2²⁶ 倍。写 `0x40000000` 时直接用字面量并在注释里引本节，不要 `#define` 到那个常量上。

**仓库内 EdgeCompressed 的现有判据走的是位宽，不是 flag 位。** `FlverNativeDocument.cs:757`：`if (fs.IndexSize != 16 && fs.IndexSize != 32) return null; // 边压缩（8）等不支持`。这是当前 production 的真实行为：只返回 `null`，没有结构化 diagnostic。

**`CullBackfaces` 在权威上确实存在**：`SoulsFormats.FLVER2+FaceSet.CullBackfaces` 是公开属性（全程集含 `Cull` 的成员只有它和它的 backing field，命中数 2）。所以文档要求 `cullBackfaces:candidate.CullBackfaces` 不是凭空要求。**缺口在 SoulForge 侧**：`FlverNativeDocument.cs:1755` 的 record 是

```csharp
uint Flags, bool TriangleStrip, int IndexCount, int IndicesOffset, int IndexSize
```

——没有 `CullBackfaces`；全仓 grep `CullBackfaces` 计数 **0**（`--include=*.cs --include=*.ts --include=*.tsx`，范围 `bridge apps packages`）。要满足本节契约必须先给这个 record 加字段并在解析处填值，不是「读出来就有」。

**`index-size field` 与 `documented header fallback` 这两个措辞在权威上没有对应物，写契约时不要照抄。** 实测：

- 权威 `FLVER2+FaceSet` **没有** `IndexSize` 属性或字段，只有方法 `GetVertexIndexSize()`。
- `VertexIndexSize` 属性属于 `SoulsFormats.FLVER0`，是**另一个格式版本**，不能拿来给 FLVER2 背书。
- 过滤 `FLVER2Header` / `Header` 类型名 **零命中**，「header fallback」在权威里找不到锚点。

`IndexSize` 是 **SoulForge 自己 record 上的字段名**（`:1755`），和权威的方法不同名。伪代码已相应改成 `rawBits = GetVertexIndexSize(candidate)`，落到 SoulForge 实现时对应读自己的 `IndexSize`；两边不要混着写。

**原契约有一条恒不触发的死判据，已从伪代码删除，这里记录为什么。** 原文是：

```text
edgeFlag = (candidate.Flags & FSFlags.EdgeCompressed) != 0
require (rawBits == 8) == edgeFlag else FLVER_FACESET_EDGE_ENCODING_INCONSISTENT
if rawBits == 8: fail FLVER_FACESET_EDGE_COMPRESSED_UNSUPPORTED
```

推导只用本节实测值和 §24.9 自己的文本，不需要外部知识：

1. `displayCandidates` 过滤条件是 `uint32(candidate.Flags) == profile.requiredFlagsExact`，而 §24.9 把两个 V1 profile 的语义锁死为「第一个 `Flags == FSFlags.None (0)`」，故 `requiredFlagsExact == 0`。
2. 走到 `edgeFlag` 那行的 `candidate` 必然满足 `Flags == 0`。
3. `0 & 0x40000000 == 0`，所以 **`edgeFlag` 恒为 `false`**。
4. 于是第二行退化成 `require (rawBits == 8) == false`，即 `require rawBits != 8`；**`FLVER_FACESET_EDGE_ENCODING_INCONSISTENT` 永不触发**。
5. 又因为第二行会先于第三行失败，**`FLVER_FACESET_EDGE_COMPRESSED_UNSUPPORTED` 也永不可达**，8 位 FaceSet 会带着「编码不一致」这个错误 code 报出。
6. 真正设了 `EdgeCompressed` 的 FaceSet（`Flags == 0x40000000`）在第 1 步就被过滤掉，走 `FLVER_DISPLAY_FACESET_UNSUPPORTED`，**与「这个 mesh 根本没有 None FaceSet」完全无法区分**——恰好摧毁 §24.9 想建立的诊断区分。

伪代码已按此改：位宽判据收成 `require rawBits in {16,32}`，EdgeCompressed 改为在 `displayCandidates` 为空时的预分类，独占 `FLVER_FACESET_EDGE_COMPRESSED_UNSUPPORTED`。这属于同一类失效的两个变体：**断言层次没有对准实现真正承诺的东西**（层次错了就得到与实现无关的结果，转绿的办法往往是放宽判据），以及**只靠源码字符串 grep 的 must-not 门禁**（改个名字就报绿，抓不到真实行为）。两者都是看着严谨、实际恒真。

**「EdgeCompressed 不支持」是本项目的取舍，不是权威的能力缺失。** 实测权威侧存在 `SoulsFormats.FLVER2+FaceSet+EdgeIndexCompression` 嵌套类，带 `DecompressIndexes_C_Standalone` 和 `ReadEdgeIndexGroup` 两个方法。所以 §24.9 里「若未来支持，必须新 schema + 独立 decompress oracle」是可实现的路线，不要写成「格式无解」。

**未测（照抄前必须自己补）：**

- `GetVertexIndexSize()` 的**返回语义**（返回 8/16/32 还是字节数、以及它内部是否真有 header 级 fallback）。本次只读了方法签名的存在性，没有读 IL、没有调用。§24.9 里凡是依赖「effective index size 如何算出」的判据都还没有权威背书。
- `FaceSet.Triangulate` 的实际绕序。§4/§24.9 多处断言权威是偶数步 `(a,b,c)`、奇数步 `(c,b,a)`，而冻结实现是 `(b,a,c)`。该结论继承自本文档早前记录，**本次没有独立复现**：既没读 `Triangulate` 的 IL，也没执行它。动 `TriangulateFaceSet` 之前必须先把这条测实，否则是拿一个未验证的绕序去改一个有测试背书的绕序。
- `EdgeIndexCompression` 两个方法的可用前提（是否需要额外原生依赖）。只确认了方法存在。
- 真实 Sekiro 语料里到底有没有 `Flags == 0x40000000` 的 FaceSet。上面第 6 步的诊断退化是**逻辑必然**，但它在真实语料上的触发频率未测。

本版本map-static profile每mesh恰选一个FaceSet；字段统一保留复数`selectedFaceSetOrdinals[]`，但loader/consumer都断言其长度为1、ordinal不重复且保持mesh引用顺序。若以后证据证明另一个Sekiro工作流需要组合多个FaceSet，必须升级profile/schema并为组合顺序增加oracle，不能在V1里悄悄恢复`include-all`。production static DTO回传ordinal、ruleId、`CullBackfaces`和registry SHA；acceptance逐mesh与manifest比较。manifest只验收，不参与production选择。

#### 24.9.2 production可恢复的streaming decoder

```ts
interface FaceSetTriangleCursorV1 {
  selectedPlanIndex: number;
  sourceIndexOrdinal: number;       // 当前FaceSet下一项source index
  previous0: number|null;
  previous1: number|null;
  flip: boolean;
  emittedTriangleOrdinal: number;  // 跨selected FaceSet单调递增
  emittedFaceSetTriangleOrdinal: number;
}

interface SelectedFaceSetPlanV1 {
  physicalOrdinal: number;
  triangleStrip: boolean;
  sourceIndexBits: 16|32;
  indexCount: number;
  ruleId: string;
  primitiveRestart:
    | {mode:"disabled"}
    | {mode:"sentinel-if-parent-vertex-count-less-than";sentinel:65535;thresholdExclusive:65535};
  winding: "a-b-c_then_c-b-a_alternating";
  cullBackfaces: boolean;
  nativeIndexBufferLocator: {dataStart:number;indicesOffset:number;byteLength:number};
}
```

`SelectedFaceSetPlanV1[]`就是后文`StaticMeshPlanEntry.selectedFaceSetPlan`的元素类型，不存在第二个更短plan。构造时逐项checked验证`nativeIndexBufferLocator`完全落在当前immutable FLVER document bytes内，`byteLength===indexCount*(sourceIndexBits/8)`，physical ordinal唯一且按mesh原生FaceSet引用数组的顺序；这里的“物理顺序”不是把ordinal重新排序。consumer不能从flags再次选FaceSet或重算restart。locator只保存在Bridge session内，绝不序列化给main/renderer。

`readSourceIndex(fs,i)`先checked-multiply `i * (indexBits/8)`，验证`DataStart + IndicesOffset + byteRange`都在source bytes内，再以**little-endian**读`uint16/uint32`；禁止用host-endian cast。每读到一个非restart index立即要求`index < meshVertexCount`，不能等renderer崩坏才发现，也不能clamp。

```text
nextTriangle(plan, cursor):
  while selectedPlanIndex < plan.length:
    fs = plan[selectedPlanIndex]          # 已包含ruleId/restart/winding/cull；不再查第二份rule

    if !fs.TriangleStrip:
      require fs.IndexCount % 3 == 0
      if sourceIndexOrdinal == fs.IndexCount:
        move to next FaceSet; reset sourceIndexOrdinal/previous/flip/emittedFaceSetTriangleOrdinal; continue
      require sourceIndexOrdinal + 3 <= fs.IndexCount
      a,b,c = read exact three indices; sourceIndexOrdinal += 3
      validate all three in bounds
      result = {a,b,c,faceSetOrdinal:fs.physicalOrdinal,ruleId:fs.ruleId,
                meshTriangleOrdinal:emittedTriangleOrdinal,
                faceSetTriangleOrdinal:emittedFaceSetTriangleOrdinal}
      emittedTriangleOrdinal++; emittedFaceSetTriangleOrdinal++
      return result

    while sourceIndexOrdinal < fs.IndexCount:
      x = readSourceIndex(fs,sourceIndexOrdinal); sourceIndexOrdinal++
      restartEnabled = fs.primitiveRestart.mode==sentinel-if-parent-vertex-count-less-than
                       and meshVertexCount < fs.primitiveRestart.thresholdExclusive
      if restartEnabled and x==fs.primitiveRestart.sentinel:
        previous0=null; previous1=null; flip=false; continue
      validate x < meshVertexCount
      if previous0 is null: previous0=x; continue
      if previous1 is null: previous1=x; continue
      a=previous0; b=previous1; c=x
      previous0=b; previous1=c
      if a==b or b==c or c==a:
        flip = !flip; continue              # degenerate仍推进strip奇偶
      triangle = flip ? (c,b,a) : (a,b,c)  # 精确匹配成熟SoulsFormats canonical index顺序
      flip = !flip
      result = {triangle,faceSetOrdinal:fs.physicalOrdinal,ruleId:fs.ruleId,
                meshTriangleOrdinal:emittedTriangleOrdinal,
                faceSetTriangleOrdinal:emittedFaceSetTriangleOrdinal}
      emittedTriangleOrdinal++; emittedFaceSetTriangleOrdinal++
      return result

    move to next FaceSet; reset sourceIndexOrdinal/previous/flip/emittedFaceSetTriangleOrdinal

  return END
```

restart启用条件必须精确复现本机成熟SoulsFormats的调用契约：仅triangle-strip decode rule声明`sentinel-if-parent-vertex-count-less-than`且父mesh `vertexCount < 65535`时，`0xFFFF`才重启strip；`vertexCount >= 65535`或rule disabled时，65535就是普通index并照常做bounds检查。这里不是让调用方凭经验猜vertex count，而是把成熟实现的**显式二元条件**固化进版本化rule和golden test。32-bit FaceSet在同一条件下仍使用值65535，绝不能擅自换成`0xFFFFFFFF`；EdgeCompressed固定在进入cursor前失败，不能默认按16位读。

production cursor保存`previous0/previous1/flip/sourceIndexOrdinal`，所以chunk边界从当前位置继续是`O(new source indices)`；禁止每页从FaceSet开头重放到triangle ordinal。重试同一immutable cursor复制相同状态并比较raw hash。oracle helper可以：

```text
decodeEntireForOracle(plan):
  cursor = zero
  while triangle = nextTriangle(plan,cursor): append triangle
  return array + SHA-256(canonical little-endian uint32 triangle bytes)
```

该helper只在corpus generator/verifier和单测使用，不得被`read-map-static-geometry`调用。成熟SoulsFormats的canonical strip顺序是偶数步`(a,b,c)`、奇数步`(c,b,a)`；`(b,a,c)`虽然是循环置换且渲染绕序相同，但triangle-list bytes/hash不同，固定拒绝。复杂度`O(I+T)`；production峰值为source file/document + constant decoder state + 当前dense chunk，而不是全mesh triangle-list/base64。单元测试必须覆盖list、strip的精确index序列、degenerate、chunk边界恰落在前两个strip index之后、`vertexCount=65534/65535/65536`三条restart边界、disabled sentinel、16/32-bit source、8-bit/EdgeCompressed精确拒绝、None/LOD/MotionBlur混排只选首个None、无None不fallback、`CullBackfaces`真假、越界以及规则0/多重匹配。旧“多个selected FaceSet”fixture若属于V1默认profile必须改成negative fixture，不能用测试迫使production偏离成熟选择语义。

### 24.10 D-2：静态地图 dense chunk 生成算法

固定协议：`MapStaticGeometryPage.chunks.length`在production固定为1；模型完成且没有剩余几何的终止页为0。session只保留immutable native FLVER document、24.9 FaceSet plans/cursors、mesh locator和小metadata，不预建`allPositions/allIndices/allChunks/allBase64`。

**冻结实现里已经有两处违反本节成本模型的具体缺陷，接手 D 阶段时都要修掉（2026-08-27 实测补全第二处）。** 只修下面「违反 1」不算修完：**违反 2 更贵，而且正是上一段协议句点名禁止的那个形态**；而违反 1 恰好是两者中更便宜、更容易「看起来修好了」的那个。

**违反 1（瞬时：每页一次全文件读取 + 全文件哈希）** —— `bridge/SoulForge.Bridge/BridgeCommandService.cs:1571-1572`：

```csharp
// Resolve file hash for session validation
var fileBytesForHash = File.ReadAllBytes(file);
var fileHash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(fileBytesForHash)).ToLowerInvariant();
```

这两行**无条件执行**，位置在 `:1578` 的 session 命中判断之上。于是每一次翻页请求——包括在一个已打开 session 上纯粹续 cursor、不需要任何新 IO 的那种——都会把整个 mapbnd 文件读进内存并算一遍 SHA-256。session+cursor 协议的意义正是让每页成本与文件大小解耦，这一处把它抵消掉了：每页仍然付一次全文件读取加全文件哈希。

正确形态是把 stale 检测和 session 查找的顺序倒过来：先按 `sessionToken` 查到 session，再只对该 session 记录的 identity 做一次廉价校验；全文件哈希只在真正需要新建 session 时计算。若要保留每页 stale 检测，必须换成不重读全文件的手段（例如打开时锁定 handle，或用 `pathSourceGeneration` 与 Patch Engine 的失效事件），并在 registry 里声明该手段的语义，而不是每页 rehash。

**量级未实测**：本工作树没有挂载游戏资产，`mods/` 下不存在 mapbnd（已实测确认），因此无法给出真实文件大小与每页耗时。接手者在挂载原版目录后必须自己测出「同一 session 连续翻 N 页」的总 IO 字节与总哈希耗时，并把它写进第17节的性能记录；在拿到这个数之前不要声称本项已修复，也不要凭直觉断言影响可忽略。

**违反 2（常驻：每个 session 全模型物化）** —— `bridge/SoulForge.Bridge/MapStaticGeometryService.cs`。**这一处才是上面协议句直接点名禁止的形态。**

协议句要求 session 只保留 immutable native FLVER document、FaceSet plans/cursors、mesh locator 和小 metadata。实测存的远不止：`:84 BuildMeshInfos(flver)` 在建 session 时**无条件**执行 → `:147-150` 对 `flver.MeshCount` **全部** mesh 循环 → `:153 GetMeshPositionsBase64(mi, int.MaxValue, allowTruncation: true)`（**上限是 `int.MaxValue`，等于没有上限**）→ `:155-157` base64 字符串 → `byte[]` → `float[]` 三重物化 → 结果装进 `MeshInfo`（`:32-43`）→ 挂到 `SessionEntry.Meshes`（`:27`，`required`）→ 塞进 `static Dictionary<string, SessionEntry> Sessions`（`:45`）。

`MeshInfo` 的四个字段就是协议句禁止的东西，**只是换了名字**：

| 字段 | 声明 | 实测消费者 |
|---|---|---|
| `float[] Positions` | `:38` | `:304-306` |
| `float[]? Normals` | `:39` | `:293`、`:310-313` |
| `float[]? UVs` | `:40` | `:294`、`:316-321` |
| `uint[] Indices` | `:41` | `:86`、`:254`、`:261`、`:276` |

**这里有个会让你误判为「已合规」的陷阱：协议句禁的是 `allPositions/allIndices/allChunks/allBase64` 这些名字，而 production 里叫 `Positions/Indices`。** 你 grep `allPositions` 会得到零命中，然后得出「没有预建，合规」——错。判据是**语义**：session 存活期间是否持有与模型规模成正比的几何数组。实测持有。这与本文其他位置反复强调的「按名字判而不按行为判 = 假绿」是同一个坑（另见 `:2258` 那条：手里有权威 `indexSize` 字段却改用 `% 2` 推断）。

**决定性证据是 `:276`：** `Array.Copy(mesh.Indices, triStart * 3, sliceIndices, 0, take * 3)`。翻页是**在预建好的整模型数组上按 cursor 裁片**，不是从 source 流式解码。协议句「不预建 …… 然后分页」被逐字违反。`:254`/`:261` 的 `mesh.Indices.Length / 3` 同样要求整个数组已在内存。

**四个数组都有真实消费者，所以修法不是删字段。** 必须改成按 cursor 惰性解码当前 chunk 需要的那一段（`GetMeshPositionsBase64` 已经接受 `maxVertices`，`:153` 只是传了 `int.MaxValue`），session 里只留 mesh locator 与 cursor。

**常驻峰值**：`:18 SessionCapacity = 16`、`:17 SessionTtlMs = 600_000` ⇒ 最多 **16 个模型的全量几何同时常驻**，且一个被放弃的 session 还会继续占 **10 分钟**（`:122-127` 的 TTL 驱逐只在下次调用时触发，没有后台计时器）。

**未测（与违反 1 共享同一个障碍：本工作树没有 mapbnd）：**
- 单个模型 `Positions+Normals+UVs+Indices` 的实际字节数，以及 16 个 session 满载时的峰值。**在拿到这个数之前不要声称影响可忽略，也不要声称必然 OOM。**
- `:153` 传 `int.MaxValue` 在最大的 Sekiro 地图上是否会直接抛 `OutOfMemoryException`。
- 真实使用中是否真会同时存在 16 个 session（若实际只有 1-2 个，严重度下降，但违反协议句这一事实不变）。

顺带纠正一个容易得出的错误结论：`:1649` 的 `GetOrCreate(file, modelName, null, fileHash, flverForNew, entryNameForNew)` 第三个参数恒为 `null`，看起来像是「session 复用被打死了」。**实际不是。** 复用发生在 `:1578` 的 `TryGet` 分支，命中时直接 `session = existing` 并且根本不会调用 `GetOrCreate`；`:1649` 只在 `:1591` 的 `else`（token 为空或 TryGet 未命中）里执行，此时传 `null` 是正确的。真实问题只是 `MapStaticGeometryService.GetOrCreate` 内部那段 `if (!string.IsNullOrWhiteSpace(sessionToken) && Sessions.TryGetValue(...))` 复用分支**因唯一调用方恒传 null 而不可达**，属于会误导读者的死代码，清理即可，不要去「修复」一个不存在的复用失效。

#### 24.10.1 NDJSON framing、字节序和DTO

```text
MAX_BRIDGE_JSON_LINE_BYTES          = 16 * 1024 * 1024  # 现有negotiated上限，不提高
MAX_STATIC_TRANSPORT_BYTES_EXCLUSIVE = 8 * 1024 * 1024  # JSON+LF必须严格小于它
MAX_STATIC_JSON_LINE_BYTES          = MAX_STATIC_TRANSPORT_BYTES_EXCLUSIVE - 2
TARGET_STATIC_JSON_LINE_BYTES    =  6 * 1024 * 1024
MAX_CHUNK_LOCAL_VERTICES         = 65535
```

Bridge协议是一条JSON object加**单个LF byte `0x0A`**的NDJSON record。stdout只允许完整NDJSON frame；诊断日志只写stderr，stdout出现非JSON行、空前缀、BOM、CRLF或一条request多行即`BRIDGE_NDJSON_FRAMING_INVALID`。C# writer直接写UTF-8 bytes和`0x0A`，禁止依赖Windows默认newline。`jsonLineBytes`是使用下面固定`BridgeJsonProfileV1`序列化整个outer frame后的UTF-8 bytes，不含LF；`transportBytes=jsonLineBytes+1`，并要求`transportBytes < MAX_STATIC_TRANSPORT_BYTES_EXCLUSIVE`。因此最大合法JSON整数长度是`8MiB-2`，不存在`<=8MiB`与`<8MiB`双解。Bridge的16MiB检查和static检查都对完整frame执行；JS字符串`.length`、payload子对象长度或raw array bytes都不是frame size。

`BridgeJsonProfileV1`不是一句模糊的“用默认JSON”，而是下面的固定serializer profile；实现可映射成一份只读`JsonSerializerOptions`，不得临时new另一套options：

```ts
interface BridgeJsonProfileV1 {
  schema: "bridge-json-profile-v1";
  utf8Bom: false;
  writeIndented: false;
  propertyNaming: "camelCase";
  propertyOrder: "schema-declaration-order";
  defaultIgnoreCondition: "never";
  numberHandling: "strict-finite-system-text-json";
  unknownMemberHandling: "reject";
  enumEncoding: "schema-ascii-string";
  encoder: "System.Text.Encodings.Web.JavaScriptEncoder.Default";
  recordTerminatorHex: "0a";
}
```

profile本身以canonical JSON/hash进入Bridge executable provenance；实际frame为UTF-8无BOM、compact、camelCase、属性按下列schema声明顺序、数字使用`System.Text.Json`有限number格式、null不省略、未知字段拒绝、enum使用schema列出的ASCII字符串。完整outer schema：

```ts
interface BridgeOutboundFrameV1 {
  schema: "bridge-outbound-frame-v1";
  requestId: string;
  sequence: 0;                         // pull协议每个requestId恰有一个frame，固定0
  ok: boolean;
  complete: boolean;
  payload: MapStaticGeometryPageV1|null;
  error: {code:string;message:string;resourceCacheKeySha256:string|null;retryable:boolean}|null;
}

interface MapStaticGeometryPageV1 {
  schema: "map-static-geometry-page-v1";
  sessionToken: string;
  resourceCacheKeySha256: string;
  cursorToken: string;
  nextCursorToken: string|null;
  complete: boolean;
  chunks: []|[MapStaticChunkV1];        // 非terminal恰1；terminal恰0
  terminalManifest: MapStaticTerminalManifestV1|null;
}

interface MapStaticTerminalManifestV1 {
  schema: "map-static-terminal-manifest-v1";
  resourceCacheKeySha256: string;
  meshPlanCount: number;
  meshes: Array<{
    meshPlanIndex:number;
    meshOrdinal:number;
    materialIndex:number;
    displayProfileId:"sekiro-map-static-highest-detail-v1";
    selectedFaceSetOrdinals:number[];
    ruleIds:string[];
    sourceFaceSetIndexBits:Array<16|32>;
    faceSetCullBackfaces:boolean[];
    faceSetTriangleCounts:number[];
    triangleCount:number;
    chunkCount:number;
  }>;
  emittedChunkCount: number;
  emittedTriangleCount: number;
  manifestSha256: string;                // canonical payload不含本字段
}
```

`read-map-static-geometry`是pull协议：每个page请求分配一个新`requestId`，且恰返回一个完整frame，所以`sequence`唯一合法值是0；不得把sequence解释成session页号，也不得在一个requestId下发多frame。cursor token负责页顺序。`ok=true`要求error=null；`ok=false`要求payload=null/error非null/complete=true。非terminal成功页`complete=false,chunks.length=1,nextCursorToken!=null,terminalManifest=null`；唯一terminal成功页`complete=true,chunks.length=0,nextCursorToken=null,terminalManifest!=null`。page/chunk/terminal三处`resourceCacheKeySha256`必须完全相等。同一cursor幂等重试使用新requestId，但必须得到相同canonical payload hash；该hash排除outer requestId，包含page、完整chunk或terminal manifest。Node与C#各自用不共享serializer代码生成至少12个golden byte vector，覆盖Unicode metadata、null、最大token、error、非terminal/terminal、空mesh terminal和`8MiB-2/-1`边界；逐byte相等才可进入production。

所有base64字段编码的raw bytes固定little-endian：float为IEEE-754 float32 LE；local triangle indices为uint16 LE；`sourceVertexIndices`统一uint32 LE；content hash metadata中的整数也用固定unsigned little-endian。C#使用`BinaryPrimitives.Write*LittleEndian`，不能用host-endian`BitConverter`/array cast。worker在little-endian host可建typed view；启动时用2-byte probe确认，非little-endian host必须用`DataView`逐项转换。字段固定包含：

```ts
interface MapStaticChunkV1 {
  schema: "map-static-chunk-v1";
  resourceCacheKeySha256: string;
  chunkId: string;
  meshPlanIndex: number;
  meshOrdinal: number;
  materialIndex: number;
  displayProfileId:"sekiro-map-static-highest-detail-v1";
  modelLocalTransformSha256: string;
  selectedFaceSetOrdinals: number[];
  faceSetTriangleSpans: Array<{
    faceSetOrdinal:number;
    ruleId:string;
    firstTriangleInChunk:number;
    triangleCount:number;
    firstTriangleInFaceSet:number;
    cullBackfaces:boolean;
  }>;
  faceSetRuleRegistrySha256: string;
  sourceTriangleStart: number;
  triangleCount: number;
  vertexCount: number;
  localIndexElementBytes: 2;          // chunk cap使local uint32分支不存在
  sourceVertexIndexElementBytes: 4;   // source mesh可超过65535
  sourceFaceSetIndexBits: Array<16|32>;
  coordinateSpaceId: string;
  mapCoordinateContractPayloadSha256: string;
  positionsBase64: string;
  normalsBase64: string|null;
  uv0Base64: string|null;
  localIndicesBase64: string;
  sourceVertexIndicesBase64: string;
  localBounds: {min:[number,number,number];max:[number,number,number]};
  rawContentSha256: string;
}
```

旧`indexSize=16/32 bits`、`indexElementBytes`含混字段在schema边界直接拒绝，不能兼容透传。16/32 source FaceSet覆盖由`sourceFaceSetIndexBits`证明；dense local index始终uint16。这样消除“最大local vertices已经65535但还测试不可达local uint32分支”的矛盾。

`chunkId`必须等于24.10.3的canonical计算，`meshPlanIndex/meshOrdinal/displayProfileId`必须精确定位同一session plan entry且map-static值固定为`sekiro-map-static-highest-detail-v1`。`selectedFaceSetOrdinals/ruleIds/sourceFaceSetIndexBits/faceSetCullBackfaces`四者长度必须相等且与session mesh plan逐项一致；每个span的faceSet/rule/cull值必须等于同位置plan，span按`firstTriangleInChunk`连续覆盖`0..triangleCount-1`，不得重叠/缺口；`materialIndex`必须等于native mesh material index。任一不变量失败不发送frame。`CullBackfaces`是FaceSet级格式语义，不能降成mesh/material默认值：renderer把每个span变成geometry group；`true`使用FrontSide变体，`false`使用DoubleSide变体。不同cull值可以共用position/index buffer，但必须使用不同material key/group，禁止为了减draw call丢掉双面语义。

#### 24.10.2 session、owner、cursor和operation lease

```ts
interface StaticGeometrySession {
  token: string;
  daemonInstanceId: string;
  workspacePersistentIdentityHash: string;
  resourceCacheKeySha256: string;
  resourceEdgeId: string;
  sourceHash: string;
  pathSourceGeneration: number;
  containerEntryIdentitySha256: string;
  modelLocalTransformSha256: string;
  displayProfileId:"sekiro-map-static-highest-detail-v1";
  faceSetRuleRegistrySha256: string;
  mapCoordinateContractPayloadSha256: string;
  state: "OPENING"|"READY"|"DRAINING"|"CLOSED";
  owners: Map<string,OwnerLease>;
  activeReaders: number;              // request lease + build document lease，锁内守恒
  document: FlverNativeDocument|null;
  meshPlan: readonly StaticMeshPlanEntry[];
  completedMeshSummaries: Map<number,StaticMeshCompletionSummary>; // meshPlanIndex -> idempotent小metadata
  emittedChunkCount: number;
  emittedTriangleCount: number;
  cursors: Map<string,StaticCursorRecord>;
}

interface StaticMeshPlanEntry {
  meshPlanIndex: number;
  meshOrdinal: number;
  materialIndex: number;
  displayProfileId:"sekiro-map-static-highest-detail-v1";
  modelLocalTransformSha256: string;
  selectedFaceSetPlan: readonly SelectedFaceSetPlanV1[];
}

interface StaticMeshCompletionSummary {
  meshPlanIndex:number;
  meshOrdinal:number;
  materialIndex:number;
  displayProfileId:"sekiro-map-static-highest-detail-v1";
  selectedFaceSetOrdinals:number[];
  ruleIds:string[];
  sourceFaceSetIndexBits:Array<16|32>;
  faceSetCullBackfaces:boolean[];
  faceSetTriangleCounts:number[];
  triangleCount:number;
  chunkCount:number;
  summarySha256:string;               // canonical payload不含本字段
}

interface StaticCursorRecord {
  token: string;                       // crypto random opaque id
  sessionToken: string;
  resourceCacheKeySha256: string;
  meshPlanIndex: number;
  faceSetCursor: FaceSetTriangleCursorV1;
  sourceHash: string;
  pathSourceGeneration: number;
  state: "READY"|"BUILDING"|"BUILT"|"CLOSED";
  inFlight?: Promise<BuiltChunk>;
  builtChunkRawHash?: string;
  nextToken?: string|null;
  activeReaders: number;               // 每个request lease恰好+1/-1
  lastUsedAt: number;
  expiresAt: number;
}
```

`open-map-static-geometry`输入显式携带workspace persistent identity、`workspaceSessionId/workspaceSessionGeneration`、webContentsId、`MAP_STATIC_READ` purpose、完整`ResourceCacheKeyV1`及其`resourceCacheKeySha256`、typed resource edge、source hash、`pathSourceGeneration`、entry identity、model-local transform hash和`mapCoordinateContractPayloadSha256`；Bridge用24.11算法重算key hash，并要求所有重复字段逐项相等，不能信调用方给的hash。返回`{sessionToken,ownerLeaseId,firstCursorToken,resourceCacheKeySha256}`。open时只按physical mesh ordinal构造小型`meshPlan`及每mesh FaceSet plan，不展开triangle/vertex/base64。mesh plan覆盖document全部mesh且`meshPlanIndex=0..meshCount-1`；0 mesh返回结构化`MAP_STATIC_NO_MESH`。token不编码路径/位置，server record逐项绑定daemon、workspace-session owner和source/cache identities。所有page/close请求必须携带`sessionToken + ownerLeaseId + cursorToken + resourceCacheKeySha256 + workspacePersistentIdentityHash + workspaceSessionId + workspaceSessionGeneration + webContentsId`并通过purpose矩阵；返回page、chunk、worker message也必须带同一hash，任一层不等立即拒绝，不能以短model名继续。

请求算法中**每条分支先取得request lease**，解决READY分支不加却finally减的负计数：

```text
requestCursor(req):
  lock index
  validate session/token/owner/workspaceSessionGeneration/full resourceCacheKey/source/TTL in this fixed order
  require session READY and cursor not CLOSED
  cursor.activeReaders++; session.activeReaders++
  create single-dispose requestLease; touch owner/cursor TTL

  if cursor READY:
      set BUILDING
      acquire an additional session documentLease before unlock
      create exactly one inFlight build using immutable cursor snapshot
  else if cursor BUILDING:
      capture exact same inFlight
  else if cursor BUILT:
      retain expected raw hash+nextToken; set BUILDING
      acquire documentLease; create one deterministic retry build from immutable snapshot
  unlock

  try await shared task respecting caller cancellation only for this subscriber
  finally release requestLease exactly once

build task finally:
  release encoded buffers
  release documentLease exactly once
  publish BUILT/hash/nextToken only if session/source/pathSourceGeneration/resourceCacheKey still valid
```

同一caller取消不取消其他subscriber的shared build；只有owner全部关闭、workspace/source失效或session explicit cancel才取消build token。旧cursor保留60秒幂等TTL；owner lease idle TTL固定5分钟且每个合法page touch，active owner/reader/build不被LRU/TTL中途删除。每session最多256 cursor、daemon最多4096；只evict`BUILT && activeReaders==0`且owner不再可能请求的最旧record。READY/BUILDING不evict。

consumer收到terminal `complete=true,chunks=[]`前，前一非terminal页的worker decode/GPU upload ACK已经完成；收到terminal后先验证`terminalManifest.meshPlanCount===open时meshPlanCount`、mesh summaries按`meshPlanIndex=0..N-1`连续且重组计数一致，再发送owner close。最后一个非terminalchunk不能自己标complete，也不能省略terminal页，否则消费者无法区分“第一个mesh结束”和“模型结束”。零triangle mesh也必须在terminal manifest中有`chunkCount=0/triangleCount=0`的summary，不能因没有chunk而从验收消失。summary只在对应cursor的build结果成功发布时，以`meshPlanIndex+summarySha256`在session锁内幂等commit；重试同一cursor不得重复累加chunk/triangle计数，hash不同则`MAP_STATIC_RETRY_NONDETERMINISTIC`。close先把owner CLOSED；最后owner消失时session转DRAINING、拒绝新request、取消build，等`session.activeReaders==0`后清cursor/document并CLOSED。workspace/source invalidation走相同路径。若owner泄漏超过5分钟，先DRAINING再释放；retry得到`MAP_STATIC_SESSION_EXPIRED`，workflow只允许按24.20整体reopen一次。open/request/build/retry/close/TTL/cancel/dispose计数必须守恒且从不为负。

#### 24.10.3 单chunk streaming构建

```text
buildNextPage(document, session.meshPlan, immutableCursor):
  pendingCompletionSummaries = []
  if immutableCursor.meshPlanIndex == meshPlan.length:
      return terminal build draft with no chunk and pendingCompletionSummaries
  require immutableCursor.meshPlanIndex in 0..meshPlan.length-1

  planEntry = meshPlan[immutableCursor.meshPlanIndex]
  mesh = document.mesh(planEntry.meshOrdinal)
  workingCursor = clone immutable 24.9 FaceSet cursor
  localBySource = Dictionary<uint,uint>()
  sourceByLocal = List<uint>()
  localIndices = List<ushort>()
  spans = List<FaceSetTriangleSpan>()
  bounds = empty
  startTriangle = workingCursor.emittedTriangleOrdinal

  loop:
      candidateCursor = clone workingCursor
      decoded = nextTriangle(planEntry.selectedFaceSetPlan,candidateCursor)
      if END:
          if localIndices not empty:
              break and next cursor starts next meshPlanIndex with zero FaceSet cursor;
              build result also carries a pending completion summary for this mesh
          else:
              append pending zero-chunk completion summary if this mesh emitted no earlier chunk
              advance immutable working position to next meshPlanIndex with zero cursor
              if now terminal: return terminal build draft carrying pendingCompletionSummaries
              restart this function's mesh-local build loop for the next planEntry
              # never carry localBySource/indices/spans across mesh/material
      validate decoded.a/b/c < mesh.vertexCount
      proposed sources/vertices/triangles/spans = checked arithmetic
      if chunk nonempty and (proposedVertices > 65535 or
          estimateFullFrameBytes(proposed shape, exact metadata) > TARGET_STATIC_JSON_LINE_BYTES):
          break without assigning candidateCursor

      decode each newly referenced position/normal/uv once from native document
      require exact attribute offsets/strides and every float finite
      append dense ushort indices; update local bounds
      append/coalesce span only when faceSetOrdinal+ruleId+cullBackfaces consecutive;
        record firstTriangleInChunk/count/firstTriangleInFaceSet/cullBackfaces
      workingCursor = candidateCursor       # only now consume triangle

  if no triangle emitted while next source triangle exists: MAP_STATIC_CHUNK_BUDGET_IMPOSSIBLE
  require every span count>0, spans cover exactly triangleCount without gap/overlap,
          and materialIndex/modelLocalTransformHash equal planEntry
  encode tightly sized LE arrays exactly once
  rawContentHash = SHA-256(canonical metadata including spans/cull/material/modelLocal + raw arrays, before base64)
  chunkId = sourceHash/mesh/startTriangle/count/rawContentHash
  next cursor stores exact workingCursor, or {meshPlanIndex+1,zero FaceSet cursor} at mesh END
  next cursor is nonnull even after the final data chunk; requesting it yields the unique terminal page
  construct whole BridgeOutboundFrameV1 once with the BridgeJsonProfileV1 options
  require jsonLineBytes<=MAX_STATIC_JSON_LINE_BYTES
  require jsonLineBytes+1<MAX_STATIC_TRANSPORT_BYTES_EXCLUSIVE
  require jsonLineBytes+1<=negotiated Bridge limit
  return data build draft {resourceCacheKeySha256,one chunk,nextCursorToken,pendingCompletionSummaries}
```

`pendingCompletionSummaries`是Bridge内部build结果，不序列化到非terminal page；它可以含本页跨过的多个空mesh和本页刚结束的一个非空mesh。request publish在同一session锁内先验证cursor仍有效，再逐项幂等commit summaries/totals。若draft是data，commit后才发布BUILT+next cursor并构造`complete=false/terminalManifest=null`的page；若draft是terminal，commit后必须确认summary key精确覆盖`0..meshPlan.length-1`，再构造/hash唯一terminal manifest/page并发布BUILT。若在commit前取消/失败，summary和totals均不变；若重试已commit cursor，summary hash必须相同且不再次累加。跨多个chunk的mesh由小型per-mesh counter累计`faceSetTriangleCounts/triangleCount/chunkCount`，但不保留triangle或wire bytes。terminal manifest的`manifestSha256`按24.11 canonical bytes计算，consumer/independent oracle逐mesh重算。frame尺寸检查发生在最终page构造之后；terminal manifest若意外超过上限也必须失败关闭，不能另发第二frame。

frame估算使用即将发送的**完整outer Bridge frame**、同一个request/resource identity、固定当次timestamp和production serializer。先把五个payload string设为空并实际序列化，得到UTF-8 overhead；base64只含ASCII且无需JSON escape，随后精确加：

```text
base64Length(n)=4*ceil(n/3)
positionsRaw=V*3*4; sourceIndicesRaw=V*4; localIndicesRaw=T*3*2
normalsRaw=hasNormal?V*3*4:0; uvRaw=hasUv?V*2*4:0
estimatedJsonLineBytes=serializedEmptyFrameBytes + sum(base64Length(rawField))
```

最终发送必须复用同一个prebuilt frame/timestamp，不能让`WriteAsync`重建不同envelope。property order/Unicode metadata/最长token/边界随机测试比较estimate与实际UTF-8 bytes完全相等；不等返回`MAP_STATIC_FRAME_ESTIMATE_BUG`，绝不提高限制。第一条triangle本身超过soft target时允许加入，但仍必须满足严格`transportBytes<8MiB`与Bridge上限，否则失败关闭。

每个chunk的`sourceVertexIndices[local]`精确指回原mesh顶点。oracle先按`meshOrdinal,sourceTriangleStart`重组，逐local index比较position与source vertex，再要求每mesh的source triangle stream、FaceSet spans、materialIndex和model-local transform hash都等于24.9/24.11 independent oracle；必须用terminal manifest见到meshPlan全部physical mesh（包括0 triangle mesh）后才接受terminal。只比较bounds/截图、只返回第一个mesh、漏掉空mesh或把不同material的三角形合并均不够。

页面返回后立即断开临时dictionary/list/raw/base64/frame引用。telemetry至少为：

```text
flverParseCount; skinningCallCount==0; skeletonBuildCount==0
activeSessionReaders; activeCursorReaders; cursorBuildCount; cursorRetryCount
encodedChunksResident<=1; currentEncodedWireBytes; peakEncodedWireBytes<2*MAX_STATIC_TRANSPORT_BYTES_EXCLUSIVE
```

渐进断言按实际页数定义：若一个resource产生至少2页，`firstChunkResponseAt < finalChunkBuildStartedAt`；单页resource不做这个不可能的相对断言，只要求单页预算/响应。地图级始终要求`firstGpuGeometryReadyAt < allMapResourcesCompleteAt`且至少一个后续resource/chunk仍在加载。复杂度`O(source indices consumed + unique vertices in emitted chunks)`；任何cursor page从FaceSet头重放或先flatten全mesh都失败。

### 24.11 D-3：MSB model type 到资源 URI 的路由算法

路由输入必须来自MSB语义DTO，不得由renderer只传modelName。Bridge的MSB reader必须为models和parts保留**物理ordinal**以及part引用的native model index；main/core在构建semantic scene时只生产一次稳定identity。

本节所有identity统一调用`canonicalIdentityBytesV1(...)`编码器：先写ASCII schema id；再按schema固定字段顺序为每个字段写uint32-BE byte length + UTF-8 bytes。整数先验证范围后转无前导零ASCII十进制；hash转lowercase hex；null编码为长度0，而这些identity字段禁止空字符串，避免null/empty碰撞；数组先写count再逐项编码。矩阵/transform数值不走JSON或字符串插值，而是逐个写IEEE-754 float64 big-endian bits，拒绝NaN/Inf并把`-0`规范为`+0`。Node/C#独立golden vector必须逐byte相等。identity key是`lowercaseHex(SHA-256(canonical bytes))`，hash不嵌回payload。

```ts
interface MapModelIdentityV1 {
  schema: "map-model-identity-v1";
  mapLogicalUri: string;
  msbSourceSha256: string;
  nativeModelOrdinal: number;
  modelType: number;
  rawModelName: string;
}

interface MapPlacementIdentityV1 {
  schema: "map-placement-identity-v1";
  mapLogicalUri: string;
  msbSourceSha256: string;
  nativePartKind: string;
  nativePartOrdinal: number;
  nativeModelOrdinal: number;
  modelEdgeId: string;
  overlayResolutionGeneration: number;
}

interface MapPlacementRecordV1 {
  identity: MapPlacementIdentityV1;
  nativeRecordSha256: string;
  semanticRevision: number;
  expectedTransformSha256: string;
  gameTransform: {position:[number,number,number];rotationDegrees:[number,number,number];scale:[number,number,number]};
}
```

`identity`不含数组显示顺序或renderer instanceId。Map/Set/key一律使用上述canonical SHA，不得`JSON.stringify`或字符串拼接。transform hash用相同binary float规则对`position/rotationDegrees/scale`生成，作为CAS版本放在record中，不拼进Map key，否则拖动一次会让选择identity消失；每次成功semantic mutation保持相同identity、递增revision并更新expected hash。`nativeRecordSha256`证明最初物理part provenance。producer逐part用`nativePartOrdinal`和native model reference join，若reference越界/类型不符即结构化失败，禁止按name重新找一个。

#### 24.11.1 `map-resource-edges.v1.json` 的owner和生成器

这是**每工作区/每overlay generation的运行时resource graph artifact**，不是手写样本表。owner是main/core的`SemanticWorkspaceIndex/MemoryResourceGraph`；存入app-data现有repository，不写Mod目录，renderer只得到logical URI和edge id。tracked schema/validator固定为v1，A2冻结generator源码hash：

```ts
interface WorkspaceMapResourceEdgesPayloadV1 {
  workspacePersistentIdentityHash: string;
  catalogSourceSnapshotSha256: string;
  overlayResolutionGeneration: number;
  edges: Array<{
    edgeId: string;
    model: MapModelIdentityV1;
    resourceKind: "map-piece"|"object"|"character"|"collision";
    resolvedLogicalUri: string|null;
    resolvedLayer: "overlay"|"base"|null;
    sourceContentSha256: string|null;
    containerEntry: {physicalIndex:number;id:number;name:string;duplicateOrdinal:number}|null;
    modelLocal: {matrixColumnMajor:number[];transformSha256:string;producerRuleSha256:string}|null;
    outcome: "resolved"|"missing"|"ambiguous"|"projection-unavailable";
    diagnosticCode: string|null;
  }>;
}

interface WorkspaceMapResourceEdgesEnvelopeV1 {
  schema: "map-resource-edges-envelope-v1";
  payload: WorkspaceMapResourceEdgesPayloadV1;
  payloadSha256: string; // 只hash canonical payload bytes，不含本字段/envelope
}
```

生成顺序：先从VFS/catalog建立typed candidate index，再遍历MSB models；不允许为每个part扫磁盘。overlay只覆盖**同一logical resource identity**，不是“先找到任意同名文件”。container内多个FLVER通过该游戏格式家族的版本化entry rule和physical entry identity决定；0个为missing，多个不可唯一裁定为ambiguous，绝不取第一个`.flver`。每个resolved FLVER还由Bridge/native projection按A2冻结的格式规则产生`modelLocal.matrixColumnMajor`；格式没有额外model-local变换时也必须显式产生identity matrix和rule hash，renderer不得因字段缺失自行猜identity。矩阵hash按本节float bits算法。edges按`mapLogicalUri UTF-8 bytes,nativeModelOrdinal`排序，canonical payload hash后用envelope原子发布。part只引用edgeId，同一model的数千placement不复制edge DTO。

A2的independent verifier从冻结filesystem inventory、Andre MSB model/part reference和BND entry inventory重建edges；逐edge比较。production generator不能读取A2 expected edge artifact决定结果，但两者schema相同。任何source/catalog/overlay generation变化使旧artifact不可用并重新生成；renderer不得自己补路径。

```text
resolveMapModel(request):
  require request contains exact MapModelIdentityV1 + edgeId + workspaceSessionId/workspaceSessionGeneration + overlayResolutionGeneration
  lookup exact verified edge; require all identity fields equal
  switch exact numeric modelType:
    0:
      kind = map-piece
      use edge.resourceKind map-piece and exact resolved container entry
      expected container = mapbnd; projection = static FLVER
    1:
      kind = object
      use edge.resourceKind object and exact resolved container entry
      expected container = objbnd; projection = static FLVER
    2:
      kind = character
      use edge.resourceKind character and exact resolved container entry
      expected container = chrbnd; projection = static FLVER only
    5:
      return COLLISION_PROJECTION_UNAVAILABLE with original identity
    default:
      return MSB_MODEL_TYPE_UNSUPPORTED with original numeric value

  if edge outcome missing: MAP_MODEL_SOURCE_MISSING
  if edge outcome ambiguous: MAP_MODEL_RESOURCE_EDGE_AMBIGUOUS
  require resolved layer/source hash/pathSourceGeneration/overlayResolutionGeneration still current
  require edge.modelLocal nonnull, finite 16-value matrix and transform/rule hashes exact
  open exact BND entry identity; do not take first .flver when several exist
  if no renderable FLVER: MAP_MODEL_CONTAINER_NO_RENDERABLE_FLVER
  if layer resolution fails: MAP_MODEL_OVERLAY_RESOLUTION_FAILED
  native parse error: MAP_MODEL_NATIVE_PARSE_FAILED
  otherwise open read-map-static-geometry session carrying modelLocal transform hash
```

map request dedupe key：

```text
24.12 ResourceCacheKeyV1 canonical SHA（包含persistent workspace、overlayResolutionGeneration/pathSourceGeneration、
edge、source/entry、model-local、FaceSet和coordinate rule identity）
```

不要使用 `normalizeMapModelKey(modelName)` 单独作为 production key；`m000010` 的 map/object/character 或不同`overlayResolutionGeneration`不能碰撞。名称规范化只能用于UI label/测试alias，不是资源authority。

#### 24.11.2 地图坐标契约和矩阵顺序

tracked契约由renderer-independent shared/core adapter拥有，建议入口`packages/core/src/scene/mapCoordinateContract.ts`；Bridge static chunk只声明source coordinate identity，不在每个vertex猜轴。A2用Andre公开语义、成熟工具导出的basis/AABB和至少一个三轴非零旋转+非均匀scale样本冻结：

```ts
interface MapCoordinateContractPayloadV1 {
  ruleId: string;
  sourceCoordinateSpaceId: string;
  sceneCoordinateSpaceId: string;
  sourceUnitsPerSceneUnit: number;
  msbRotationUnit: "degrees";
  msbEulerComposition: "XYZ"|"XZY"|"YXZ"|"YZX"|"ZXY"|"ZYX";
  gameToSceneRootColumnMajor: readonly number[16];
  vectorConvention: "column-vector";
}

interface MapCoordinateContractEnvelopeV1 {
  schema: "map-coordinate-contract-envelope-v1";
  payload: MapCoordinateContractPayloadV1;
  payloadSha256: string; // canonical payload，不自包含
}
```

字段值不能由接手者凭当前画面填写。证据程序读取至少10个真实part（覆盖三轴旋转、负坐标、非均匀scale）和一个合法synthetic matrix fixture，枚举只用于发现候选；只有Andre矩阵、成熟工具basis/world AABB和SoulForge-independent计算三者唯一一致才冻结。若无法唯一裁定，A2保持`MAP_COORDINATE_RULE_DISPUTED`，不得进入D。envelope/payload与float canonical bytes各有Node/C# golden vectors；绝不把`payloadSha256`或旧`ruleSha256`字段包含进自身hash。全文字段`mapCoordinateContractPayloadSha256`唯一指这个payload hash；不存在第二个`mapCoordinateRuleSha256/coordinateRuleSha256/coordinateContractHash`别名。

唯一乘法约定为column vector；matrix DTO用16个finite float64 JSON number按Three `Matrix4.elements`的column-major顺序：

```text
v_scene_world = M_host_scene_root
              * C_game_to_scene_root
              * M_msb_game_placement(TRS using frozen Euler rule)
              * M_flver_model_local
              * vec4(v_flver_local,1)
```

Bridge chunk positions固定保持`sourceCoordinateSpaceId`中的FLVER source单位；chunk不含可再次应用的`unitScale`。`sourceUnitsPerSceneUnit`的定义是“一个scene单位等于多少source单位”，必须finite且`>0`；A2 producer先得到纯轴/手性basis `C_axis`，再冻结`C_game_to_scene_root = C_axis * Scale(1/sourceUnitsPerSceneUnit)`，并用非1 scale golden vector证明没有乘反。production只消费已冻结的完整矩阵，不在renderer重新组合。唯一单位/轴转换owner是`C_game_to_scene_root`，renderer不得再乘或除该scalar。`M_flver_model_local`来自resource-edge/native producer并以hash贯穿chunk/manifest；缺失或hash不一致固定失败，不能默认identity。

“纯轴/手性basis”不是自然语言许可。registry loader必须从payload重建矩阵并逐项验证以下唯一结构，否则返回`MAP_COORDINATE_MATRIX_INVALID`：

```text
u = sourceUnitsPerSceneUnit
C = matrix from gameToSceneRootColumnMajor
C_axis = C * Scale(u,u,u)             # 因 C = C_axis * Scale(1/u)

require C and C_axis all finite; u > 0
require homogeneous last row of C_axis == [0,0,0,1] within 1e-12
require translation column C_axis[0..2,3] == [0,0,0] within 1e-12
B = upper-left 3x3 of C_axis
require every B element is within 1e-12 of exactly one of {-1,0,+1}
require each row and each column has exactly one nonzero signed entry
require maxAbs(transpose(B)*B - I) <= 1e-12
require determinant(B) is exactly +1 or -1 within 1e-12
require upper-left(C) == B/u, C translation==0 and homogeneous last row==[0,0,0,1]
```

因此该V1只允许signed-permutation axis basis加uniform单位缩放，不允许translation、shear、任意旋转、非均匀scale或把`u`烘两次。A2 artifact必须保存`B`、`determinant(B)`以及source原点/+X/+Y/+Z四个有向基点和一个有向非退化triangle在成熟工具中的scene结果；逐点和triangle法向/绕序一致才可冻结。只比较无方向的AABB无法证明轴正负或手性，固定视为证据不足。Node/C# golden vector要覆盖`det(B)=+1`和`-1`、`u!=1`以及translation/shear/重复轴negative fixtures。

scene graph实现固定：`placementRoot.matrix = M_host_scene_root * C_game_to_scene_root`，每个InstancedMesh是root的identity直接子对象，instance matrix是`P*N = M_msb_game_placement * M_flver_model_local`。24.14的TransformControls target与instance处于同一root-local space，但target矩阵只保存`P`；每个binding保存完整`N`，objectChange计算`P'*N`。Gizmo写回直接把target的`P`交给同一adapter按冻结Euler规则解compose；禁止先分解可能含shear的`P*N`、再右乘`inverse(N)`，也禁止handler手写x/z交换。契约fixture必须含非identity host root、非identity C、非identity model-local、三轴rotation和非uniform scale，验证P的forward/inverse/writeback以及每个P*N world矩阵；仅identity root测试不通过。

全量 499 验收算法对每个 manifest identity 独立记录 actual：

```text
expected loaded:
  every page complete + reconstructed oracle exact -> PASS
  any diagnostic -> FAIL
expected unavailable with allowed code:
  exact diagnostic and zero fake geometry -> PASS
expected disputed:
  FAIL pending adjudication
```

不能以 `successCount >= 481` 通过；历史数字只是定位线索。

### 24.12 E-1：地图加载调度、worker 解码和 GPU pool 算法

首先定义所有in-flight/ready/failure/GPU owner共同使用的唯一复合key；禁止有的Map只用`resourceKey`、另一个才检查generation：

```ts
interface ResourceCacheKeyV1 {
  schema: "map-resource-cache-key-v1";
  workspacePersistentIdentityHash: string;
  overlayResolutionGeneration: number;
  resourceEdgeId: string;
  resolvedLogicalUri: string;
  sourceIdentityHash: string;
  pathSourceGeneration: number;
  containerEntryIdentitySha256: string;
  modelLocalTransformSha256: string;
  faceSetRuleRegistrySha256: string;
  mapCoordinateContractPayloadSha256: string;
}
```

key使用24.11 canonical bytes/hash；任何字段不同就是不同cache entry，不允许先按短`resourceKey`join后再“发现不匹配”。`resourceCacheKeySha256`在 Bridge page/chunk、worker message、ready/failure manifest、scene owner和GPU acquisition中都指这同一份完整canonical SHA；不得把modelName、edgeId或session token塞进同名字段。随后一次性把P个part分组，禁止每个模型到达后再扫描P：

```text
placementsByCacheKey = Map<ResourceCacheKeySha256, Placement[]>()
for part in semantic scene exactly once:
  key = typed resolved ResourceCacheKeyV1
  placementsByCacheKey[canonicalSha(key)].push(part)
```

调度状态：

```ts
type ModelLoadState =
  | { kind:"queued"; priority:number; sceneGeneration:number }
  | { kind:"native"; sessionToken:string;ownerLeaseId:string;cursor:string|null;sceneGeneration:number }
  | { kind:"decoding"; pendingChunkIds:Set<string>; sceneGeneration:number }
  | { kind:"uploading"; pendingChunkIds:Set<string>; sceneGeneration:number }
  | { kind:"ready"; geometryKeys:string[]; materialKeys:string[]; sceneGeneration:number }
  | { kind:"failed"; diagnostic:Diagnostic; retryAfter:number; sceneGeneration:number }
  | { kind:"cancelled"; sceneGeneration:number };
```

优先级：选中模型 0，视锥内/相机附近 1，其余地图模型 2；相同优先级按 manifest/model identity 稳定排序。Bridge native 并发不超过 daemon 可处理的 2；decode worker 数固定 `max(1,min(4,hardwareConcurrency-1))`；GPU upload 始终由 renderer frame queue串行控制。

in-flight不是一个无owner的长期Promise。结构固定为：

```ts
interface MapLoadOperationKeyV1 {
  schema:"map-load-operation-key-v1";
  resourceCacheKeySha256:string;       // immutable content key
  workspaceSessionId:string;           // pending native owner/publish lifetime；不写回content key
  workspaceSessionGeneration:number;
  rendererContextGeneration:number;    // task含GPU upload，因此不同context绝不能join
}
interface MapLoadSubscriberId {
  sceneId:string;
  sceneGeneration:number;
  rendererContextGeneration:number;
  resourceCacheKeySha256:string;
  requestId:string;
}
interface MapLoadSubscriberLease {
  leaseId:string;                   // random 128-bit
  id:MapLoadSubscriberId;
  operationKeySha256:string;
  resourceCacheKeySha256:string;
  state:"OPEN"|"CLOSED";
}
interface InFlightMapLoad {
  cacheKey: ResourceCacheKeyV1;
  resourceCacheKeySha256: string;
  operationKey: MapLoadOperationKeyV1;
  operationKeySha256: string;
  subscribers: Map<string,{lease:MapLoadSubscriberLease;onChunk:(c:UploadedChunkRef)=>void;onError:(d:Diagnostic)=>void}>;
  task: Promise<ReadyResourceManifestV1>;
  abort: AbortController;
  uploadedSoFar: UploadedChunkRef[]; // 只含keys/identity，不含wire/ArrayBuffer
}

interface SceneResourceOwnerRecord {
  ownerId: string;                  // 下面lifetime tuple的24.11 canonical SHA
  workspaceSessionId: string;
  workspaceSessionGeneration: number;
  sceneId: string;
  sceneGeneration: number;
  rendererContextGeneration: number;
  resourceCacheKeySha256: string;
  subscriberLeaseIds: Set<string>;
  acquiredGeometryKeys: Set<string>;
  acquiredMaterialKeys: Set<string>;
}

type GpuOwnerId = SceneResourceOwnerRecord["ownerId"];
```

`MapLoadOperationKeyV1`使用24.11 canonical bytes；它只给pending operation/in-flight索引，绝不能冒充或替换`ResourceCacheKeyV1`。因为当前task包含Bridge owner和GPU upload，只按resource hash join会让新workspace session加入旧native owner、或让context-loss后的新renderer加入旧GPU task。`subscribe(cacheKey,lifetime,subscriber)`在同一scheduler transaction中：验证两个canonical key/hash和24.20 lifetime，mint lease；按`{workspaceSessionId,workspaceSessionGeneration,sceneId,sceneGeneration,rendererContextGeneration,resourceCacheKeySha256}`取得/创建`SceneResourceOwnerRecord`并加入lease；然后按`operationKeySha256`查exact in-flight。不同sceneGeneration可在同一session/context共享任务，但各有独立scene owner；不同workspace session或renderer context绝不join。

命中in-flight时不能只回放小key：对`uploadedSoFar`每一项，在同一不可`await`事务中验证geometry/material仍存在且属于当前renderer context，为新scene owner幂等acquire，构造该scene的全部placement bindings，全部成功后才加入subscriber并逐项通知。任一缺失/throw就逆序释放本事务delta、删除pending bindings，并让该订阅走正常reload；不能发布一个没有GPU owner的迟到subscriber。`unsubscribe(leaseId)`先原子把lease从inFlight和scene owner移除；同一精确scene-owner仍有其他lease时不得释放bindings/GPU owner，最后一个lease离开才释放该owner的partial bindings和pool owners；同一operation全局subscriber数为0才abort底层native/worker/task。重复/未知lease close是测试错误。一个scene取消不能打断另一个scene。task settle后`finally`只删除同一operation key且同一task identity的inFlight，向每个仍OPEN且lifetime仍current的subscriber发布ready/error；callback异常只关闭该lease，不污染共享task。

逐模型流水线：

```text
request exact operation key once (join same workspace-session/renderer-context in-flight task)
open static session and retain {sessionToken,ownerLeaseId}
while not complete and operation lifetime plus exact ResourceCacheKey remain current:
  request exactly one bounded chunk page
  require page.resourceCacheKeySha256 and chunk.resourceCacheKeySha256 equal operation key
  immediately post a typed MapStaticWorkerDecodeRequestV1 to decode worker
  do not retain page in resolved cache
  worker validates and transfers ArrayBuffers back
  enqueue one GPU upload task for this chunk
  after upload success:
      in one scheduler transaction collect unique live SceneResourceOwnerRecords for this operation
      for each current owner, acquire geometry/material independently and build all placement bindings
      if one owner transaction fails: rollback/close only its subscriber leases; other owners continue
      append one small UploadedChunkRef only after pool entries exist
      notify each successfully committed live subscriber
      clear worker result/page/base64 references
      emit first-geometry progress if first
  yield between page requests when foreground input pending
on final page: wait for final worker decode + GPU upload ACK
then close native owner/session; atomically publish readyManifest; mark ready
on cancel/failure: close session; release partial owners; keep only small diagnostic/backoff
```

worker envelope也不能靠闭包猜generation或短名字：

```ts
interface MapStaticWorkerDecodeRequestV1 {
  schema:"map-static-worker-decode-request-v1";
  operationKeySha256:string;
  resourceCacheKeySha256:string;
  workspaceSessionGeneration:number;
  rendererContextGeneration:number;
  chunkId:string;
  chunk:MapStaticChunkV1;
}
interface MapStaticWorkerDecodeResultV1 {
  schema:"map-static-worker-decode-result-v1";
  operationKeySha256:string;
  resourceCacheKeySha256:string;
  workspaceSessionGeneration:number;
  rendererContextGeneration:number;
  chunkId:string;
  rawContentSha256:string;
  decodedBuffers:TransferableDecodedStaticBuffersV1;
}
interface TransferableDecodedStaticBuffersV1 {
  positions:ArrayBuffer;
  normals:ArrayBuffer|null;
  uv0:ArrayBuffer|null;
  localIndices:ArrayBuffer;
  sourceVertexIndices:ArrayBuffer;
  vertexCount:number;
  triangleCount:number;
  renderGroups:Array<{
    firstIndex:number;
    indexCount:number;
    faceSetOrdinal:number;
    ruleId:string;
    cullBackfaces:boolean;
  }>;
}
```

worker开始、post回renderer和GPU queue消费前都重算/比较两种key及两个generation；结果晚到时只释放transferables，不能命中新context。`TransferableDecodedStaticBuffersV1`不包含Three对象，每个实际非null的`ArrayBuffer`必须各自恰好一次进入transfer list，且必须由下面长度/有限值验证完整后才构造。

worker 解码不得使用当前 `decodeBase64F32` 的“长度不足就补全零数组”行为。固定严格算法：

```text
decode field -> exact byteLength check -> alignment check -> typed array view
positions length == vertexCount*3 and all finite
normal length == vertexCount*3 and all finite when present
uv length == vertexCount*2 and all finite when present
localIndices byteLength == triangleCount*3*2 and count % 3 == 0
every index < vertexCount
sourceVertexIndices byteLength == vertexCount*4 and length == vertexCount
renderGroups are derived one-for-one from faceSetTriangleSpans:
  firstIndex=firstTriangleInChunk*3; indexCount=triangleCount*3
  groups cover exactly 0..triangleCount*3 with no gap/overlap and preserve cullBackfaces
binaries decode as little-endian; schema requires localIndexElementBytes=2/sourceVertexIndexElementBytes=4
coordinateSpaceId/modelLocalTransformSha256/coordinateRule hash equal exact ResourceCacheKey contract
bounds finite, min<=max, and recomputed bounds within float tolerance
postMessage({buffers}, transferList=[each ArrayBuffer])
```

任何失败返回 chunk/resource identity；不得创建空 geometry 或 proxy 冒充真实模型。

GPU geometry、material 是不同资源、不同 key、不同refcount，禁止塞进同一entry。每个GPU pool实例必须绑定一个`rendererContextGeneration`；若实现选择process级outer map，第一层必须按context generation分池，第二层才按immutable content key查entry，绝不能让两个WebGL context共享同一个`BufferGeometry/Material`对象。pool owner粒度唯一固定为`GpuOwnerId=canonicalSha(workspaceSessionId,workspaceSessionGeneration,sceneId,sceneGeneration,rendererContextGeneration,resourceCacheKeySha256)`；它由`SceneResourceOwnerRecord`持有，subscriber lease只决定这个精确lifetime owner是否仍存活。immutable geometry/material content key仍不含这些lifetime字段。placement、part、chunk batch数量不参与资源refcount：

```ts
interface GpuGeometryEntry {
  key: string;                    // geometry content + layout + mesh/chunk identity；不含 material
  rendererContextGeneration: number;
  geometry: BufferGeometry;
  owners: Set<GpuOwnerId>;
  refCount: number;               // invariant: refCount === owners.size
  gpuBytes: number;
  lastUsedFrame: number;
}

interface GpuMaterialEntry {
  key: string;                    // shader/material parameters + referenced texture identities
  rendererContextGeneration: number;
  material: Material;
  textureLeaseKeys: string[];     // 若有 texture pool，由此独立 release
  owners: Set<GpuOwnerId>;
  refCount: number;               // invariant: refCount === owners.size
  gpuBytesEstimate: number;
  lastUsedFrame: number;
}
```

`acquireGeometry(owner,key)` 与 `acquireMaterial(owner,key)` 分别执行：先要求entry所属renderer context与owner完全相等；已存在 owner 时幂等，不重复加ref；不存在时加入owner并立即令`refCount=owners.size`，同时把key加入SceneResourceOwnerRecord对应Set。一个资源的P个placement和C个geometry chunks不会给同一pool key增加P/C次lease。`releaseGeometry`归零时只`geometry.dispose()`；`releaseMaterial`归零时只`material.dispose()`并逐个释放它实际持有的texture lease，绝不能从geometry entry销毁共享material/texture。关闭scene/workspace/context或最后subscriber离开时按精确owner record中的去重key各释放一次；旧scene/context owner不能命中新generation owner；重复release是测试错误。`clear()`必须逐owner/entry走同一dispose路径，不能只清Map。

batch策略必须在该scene第一chunk上传前确定，不能先建全地图batch再搬到cell。若24.13的cell模式关闭，同一模型每个geometry chunk建一个`InstancedMesh`，instance数等于该resource placements；若cell模式开启，则一开始就按`geometryChunk + centerCell`为batch，每个只含该cell子集。两种模式中一个逻辑placement都对应模型**全部已上传chunk bindings**。复杂度：分组`O(P)`，每chunk建矩阵`O(placementsForModel)`；不允许React每chunk深拷贝scene。

`MapModelLoadCache.resolved`当前会长期保存base64 wire DTO，必须替换为inFlight + 小型ready manifest + GPU pools：

```ts
interface ReadyResourceManifestV1 {
  schema: "map-ready-resource-manifest-v1";
  cacheKey: ResourceCacheKeyV1;
  resourceCacheKeySha256: string;
  chunks: Array<{
    chunkId:string; meshOrdinal:number; materialIndex:number; sourceTriangleStart:number; triangleCount:number;
    modelLocalTransformSha256:string; faceSetSpansAndCullSha256:string;
    geometryKey:string; materialKeys:string[]; rawContentSha256:string;
  }>;
  complete: true;
  createdAtFrame: number;
  lastUsedFrame: number;
}

inFlight: operationKeySha256 -> InFlightMapLoad only while task pending
readyManifest: resourceCacheKeySha256 -> ReadyResourceManifestV1; metadata only, no base64/ArrayBuffer/native doc
geometryPool/materialPool: content key -> bounded resource entry
deterministicNativeFailure: resourceCacheKeySha256 -> {cacheKey,diagnostic,retryAfter}; no geometry/base64
projectionFailure: operationKeySha256 + diagnosticCode -> {operationKey,diagnostic,retryAfter}; context/workspace lifetime scoped
```

ready hit算法在一个不可`await`的scene-resource transaction中完成：要求requested canonical key/hash与manifest逐字段完全相等，并要求当前workspace/scene/context lifetime精确有效；先验证每个geometry/material key存在、未disposed且属于当前renderer context，再为该精确scene owner逐项acquire并构造pending bindings。全部成功才同时发布owner key sets和bindings；任一缺失/throw则逆序release本事务新acquire项、删除pending bindings，把manifest标STALE并进入正常reload，不能留下半模型。两个subscriber共享同一精确scene owner时，第二个只加入subscriberLeaseIds，不重复pool acquire；第一个unsubscribe也不释放。pool允许refcount=0 entry在有界warm LRU短暂保留；readyManifest budget固定最多512 resources/16MiB metadata/idle 5分钟，并与pool eviction联动删除引用。顺序关闭后立即重开：若renderer context未变可命中GPU pool；context已变只能复用renderer-independent identity并重新upload，绝不能复活旧WebGL对象。超预算后重载是明示eviction，不是假“重复工作”。

Promise settle后`finally`删除inFlight；每次GPU上传后立刻删除/置空page、worker DTO和transferable引用。manifest只在收到所有chunk upload ACK且native complete后一次发布；取消/失败不得发布partial ready。heap smoke从retainer path证明base64不可达，不靠`Map.size`猜。

`FrameTaskQueue`只保证任务之间让步，因此每个task固定只上传一个已解码bounded chunk。任务开始前按24.20检查`workspaceSessionGeneration + source identity/pathSourceGeneration + sceneGeneration + rendererContextGeneration + resourceCacheKeySha256`；任一过期直接释放transferable buffer并返回false。若一个upload P95超过6 ms，减小Bridge chunk target，不要把frameBudget改大。

### 24.13 E-2：instance batch、空间 cell 和拾取算法

先跑 draw/CPU/GPU/pick 指标。若单一全地图 `InstancedMesh` 的 bounds 导致远处实例始终绘制，才启用本卡的 cell 切分；geometry/material 继续走同一组独立 pools，不复制顶点数据。

固定 world cell size 初始为 64 个**scene world单位**，即已经经过24.11.2唯一`C_game_to_scene_root`单位换算后的world AABB空间；禁止拿source/game数值直接除这个cell size而造成二次或漏单位转换。它不是为 m10 写的特例；所有地图共用。若真实 20-run 证明需要调整，只能在 A2 冻结的scene-unit候选 `{32,64,128}` 中跑同一 corpus，选择同时满足最低 loaded-frame P95且draw-call最少者，结果进入配置和 artifact；禁止运行时按样本 ID 切换。

每个 placement 在 geometry 到达后计算 world AABB：将 local AABB 的 8 个角逐一乘完整 placement/root world matrix，再逐轴取 min/max；对旋转/非均匀缩放不能只变换 min/max 两点。

空间索引：

```text
cellCoord(x) = floor(x / cellSize)           # 负数也使用 floor，不是 trunc
cellKey = `${cx},${cy},${cz}`

for placement worldAabb:
  minCell = floor(aabb.min / cellSize)
  maxCell = floor(aabb.max / cellSize)
  coveredCount = product(maxCell-minCell+1)
  if coveredCount <= 4096:
      insert placement identity into every overlapped cell
  else:
      insert once into oversizedPlacements
```

重复插入多个 cell 只用于 broadphase；渲染 instance 不能复制绘制。渲染 batch 的归属固定按 placement AABB center 所在 cell：

```text
RenderBatchKey = gpuGeometryKey | materialKey | centerCellKey
```

每个 batch 保存双向身份：

```text
MapPlacementIdentityV1 canonical key -> Array<{batchKey, instanceId}> sorted by batchKey UTF-8 bytes then instanceId
batchKey + instanceId -> exact MapPlacementIdentityV1 canonical key
```

数组长度等于该 placement 当前已上传的 geometry chunk 数；每个binding还保存immutable `modelLocalMatrix/modelLocalTransformSha256/resourceCacheKeySha256/rendererContextGeneration`，其instance matrix固定为`placementLocalMatrix * modelLocalMatrix`。上传一个新 chunk时，先为该 chunk的全部 placements构造 pending bindings，验证无 duplicate reverse key，再在一个 identity-index transaction中同时 append所有 forward arrays和reverse entries；删除/compaction也先计算新表，全部验证后交换引用。中途失败丢弃 pending表，旧表不变。禁止通过数组当前位置猜 semantic part，也禁止只保留最后到达的 chunk binding。

scene projection维护显式单调revision，不能让可见集缓存只看一个从不随chunk变化的`sceneGeneration`：

```ts
interface MapSceneProjectionRevisionsV1 {
  sceneId:string;
  sceneGeneration:number;
  rendererContextGeneration:number;
  batchRevision:number;                 // safe integer, monotonic, never reused in this scene lifetime
  spatialRevision:number;               // same constraints
}

interface VisibleBatchCacheKeyV1 {
  sceneId:string;
  sceneGeneration:number;
  rendererContextGeneration:number;
  cameraRevision:number;
  batchRevision:number;
  spatialRevision:number;
}
```

每次成功的“新chunk binding publish、任何binding add/remove、placement transform、cell rebucket、batch bounds交换、batch compaction”事务在**最后一次引用交换后**同时各递增`batchRevision/spatialRevision`恰好1；失败/rollback不递增。一个事务改一千个binding仍只增1。`cameraRevision`在view/projection matrix、viewport或DPR改变后增1。接近`Number.MAX_SAFE_INTEGER`时必须创建新sceneGeneration重投影，不能wrap。identity tables、batch instance buffers、world AABB/cell index、batch bounds和这两个revision必须在同一scene transaction内发布，observer不能看到“新binding+旧revision”。

frustum culling：每帧只测试 batch world bounding box/sphere；bounds 只有 placement/geometry 变化时重算，不在每帧遍历全部 vertices。visible set只能按完整`VisibleBatchCacheKeyV1`命中；相机不动但新chunk、拖拽、cell迁移或compaction导致任一revision变化时必须重算。测试先命中一次可见缓存，再上传一个位于视锥内的新chunk且不移动相机，断言新batch下一帧可见；旧`camera+sceneGeneration`二元key必须作为negative fixture。

拾取分两层：

```text
pick(ray):
  require normalized finite world ray and finite camera far plane
  testedPlacementIds = Set()
  nearest = exact-test every oversizedPlacement once, using the helper below
  gridBounds = union of all populated cell world AABBs
  slab-intersect ray with gridBounds -> [tEnter,tExit]
  if no intersection: return nearest oversized hit or miss
  t = max(0,tEnter); stopT = min(cameraFar,tExit)
  initialize 3D DDA at ray(t), with exact boundary tie handling
  while t <= stopT:
      for each placement id in current cell not yet in testedPlacementIds:
          mark tested
          cheap ray/worldAabb test; if hit interval can beat nearest:
              bindings = exact forward identity lookup
              for every chunk binding of that placement:
                  transform ray by inverse(instance world matrix)
                  exact ray/triangle test against that binding's shared geometry/BVH
              convert hit point back to world and compute distance from world ray origin
              update nearest; equal-distance tie uses canonical semantic part identity
      nextBoundaryT = minimum current DDA tMax
      if nearest exists and nearest.worldRayT <= nextBoundaryT: break
      advance every axis whose tMax equals nextBoundaryT; t = nextBoundaryT
  return nearest or miss
```

精确测试不能被挪到DDA全部结束以后；否则“最近命中早于下一cell边界就停止”没有可用的nearest值，只能退化成遍历到far plane。`oversizedPlacements`必须先测以给early-exit一个可能更近的上界。world ray direction固定归一化，`nearest.worldRayT`由world hit point重算；不能比较经过非均匀scale后的local ray参数。场景grid bounds或slab结果非finite固定FAIL，不进入无界循环。

同一placement的不同chunk命中只合并成一个semantic candidate，返回完整`MapPlacementIdentityV1`以及用于诊断的hit binding；selection/Gizmo随后必须重新从forward table取得**全部**bindings，不能只沿用被射线命中的那一块。

DDA 每轴初始化：

```text
step = rayDirAxis >= 0 ? +1 : -1
nextBoundary = (cell + (step>0 ? 1 : 0)) * cellSize
tMax = rayDirAxis == 0 ? Infinity : (nextBoundary-originAxis)/rayDirAxis
tDelta = rayDirAxis == 0 ? Infinity : cellSize/abs(rayDirAxis)
```

每次推进最小 `tMax` 的轴并加 `tDelta`。处理两个/三个相等轴时都推进，避免边界漏格。候选 Set 防止跨 cell 的 placement 重复精测。

如果没有现成可靠 triangle BVH，先用 Three.js 对已经 broadphase 缩小的对应 InstancedMesh/instance 精测并记录 P95；只有仍超 50 ms 才引入经过许可审查的成熟 BVH 库。不要手写一个未验证的 triangle BVH 混进这次根因修复。

### 24.14 E-3：Gizmo 选择、矩阵、拖拽和单次语义提交算法

核心规则：instance matrix 与 `binding.target` 都处在同一个共享 `placementRoot` local space。每个 batch record的`root`字段必须指向这同一个Object3D/rootSpaceIdentity，所有chunk/cell `InstancedMesh` 都是它的直接子对象；batch不是各自再创建一层有变换的root。不要在 local/world 之间来回猜轴。

这条规则成立的强制前提是：`instancedMesh.parent === batch.root` 且 `instancedMesh.matrix` 精确为 identity（position 0、unit quaternion、scale 1；`matrixAutoUpdate=false` 后仍保持）。所有坐标系/地图根变换只能放在 `batch.root`，所有 placement 变换只能放在 instance matrix。`addInstanceBatch` 创建时和每次选择前都断言；不满足返回 `MAP_INSTANCE_SPACE_INVARIANT_BROKEN` 并修 batch构造，禁止继续把 mesh-local matrix当 root-local，也禁止临时改挂点掩盖。

状态：

```ts
interface ActiveTransformSession {
  dragSessionId: string|null;        // select时null；pointerdown才mint随机128-bit
  controlsEpoch: number;
  pointerId: number|null;
  workspacePersistentIdentityHash: string;
  workspaceSessionId: string;
  workspaceSessionGeneration: number;
  sceneGeneration: number;
  rendererContextGeneration: number;
  resourceCacheKeySha256: string;
  selectionGeneration: number;
  partIdentity: MapPlacementIdentityV1;
  expectedSemanticRevision: number|null; // 每次pointerdown重新读取；非drag为null
  expectedTransformSha256: string|null;
  bindings: Array<{
    batchKey: string;
    instanceId: number;
    instancedMesh: InstancedMesh;
    root: Object3D;
    rendererContextGeneration:number;
    resourceCacheKeySha256:string;
    modelLocalTransformSha256:string;
    modelLocalMatrix:Matrix4;
    initialInstanceLocalMatrix: Matrix4; // drag开始时P0*N；非drag前不得用于rollback
  }>;
  target: Object3D;
  initialPlacementLocalMatrix: Matrix4|null; // P0，不含model-local N
  initialSemanticTransform: SemanticTransform|null;
  dragStartBatchRevision:number|null;
  dragStartSpatialRevision:number|null;
  dragging: boolean;
  dirty: boolean;
  committed: boolean;
  aborted: boolean;
  abortReason: string|null;
}
```

统一 detach helper：

```text
detachActiveTarget(reason):
  controls.detach()
  if active.target.parent != null: active.target.parent.remove(active.target)
  active.target.parent must now be null
  orbit.enabled = true unless another modal interaction owns it
  clear active session
```

选择算法：

```text
select(partIdentity):
  increment selectionGeneration
  detachActiveTarget("selection-change")
  capture exact workspace/session/scene/renderer-context/resource-cache lifetime
  semantic = read exact part from renderer-independent authority
  placementLocal = frozen 24.11.2 adapter.forwardPlacement(semantic.transform)  # P，不含N
  require placementLocal finite/invertible
  decompose placementLocal -> p,q,s; recompose P2=T(p)*R(q)*S(s)
  require maxAbs(P2-placementLocal)<=1e-6 else MAP_GIZMO_NON_TRS_TARGET
  bindings = fresh identity index lookup; require bindings.length > 0; do not scan all parts
  sort/copy bindings in canonical order
  require every instancedMesh.parent === binding.root and instancedMesh local matrix is identity
  require every binding.root is the same placement root object/rootSpaceIdentity
  require every binding rendererContextGeneration/resourceCacheKey/modelLocal hash equal active lifetime
  for each binding:
      expectedInstance = placementLocal * binding.modelLocalMatrix
      require current instance matrix equals expectedInstance within exact upload tolerance
  target.matrixAutoUpdate = true
  set target.position/quaternion/scale from placementLocal decomposition
  require quaternion/scale finite; reject singular transform
  placementRoot = bindings[0].root
  placementRoot.add(target)
  target.updateMatrix(); placementRoot.updateMatrixWorld(true)
  require target.parent === placementRoot
  create selection shell ActiveTransformSession with dragSessionId/pointerId=null,
    expected revision/hash and all drag-start fields null; bindings are only current selection projection
  when async TransformControls module resolves:
      attach only if captured workspaceSessionGeneration/selectionGeneration/sceneGeneration/
        rendererContextGeneration/resourceCacheKey/controlsEpoch all current and same target.parent
```

不得使用 `scene.attach(target)`，因为它会保留world transform并改变local matrix；这里要求直接`batch.root.add(target)`。注意target与instance只处于同一root-local**坐标空间**，数值不相同：target是可编辑的MSB placement矩阵`P`，instance是`P*N`。禁止把`P*N`直接`decompose`给TransformControls；非均匀P与旋转N的乘积可含合法shear，Three TRS target无法无损表示。`N`始终作为完整4x4矩阵右乘，只有`P`必须通过compose/decompose round-trip；这既保留真实模型local变换，又让写回直接对应MSB transform。

pointer 状态：

```text
pointerdown on handle:
  require active.dragging==false, active.dragSessionId==null and active.pointerId==null
  require active target parent exists and controls.object === active.target
  require real PointerEvent, handle ID来自24.21 typed ID-buffer artifact
  begin one scheduler/semantic read transaction; capture batchRevision/spatialRevision
  revalidate exact persistent workspace/session/session-generation/scene/renderer-context/resource key
  semantic0 = re-read exact part from semantic authority NOW（不能沿用select或上一次drag的snapshot）
  P0 = adapter.forwardPlacement(semantic0.transform); require finite/invertible
  decompose P0 -> p,q,s; recompose; require maxAbs(recomposed-P0)<=1e-6
    else MAP_GIZMO_NON_TRS_TARGET
  freshBindings = re-read all forward bindings NOW, canonical sort; require nonempty
  for each fresh binding:
      require reverse identity、scene/context/resource key/modelLocal hash仍exact
      current = getMatrixAt(instanceId)
      require current == P0 * modelLocalMatrix within upload tolerance
      snapshot initialInstanceLocalMatrix=current
  require transaction revisions unchanged; otherwise reject this pointerdown as
    GIZMO_DRAG_REBASE_RACED and let the next real pointerdown start a new attempt
  replace active.bindings with freshBindings; set target TRS/matrix=P0 before capture
  set expectedSemanticRevision=semantic0.revision, expectedTransformSha256=semantic0.transformSha256,
      initialSemanticTransform=semantic0.transform, initialPlacementLocalMatrix=P0,
      dragStartBatchRevision=batchRevision, dragStartSpatialRevision=spatialRevision
  mint random dragSessionId; increment controlsEpoch; save pointerId；不得复用select或上一drag的nonce/snapshot
  setPointerCapture(pointerId)
  install per-drag objectChange/end closures capturing dragSessionId+controlsEpoch+target object
  active.dragging=true; dirty=false; committed=false; aborted=false; abortReason=null
  orbit.enabled=false
  selection lock=true

objectChange (may fire many times):
  require callback captured dragSessionId/controlsEpoch equal active values
  require controls.object === active.target and active.target.parent === placementRoot
  require pointer capture still belongs to active.pointerId and scene/selection generations current
  if any mismatch: abortTransformSession(GIZMO_EVENT_SESSION_MISMATCH); return
  if not dragging or aborted: ignore
  target.updateMatrix()
  require all 16 local matrix elements finite
  stagedPlacementMatrix = clone target.matrix             # P'
  decompose/recompose stagedPlacementMatrix and require <=1e-6; otherwise abort MAP_GIZMO_NON_TRS_TARGET
  prevalidate every binding still maps reverse->same part, sceneGeneration current, instanceId in range
  try:
    for every binding in canonical order:
      stagedInstanceMatrix = stagedPlacementMatrix * binding.modelLocalMatrix
      require stagedInstanceMatrix all finite
      binding.instancedMesh.setMatrixAt(binding.instanceId, stagedInstanceMatrix)
    after all writes succeed:
      mark each distinct instanceMatrix needsUpdate exactly once
      recompute this placement worldAabb/cell membership and each touched batch bounds transactionally
      publish identity/spatial/bounds tables and increment batchRevision+spatialRevision exactly once
  catch:
    restore every binding from its initialInstanceLocalMatrix
    restore spatial/bounds tables transactionally and increment revisions once only if restored state was published
    active.aborted=true; abortReason=GIZMO_MULTI_CHUNK_UPDATE_FAILED
    active.dragging=false; active.dirty=false; active.committed=false
    orbit.enabled=true; selection lock=false; controls.detach(); detach target from root
    surface diagnostic; return immediately
  active.dirty = stagedPlacementMatrix differs initialPlacementLocalMatrix by epsilon
  render invalidation only; DO NOT mutate React semantic doc or Patch Engine

pointerup or dragging-changed=false:
  orbit.enabled=true; selection lock=false
  if active.aborted:
      require dirty=false and committed=false
      cleanup listeners/pointer capture/target only; semantic commit count remains 0
      return
  active.dragging=false
  if dirty and !committed:
      require expected revision/hash/initial fields are nonnull for this dragSessionId
      convert target placement-local P matrix（不含N）through exact 24.11.2 inverse adapter
      produce one semantic transform mutation carrying MapPlacementIdentityV1,
        expectedSemanticRevision, expectedTransformSha256,
        workspacePersistentIdentityHash/workspaceSessionId/workspaceSessionGeneration,
        sceneGeneration/rendererContextGeneration/resourceCacheKeySha256
      try applyTransformCas once to renderer-independent document, atomically comparing
        all identities/generations above + MapPlacementIdentityV1 + expected revision/hash
      on success:
          active.committed=true
          require subsequent semantic projection updates every binding to same matrix without jump
      on conflict/failure:
          re-read current semantic revision/hash/sceneGeneration
          if all still equal drag-start values:
              restore every binding.initialInstanceLocalMatrix and spatial/bounds tables transactionally
          else:
              do not write stale initial matrices; discard old scene transaction and
              reproject this placement from current semantic document/sceneGeneration
          keep semantic document unchanged by this drag; active.committed=false
          surface GIZMO_SEMANTIC_COMMIT_FAILED and detach
  if not dirty: commit count remains 0
  finally for this captured dragSessionId:
      remove only this drag's objectChange/end closures
      releasePointerCapture(pointerId) if still held
       if active still denotes this same target/session:
           set dragSessionId/pointerId=null, expected revision/hash=null,
               initialPlacementLocalMatrix/initialSemanticTransform=null,
               dragStartBatchRevision/dragStartSpatialRevision=null, dirty=false
       keep TransformControls attached only when the same selection remains active and no abort/conflict detached it
```

`catch`后禁止落到`active.dirty=...`，这是必须用显式`return`/状态分支锁住的控制流。`pointercancel`、`lostpointercapture`、Esc、controls被dispose与workspace切换都调用同一个`abortTransformSession(reason)`；该helper幂等，只允许第一次从active转aborted/closed，并移除该dragSession专属listeners、释放pointer capture。正常pointerup也必须执行上面的per-drag finally，否则第二次拖拽会继承旧nonce/listener/capture。aborted session收到晚到`objectChange/pointerup`时dragSessionId/epoch检查失败，只能清理，绝不能读target矩阵或提交。

`translate/rotate/scale` 都使用 TransformControls 自己更新的 quaternion/scale；不要把 Euler 累加到旧值。写回时使用项目现有 FromSoftware coordinate adapter把`P`转回语义TRS，禁止在Gizmo handler里手写`x/z`交换或角度正负号，也禁止对`P*N`做decompose后再右乘`inverse(N)`补救。每次pointerdown的rebase使第二次拖拽取得第一次提交后的新revision/hash/P0/bindings；测试必须连续拖两次同一part，断言第二次CAS使用第一次提交后的身份且总commit=2，不能继承第一次drag-start snapshot。

取消算法：Esc、workspace切换、对象删除、context loss时，先在semantic authority重新核对完整workspace/session/scene/renderer-context/resource key以及`expectedSemanticRevision + expectedTransformSha256`。只有所有drag-start字段非null且完全相等，才在detach前遍历`bindings[]`恢复每项`initialInstanceLocalMatrix`，并在一个scene transaction中恢复AABB/cell/bounds、递增batch/spatial revisions；任一identity/revision不同或binding已被新generation替换，就丢弃整个旧scene transaction并从当前semantic document重投影，禁止用drag-start矩阵覆盖并发更新。设`aborted=true,dirty=false,dragging=false`，不提交semantic mutation，然后detach。若semantic commit已成功，不再恢复。测试对至少含3个geometry chunks的placement，在第2个binding注入失败，断言所有chunk回到各自`P0*N`、commit=0、晚到pointerup仍为0；另注入拖拽期间semantic revision/context/resource变化，断言不恢复旧矩阵而重投影新authority；成功路径断言每个chunk最终等于同一个`Pfinal`右乘各自`N`且commit恰好1。

加载中同一placement可能到达新chunk。identity-index transaction在publish新binding前检查active transform session的`dragSessionId`、完整workspace/session/scene/context/resource lifetime、非nullrevision/hash和当前authority：若同一part仍在同一drag，令新binding的`initialInstanceLocalMatrix = initialPlacementLocalMatrix * newBinding.modelLocalMatrix`，GPU当前值=`target.matrix * newBinding.modelLocalMatrix`，再把binding同时追加到forward/reverse table和`active.bindings`，更新空间表并令batch/spatial revisions各增1；所有引用交换必须原子。若authority revision/hash或任一lifetime已改变，先abort并重投影，不得加入旧drag。失败则删除未发布batch/释放GPU owner，旧bindings/session/revisions不变。若session已aborted/commit冲突，不发布迟到binding直到下一次semantic projection；禁止新chunk用旧`P`或漏乘`N`把正在拖动对象撕成两份。

非 identity root 测试必须设置 root translation + rotation + 非均匀 scale，执行三种 mode：

```text
beforeWorld[i] = root.matrixWorld * initialPlacementLocal * binding[i].modelLocalMatrix
drag target in root-local through real pointer events
afterLocals = bindings.map(getMatrixAt)
assert every afterLocals[i] equals target.matrix * binding[i].modelLocalMatrix
afterWorld[i] = root.matrixWorld * afterLocals[i]
assert target.matrixWorld == root.matrixWorld * target.matrix
assert semantic adapter round-trip recreates target.matrix（P）within 1e-5
assert objectChange count >= 1, semanticCommit count == 1
```

加载中selection：semantic selection可以先存在；目标batch到达时必须同时核对selectionGeneration、sceneGeneration、rendererContextGeneration和resourceCacheKeySha256后attach。旧模型/旧GPU context晚到不得覆盖当前选择。切换选择时旧target `parent===null`、旧controls object为空。

### 24.15 F-1：CharacterAssemblyContext 的 production resolver 算法

不要先写一个返回 c0000 四个 URI 的函数。先建立 Sekiro 版本化装配规则，它描述“哪个 PARAM 字段代表哪个 slot、数值怎样变成模型资源名”，规则按 game/Paramdef identity 选，不按角色 ID 选。

规则数据结构：

```ts
interface CharacterAssemblyRuleV1 {
  game: "sekiro";
  metadataPackageHash: string;
  table: string;
  dataVersion: number;
  characterRowResolver: "explicit-param-row" | "indexed-character-link";
  leader: {
    source: "selected-character-resource"|"param-field";
    fieldId?: string;
    resourceKind: "character";
    idWidth: number;
    fileTemplate: "c{id}.chrbnd.dcx";
  };
  gender:
    | {source:"param-field";fieldId:string;encoding:Record<string,"m"|"f">}
    | {source:"rule-constant";value:"m"|"f";evidenceArtifactHashes:string[]};
  slots: Array<{
    slot: "head"|"face"|"body"|"arms"|"legs";
    fieldId: string;
    resourcePrefix: "hd"|"fc"|"bd"|"am"|"lg";
    idWidth: number;
    fileTemplate: "{prefix}_{gender}_{id}.partsbnd.dcx";
    zeroSemantics: "absent"|"valid-model";
    resourceKind: "parts";
  }>;
}
```

建立规则时的固定研究步骤：

1. 从当前已校验 Paramdex metadata 读取候选 table/field 的内部 field ID、offset、display type 和 dataVersion；不要依赖中文显示名模糊匹配。
2. 用 Andre/Smithbox 对同一真实 param row 导出字段值和实际装配 resource identity。
3. 每个 slot 至少找两个不同非零值做对照，证明格式规则，而不是只验证默认狼的一组值。
4. 把 leader来源/field、field ID、前缀、idWidth、fileTemplate、完整gender来源、zero语义和metadata package hash固化到规则fixture；三方证据不一致则G6 FAIL，不能猜。`gender`是必填discriminated union：`param-field`必须有真实field+非空encoding，`rule-constant`必须有非空独立证据hash；不存在“genderFieldId缺失后再要求一个schema里没有的gender selection purpose”。schema必须拒绝未知placeholder、缺leader字段、idWidth不在1..8、gender值未映射、无证据constant和重复slot。
5. production resolver 只消费这份经过验证的通用规则。规则不允许含 `c0000`、具体装备数字、骨骼数、mesh 数或目录排序。

若当前资源图无法把角色选择解析到合法 PARAM 物理行，自动装配必须返回 `CHARACTER_ASSEMBLY_CONTEXT_REQUIRED`，并在 UI 允许用户通过真实资源/PARAM 行选择建立 context；禁止退回“扫描 parts 目录取最小/首个”。但 G6 仍要求真实 c0000 production workflow最终获得合法 context，不能以这一诊断结束任务。

PARAM provenance resolver：

```text
resolveFromParamSelection(request):
  require request.paramRow carries eventId+raw nonce from main-owned active selection registry
  lookup metadata/rule identity from the active typed table selection without reading mutable row bytes
  derive the exact selection-purpose closure:
    required = exactly one param-row
    if rule.leader.source==selected-character-resource: add exactly one leader; otherwise add none
    body slots are always generated from this PARAM row and require zero pseudo-body selection records
    add one attachment record only for each user-declared requested attachment; no implicit attachment
  require request supplies exactly this closure，无缺项/多余purpose/重复eventId
  reserve all supplied records in one transaction；only use returned immutable provenances below
  require every record.workspaceSessionId/workspaceSessionGeneration == active workspace scope
  open/reuse PARAM native session
  locate exact physical rowIndex from reserved param-row provenance
  require current row id/hash/source/pathSourceGeneration equal reserved expected identity
  load exact metadata rule by game+table+dataVersion+metadataHash

  if rule.leader.source == selected-character-resource:
      require reserved leader provenance exists；obtain its exact indexed URI（不得再次consume）
  else:
      decode rule.leader.fieldId, zero-pad to idWidth, apply exact leader fileTemplate,
      resolve that identity through resource graph
  leaderUri = resolved exact character URI; no directory scan/fallback
  for slotRule in rule.slots in fixed rule order:
      rawValue = decode exact field from same physical row
      validate value using metadata display type/range
      if rule says absent and value is absent: continue
      if rule.gender.source==param-field:
          genderRaw = decode exact rule.gender.fieldId from the same physical row
          require exact key in rule.gender.encoding; gender=rule.gender.encoding[genderRaw]
      else:
          require rule-constant evidence hashes still equal frozen rule; gender=rule.gender.value
      modelName = apply slot fileTemplate with validated prefix/gender/zero-padded id only
      resourceUri = resourceGraph.resolveExact(kind=parts, modelName, overlay policy)
      if missing: fail CHARACTER_PART_RESOURCE_MISSING with slot/field/value
      append bodyPart with param-field provenance
  build immutable context
  commit the one reservation transaction exactly once; mark transaction terminal
  only then publish/return context
  on any failure/cancel before committed: rollback that same transaction exactly once in finally
  after commit: finally must not rollback; publish no partial context on commit failure
```

FromSoftware filename formatter只把**已经从权威字段读出的 model id**转成名字：验证id是安全非负整数且十进制位数不超过rule.idWidth，按rule固定补零；template只允许上面声明的固定placeholder并拒绝`/\\..`等路径字符。param-field gender原值必须精确命中对应`encoding`；rule-constant必须来自已冻结证据；两者都不能在缺值时默认`m`。formatter不能枚举目录寻找“最接近”的id。

显式资源选择 provenance 不能只是 renderer 传一个字符串。main 维护短生命周期 registry：

```ts
interface SelectionRecordV1 {
  selectionEventId: string;       // main生成random 128-bit opaque id
  selectionNonceSha256: string;   // main只存hash；raw nonce只在mint response返回一次
  webContentsId: number;
  workspacePersistentIdentityHash: string;
  workspaceSessionId: string;
  workspaceSessionGeneration: number;
  selectedResourceUri: string;    // 必须来自active index
  selectedSourceContentSha256: string;
  selectedPathSourceGeneration: number;
  selectedOverlayResolutionGeneration: number;
  selectedEntryIdentity: string;  // BND physical entry/PARAM row/action physical identity
  selectionRevision: number;
  createdAt: number;
  expiresAt: number;
  allowedPurpose: "leader"|"attachment"|"animation"|"skeleton"|"param-row";
  state: "AVAILABLE"|"RESERVED"|"CONSUMED"|"EXPIRED";
  reservationTransactionId: string|null;
  reservationExpiresAt: number|null;
  consumedAt: number|null;
  consumedPurpose: string|null;
}

interface ActionSelectionRecordV1 extends SelectionRecordV1 {
  allowedPurpose: "animation";
  selectedResourceUri: string;             // exact anibnd URI
  selectedEntryIdentity: string;           // TAE/action physical binding identity
  typedAnimationId: number;                // reducer从typed action DTO取得，不解析display label
  actionBindingIdentitySha256: string;
}
```

只有main-owned workbench selection reducer在真实用户选择已提交、并能从自己当前index/physical selection查到identity时才可mint record；不得暴露“renderer传URI让main发票”的通用IPC。main同时生成独立random 256-bit raw nonce，只在mint response `{selectionEventId,selectionNonce}`返回一次，registry只存SHA-256；renderer后续必须同时出示两者。record绑定source hash、`selectedPathSourceGeneration`、`selectedOverlayResolutionGeneration`、entry identity和selection revision，因此路径被覆盖、overlay重新解析或硬编码URI都不能包装成仍合法的选择。action reducer还必须从typed action DTO写入`typedAnimationId/actionBindingIdentitySha256`；不得从`a000_000010`显示字符串正则提取。TTL固定2分钟；新workspace/window销毁立即expire。

consume必须在main registry同一把锁内做一次性CAS：

```text
consumeSelection(eventId, rawNonce, expectedPurpose, callerWindow,
                 workspacePersistentIdentityHash, workspaceSessionId, workspaceSessionGeneration):
  lock registry
  record = exact lookup; missing -> SELECTION_NOT_FOUND
  validate state==AVAILABLE, now<expiresAt, window/persistentWorkspace/session/workspaceSessionGeneration/purpose all exact
  require constantTimeEqual(SHA-256(rawNonce bytes), record.selectionNonceSha256)
  re-read active index selection identity; require URI/sourceHash/pathSourceGeneration/
    overlayResolutionGeneration/entry/revision unchanged
  if any validation fails: do not mutate AVAILABLE except TTL may atomically become EXPIRED; reject
  atomically set state=CONSUMED, consumedAt=now, consumedPurpose=expectedPurpose
  remove from available index; retain small replay tombstone until workspace closes
  unlock; return immutable consumed provenance
```

第二次consume、nonce错误、换purpose、跨window/workspaceSessionGeneration、source变化或复制event id固定拒绝`SELECTION_REPLAY_REJECTED/SELECTION_NONCE_MISMATCH/SELECTION_*_MISMATCH`。多个用途需要多个真实selection event，不能把一个record复用为leader+skeleton。并发双consume测试用barrier同时发两次，必须恰好一个成功；registry purge不会在active consume中删除record。eventId和nonce缺一都不能授权。

需要同时消费action+skeleton或leader+多个body选择时，禁止逐个consume造成半消费。固定reservation事务：

```text
reserveSelections(transactionRequestId, [{eventId,rawNonce,purpose},...], scope):
  require数组非空、eventId无重复、按eventId UTF-8排序
  lock registry；逐项执行consume的全部验证，但先不改任何record
  任一失败 -> 0 records changed；返回精确失败
  mint transactionId；把全部record原子改RESERVED
  each reservationExpiresAt = min(record.expiresAt, now+30秒)，reservation绝不延长原2分钟TTL
  unlock；return immutable provenances + transactionId

commitSelectionReservation(transactionId):
  lock；require全部仍RESERVED、now<各自reservationExpiresAt且scope/source/path/overlay/entry/revision未变
  全部原子改CONSUMED并写tombstone；unlock

rollbackSelectionReservation(transactionId, reason):
  lock；对仍属于该transaction的record：
    若原TTL未过且source/path/overlay/entry/revision仍相同 -> AVAILABLE
    否则 -> EXPIRED
  0 record可保持RESERVED；unlock
```

resolver只能在全部native/resource graph/context校验成功、即将发布最终context时commit；skeleton解析失败、conversion rule缺失、Bridge异常、取消和超时都在finally rollback。commit自身失败则不发布context。purge在同一registry锁内把超时RESERVED事务整组rollback/expire，不能只删一条；进程/窗口/workspace dispose也按transaction成组处理。barrier测试覆盖两请求竞争同一record（至多一个reserve成功）、第二个record验证失败（0项改变）、reserve后失败可重试、原TTL早于30秒、reservation TTL过期和workspace dispose。

attachments 独立处理：只有 context 明确给出 `attachBoneName` 才装配；验证 leader 中该名称唯一，然后把 attachment root挂到该 bone。weapon parts 不进入 body remap；缺挂点返回精确 diagnostic。

最终 context 规范化顺序固定为 leader、按 rule slots 顺序的 bodyParts、按 URI 字节序的 attachments。context identity 使用24.11 canonical encoder，固定包含persistent workspace identity、每个URI/source hash/pathSourceGeneration/container entry、PARAM物理行/field provenance、selection consumed provenance、assembly/remap rule hashes和输出coordinate identity；`workspaceSessionGeneration`只在owner lease/publish guard中，不进入可跨重开的不可变content identity。缓存按这个完整identity，不按 `c0000`名字或通用`generation`字段。

### 24.16 F-2：leader 骨骼验证、正权重 remap 和 bundle 构建算法

所有权：Bridge 解析每个 FLVER 自己的原生骨骼/mesh；renderer-independent core/main 将 part bone namespace重映射到 leader；renderer 只接收最终单 leader bundle。当前 renderer `flverSkeletonMapping.ts` 可作为诊断/测试参考，但 production remap 不得留在 React/Three 层。

输入前置条件：

- 每个模型有唯一 container entry identity/content hash。
- 每个角色/parts mesh必须调用24.9的`sekiro-character-preview-highest-detail-v1`选择与同一streaming decoder；triangle bytes、rule id、source bits和`CullBackfaces`进入semantic payload。禁止角色路径继续使用另一套`Flags==0 ?? first` helper或默认uint16。
- bone 数组物理 index 连续，parentIndex 为 `-1` 或有效 index。
- mesh bone index 已由 Bridge 明确投影为 `flver-global`；如果原格式使用 mesh-local palette，Bridge 必须先按 mesh bone table 转成 global，不能让 core 猜。
- skinningMode 明确为 weighted/rigid/static。

Bridge 的 global 化规则也锁死：Sekiro-era `InternalVersion > 0x2000D` 的 vertex bone index 已处于 FLVER global namespace，直接做骨表范围检查；旧版本才把 raw slot先索引 `mesh.BoneIndices[rawSlot]` 得到 global index。rigid vertex 优先使用格式已验证的 NormalW，否则使用 mesh default bone。正权重 raw slot、palette/global index或 rigid index越界都必须返回定位到 mesh/vertex/slot 的 diagnostic，禁止像旧代码那样退回 `Static` 或 bone 0。mesh DTO 增加明确 `weightEncoding=byte4c|byte4a|short4|float`（按实际支持闭集），供下游采用对应量化容差；不允许从 base64长度猜编码。

先验证并计算 bind-world：

```text
validateSkeleton(bones):
  require bone.index == array position
  require unique/valid parent references and parent != self
  DFS color WHITE/GRAY/BLACK; GRAY revisit => cycle failure
  require translation/rotation/scale finite
  rotationColumn = RotY(rotation.y) * RotZ(rotation.z) * RotX(rotation.x)
  local = Translation * rotationColumn * Scale
  world[index] = parent<0 ? local : world[parent] * local
  require every world matrix finite and invertible when used for skinning
  return world matrices
```

“XZY”标签本身不足以决定列向量乘法顺序。这里以本机成熟实现的可执行语义锁定：DSAnimStudio 4.9.9所带`SoulsFormats.FLVER.Bone.ComputeLocalTransform`在System.Numerics行向量约定中等价于`S*Rx*Rz*Ry*T`；转成本文统一的列向量后精确为`T*Ry*Rz*Rx*S`，旋转四元数为`qy*qz*qx`。因此禁止直接调用Three `Euler(x,y,z,"XZY")`或当前helper的`qx*qz*qy`，它们会得到不同矩阵。A2 verifier必须独立读取成熟DLL/XML identity并冻结下面的三轴非零golden vector；只拿当前SoulForge CPU smoke互相证明无效。

固定输入`translation=[1.25,-2.5,3.75]`、`rotationRadians=[0.31,-0.47,0.83]`、`scale=[1.2,0.8,1.5]`时，列向量row-major local matrix必须在`1e-6`内等于：

```text
[ 0.722037391382, -0.611770052011, -0.345893686785,  1.25 ]
[ 0.885517645332,  0.514165473454, -0.308815018704, -2.50 ]
[ 0.366770371285, -0.037030654459,  1.426531051770,  3.75 ]
[ 0,               0,               0,               1    ]
```

同输入的Three `Euler("XZY")`矩阵必须作为negative fixture且不得等于该expected；Node adapter、C# Bridge和独立System.Numerics转置oracle三者逐元素一致后才能开放角色production路径。

#### 24.16.1 三方核对已完成：结论、替换常量与四个改动点

上一段要求的三方核对已在 2026-08-27 实测完成，结论**支持本节的数学、否定生产实现**。下面全部是可复现的实测值，不是推导；接手者不需要重新证明契约本身，只需要照着改代码并复跑。

golden matrix 复核：按 `T*Ry*Rz*Rx*S` 独立算出的矩阵与 §5278 冻结值 `maxAbsDiff = 4.865e-13`；反向实现 `T*Rx*Rz*Ry*S` 与冻结值 `maxAbsDiff = 5.766e-1`。冻结表可信，negative fixture 是真判别器，两者都直接用。

四元数三方核对，输入 `rotationRadians=[0.5,-0.3,1.2]`（与 `flverSkeletonMapping.test.ts:38` 同一输入，便于直接替换常量）：

| 候选 | `[x,y,z,w]` | 与 SoulsFormats 权威一致 |
| --- | --- | --- |
| 权威 `qy⊗qz⊗qx` | `0.1201424763, 0.0186237853, 0.5714598517, 0.8115741358` | — |
| `qx⊗qz⊗qy`（`flverSkeletonMapping.ts:132` 现状） | `0.2836544250, -0.2576285380, 0.5104319190, 0.7698226807` | 否 |
| `CreateFromYawPitchRoll(y,x,z)`（`BridgeCommandService.cs:1235`） | `0.1201424897, -0.2576285899, 0.5714598894, 0.7698227763` | 否，实测等于 `qy⊗qx⊗qz` |

判据不靠四元数逐位比较（`q` 与 `-q` 是同一旋转，逐位比会给假红），而是取非对称向量 `v0=(0.3,0.7,-0.2)` 过 SoulsFormats 行向量矩阵得 `(-0.5758187, 0.5369556, -0.0105562)`，再分别过三个候选：权威命中；`qx⊗qz⊗qy` 给 `(-0.5271586, 0.5544641, +0.1862082)`，z 分量连符号都反；`CreateFromYawPitchRoll` 给 `(-0.5431195, 0.5638667, -0.0841167)`。Node 与 C# 两侧各自独立构造 oracle，结论一致。

**Three 侧的替换值是 `'YZX'`，不是别的。** 本节只写了「禁止 `Euler(...,"XZY")`」却没给替换值，接手者会卡在这里或自己猜。实测 three@0.172.0 六个 order 全枚举，只有 `Euler(x,y,z,'YZX')` 与权威逐位一致（`setFromEuler` 与 `makeRotationFromEuler` 同语义，两者都测过）。注意参数位置不动，仍是 `(x, y, z, order)`，只换 order 字符串。

需要改的四处，全部改完才算一次完整修复：

1. `apps/desktop/src/renderer/src/scene/flverSkeletonMapping.ts:132`：`multiplyQuaternion(multiplyQuaternion(qx, qz), qy)` → `multiplyQuaternion(multiplyQuaternion(qy, qz), qx)`。`:126` 的 docstring 也要改：函数名 `flverEulerXzyToQuaternion` 与「XZY」标签描述的是 FLVER 源格式（行向量 `Rx*Rz*Ry`），**这个名字是对的，不要改名**；docstring 必须写明「行向量 XZY 源 → 列向量 `qy⊗qz⊗qx`」，否则下一个人会把名字和实现的表面矛盾当 bug 再翻回去。
2. `apps/desktop/src/renderer/src/scene/threeSceneController.ts:386` 与 `:1477`：`'XZY'` → `'YZX'`。
3. `threeSceneController.ts:152` 的类型 `rotationOrder?: 'XZY' | 'XYZ'` 不含 `'YZX'`，必须一起改，否则 typecheck 拦住。`:432` 的默认值 `b.rotationOrder ?? 'XZY'` 同步改。这四处是一个原子改动，漏掉类型会让人以为方案不可行。
4. `bridge/SoulForge.Bridge/BridgeCommandService.cs:1235` 的 `CreateFromYawPitchRoll(arr[1], arr[0], arr[2])` 是**第三种约定**，两种解释下都错。它当前从 typed TS 调用方不可达（`BoneTransformData.rotation` 是 4 元组，`action-continuous-sampler.ts:176` 恒发 4 元），属于潜伏项，但它长在权威层。要么删掉这个 3 元宽容分支改为 fail-closed 报 `ACTION_FLVER_REFERENCE_POSE_ROTATION_ARITY`，要么按 `qy⊗qz⊗qx` 重写。禁止原样留着——宽容分支一旦被将来某个调用方触发，会静默给出第三种姿态，且没有任何诊断。

#### 24.16.2 现有测试会惩罚正确修复，必须同批改

`flverSkeletonMapping.test.ts` 共 4 个用例。修改前先弄清哪个测什么，否则会改错文件位置：

- `:11`、`:27` 测 `mapFollowerSkeleton`，与旋转无关，不动。
- `:37` `composes FLVER Euler rotations in XZY order` 测 `flverEulerXzyToQuaternion`。**这是活断言，但它钉死的是错的约定。** 实测把 `:132` 改成正确的 `qy⊗qz⊗qx` 会让它变红。这不是回归，是判据在惩罚正确修复——比死断言更坏，因为它给的是反向信号。`:39-44` 的期望常量必须同批替换为权威值：`0.1201424763, 0.0186237853, 0.5714598517, 0.8115741358`（`1e-12` 容差下通过）。改完这条会由「锁死缺陷」变成「锁死正确约定」，是唯一能长期防回归的位置，不要删掉它。
- `:50` `retargets animation deltas while preserving a follower bind pose` 测 `retargetHkxPoseToFlver`。它的 follower fixture 旋转全为 `[0,0,0]`，`flverEulerXzyToQuaternion` 两种实现都返回单位四元数，所以**改 `:132` 不会波及这条**。两个缺陷互相独立，但被同一个「fixture 全零」的选择同时藏住。

`:50` 自己还有一条独立的死断言，与旋转约定无关，必须分开修：

`:168` 的 `multiplyQuaternion(bind.rotation, rotationDelta)` 交换两个操作数后，`:50` 保持绿（实测）。原因是两层空洞，只修一层仍是假门禁：

- 第一层，fixture 可交换：`Ctrl.rotation` 为 `[0,0,0]` → bind 是单位四元数，与任何四元数可交换，两种乘序逐位相同。
- 第二层，断言只查两个分量：`:74-75` 只查 `rotation[2]`、`rotation[3]`。即便把 fixture 换成与 delta 异轴的 `[Math.PI/2,0,0]`，两种乘序在 `[0]`、`[2]`、`[3]` 上仍完全相同，`mul(bind,delta)=[0.5,-0.5,0.5,0.5]` 与 `mul(delta,bind)=[0.5,+0.5,0.5,0.5]` **唯一的判别位是分量 `[1]` 的符号**。

所以有效修复必须同时动两处：fixture 用 `rotation: [Math.PI / 2, 0, 0]`（与 delta 绕 Z 异轴），断言改成查全四分量 `[0.5, -0.5, 0.5, 0.5]`。**不要只把 fixture 换成 `[0,0,Math.PI/2]`**——那与 delta 同绕 Z 轴、仍可交换，断言照样是死的。

只改 fixture 不改断言会得到一个具有欺骗性的假红：`:74-75` 硬编码期望 `Math.SQRT1_2 ≈ 0.7071`，而两种乘序在 `[2]`、`[3]` 上都给 `0.5`，于是生产代码正确时也红。这个红与乘序无关，纯粹是 fixture 与旧期望值失配。**看到这个红不要以为判据活了。** 判定方法是加一个对照相位：生产代码保持正确、只改 fixture，如果也红，就说明红的成因是失配而不是乘序。

完整扰动矩阵（实测，靶标为 `:50`）：

| 相位 | 改动 | 结果 |
| --- | --- | --- |
| P0 | 无 | 绿 |
| P1 | 仅交换生产乘序 | **绿 → 断言是死的** |
| P2 | 交换乘序 + 仅改 fixture | 红 |
| P2c | 正确乘序 + 仅改 fixture（对照） | **红 → P2 是假红** |
| P3 | 交换乘序 + fixture + 全分量断言 | 红 |
| P4 | 正确乘序 + fixture + 全分量断言 | 绿 |

P3 红、P4 绿同时成立，才证明判据既能抓到扰动又不误红。缺任一相位都不算证完。

#### 24.16.3 跑这个套件之前必须知道的两件事

命令是 `node scripts/run-renderer-unit-tests.mjs`（根 `package.json` 收集，非 `apps/desktop` workspace）。

**这个套件在冻结 worktree 上的基线就是红的。** 实测 `tests 837 / suites 155 / pass 836 / fail 1 / duration_ms 2383.0286`，退出码 1，JSON 摘要 `"code": "RENDERER_UNIT_TESTS_FAILED"`。这条红与骨骼/旋转无关，**不是你改出来的**。

失败用例的三个定位口径（任一都能找到它，不要只记一个）：

| 口径 | 值 |
| --- | --- |
| 文件 | `apps/desktop/src/renderer/src/editors/TaeWorkbenchPanel.test.tsx:535` |
| 用例名 | `问题4-A：预览一次读取并校验完整角色 bundle，不再逐 mesh 重启 Bridge` |
| 所属 suite | `Negative source tests（ANIMATION-56B / ANIMATION-56C）` |
| 报错 | `AssertionError [ERR_ASSERTION]: The input did not match the regular expression /readTaeChrbndPreview\(props\.resourceUri\)/` |

**本文档此前把这条红的成因写反了，以下是实测后的更正。** 原文说「源码已漂移，正则不再匹配，是又一个腐坏的源码字符串门禁，不要去修」。三条测量否掉了这个说法：

1. `git status --porcelain` 里**只有 `.test.tsx` 是 M，`TaeWorkbenchPanel.tsx` 干净**——源码这一轮没被动过。
2. `git show HEAD:...TaeWorkbenchPanel.test.tsx` 的第 536 行是 `/readTaeChrbndPreview\(props\.resourceUri, index\)/`，**带 `index`**。
3. 源码 `TaeWorkbenchPanel.tsx:720` 是 `readTaeChrbndPreview(props.resourceUri, 0)`、`:755` 是 `(props.resourceUri, index)`——**正好满足 HEAD 那个正则**。

也就是说：不是源码退了，是**测试在脏树里被提前写到了源码前面**。断言钉的是一个还没实现的新约定（一次读整包，而不是按 mesh 循环）。这是「测试即规格」，不是门禁腐坏。

**所以处置方式和原文相反：这条红在你的作业范围内，要修的是源码，不是断言。** 问题4-A（预览一次读齐整个角色 bundle，不再逐 mesh 重启 Bridge）属于用户点名的「动作预览」。断言要的四样东西里有两样**已经在仓库里了**，不用新建：`isCharacterPreviewBundle` 在 `packages/shared/src/flver-preview.ts:78`；`externalBundle` prop 在 `FlverViewer.tsx` 已全线接通（`:34` 类型、`:174`/`:205`/`:243` 三处分支、`:311` 走 `buildBundleSemanticScene`、`:384` 汇总、`:402` 计数）。

四个改动点（少一个就编译不过或恒红）：

| # | 位置 | 现状 → 目标 |
| --- | --- | --- |
| 1 | `TaeWorkbenchPanel.tsx:720`、`:755` | 两次带 meshIndex 的调用 + 循环 → 一次 `readTaeChrbndPreview(props.resourceUri)`，结果过 `isCharacterPreviewBundle(result.data)` |
| 2 | `TaeWorkbenchPanel.tsx` 渲染处 | `meshIndex={0}` → `externalBundle={preview.bundle}` |
| 3 | `apps/desktop/src/preload/index.ts:385-386` | `(sourceUri, meshIndex)` → 去掉 `meshIndex`（必填位参，不改这里 typecheck 直接红） |
| 4 | `apps/desktop/src/main/ipc.ts:4806` handler | 形参 `meshIndex: number` 同步去掉，返回整包 |

**顺手记一条同形发现：** `remapCharacterBundleToLeader`（`packages/core/src/character/characterAssembly.ts:36`）已实现、已在 `packages/core/src/index.ts:69` 桶导出，但 `ipc.ts` 里**零引用**——第三个「实现完了没接线」的孤岛，前两个是 `mapMeshGeometry.ts`（§18）和 `MapStaticGeometryService.cs`（§0.4.2）。别重写它。

**最后一条警告，来自 §18：这仍然是源码字符串判据，正则绿 ≠ 行为对。** 把 `readTaeChrbndPreview(props.resourceUri)` 这个串写进注释、写进死代码，五条断言就全绿了，而预览一帧都没变。这条用例只能证明「调用形状变了」，不能证明「整包真的读齐并画出来了」。行为侧要另测：一次调用后 `preview.bundle.models[].meshes` 的总数等于 `meshCount`，且 Bridge 只被起了一次。

**因此套件退出码不能作为任何扰动实验的测量口径。** 它恒为 1，会把所有相位盖成同一个值，让人误判成「判据是死的」。判据必须下沉到目标用例自己那一行的 `✔`/`✖`；找不到那一行要当测量失效报错，而不是当通过。上面的 P0-P4 矩阵就是这样测的。

构建 leader name index：

```text
leaderByExactName: Map<string, number[]>
for each leader bone:
  append index under StringComparer.Ordinal/exact code-unit name
```

不要先 `Map<string,number>`，它会把重复骨名折叠。

收集 part 真正使用的 influence：

```text
for each mesh:
  if static: no bone mapping
  if rigid: add mesh.default/global bone index as one positive influence
  if weighted:
    require weights/indices tuple counts match vertexCount
    for each vertex and each slot:
      require weight finite and nonnegative
      if weight > 0:
        require partBoneIndex in range
        add partBoneIndex to used set
        record first {mesh,vertex,slot} for diagnostics
    require each weighted vertex has positive finite sum
```

权重和容差由编码决定：Byte4C 每分量量化误差上限 `0.5/255`，四项和容差 `2/255`；Byte4A 对应 `2/127`；UVPair/Short4对应`2/32767`；Float 权重使用格式/oracle 确认的 `1e-5`。只有总和落在 `1 +- encodingTolerance` 时才除以 sum 做微小归一化；超出直接 `FLVER_SKIN_WEIGHT_SUM_INVALID`，不能无条件 normalize 掩盖错位。

对每个 used part bone：

```text
name = partBones[index].name
candidates = leaderByExactName[name]
if 0: FLVER_LEADER_BONE_MISSING with first influence location
if >1: FLVER_LEADER_BONE_AMBIGUOUS with candidate indices
require candidates.length == 1
leaderIndex = candidates[0]
correction[index] = leaderBindWorld[leaderIndex] * inverse(partBindWorld[index])
mapping[index] = leaderIndex
```

对同一part所有used bone的`correction[index]`逐元素比较。以第一个used bone为candidate C，要求其余`maxAbs(C_i-C)<=1e-4`；通过则把C保存为`partToLeaderBind`。A2 oracle逐part记录used bone correction spread、C矩阵/hash和CPU bind结果；只有冻结规则/corpus通过才开放该part。若不收敛返回`FLVER_PART_BIND_CORRECTION_NON_UNIFORM`，不能由实现者在“拒绝、忽略、每part新Skeleton”之间任选。不要用hierarchy fallback悄悄挑重复名；若成熟证据以后证明需要hierarchy identity，必须先增加独立fixture/oracle并修改锁定契约。

重写每个 mesh：

```text
for each influence slot:
  if weight == 0:
      output index may be 0 but never counted/mapped
  else:
      output index = mapping[source global part bone index]
      require 0 <= output < leaderBoneCount
preserve positions/normals/uv and validated weights
set boneIndexSpace = leader-global
set skeletonId = leader model/content identity
```

矩阵空间和乘法顺序不再留给实现者选择。全部使用 column vector、右乘点、组合 `A*B*v` 表示先 B 后 A，并定义：

```text
R0 = bind snapshot时characterRoot.matrixWorld；包含角色预览placement/统一坐标适配，不含任何单part修正
Rt = 当前frame的characterRoot.matrixWorld；root未移动时Rt=R0
C = partToLeaderBind；满足每个已使用映射骨 C * partBindWorld == leaderBindWorld
N = meshToPart；来自 Bridge FLVER semantic DTO 的该 mesh 原生 local-to-part transform；格式无此变换时才是 identity

skinnedMesh.parent = characterRoot
skinnedMesh.matrix(local) = C * N
skinnedMesh.matrixWorld(t) = Rt * C * N
leaderBoneActualBindWorld[i] = R0 * leaderBindWorld[i]
leaderBoneInverse[i] = inverse(leaderBoneActualBindWorld[i])
meshBindMatrixSnapshot = skinnedMesh.matrixWorld at bind = R0 * C * N
meshBindMatrixInverseCurrent(t) = inverse(Rt * C * N) in AttachedBindMode
```

构建顺序固定：先设置 `R0` 并更新 characterRoot world；再设置所有 leader bone bind local TRS并更新骨层级；用当时的实际 bone `matrixWorld` 计算唯一 shared Skeleton 的 inverses；再给 mesh 设置 local `C*N`、更新 world，并以显式`meshBindMatrixSnapshot=R0*C*N`调用`SkinnedMesh.bind(sharedSkeleton,meshBindMatrixSnapshot)`，明确设置`bindMode=THREE.AttachedBindMode`。Three的`bindMatrix`是每mesh的immutable bind snapshot；Attached只在每次`updateMatrixWorld`把该mesh的`bindMatrixInverse`更新为当前`inverse(Rt*C*N)`，两者不是同一个字段，不能因前者显式就误改Detached。角色root后续移动时mesh与bones同属该root一起移动，不能重算/累乘C；调用CPU oracle或render前必须先更新root、bones和mesh world matrices。

Detached是明确negative fixture，不是备选：令`R0=I`、bind pose无动画、之后`Rt=T(1,0,0)`，Attached的world vertex只平移1次；Detached固定使用`inverse(R0*C*N)`，shader外又乘当前`Rt*C*N`，会得到`T^2`、平移2次。测试还要用非交换root rotation/scale证明不是只对translation的偶然现象。共享一个Skeleton不改变结论，因为bone matrices共享，而`bindMatrix/bindMatrixInverse`是每个SkinnedMesh自己的字段。

非交换 fixture 固定为（角度 degrees，TRS 均为 `T*R* S`，Euler这里只用于构造测试矩阵）：

```text
R = T(3,-2,5) * Ry(30)  * S(2,0.5,1.5)
C = T(0.25,0.5,-0.75) * Rx(45) * S(1,1.25,0.8)
N = T(-0.5,0.25,1) * Rz(-30) * S(0.75,1.5,0.6)

expected R*C*N row-major =
[ 0.876407772239,  2.160186843374,  0.254558441227,  2.594479518660 ]
[-0.165728151841,  0.574099158465, -0.169705627485, -1.922357277914 ]
[-1.080093421687,  0.741553366565,  0.440908153701,  5.297617922810 ]
[ 0,                 0,                 0,                 1                ]
```

double-precision oracle容差`1e-12`；同时断言 `maxAbs(R*C*N - R*N*C) > 0.8`，确保错误顺序不会碰巧通过。CPU bind-pose oracle必须在这组非 identity R/C/N上仍回到 object-local raw vertex，并验证GPU world结果等于`R*C*N*raw`；不能只测三者identity。

输出 bundle 只含一份 leader bones、leader bind/inverse 和许多已经 remap 的 meshes。renderer 禁止为 part 再创建 Skeleton，也禁止每帧调用 part-to-leader mapping。

复杂度：骨架验证 `O(B)`，name index `O(B)`，influence 扫描/重写 `O(K)`；不得对每个 influence 线性搜索 B（那是 `O(K*B)`）。

#### 24.16.4 第五处改动点：实时预览路径上的第四种约定

§24.16.1 给了四处改动点。实测发现**第五处**，而且它是**第四种**互不相同的约定，位置在实时动作预览的渲染路径上：

- 实现：`packages/shared/src/action-continuous-sampler.ts:528 eulerXYZToQuaternion`，实为 `qx⊗qy⊗qz`。源码注释 `Intrinsic XYZ Euler rotation: q = qx * qy * qz` 是诚实的，约定本身错。
- 调用点：`apps/desktop/src/renderer/src/editors/TaeWorkbenchPanel.tsx:1065`，喂进去的是 Bridge 返回的**真实 FLVER 骨骼数据**，上一行 `:1060` 的注释写着 `采样 FLVER 骨骼位姿`。
- `:1066` 同时把 `scale` 硬编码为 `[1,1,1]`，丢弃 bind scale。

沿用 §24.16.1 的输入 `[0.5,-0.3,1.2]` 与判别向量 `v0=(0.3,0.7,-0.2)`。下表前三行是 §24.16.1 的冻结值，我已用独立脚本复现（q maxdiff ≤ 9.564e-8，v maxdiff ≤ 1.230e-7），故第四行可直接与之对照：

| 排列 | v0 旋转结果 | 与权威 Δv | 位置 |
| --- | --- | --- | --- |
| 权威 `qy⊗qz⊗qx` | `(-0.5758187, 0.5369556, -0.0105562)` | — | **仓库内不存在任何实现** |
| `qx⊗qz⊗qy` | `(-0.5271585, 0.5544641, +0.1862082)` | 1.968e-1 | `flverSkeletonMapping.ts:132` |
| `qy⊗qx⊗qz` | `(-0.5431195, 0.5638667, -0.0841167)` | 7.356e-2 | `BridgeCommandService.cs:1235` |
| `qx⊗qy⊗qz` | `(-0.4603315, 0.6366183, -0.0530280)` | **1.155e-1** | `action-continuous-sampler.ts:528` ← 本节 |

四者两两互异，最小间距 `Δv = 7.356e-2`，所以这不是同一约定的重复记账，是第四种。

**不要用「import 一个正确实现」来修这一处。** 权威 `qy⊗qz⊗qx` 在仓库内没有任何实现，而 `flverSkeletonMapping.ts:127 flverEulerXzyToQuaternion` 本身也是错的（上表第二行）。照它替换只是把第四种错误换成第二种错误，且因为 `flverSkeletonMapping.test.ts:37` 会变绿，你会以为修好了。修 `:528` 必须按权威乘序**新写**，或等 §24.16.1 第 1 点把 `flverSkeletonMapping.ts:132` 改对之后再从那里引入。

`action-continuous-sampler.ts:548` 的 `export const flverEulerToQuaternion = eulerXYZToQuaternion;` 是零调用方别名，名字写着 FLVER 而实现是 `qx⊗qy⊗qz`。**不要照名字取用**，应连同 `:528` 一并处理。

**失明契约（算法契约，改任何 Euler→四元数代码前必须先读）**

「为什么这么多轮都没人发现四种约定并存」有确定答案。四条实测事实，每条都说明一类断言为什么结构性地抓不到排列顺序：

| # | 实测事实 | 测量值 | 使哪类断言失明 |
| --- | --- | --- | --- |
| 1 | 六种排列**全部**是单位四元数 | 极差 `1.110e-16` | 任何只查模长/归一化的断言 |
| 2 | 每个分量在六种排列下**只取 2 个值**（`t1+t2` 与 `t1−t2`），每个值恰由 3 种排列共享 | 见下 | 任何只查部分分量的断言，留 3 种排列不可区分 |
| 3 | 单轴输入下六种排列**完全重合** | maxdiff 精确 `0.000e+0`（x/y/z 三轴各测）；双轴 `7.394e-2`；三轴 `2.763e-1` | 任何 fixture 含零角的断言 |
| 4 | v0 判据下非权威排列最小间距 | `Δv = 7.356e-2` | —（这条给出可用容差） |

事实 2 的实测分量表，输入 `[0.5,-0.3,1.2]`：

| 排列 | x | y | z | w |
| --- | --- | --- | --- | --- |
| xyz | 0.1201425 | −0.2576285 | 0.5104319 | 0.8115741 |
| xzy | 0.2836544 | −0.2576285 | 0.5104319 | 0.7698227 |
| yxz | 0.1201425 | −0.2576285 | 0.5714599 | 0.7698227 |
| yzx | 0.1201425 | 0.0186238 | 0.5714599 | 0.8115741 |
| zxy | 0.2836544 | 0.0186238 | 0.5104319 | 0.8115741 |
| zyx | 0.2836544 | 0.0186238 | 0.5714599 | 0.7698227 |

每列只有 2 个不同值。所以「某分量等于某期望值」这种断言，一次能被 3 种排列同时满足。§24.16.2 已单独记录 `:50` 用例「唯一判别位是分量 `[1]` 的符号」，那是本事实在另一个靶标上的同一后果。

被上述事实证实为失明的既有断言：

- `packages/core/src/testing/runAnimationPlaybackClockSmoke.ts:121-131`：三个用例分别喂 `[π/2,0,0]`、`[0,π/2,0]`、`[0,0,π/2]`，全是单轴 → 触发事实 3，六种排列 maxdiff 精确为 0，**换成任何错误排列都不会红**。
- 同文件 `:134-136`：`[0.5,-0.3,1.2]` 是三轴输入，本来有判别力，但断言只查 `Math.abs(qCompLen - 1.0) < 1e-4`，即只查模长 → 触发事实 1，六种排列全过。
- `flverSkeletonMapping.test.ts:37-48`：三轴输入 + 全四分量 + `1e-12` 容差，**确实有判别力**。它不是失明，而是按 §24.16.2 所述钉死了错的约定，改对实现会让它变红。两类问题必须分开处理。

**写一条真能判别排列顺序的断言，三个条件缺一不可**：三个输入角全非零；比较全四个分量，或改比向量旋转结果；容差 `1e-4` 即可（事实 4 给出 `7.356e-2` 的安全边界，比 `1e-4` 大约 600 倍，**不需要调松容差**）。

推荐用向量判据而非四元数逐位比较，理由见 §24.16.1：`q` 与 `−q` 是同一旋转，逐位比会给假红。取非对称向量（如 `v0=(0.3,0.7,-0.2)`，勿用 `(1,0,0)` 这类单轴向量）过旋转后比较结果。


**影响范围必须写窄：只波及未被动画到的骨**

我最初判断这处错误约定污染整个实时预览姿势。**实测否证，范围更窄。** `action-continuous-sampler.ts:158-191` 的 `sampleFlverPose`：

- `:174-178` 先把 `flverReferencePose` 逐骨拷进 `result`
- `:185` `result[flverBone] = hkxPose[hkxBone]!;` —— **整体替换，不是 delta**

凡 `hkxToFlverBoneMap` 覆盖到的骨，参考姿势立刻被原始 HKX 变换覆写。所以 `flverReferencePose` 的真实语义是**未动画骨的填充值**，不是重定向基准。`:1065` 的错误约定与 `:1066` 的 `scale:[1,1,1]` 都只在该 clip 未动画到的骨上存活。仍是真缺陷（未动画骨朝向错误、丢弃 bind scale），但不要写成「整条预览姿势全错」——那会让接手者在动画正常的骨上白找一轮。

**与之相对，正确的 delta 重定向在仓库里存在但零调用方**：`flverSkeletonMapping.ts:164-168` 算 `bind * (ref⁻¹ * animated)`，`:174` 用 `bind.scale[axis]! * ratio` 保留 per-bone bind scale。整个 `retargetHkxPoseToFlver` 只有自身 `.test.ts` 引用，生产路径一次都不调。同文件 `mapFollowerSkeleton`、以及 `packages/core/src/character/characterAssembly.ts:36 remapCharacterBundleToLeader`、`:228 isLeaderRemappedBundle` 同为零生产调用方（后两者连测试都没有）。

对照组证明这不是 grep 方法的产物：`mapModelLoadScheduler` 有 `MsbScenePanel.tsx` 真实调用，`RemapPoseToFlver` 有 `BridgeCommandService.cs:1279` 真实调用，同一条 grep 都能找到。

**复现步骤**（不依赖真实语料）：

1. 记下 `action-continuous-sampler.ts:528` 对 `[0.5,-0.3,1.2]` 的输出，与本节表格第四行核对，确认它是 `qx⊗qy⊗qz`。
2. 把 `runAnimationPlaybackClockSmoke.ts:121-131` 任一单轴输入改成三轴非零（如 `[0.5,-0.3,1.2]`），断言由查模长改为查全四分量。
3. 复跑。**修改前**：把 `:528` 换成任意其他排列，测试仍绿（证明判据失明）。**修改后**：同样扰动会红（证明判据活了）。两个相位都要跑，只跑一个不算证完——理由见 §24.16.2 的扰动矩阵。

**本节未测，接手者不要当已知**：

- 真实 Sekiro HKX↔FLVER 骨名匹配率：未测。故「未动画骨」在真实语料里占多大比例未知，缺陷的视觉严重度未定。
- `preview.bones` 为空的现场频率：未测。
- 真实 Sekiro 骨架是否含重名骨：未测。这决定 `BuildUniqueNameIndex:201-205`（抛 `InvalidDataException`）与 TS `mapFollowerSkeleton`（静默降级为 `-1`，见 `flverSkeletonMapping.test.ts:30-34`）两条相反策略哪条会被触发。
- 权威 `qy⊗qz⊗qx` 的 SoulsFormats 出处：本节直接采用 §24.16.1 的三方核对结论，我只复现了其数值，**未独立验证其对 SoulsFormats 源码的引用**。

#### 24.16.5 第六处改动点：`sampleFlverPose` 的三种结局，以及「补 null 判断」为什么修不掉它

`packages/shared/src/action-continuous-sampler.ts:158-190` 的 `sampleFlverPose` 有三种结局，其中**只有一种是缺陷**。接手者最容易犯的错是看到 `:181` 的 `if (map)` 没有 `else` 就去补 null 判断——那修的是不存在的问题。先看源码：

```ts
// :164-165
const hkxPose = this.sampleHkxPose(timeSeconds, loop);
const map = this.clip.hkxToFlverBoneMap;
// :167-169  refPose 长度不符就抛
if (!flverReferencePose || flverReferencePose.length !== flverBoneCount)
  throw new Error(`ACTION_FLVER_REFERENCE_POSE_REQUIRED: bones=${flverBoneCount}`);
// :171-179  先把 refPose 逐条抄进 result
for (let i = 0; i < flverBoneCount; i++) { result[i] = { ...refPose[i] 的三个字段... }; }
// :181-189  再用 map 覆盖
if (map) {                                   // ← 没有 else
  for (let hkxBone = 0; hkxBone < map.length && hkxBone < hkxPose.length; hkxBone++) {
    const flverBone = map[hkxBone];                                    // :183
    if (flverBone !== undefined && flverBone >= 0 && flverBone < flverBoneCount)
      result[flverBone] = hkxPose[hkxBone]!;                           // :185  整条替换
  }
}
return result;                                                         // :190
```

**三种结局（renderer 侧调用点是 `TaeWorkbenchPanel.tsx:1068`，实测已定型）**

| # | 触发条件 | 实际结局 | 是缺陷吗 |
|---|---|---|---|
| A | `preview.bones` 空且 `preview.boneCount === 0` | `TaeWorkbenchPanel.tsx:1062` 提前 `return undefined`，**根本不进 `sampleFlverPose`** | 不是。是「没预览」，非「静止」 |
| A' | `preview.bones` 空但 `preview.boneCount > 0` | refPose 长度 0 ≠ boneCount ⇒ `:167` 抛 ⇒ 被 boundary 接住 ⇒ 面板降级为错误态 | 不是静默。**且当前生产路径不可达，见下** |
| B | `bones` 非空、长度等于 `boneCount`，但**骨名一条都匹配不上** | C# 返回**全 `-1`** 的 map ⇒ `:181` 为真 ⇒ 循环照跑 ⇒ 每次 `flverBone >= 0` 为假 ⇒ **零次写入** ⇒ 逐字返回参考姿势 | **是。这是唯一的静默静止** |

**为什么 A' 当前不可达（实测）**：wire 上 `boneCount` 与 `bones` 是两个独立字段（renderer `TaeWorkbenchPanel.tsx:744` 取 `first.data.boneCount`，`:745` 取 `first.data.bones`），C# 侧也是两个独立构造器参数（`FlverNativeDocument.cs:162 BoneCount = boneCount;` 与 `:177 Bones = bones;`）。**类型上允许分歧**。但唯一的生产装配路径是 `FlverNativeDocument.cs:1034-1035`：

```csharp
var bones = new List<FlverBoneEntry>(boneCount);
for (var i = 0; i < boneCount; i++, off += BoneSize)   // ← 循环次数就是 boneCount
```

而 wire 的 `bones` 由 `BridgeCommandService.cs:2406 BuildFlverSkeleton` 产出，其结尾是 `flver.Bones.Select(...)`（长度恒为 `Bones.Count`）。故 `bones.length === boneCount` 在当前唯一路径下必然成立，A' 不可达。

**这不等于可以不管 A'。** 三处结构性缺口让它随时会变成可达：

1. 构造器两个独立参数，任何新增装配点（测试、合成 fixture、未来的 mapbnd 路径）都能传不一致的值，编译器不会拦。
2. wire 上两个独立字段，Bridge 与 renderer 之间没有一致性断言。
3. renderer `TaeWorkbenchPanel.tsx:759-766` 会在 `bones.length === 0` 时**用 mesh index > 0 的 bones 覆盖**，而 `boneCount` 固定停在 mesh 0 的 `first.data.boneCount`——这是仓库里已经写好的、唯一有意让两者不同源的代码。它当前不触发是因为同一份 FLVER 的每个 mesh 共享同一份骨架，**不是因为有断言拦着**。

所以 A' 的处置是：**加一条 `bones.length === boneCount` 的断言，别去改 `:167` 的抛错**。抛错本身是对的。

**为什么「补 null 判断」修不掉 B（这是本节最重要的一句）**：全 `-1` 的 map 是**非 null、非空、长度正确**的数组。`ActionAnimationSemantics.cs:149-164` 的 `BuildHkxToFlverBoneMap` 在零匹配时返回 `new int[hkxBoneNames.Count]` 且每格写 `-1`：

```csharp
map[hkxBone] = flverByName.TryGetValue(...) ? flverBone : -1;
```

于是 `:181` 的 `if (map)` 为真、`:433` 的长度校验（`clip.hkxToFlverBoneMap.length !== clip.hkxBoneCount` 才抛 `ACTION_CLIP_FLVER_MAPPING_MISMATCH`）也通过——**它只验长度，不验内容**。任何形态的 null/undefined 检查都拦不住它。修它必须在「匹配数」这一层：要么 `BuildHkxToFlverBoneMap` 在匹配数为 0（或低于阈值）时返回诊断，要么 `:433` 增加内容校验。

**X2：`flverReferencePose` 是填充物，不是 retarget 基准。** `:185` 是**整条替换**（`result[flverBone] = hkxPose[hkxBone]`），不是增量。对比 `apps/desktop/src/renderer/src/scene/flverSkeletonMapping.ts:164-168` 做的是 `bind * (ref⁻¹ * animated)`——保留了 FLVER bind 变换。`:185` 把它整条丢掉。两处对「参考姿势」的语义理解不同，这是 §24.16 那一串「第 N 种约定」的又一例。接手者若按 `flverSkeletonMapping.ts` 的心智模型读 `sampleFlverPose`，会得出错误结论。

**X4：零可观测性，而且是规格级的。** 在 `ActionAnimationSemantics.cs` 里搜 `matched|matchCount|unmatched|nomatch|diagnostic|warn`，**唯一命中是 `:146` 的一行注释**：

```
/// ... Unmatched HKX bones remain -1 because
```

紧随其后还有一句 `/// Bones with no HKX name match retain the FLVER bind/reference local transform supplied by the caller.` —— 也就是说，全 `-1` 静默降级**是被文档明确背书的设计意图**，不是漏写。这决定了 B 的修法不是「补个日志」而是**要先推翻这条规格**，属于需要用户决策的范围，接手者不要自行改掉注释了事。

**那条绿测试比它看起来弱得多（务必自己读一遍）**：`packages/core/src/action/taeAnimationBridge.test.ts:92-133`，名字叫「`sampleFlverPose` 正确执行骨骼映射并在缺失时回退 reference pose」。它传的 map 是 `hkxToFlverBoneMap: [1, 0]`——**全匹配、零个 `-1`**。三条断言分别覆盖「映射到的动画骨」「映射到的参考骨」「map 之外的 FLVER 骨 2」。**A、A'、B 三种结局它一种都没覆盖。** 名字里的「缺失时回退」指的是「FLVER 骨号超出 map 长度」，不是「map 缺失」，也不是「map 全 `-1`」。这条测试是绿的，不能作为 B 已被覆盖的证据。它和 §24.16 里 `validateQuatCurve:456` 那条 t=0.5 空转断言同类。

**本节未测，接手者不要当已知**：

- 真实 Sekiro 语料里 HKX↔FLVER 骨名匹配率：未测。故 B 的现场发生率未知。
- `preview.bones` 为空的现场频率：未测。故 A 的现场发生率未知。
- 全 `-1` map 在真实语料里是否真的出现过：未测。B 的机制链已逐行走通，但**没有在真实 chrbnd 上复现过一次**。
- 另一条采样路径 `BridgeCommandService.cs:1279` 附近（X6）是否共享同一张坏表：本节未展开，见后续切片。

### 24.17 F-3：CPU bind-pose skin oracle 与 GPU bundle 算法

### 24.17 F-3：CPU bind-pose skin oracle 与 GPU bundle 算法

CPU oracle 必须与 Three skinning方程同空间。这里的`poseWorldActual[i]`是Three bone在当前frame的实际`matrixWorld = Rt * leaderPoseWorld[i]`，不是去掉character root后的leader-local world；`leaderBoneInverse[i]`是bind snapshot的`inverse(R0 * leaderBindWorld[i])`。对一个 raw vertex `v=[x,y,z,1]`：

```text
skinMatrix(i, pose) = poseWorldActual[i] * leaderBoneInverse[i]

weightedSum = zero 4-vector
for each positive influence (i,w):
  weightedSum += w * skinMatrix(i,pose) * meshBindMatrixSnapshot * v

objectLocalOutput = meshBindMatrixInverseCurrent(t) * weightedSum
worldOutput = (Rt*C*N) * objectLocalOutput
```

static mesh直接输出raw；rigid mesh等价于一个权重1的influence。法线必须精确匹配当前Three shader，而不是写一句含混的“inverse-transpose skinning”：

```text
K = meshBindMatrixInverseCurrent(t)
    * sum(w_i * poseWorldActual[i] * leaderBoneInverse[i])
    * meshBindMatrixSnapshot
objectLocalNormal = mat3(K) * rawNormal          # shader等价vec4(normal,0)，无translation
viewNormal = normalMatrix(modelViewMatrix) * objectLocalNormal
normalize viewNormal
```

Three只对后续`modelViewMatrix`使用inverse-transpose normalMatrix；不会对skinning矩阵`K`求inverse-transpose。CPU/GPU oracle必须匹配这条production shader路径；若要换成物理上不同的custom normal skin算法，必须另开shader/schema/视觉oracle，不能只改CPU expected。

bind pose断言：`Rt=R0`且`poseWorldActual = R0 * leaderBindWorld`时，每个object-local输出vertex应回到raw vertex；随后乘`R0*C*N`得到期望world vertex。root-move断言：保持bind pose但令`Rt!=R0`，更新Attached inverse后object-local仍回到raw，world精确为`Rt*C*N*raw`。若CPU oracle传入未乘Rt的leader pose、把bone inverse按Rt重算、或固定旧mesh inverse，fixture必须失败，禁止用identity R掩盖。最大欧氏误差：

```text
max(1e-5, modelAabbDiagonal * 1e-5)
```

出现大量点聚到原点时，先输出首个失败 vertex 的 raw、indices、weights、part bone name、leader index、part/leader bind matrices、mesh bind matrices；不要调全局 scale/rotation。

renderer bundle 构建：

```text
create leader Bone Object3D hierarchy once
apply leader FLVER bind local TRS through the locked T*Ry*Rz*Rx*S adapter；禁止Three Euler("XZY")捷径
create one THREE.Skeleton(leaderBones, leaderBoneInverses)
for each body mesh:
  create geometry from strict worker-decoded buffers
  create FaceSet groups/material-side variants from preserved CullBackfaces；禁止mesh级默认覆盖
  set skinIndex/skinWeight attributes already in leader-global space
  create SkinnedMesh
  skinnedMesh.bind(sharedSkeleton, mesh.bindMatrix)
  add under character root without creating another skeleton
```

所有 SkinnedMesh 必须引用同一 `Skeleton` object 或同一明确的 bone texture owner；不能只是 `skeletonId` 字符串相同但实际各 new 一份。

GPU validation 不依赖黄色 skeleton helper。固定材质 validation pass 输出 object mask + linear depth，和独立 CPU skin geometry 在相同固定相机下比较 IoU/depth；再保存正常材质图供人工定位。mask 通过前还要断言 meshes/vertices/bodyParts 数与 context/oracle一致，防止一个替代 quad骗 coverage。

### 24.18 F-4：显式动画容器、一次 retarget 和每帧更新算法

#### 24.18.1 AnimationPlaybackContext 的 production producer

输入不是两个凭空出现的 URI，而是 workbench 的真实选择：

```ts
interface AnimationPlaybackSelectionV1 {
  workspacePersistentIdentityHash: string;
  workspaceSessionId: string;
  workspaceSessionGeneration: number;
  characterContextIdentity: string;
  actionSelectionEventId: string;          // main-owned TAE/action selection
  actionSelectionNonce: string;
  explicitSkeletonSelectionEventId?: string;
  explicitSkeletonSelectionNonce?: string;
  expectedLeaderCoordinateSpaceId: string;
  expectedLeaderUnitScale: number;
  allowedConversionRegistrySha256: string;
}
```

main 的 action selection record 必须绑定：当前 anibnd source URI、内部 TAE/animation物理 identity、typed numeric animationId、窗口、persistent workspace、workspace session及`workspaceSessionGeneration`。`animationId` 不从 `a000_000010` 显示字符串用正则临时截取。

skeleton URI 解析只允许两条 production 路径：

```text
1. active resource graph 中恰有一条 typed animation-skeleton edge；或
2. 用户在 workbench 显式选择 skeleton container，consume main-owned SelectionRecord。
```

Sekiro graph edge由版本化规则构建，而不是 Bridge扫描邻居：

```ts
interface AnimationContainerRuleV1 {
  game: "sekiro";
  sourcePattern: "^(c[0-9]{4})(?:_a[0-9]{3}_(?:lo|hi))?\\.anibnd\\.dcx$";
  skeletonTemplate: "{character}.anibnd.dcx";
  evidenceHash: string;
}

interface AnimationSkeletonEdgeV1 {
  schema:"animation-skeleton-edge-v1";
  edgeId:string;                         // canonical payload SHA-256，不自包含
  relation:"animation-skeleton";
  from:{
    logicalUri:string;
    sourceContentSha256:string;
    pathSourceGeneration:number;
    containerEntryIdentitySha256:string;
    overlayResolutionGeneration:number;
  };
  to:{
    logicalUri:string;
    sourceContentSha256:string;
    pathSourceGeneration:number;
    containerEntryIdentitySha256:string;
    overlayResolutionGeneration:number;
  };
  resolverRuleSha256:string;
}
```

索引器只对已经索引的 logical URI basename应用经 Andre/DSAnimStudio多样本验证的规则，得到 target logical identity；再通过resource graph exact join解析overlay/base。它不调用`exists`逐目录试文件，不选“第一个相似名称”。0个target返回`ACTION_SKELETON_CONTEXT_REQUIRED`；多个返回`ACTION_SKELETON_CONTEXT_AMBIGUOUS`。edge必须直接使用`AnimationSkeletonEdgeV1`，其`edgeId`为去掉自身字段后按24.11 canonical bytes的SHA-256；from/to任一source/path/entry/overlay generation变化都重建edge并使旧provenance失效。禁止另传一组散装`edgeId/fromUri/toUri`让consumer自行猜缺失字段。

producer：

```text
resolveAnimationPlayback(selection):
  reserve action event+nonce and optional skeleton event+nonce in one transaction;
    verify window/persistent workspace/workspaceSessionGeneration/TTL
  require reserved record conforms to ActionSelectionRecordV1
  animationContainerUri = record.selectedResourceUri
  animationId = record.typedAnimationId
  physicalBindingIdentity = record.actionBindingIdentitySha256
  require resource URI still has same indexed source identity

  if explicitSkeletonSelectionEventId present:
      use the already-reserved skeleton record; skeleton provenance=explicit selection
  else:
      edges = graph exact outgoing(animationContainerUri,"animation-skeleton")
      require exactly one; skeleton provenance=edgeId/ruleHash

  require animation/skeleton source hashes、pathSourceGenerations和overlayResolutionGeneration均current
  resolve exact native layout -> exactly one A2 conversion rule; 0/multiple rules fail
  require rule output coordinate/unit exactly match selected character leader DTO
  build AnimationPlaybackContext with both URIs, typed id, physical binding, provenances,
    expected coordinate/unit and conversion rule identity
  commit all reserved records atomically; only then publish context
  any failure/cancel -> rollback reservation in finally; no record stays half-consumed
```

真实 UI 集成测试依次选择 `c0000_a000_lo.anibnd.dcx` 中的 typed action id 10，验证 graph edge自动解析到 `c0000.anibnd.dcx`；再删除edge，验证 UI要求显式 skeleton选择而不是猜目录；过期/跨窗口 selection event均拒绝。production源码不得出现这两个字面 URI，fixture/manifest expected value可以出现。

打开动作：

```text
request = {
  CharacterAssemblyContext identity,
  AnimationPlaybackContext {
    workspacePersistentIdentityHash,
    workspaceSessionId,
    workspaceSessionGeneration,
    animationContainerUri,
    animationSourceContentSha256,
    animationPathSourceGeneration,
    animationOverlayResolutionGeneration,
    animationEntryIdentitySha256,
    skeletonContainerUri,
    skeletonSourceContentSha256,
    skeletonPathSourceGeneration,
    skeletonOverlayResolutionGeneration,
    skeletonEntryIdentitySha256,
    typedAnimationId,
    actionPhysicalBindingIdentitySha256,
    both provenances,
    source/output coordinate ids,
    conversionRuleVersion/Sha256,
    unitScaleFloat64BitsHex
  }
}
```

main 对两个 URI 分别从 active resource graph解析；必须已索引、source hash/pathSourceGeneration/overlayResolutionGeneration匹配、provenance可消费。Bridge 只接收 main 验证后的真实路径/entry identity和 allowedRoots，不拼目录、不试邻近文件。

Bridge open：

```text
animation container session = get/open by content identity
skeleton container session  = same cache, may be same or different container
locate exact animation id/binding; duplicate/missing => diagnostic
resolve binding original skeleton name against skeleton container:
  0 match -> ACTION_HKX_SKELETON_MISSING
  >1 match -> ACTION_HKX_SKELETON_AMBIGUOUS
convert native reference pose and every animated local TRS to leader-compatible basis as specified below
return immutable clip/tracks/reference pose + identities + coordinate conversion identity
```

Bridge 返回的 clip DTO 必须携带且下游严格核对：

```ts
interface AnimationClipSemanticPayloadV2 {
  workspacePersistentIdentityHash: string;
  animationContainerUri: string;
  animationSourceContentSha256: string;
  animationPathSourceGeneration: number;
  animationOverlayResolutionGeneration: number;
  animationEntryIdentitySha256: string;
  skeletonContainerUri: string;
  skeletonSourceContentSha256: string;
  skeletonPathSourceGeneration: number;
  skeletonOverlayResolutionGeneration: number;
  skeletonEntryIdentitySha256: string;
  actionPhysicalBindingIdentitySha256: string;
  typedAnimationId: number;
  sourceCoordinateSpaceId: string;
  coordinateSpaceId: string;        // 必须精确等于 leader skeleton DTO.coordinateSpaceId
  unitScale: number;                // 已经应用过的 source->leader unit scalar，仅作审计，不可再次乘
  unitScaleFloat64BitsHex: string;
  conversionRuleVersion: string;
  conversionRuleSha256: string;     // 规则 canonical JSON/content hash
  referenceLocalTrs: LocalTrs[];
  tracks: AnimationTrack[];
}

interface AnimationClipSemanticEnvelopeV2 {
  schema: "animation-clip-semantic-envelope-v2";
  payload: AnimationClipSemanticPayloadV2;
  payloadSha256: string;            // canonical payload，不自包含
}

interface DecodedClipCacheKeyV2 {
  schema: "decoded-clip-cache-key-v2";
  workspacePersistentIdentityHash: string;
  animationContainerUri: string;
  animationSourceContentSha256: string;
  animationPathSourceGeneration: number;
  animationOverlayResolutionGeneration: number;
  animationEntryIdentitySha256: string;
  skeletonContainerUri: string;
  skeletonSourceContentSha256: string;
  skeletonPathSourceGeneration: number;
  skeletonOverlayResolutionGeneration: number;
  skeletonEntryIdentitySha256: string;
  actionPhysicalBindingIdentitySha256: string;
  typedAnimationId: number;
  conversionRuleVersion: string;
  conversionRuleSha256: string;
  sourceCoordinateSpaceId: string;
  outputCoordinateSpaceId: string;
  unitScaleFloat64BitsHex: string;
}
```

坐标转换的唯一生产位置是 C# Bridge 的 native HKX projection：它发生在 HKX 解码得到 source local TRS之后、DTO serialization和任何 retarget delta之前。版本化 conversion rule按 `game + native format/layout identity`选择，不按`c0000`或动作ID选择，并提供4x4 homogeneous basis矩阵`H`、`unitScale`、输出`coordinateSpace`和rule hash。对 reference pose及每个track key/sample执行同一个算法：

```text
sourceLocal = T(source.translation) * R(source.quaternion) * S(source.scale)
leaderLocalMatrix = H * sourceLocal * inverse(H)
decompose leaderLocalMatrix -> leader translation/quaternion/scale
normalize quaternion; require all components finite
recompose and require maxAbs(recomposed-leaderLocalMatrix) <= 1e-6
emit converted local TRS
```

`H`不是任意4x4。conversion rule loader必须证明它精确表示source→leader的无平移、uniform-scale signed axis basis：

```text
s = unitScale; require finite and s>0
B = frozen source-axis -> leader-axis 3x3 basis
require B is a signed permutation: entries in {-1,0,+1}, each row/column exactly one nonzero
require transpose(B)*B=I and determinant(B) in {-1,+1}
H = [ s*B  0 ]
    [  0    1 ]
require H translation column is zero and homogeneous last row exactly [0,0,0,1]
require inverse(H) is computed once from this validated matrix
```

这里的方向不可颠倒：对source point `[1,0,0,1]`，`H*p`必须等于冻结artifact中的leader point；把leader→source矩阵塞入同字段固定失败。native HKX若由System.Numerics行向量矩阵进入Bridge，只允许在native adapter边界**转置一次**成本文column-vector；payload、共轭、decompose、retarget和renderer随后全部保持column-vector，任何第二次转置是negative fixture。`H * sourceLocal * inverse(H)`会令translation变为`s*B*t`，而rotation/scale basis只由`B`共轭（uniform s抵消）；downstream不得再交换轴、改符号或乘scale。若decompose出现超容差shear/奇异矩阵，返回`ACTION_COORDINATE_CONVERSION_INVALID`，不能丢scale。Bridge构造payload时先验证`unitScale`与H中的`s`逐bit一致，再按IEEE-754 float64 big-endian取8-byte hex；`unitScaleFloat64BitsHex`解码必须逐bit等于同payload numeric `unitScale`，禁止三份值各自填写。core建立retarget plan前要求clip与leader的`coordinateSpaceId`完全相同、该bit identity与context一致、rule version/hash属于A2 registry允许集合；不匹配固定`ACTION_COORDINATE_SPACE_MISMATCH`。

转换测试至少含一次非零translation、非交换rotation、非均匀scale以及带反射/非反射basis的规则边界；expected matrices由Andre或成熟工具导出的 sampled local matrices独立产生，不能调用被测 converter生成。真实 c0000 trace必须显示 conversion发生在Bridge且每个clip只做一次；core/renderer转换计数固定为0。

HKX 到 leader plan 只建一次：对动画真正有 track/角色正权重需要的骨骼按 exact name建立映射，缺失/重复产生明确诊断；允许 leader 的辅助骨骼没有 HKX track，它们保持 FLVER bind local pose。不得为每个 body part各建 plan。

旋转约定固定为右手系、quaternion tuple `[x,y,z,w]`；column vector由`q * v * inverse(q)`旋转。乘法`a*b`表示先作用b、再作用a；local matrix=`T*R*S`，world=`parentWorld*local`。HKX/FLVER坐标转换必须已由上面的 Bridge producer完成并由 DTO identity证明；不能在delta里临时换轴。

非交换数值fixture必须精确通过（容差`1e-12`）：

```text
s = sqrt(1/2)
leaderBind = [s,0,0,s]       # X +90 deg
hkxRef     = [0,s,0,s]       # Y +90 deg
hkxAnim    = [0,0,s,s]       # Z +90 deg
delta      = inverse(hkxRef) * hkxAnim
           = [-0.5,-0.5,0.5,0.5]
output     = leaderBind * delta
           = [0,-0.7071067811865476,0,0.7071067811865476]
```

测试若得到共轭、相反角或交换后的结果，说明乘法约定错，不能改expected。真实oracle还必须由Andre/成熟工具导出的独立HKX sampled local/world bone matrices生成，禁止调用被测retarget函数再比较自身输出。

每帧算法：

```text
t = playback clock mapped by loop/clamp policy to [0,duration]
hkxAnimatedLocal = sample clip once at t

for leader bone in topological order:
  if mapped hkx bone exists:
      rotationDelta = inverse(hkxReference.rotation) * hkxAnimated.rotation
      leaderLocal.rotation = leaderBind.rotation * rotationDelta
      leaderLocal.translation = leaderBind.translation
                              + (hkxAnimated.translation - hkxReference.translation)
      leaderLocal.scale = leaderBind.scale
                        * safeComponentRatio(hkxAnimated.scale, hkxReference.scale)
  else:
      leaderLocal = leader bind local
  require finite quaternion/translation/scale

apply local TRS to the one leader Bone hierarchy
update skeleton/bone texture once
render; do not set React state with 467 matrices every frame
```

四元数每次 normalize；reference scale 分量接近 0 时 ratio 固定为 1并记录诊断计数，不产生 Infinity。矩阵/四元数乘法顺序由 synthetic 非交换旋转 + c0000 CPU oracle双重锁定。

缓存：每个唯一chrbnd/partsbnd/anibnd content hash+entry+`pathSourceGeneration`最多read/inflate/parse一次；`context identity -> assembled semantic bundle`、`DecodedClipCacheKeyV2 -> clip`、`clip+skeleton+leader -> retarget plan`分开有界缓存。`workspaceSessionGeneration`只绑定owner和阻止旧异步publish，不替代`pathSourceGeneration`，也不直接进入可跨重开的immutable content key。并发请求join exact in-flight；顺序重开命中READY；任一source/rule identity变化只失效相关entry。GPU owner/refcount按第24.12节释放，wire base64上传后释放。

三类F阶段cache的固定初始预算和owner：

| cache | key | owner | entry/byte budget | idle TTL |
|---|---|---|---|---|
| assembled semantic | context hash + all source hashes/path generations + assembly/remap rule hashes | character preview scene owner lease | 4 entries / 128 MiB | 120 s |
| decoded clip | `DecodedClipCacheKeyV2` canonical SHA | playback controller owner lease（含workspaceSessionGeneration） | 16 entries / 256 MiB | 120 s |
| retarget plan | decoded clip payload hash + HKX skeleton source/entry hash + leader skeleton/bind hash + conversionRuleSha256 + coordinateSpaceId + unitScale bits + remap rule version | playback controller owner lease | 64 entries / 8 MiB | 300 s |

预算计算包含entry实际持有的ArrayBuffer/native数组，不包含已经转移给GPU且cache不再持有的wire string。任一单entry超过byte budget时允许在active owner期间存在，但标记`oversizeNonRetainable`，owner释放后立即evict，不能为了warm数字永久保留。修改预算需20-run/峰值证据和用户裁定，接手者不能自行加大。

每个entry状态`OPENING|READY|FAILED|CLOSING|EVICTED`，保存完整canonical key/hash、owners Set、activeReaders、byteCost、lastUsed。owner lease分别保存`workspaceSessionId/workspaceSessionGeneration/webContentsId/playbackControllerId`，通用`generation`字段禁止存在。acquire同owner幂等；并发OPENING只在完整key相同才join；evict只选READY/FAILED且owners=0/activeReaders=0的LRU。FAILED entry固定为`{diagnostic:{code,resourceIdentities,detailHash,retryable},failedAt,retryAfter,attemptCount}`，不保留clip/wire/native bytes；`now<retryAfter`返回同diagnostic，之后一次显式retry创建新OPENING。`workspaceSessionGeneration`变化关闭对应owners并阻止旧结果publish；`pathSourceGeneration`已经进入key，变化必然miss并在reader归零后清旧entry。

cache key使用24.11的length-prefixed/binary-float canonical算法，禁止普通字符串插值float。`unitScale`先验证finite/positive，再按IEEE-754 float64 big-endian 8-byte hex进入key和payload。animation/skeleton URI、两份source hash/`pathSourceGeneration`/entry identity、physical action binding、typed id、source/output coordinate、rule version/hash任一变化都必须miss并重新convert，绝不能命中旧converted clip。READY hit后仍逐字段核对entry envelope、leader和PlaybackContext；不等即`ACTION_CLIP_CACHE_IDENTITY_MISMATCH`、隔离entry并按failure schema退避，而不是返回旧clip。

关闭顺序固定：停止RAF/playback采样 -> release retarget plan -> release clip -> detach SkinnedMesh/Skeleton -> release assembled bundle -> release GPU owners -> main关闭Bridge session。workspace dispose执行同一顺序并等待/取消opening。测试分别覆盖正常close、解析失败、并发close和workspace切换，断言open/acquire/release/evict计数守恒；不能只有`Map.clear()`。

复杂度：初装 `O(total vertices + K + B)`；每帧 `O(HKX tracks + leader B)` 一次，与 body part数量无乘法关系。

### 24.19 H-1：性能 schedule、计时、分位数与 baseline 算法

外部黑盒 harness 对 clean HEAD 和 final 使用完全相同的 scenario 输入。scenario 只描述用户可观察动作/标记，不调用 final 独有内部 API：

```ts
type PerformanceMetricKindV2 =
  | "first-visible-ms"|"complete-ms"|"selected-page-ms"|"handler-ms"
  | "cpu-frame-ms"|"gpu-frame-ms"|"long-task-ms"
  | "pick-ms"|"pointer-to-visual-ms"
  | "retained-wire-bytes"|"instrumentation-wall-ms"
  | "source-read-count"|"source-inflate-count"|"source-parse-count"|"source-hash-count"
  | "semantic-commit-count"|"visible-entity-count"|"background-processed-count";

type PerformanceCohortV2 =
  | "baseline"|"final"|"mature"
  | "final-background-active"|"final-background-idle"
  | "final-instrumentation-on"|"final-instrumentation-off";

interface ExternalMetricSpecV2 {
  metricSpecId:string;                    // plan内唯一、稳定ASCII id
  scenarioId:BlackBoxScenarioV1["id"];
  metricKind:PerformanceMetricKindV2;
  unit:"milliseconds"|"bytes"|"count";
  applicableCohorts:PerformanceCohortV2[];
  sampleCardinality:"one-per-run"|"event-series-per-run";
  extractorId:string;                     // A2 parent-owned闭集，不接受child任意代码/字符串
  observer:"playwright-dom"|"cdp-frame"|"webgl-timer-query"|"uia"|"etw-process"|"heap-snapshot"|"audited-counter";
  requiredArtifactRoles:string[];
  validityPredicateId:string;
}

type ThresholdComputationV2 =
  | {kind:"single-statistic";cohort:PerformanceCohortV2;metricSpecId:string;
      statistic:"nearest-rank-p50"|"nearest-rank-p95"|"global-max"|"global-min"}
  | {kind:"failure-rate";cohort:PerformanceCohortV2}
  | {kind:"relative-p95-ratio";metricSpecId:string;numerator:"final";denominator:"baseline"}
  | {kind:"mature-p95-ratio";metricSpecId:string;numerator:"final";denominator:"mature"}
  | {kind:"background-impact-ratio";metricSpecId:string;
      numerator:"final-background-active";denominator:"final-background-idle";subtractOne:true}
  | {kind:"instrumentation-overhead-ratio";metricSpecId:string;
      numerator:"final-instrumentation-on";denominator:"final-instrumentation-off";subtractOne:true}
  | {kind:"all-runs-exact";cohort:PerformanceCohortV2;metricSpecId:string}
  | {kind:"all-runs-metric-order";cohort:PerformanceCohortV2;
      earlierMetricSpecId:string;laterMetricSpecId:string};

interface PerformanceThresholdV2 {
  thresholdId:string;
  budgetClauseId:string;                   // 17.3闭集中的唯一条款；防止schema漏掉整行预算
  scenarioId:BlackBoxScenarioV1["id"];
  cacheState:"cold"|"warm"|"both";
  computation:ThresholdComputationV2;
  comparison:"<"|"<="|"=="|">="|">";
  numericLimit:number;
  requiredInModes:Array<"RELATIVE_AND_ABSOLUTE"|"ABSOLUTE_AND_MATURE">;
}

interface PerformanceComparisonModeDecisionV1 {
  scenarioId: BlackBoxScenarioV1["id"];
  cacheState: "cold"|"warm";
  mode: "RELATIVE_AND_ABSOLUTE"|"ABSOLUTE_AND_MATURE";
  baselineMarkerCapability: "FULL"|"MISSING_FIRST_VISIBLE"|"MISSING_COMPLETE"|"UNAUTOMATABLE";
  relativeComparable:boolean;             // parent probe派生；mode=RELATIVE时true，否则false
  capabilityProbeArtifactHashes: string[];
  baselineNoncomparabilityProofSha256: string|null;
}

interface PerformanceAcceptancePlanV2 {
  schema: "mission1-performance-acceptance-plan-v2";
  assertionRegistrySha256: string;
  stageInputRegistrySha256: string;
  budgetClauseRegistrySha256:string;
  externalMetrics:ExternalMetricSpecV2[];
  thresholds: PerformanceThresholdV2[];
  scenarios: BlackBoxScenarioV1[];
  comparisonModeDecisions: PerformanceComparisonModeDecisionV1[];
  corpusManifestSha256: string;
  adapterIdentities: Array<{adapterId:string;adapterSourceSha256:string;executableSha256:string;capabilityArtifactSha256:string}>;
  formatRuleRegistryHashes: Array<{registryId:string;sha256:string}>;
}

type BlackBoxActionV1 =
  | {kind:"launch-app";workspaceCorpusKey:string}
  | {kind:"invoke-accessible-control";accessibleId:string;expectedRole:string}
  | {kind:"select-indexed-logical-uri";logicalUri:string}
  | {kind:"select-param-table";paramType:string}
  | {kind:"select-action-binding";physicalBindingIdentitySha256:string}
  | {kind:"send-real-pointer-sequence";pointerArtifactSpecId:string};

type BlackBoxMarkerKindV1 =
  | "USER_ACTION_DISPATCHED"
  | "WORKSPACE_FILES_INTERACTIVE"|"WORKSPACE_EDITOR_READY"
  | "PARAM_COMPLETE_INDEX_INTERACTIVE"|"PARAM_SELECTED_PAGE_READY"
  | "MAP_FIRST_BROWSABLE_GEOMETRY"|"MAP_ALL_EXPECTED_RESOURCES_TERMINAL"
  | "CHARACTER_COMPLETE_BODY"|"CHARACTER_BIND_READY"
  | "CLIP_POSE_READY"|"CLIP_VISIBLE_FRAME_CHANGED";

interface ExternalMarkerSpecV1 {
  kind: BlackBoxMarkerKindV1;
  observer: "playwright-dom"|"cdp-frame"|"uia"|"etw-process";
  predicateId: string;               // A2闭集；不是app自报的任意字符串
  requiredArtifactRoles: string[];
}

interface BlackBoxScenarioV1 {
  id: "workspace-open"|"param-atkparam-npc"|"param-speffectparam"|"map-m10"|"character-c0000"|"clip-a000-000010";
  workflow:"workspace"|"param"|"map"|"character"|"clip";
  corpusIdentity: string;
  actions: BlackBoxActionV1[];
  startMarker: ExternalMarkerSpecV1;
  firstVisibleMarker: ExternalMarkerSpecV1;
  completeMarker: ExternalMarkerSpecV1;
  timeoutMs: number;
  viewport: { width:1280; height:720; dpr:1 };
}

// child只产出每轮外部事件/像素/DOM/ETW raw facts
interface PerformanceRunObservationV2 {
  scenarioId: BlackBoxScenarioV1["id"];
  testedSourceSnapshotSha256: string;
  runIndex: number;
  cacheState: "cold"|"warm";
  cohort:PerformanceCohortV2;
  markerObservations: Array<{kind:BlackBoxMarkerKindV1;monotonicMs:number;rawArtifactSha256:string}>;
  metricSamples:Array<{
    metricSpecId:string;
    values:number[];                       // external extractor的raw finite samples；禁止P50/P95/ratio
    samplesCanonicalSha256:string;
    rawArtifactSha256:string;
  }>;
  processExitCode: number|null;
  timedOut: boolean;
  failureCode:string|null;
}

// 只由parent runner从20轮raw observation和A2 plan逐expanded threshold派生
interface PerformanceThresholdDerivedV2 {
  thresholdId:string;
  derivedMetricIdentity:string;           // `${thresholdId}::${cacheState}`，全plan唯一
  budgetClauseId:string;
  scenarioId:BlackBoxScenarioV1["id"];
  cacheState:"cold"|"warm";
  comparisonMode: "RELATIVE_AND_ABSOLUTE"|"ABSOLUTE_AND_MATURE";
  computationKind:ThresholdComputationV2["kind"];
  operandStatistics:Array<{cohort:PerformanceCohortV2;metricSpecId:string|null;statistic:string;value:number|null;artifactHashes:string[]}>;
  observedValue:number|null;
  comparison:PerformanceThresholdV2["comparison"];
  numericLimit:number;
  requiredByMode:boolean;
  evaluated:boolean;
  result:"PASS"|"FAIL"|null;             // requiredByMode=true时绝不能为null
  diagnosticCode:"NOT_COMPARABLE"|"ENVIRONMENT_BLOCKED"|"MISSING_RAW_SAMPLES"|"INVALID_DENOMINATOR"|null;
}
```

plan loader先做静态完备性验证，任何一项不成立都在启动测量前`PERFORMANCE_PLAN_INVALID`：

1. `metricSpecId/thresholdId/budgetClauseId`各自在自己的registry中唯一；每个threshold引用同scenario的已存在metric spec，所有数值finite，ratio denominator的单位/metric与numerator相同。
2. 将每个`cacheState="both"`阈值确定性展开为两个derived identity：`thresholdId::cold`和`thresholdId::warm`；cold/warm原项展开一个。展开后identity全局唯一，parent绝不把两种cache样本混入同一分位数。
3. `requiredInModes`非空且无重复。对每个scenario/cache，若mode=`RELATIVE_AND_ABSOLUTE`，required阈值静态集合必须含至少一个final绝对/正确性threshold和适用的`relative-p95-ratio`；若mode=`ABSOLUTE_AND_MATURE`，必须含至少一个final绝对/正确性threshold和适用的`mature-p95-ratio`。不存在用空集合“全都通过”的模式。
4. `budgetClauseRegistry`把第17.3节每一个原子预算映射到一个或多个threshold ID；双射校验要求每个required clause至少一次、每个threshold恰属一个已知clause。至少覆盖：workspace shell-before-ready及cold/warm complete、background impact、两张PARAM表的first-visible/index/page/handler/long-task、map first/complete/CPU/GPU frame/long-task/pick/pointer/commit/visible entity、character cold/warm/read-inflate-parse、clip cold/warm、retained wire bytes、instrumentation overhead、failure rate。缺任何一项即FAIL，不能靠章节正文人工补。
5. metric samples只含external extractor从artifact重算的raw finite值；child不能提交P50/P95、ratio、PASS或cache hit结论。parent逐`thresholdId::cacheState`取恰好20个对应cohort run，按spec aggregation求operand和observedValue，保留全部artifact hashes后比较。
6. `NOT_COMPARABLE`和`ENVIRONMENT_BLOCKED`只允许写`diagnosticCode`。任何`requiredByMode=true`的derived必须`evaluated=true,result=PASS|FAIL`；相对阈值在ABSOLUTE_AND_MATURE模式应`requiredByMode=false,evaluated=false,result=null,diagnostic=NOT_COMPARABLE`，它不贡献PASS。mature adapter不可用时required mature threshold直接`result=FAIL,diagnostic=ENVIRONMENT_BLOCKED`，不能变成null。

固定预算展开示例不是可选建议：map loaded CPU与GPU分别有独立metric/threshold；background ratio按`P95(active)/P95(idle)-1 <= 0.15`；instrumentation按`P95(on)/P95(off)-1 <= 0.02`；read/inflate/parse/hash与semantic commit使用`all-runs-exact`；“shell/files早于editor-ready”使用`all-runs-metric-order`；wire bytes在两次test GC后的heap artifact上取`global-max <= 32MiB`。`max-long-task < 50/100ms`必须用`global-max`和严格`<`，不能误写P95。

每个scenario ID的action/marker组合由A2 schema固定：workspace必须用`WORKSPACE_FILES_INTERACTIVE/WORKSPACE_EDITOR_READY`；PARAM用完整index可搜索和selected page；map first marker必须满足第17节真实几何+camera/pick外部变化，complete marker还要499 outcome terminal；character必须是非骨架完整body mask/bounds；clip必须有目标pose ready和真实可见帧变化。“窗口出现”“loading消失”“app自报ready”不属于闭集predicate。observer从Playwright/CDP/UIA/ETW的外部raw artifact计算marker；app内部telemetry只解释，不决定版本间起止。

A2先对clean HEAD执行marker capability probe，child只提交raw observations，`baselineMarkerCapability/relativeComparable/comparisonMode/derived result`全部由parent predicate计算，observation schema若含这些结论字段直接拒绝。如果baseline与final都产生语义相同的三类marker，固定`comparisonMode=RELATIVE_AND_ABSOLUTE`且required relative阈值必须PASS。若clean HEAD经独立probe确实缺语义marker，A2只能在任何final测量前冻结`ABSOLUTE_AND_MATURE`：此分支要求`baseline-noncomparability-proof`、final绝对预算、正确性和mature comparator预算全部PASS；相对derived只写`diagnosticCode=NOT_COMPARABLE`且`result=null`，它本身**不算PASS**。mature adapter不可用、proof不完整或final缺marker时相应required predicate FAIL，不能以NOT_COMPARABLE豁免。缺markerbaseline run的timeout只作诊断，绝不能进入相对P50/P95或满足`<=60% baseline`，也不能把marker改弱成窗口出现。

A2 acceptance plan的canonical bytes不能写成“把几个JSON拼起来”。唯一结构为一个fresh `PerformanceAcceptancePlanV2`，字段顺序固定：`schema,assertionRegistrySha256,stageInputRegistrySha256,budgetClauseRegistrySha256,externalMetrics,thresholds,scenarios,comparisonModeDecisions,corpusManifestSha256,adapterIdentities,formatRuleRegistryHashes`；每个子对象拒绝未知/缺字段，数字必须finite且整数处严格整数，object keys按UTF-8 bytes排序。`externalMetrics`按metricSpecId、`thresholds`按thresholdId、`scenarios`按id、`comparisonModeDecisions`按scenarioId/cacheState、adapter/registry数组按各自id的UTF-8 bytes排序后冻结；每个scenario/cache恰有一个mode decision，不能在final时改分支。compact JSON UTF-8、无BOM/尾换行。`acceptancePlanSnapshotSha256=SHA-256(canonicalBytes)`。同一fixture分别由Node和一个独立C#/Python小verifier产生bytes/hash并完全一致；不能共享canonical serializer实现。任何locale、property insertion order或CRLF变化都不改变结果。

schedule 生成算法不依赖实现者手排：

```text
acceptancePlanSnapshotSha256 = SHA-256(canonical PerformanceAcceptancePlanV2 bytes defined above)
cohorts = sorted unique cohorts referenced by required expanded thresholds for this scenario/cacheState
require cohorts contains final or a final-* cohort and every required operand cohort
seedInput = length-prefixed UTF-8 fields ["mission1-schedule-v2", acceptancePlanSnapshotSha256,
             corpusManifestSha256, scenarioId, cacheState, ...cohorts]
seed = SHA-256(seedInput)
for runIndex 0..19:
  for cohort in cohorts:
      orderDigest[cohort] = SHA-256(length-prefixed [lowercase hex seed, decimal runIndex, cohort])
  order cohorts by raw 32-byte orderDigest ascending; tie by cohort UTF-8 bytes
  append each cohort exactly once with same runIndex/cacheState
write schedule before running and hash it
```

`length-prefixed` 的唯一编码是：每个字段先转UTF-8 bytes，写一个 unsigned 32-bit big-endian byte length，再写字段bytes；不加分隔符/BOM/NUL，runIndex使用无前导零ASCII十进制。digest按raw bytes比较，不比较hex locale字符串。`acceptancePlanSnapshotSha256`在A2独立审查通过时冻结；后续修改registry、metric spec、阈值、scenario、corpus/adapter identity必须使A2失效并重新审查，不能只重算一个对final更有利的新schedule。各cohort source snapshot进入各自run artifact的`testedSourceSnapshotSha256`，不进入seed。`cacheState="both"`先展开后为cold/warm各生成独立schedule。

cold每个run：关闭本轮app/Bridge进程树，使用新建的测试专用app-data/cache目录，不删除用户缓存，不声称清OS page cache；记录`osPageCache=uncontrolled`。warm：同一app、同一`workspaceSessionId/workspaceSessionGeneration`且所有相关source hash/`pathSourceGeneration`不变，先完成一次成功预热，再关闭/重开对应editor；后台任务必须达到定义完成，不能留到测量后。

单 run：

```text
verify power/viewport/corpus/source identity
start monotonic timer immediately before first user action
perform exact scenario actions
capture firstVisible and complete marker timestamps
on timeout/crash/assertion failure:
  status=FAIL; duration=timeout or elapsed; preserve logs
on success:
  status=PASS; duration=complete-start
append raw JSONL immediately and fsync/close record
```

metric派生与分位数：

```text
for each expanded threshold and each referenced cohort:
  require exactly runIndex 0..19 once each for its cacheState
  validate every metric sample against ExternalMetricSpecV2 and raw artifact hash
  for latency metric whose run failed before sample exists: use scenario timeoutMs as that run's sample
  for failure-rate: failed = timeout/crash/marker/predicate/metric extraction failure; value=failed/20
  for event-series statistic: concatenate all valid event samples from all 20 runs;
    never average each run's P95 and never let a run omit an empty/failed series
  values = the computation-defined 20 one-per-run values or full event series
  sort numeric ascending
  nearest-rank P50 = values[ceil(0.50 * n)-1]
  nearest-rank P95 = values[ceil(0.95 * n)-1]
  global-max/min = max/min of the same complete values
  ratio requires finite denominator > 0; otherwise required threshold FAIL INVALID_DENOMINATOR
  compare observedValue with the threshold's exact strict/non-strict operator
```

上述`values`只用于对应metric/cohort/cache的预算和故障可见性，失败run以timeout计入latency使指标不会因删慢样本变好；非latency metric缺样本使其required threshold直接FAIL，不能编造timeout字节/计数。`RELATIVE_AND_ABSOLUTE`模式要求baseline/final各20次均产生语义相同marker，任何缺失都使required performance predicate FAIL；`ABSOLUTE_AND_MATURE`模式要求独立noncomparability proof与mature/absolute断言全PASS，相对derived只保留NOT_COMPARABLE诊断而不参与Gate AND。任何final或final-* cohort failureRate>0都使对应正确性Gate失败，即使P95达标；baseline failureRate>0会使relative模式失败，不能自动切换模式或把final绝对正确性算PASS。只允许系统sleep、电源计划变化、GPU driver reset、**harness自身**明确崩溃使整批invalid；mature comparator产品crash是该cohort失败run，不是环境invalid。原始批次仍保留。CPU抖动、GC、后台hash、慢parse和产品crash不是可删除outlier。

成熟工具 comparator 使用各自自动化 adapter，但 corpus、用户目标和起止语义相同。A2候选选择阶段才允许对capability probe通过的候选各跑5次，按P50最快者固定并记录exe/adapter hash；这5次不进入正式threshold、不能补成20次。选定后、final测量开始前把唯一comparator identity冻结进plan；正式`mature` cohort必须针对该工具另跑完整20 cold + 20 warm（按实际required cache state），由同一raw observation schema派生mature thresholds。不能拿候选5轮冒充正式20轮，也不能在final变慢后换comparator。

### 24.20 全链路 cancellation、generation 和 retry 算法

本节禁止再使用裸`generation`。每个长请求携带一个typed lifetime envelope；不适用的scope显式为null，不能省略后由consumer猜：

```ts
interface RequestLifetimeBaseV1 {
  schema: "mission1-request-lifetime-v1";
  requestId: string;
  correlationId: string;
  abortTokenId: string;
  workspace: {
    workspacePersistentIdentityHash: string;
    workspaceSessionId: string;
    workspaceSessionGeneration: number;
    fingerprintStoreGeneration: number|null;
  };
}

interface VerifiedRequestSourceV1 {
  identityState:"verified";
  logicalUri: string;
  sourceContentSha256: string;
  pathSourceGeneration: number;
  containerEntryIdentitySha256: string|null;
  overlayResolutionGeneration: number|null;
}

interface UnknownColdBinderSourceV1 {
  identityState:"unknown-cold-binder-open";
  logicalUri:string;
  sourceContentSha256:null;
  pathSourceGeneration:number;
  containerEntryIdentitySha256:null;       // binder root file，还未选child
  overlayResolutionGeneration:number|null;
  preHashFileSnapshotIdentitySha256:string; // main从同一open handle/file identity冻结，不是mtime/size cache key
}

interface SceneLifetimeV1 {
  sceneId: string;
  sceneGeneration: number;
  rendererContextGeneration: number;
  projectionIdentitySha256:string;         // map/character/playback各自完整projection identity
  mapResourceCacheKeySha256: string|null;   // 仅map-static/map-scene非null
}

type RequestLifetimeV1 = RequestLifetimeBaseV1 & (
  | {
      operationKind:"binder-cold-source-probe";
      sources:[UnknownColdBinderSourceV1];
      bridge:{daemonInstanceId:string};
      scene:null;
    }
  | {
      operationKind:
        | "workspace-discovery"|"binder"|"param"|"map-static"|"map-scene"
        | "character-semantic"|"character-gpu-projection"
        | "animation-decode"|"animation-playback"|"acceptance";
      sources:VerifiedRequestSourceV1[];
      bridge:{daemonInstanceId:string}|null;
      scene:SceneLifetimeV1|null;
    }
);
```

verified`sources`按`logicalUri + containerEntryIdentitySha256`的24.11 canonical bytes排序且identity唯一；除唯一cold probe分支外，数组里出现null hash或unknown identity一律schema拒绝。固定适用矩阵如下，字段组合不符先返回`REQUEST_LIFETIME_SCOPE_INVALID`，不得悄悄少比一个scope：

| operationKind | sources | bridge | scene |
|---|---|---|---|
| workspace-discovery | verified可为空；fingerprint store必非null | null | null |
| binder-cold-source-probe | 恰一个unknown tuple | 非null | null |
| binder / param | 至少一个verified | 非null | null |
| map-static | 恰一个verified模型source | 非null | 非null，projection identity与`mapResourceCacheKeySha256`均非null且后者等于24.12 key |
| map-scene | 全部实际verified sources | null | 同上两字段非null |
| character-semantic | leader/parts等全部verified sources | 非null | null |
| character-gpu-projection | semantic bundle涉及的全部verified sources | null | 非null，projection identity=context SHA，map key必须null |
| animation-decode | animation+skeleton全部verified sources | 非null | null |
| animation-playback | clip+skeleton+leader全部verified sources | null | 非null，projection identity=playback/clip/leader复合SHA，map key必须null |
| acceptance | 由24.2 source/runtime artifact guard给出verified闭集 | 按child operation | 按child operation |

`binder-cold-source-probe`是唯一允许`sourceContentSha256=null`的操作，只能在同一个已冻结file handle上流式读/hash并返回一个短生命周期`VerifiedSourceLease{readonlyBytesOrHandle,VerifiedRequestSourceV1}`；它不得join/publish binder content cache、不得parse BND、不得返回UI数据。随后owner必须用**新requestId**（可保留correlationId）和该verified source创建普通`binder` lifetime，后者才允许cache lookup/publish/parse；probe结果晚到或file snapshot变化即丢弃lease。若fingerprint store已有当前verified hash，直接走普通binder。这样既消除“cold时hash为null但schema强制string”的矛盾，也不靠第二次磁盘读取取得bytes。

lifetime guard 必须在四个位置检查：发请求前、每个native/worker chunk边界、异步结果提交UI/GPU前、任何cache entry publish前。比较不是“一串数字相等”，而是按owner逐项验证：

```text
validateLifetime(request, active):
  require persistent workspace identity相同
  require workspaceSessionId + workspaceSessionGeneration相同（只决定本session能否publish）
  if fingerprintStoreGeneration nonnull: require active store generation相同
  for every verified source: require logical URI/source hash/pathSourceGeneration/entry/overlayResolutionGeneration exact
  for cold probe only: require same open handle/file snapshot identity and forbid every publish/cache operation
  if bridge nonnull: require daemonInstanceId exact
  if scene nonnull: require sceneId/sceneGeneration/rendererContextGeneration/
    projectionIdentitySha256/mapResourceCacheKeySha256 exact

on any mismatch:
  do not mutate catalog/scene/React state or publish OPENING/READY cache entry
  release every acquired reader/GPU owner/temp/transferable exactly once
  return the precise code STALE_WORKSPACE_SESSION | STALE_FINGERPRINT_STORE |
         STALE_SOURCE_IDENTITY | STALE_BRIDGE_DAEMON | STALE_SCENE |
         STALE_RENDERER_CONTEXT | STALE_PROJECTION_IDENTITY | STALE_RESOURCE_CACHE_KEY
```

不可变content cache key仍只使用各卡规定的content/source/rule字段；不能因为envelope有`workspaceSessionGeneration/sceneGeneration`就把它们塞进跨重开content key。反过来，owner/publish guard也不能只看content key而漏掉session或scene。取消传播顺序：renderer abort -> preload/main request registry -> Bridge request cancellation token -> native loop/chunk iterator。Bridge 无法中断的单个parse完成后也必须在投影/返回前重新跑`validateLifetime`并丢弃；不得把旧结果装进新session/scene。

统一重试预算：

```text
stale/expired session: explicit reopen at most once
transient Bridge process restart: owning workflow at most once after new daemon identity
deterministic parse/schema/corpus error: zero automatic retry
GPU context loss: one controlled scene rebuild per rendererContextGeneration
user Retry: starts a new request id, never revives old Promise
```

retry key按operation使用完整immutable resource/cache identity + 精确diagnostic code；Bridge restart另含旧/new daemon identity，GPU rebuild另含sceneId+rendererContextGeneration。`workspaceSessionGeneration`不进入共享content failure key，也不会仅因重开editor清除确定性parse失败；source hash/pathSourceGeneration/rule identity改变自然产生新key。指数退避`2s,4s,8s,... max30s`只适用于registry分类为transient的失败。成功清对应key；user Retry也必须遵守显式retry计数和当前lifetime，不能删除全局failure map。React effect把attempt ledger放在workflow owner中，rerender/`setState`不能重置一次reopen/restart/context-rebuild预算。

所有 acquire 必须有对应 finally/release：

```text
binder reader lease
PARAM session reader/owner
FLVER static session
worker transferable buffer ownership
GPU pool owner/refcount
TransformControls target/orbit lock
performance child process and temp app-data
```

失败注入测试逐项比较 acquire/release counter；完成/失败/取消后三条路径都必须归零或回到预期长驻 owner数。

### 24.21 G4/G5：确定性地图 canvas、样本选择和真实 pointer 算法

固定相机按第 16.6.1 节 world AABB计算。不能由测试作者鼠标挑“看起来最好”的区域。

真实交互 placement 的确定性选择：

```text
candidates = manifest.mapCorpus.placements whose exact resource edge expected=loaded
filter only objective prerequisites:
  geometry oracle triangleCount > 0
  transform finite and invertible
  projected AABB intersects central 80% viewport under fixed camera
for each candidate:
  identityBytes = length-prefixed UTF-8 fields in exact order
    [mapLogicalUri,msbSourceSha256,nativePartKind,decimal nativePartOrdinal,
     decimal nativeModelOrdinal,modelEdgeId,decimal overlayResolutionGeneration]
  candidateDigest = SHA-256(identityBytes)
sort by candidateDigest raw 32 bytes, tie by the same length-prefixed identityBytes
target = first candidate
```

decimal integers用无前导零ASCII（0除外）；length prefix是24.19定义的uint32 big-endian。禁止用`JSON.stringify(object)`、modelName、当前array index、instanceId或transform hash排序。manifest verifier要证明每个placement identity唯一且引用存在的model/edge；否则样本冻结失败。

如果第一个 candidate 加载/投影/handle失败，测试立即 FAIL并保留 identity；不得继续找下一个容易成功的对象。目标 identity在 A2 manifest中冻结，B-G 期间不能重选。

三个 Gizmo mode 都对同一 target执行，顺序固定 translate -> rotate -> scale；每次从原始 transform的临时副本重开场景，避免前一模式影响后一模式。锁定 `three@0.172.x` 的实际 package-lock identity，`controls.space="local"`，三个 snap均为 `null`。从 X/Y/Z 中选择该 target 在屏幕投影长度最大的正轴，tie按 X、Y、Z；A2把 axis与handle ID冻结。若依赖版本改变，旧数学 oracle失效，必须重审。

pointer事件必须由 Playwright mouse/touch API作用于真实 canvas坐标：

```ts
interface ValidationIdBufferArtifactV1 {
  schema: "mission1-validation-id-buffer-v1";
  passKind: "PLACEMENT_OBJECT_ID"|"GIZMO_HANDLE_ID";
  sourceSnapshotSha256: string;
  sceneGeneration: number;
  canvas: {cssWidth:number;cssHeight:number;drawingWidth:number;drawingHeight:number;dpr:number};
  cameraProjectionMatrixSha256: string;
  cameraViewMatrixSha256: string;
  depthTestEnabled: true;
  occlusionMode: "PRODUCTION_DEPTH";
  idEncoding: "RGBA8_UINT_BE";
  idMap: Array<{numericId:number;semanticIdentitySha256:string;handleId:string|null}>;
  rgbaBytesSha256: string;
  depthBytesSha256: string;
  producerRendererIdentitySha256: string;
  capturedAtMonotonicMs: number;
}
```

artifact由acceptance harness请求真实WebGL canvas额外渲染pass并`readPixels`产生；placement pass使用production geometry/instance/depth/矩阵，只替换为flat ID材质；Gizmo pass使用当前TransformControls实际可见handle/depth，只替换handle颜色。`idMap`由当前canonical placement identity/Three handle name生成，不能由测试传入想要的结果。harness独立重算rgba/depth hash、验证矩阵/canvas/source identity并从raw pixels求质心；schema、raw bytes或producer identity缺失即FAIL。validation pass只选择屏幕坐标，随后的pointerdown/move/up仍走正常canvas raycast/TransformControls hit path，并必须选回同一semantic identity/handle；禁止从ID pass直接调用selection/transform handler或把人工坐标写进artifact。

```text
1. 从 validation ID buffer找到 target visible像素的稳定质心。
2. click 该像素，断言 semantic selection identity。
3. 从 gizmo validation ID buffer取得指定轴/环/scale handle的质心。
4. mouse.move(handle); mouse.down()；translate/scale沿所选正轴的屏幕投影方向、rotate沿该环在起点的屏幕切线正方向，分10个等距step移动固定80px；mouse.up()。
5. 每 step记录 pointer event、objectChange、view/instance matrix timestamp。
6. 断言无异常、selection保持、visual latency、最终矩阵、单次 semantic commit。
```

handle 若被遮挡/没有足够像素，不换 target，直接 `GIZMO_HANDLE_NOT_RENDERABLE` FAIL。为了使验证确定，可在 acceptance validation pass 给 handle写 ID buffer，但正常材质/深度和 production pointer hit path必须相同，不能直接调用 handler。

测试 trace只读记录TransformControls的`pointStart`以及**每个pointer move**的`pointEnd/worldPosition/worldQuaternion/eye/cameraPosition`，并记录drag-start的`worldPositionStart/worldQuaternionStart/quaternionStart/positionStart/scaleStart/parentQuaternionInv/parentScale`；它不能写这些值或直接调用transform handler。独立oracle按仓库锁定Three版本源码逐move重算最终local TRS：

```text
translate(axis):
  offset = pointEnd - pointStart
  offset = inverse(worldQuaternionStart) * offset
  将非 axis 分量置 0
  offset = quaternionStart * offset
  offset = componentWiseDivide(offset, parentScale)
  expectedPosition = positionStart + offset

scale(axis):
  startLocal = inverse(worldQuaternionStart) * pointStart
  endLocal   = inverse(worldQuaternionStart) * pointEnd
  require abs(startLocal[axis]) > 1e-6
  factor[axis] = endLocal[axis] / startLocal[axis]
  其他 factor 分量 = 1
  expectedScale = scaleStart * factor

rotate(axis):
  localAxis = unit X/Y/Z
  worldAxis = worldQuaternion_at_this_pointer_move * localAxis
  tangent = normalize(worldAxis cross eye_at_this_pointer_move)
  require tangent length > 1e-6; axis选择算法必须避开平行情形
  rotationSpeed = 20 / distance(worldPosition_at_this_pointer_move,cameraPosition_at_this_pointer_move)
  angle = dot(pointEnd_at_this_pointer_move-pointStart,tangent) * rotationSpeed
  expectedQuaternion = normalize(quaternionStart * quaternion(localAxis,angle))
```

上式final expected使用最后一个pointer move的current值；禁止拿固定`worldPositionStart/worldQuaternionStart`代替，因为TransformControls会在每次move使用当前world position/quaternion计算速度和local axis。oracle最终compose`expectedPosition/Quaternion/Scale`成placement local矩阵P，与target.matrix和semantic round-trip比较`maxAbs<=1e-5`；每个instance则比较`P * binding.modelLocalMatrix`，不能直接等于P。同时要求translate非目标分量、scale非目标分量在容差内不变，rotate translation/scale不变，三种mode的改变量都大于`1e-4`。这不是只断言“方向一致”。

canvas 几何正确性：从独立 oracle bounds frame相机，渲染 production geometry的 object ID mask和linear depth；oracle geometry使用独立转换器渲染相同 pass。比较前确认 viewport/DPR/FOV/near/far/matrix完全一致。mask coverage、IoU、depth P95按第16节阈值；任何 NaN/Inf depth、越界 index、超出 oracle AABB容差先失败，不让图像阈值掩盖结构错误。

### 24.22 每张算法卡必须拥有的测试层级

不要只写一个巨大 E2E。每张卡至少三层：

```text
纯算法单元测试
  -> 构造最小边界数据，证明状态/数学不变量

跨层集成测试
  -> 真实 schema + Bridge/main/worker 生命周期，证明数量和释放

真实 corpus/Electron smoke
  -> 证明实际 Sekiro 文件、GPU和用户输入走同一路径
```

对应关系：

| 算法卡 | 必做单元 | 必做集成 | 必做真实 smoke |
|---|---|---|---|
| 24.1 snapshot | staged/unstaged/untracked/二次dirty内容/reparse/变化中 | trackedChanges+raw patch恢复最早stage | 最终H前后snapshot相同、未知path回A0 |
| 24.2 runner | child伪status/逐negative manifest/replay/empty Gate/派生state | crash原子state、resume、stageRank/Gate/overall一致性 | 同一runner spawn完整命令 + 外部A0/A2 review/user hash |
| 24.3 corpus | 三方source+entry join/换文件/disputed/count | generator/verifier不共享逻辑差分 | 当前本机corpus hash + mature target identity |
| 24.4 discovery | continuation抢占/cancel/hash失败/USN gap/等长离线写回 | persisted fingerprint+continuity事务 | 工作区cold/warm/单文件变更/journal gap |
| 24.5 BND | duplicate/in-flight/cold null hash/跨window purpose/double close/LRU | list-extract-list owner/readers守恒 | gameparam cold/warm/两个window共享content |
| 24.6 PARAM session | token/page bounds/evict/跨owner/double close | N page parse=1、owner capability/释放 | AtkParam_Npc/SpEffectParam/重复ID |
| 24.7 PARAM write | duplicate id/CAS/CSV quoting | staging reread/atomic batch | 138表 no-op + 临时副本写回 |
| 24.9 FaceSet | 16/32/list/strip/restart边界/8-bit Edge拒绝/0或多rule/None-LOD-motion profile/cull | map+character DTO index/profile/rule/cull validation | 499地图+10角色逐mesh triangle/FaceSet oracle重组 |
| 24.10 chunk | 多mesh meshPlan/dense remap/material span/strict<8MiB/golden NDJSON/cursor TTL | stdout framing、worker乱序/丢失/取消/reader close | m002021 + m10全mesh/峰值/唯一terminal |
| 24.11 route | type switch/unknown/canonical identity/self-hash排除/model-local/单位只转一次 | resource-edge envelope+coordinate golden vectors | o000100/c1000/type5/非identity model-local |
| 24.12 scheduler | full cache key/subscriber lease/ready事务/refcount | worker transfer/GPU rollback/dispose/两个subscriber | m10 loading/loaded/顺序重开/eviction reload |
| 24.13 spatial/pick | negative cell/DDA/tie/batch+spatial revision/visible cache stale | identity双向表与revision同事务 | m10静止相机后到chunk可见+pick P95 |
| 24.14 Gizmo | P与P*N/non-TRS/每pointerdown rebase/dragSession/全lifetime CAS/late chunk/abort冲突 | TransformControls事件链+连续两drag+多chunk全回滚/authority重投影 | typed ID-buffer下三种真实pointer |
| 24.15 context | gender union/path+overlay provenance/purpose闭包/nonce/replay/reserve一次事务/TTL | PARAM+resource graph resolver+多record rollback | c0000 production context |
| 24.16 remap | duplicate/missing/bind mismatch | 单 leader bundle | c0000/c1000/10样本 |
| 24.17 skin | bind identity/noncommuting矩阵/Attached root move/Detached双root反例/Three normal K | one Skeleton引用+每mesh动态bind inverse | CPU/GPU mask/depth |
| 24.18 animation | explicit URI/binding/source hash/path gen/conversion key/delta/FAILED backoff | selection reservation+cache顺序/并发重开/stale rule miss | a000_000010真实播放 |
| 24.19 performance | closed action/marker/metric/预算覆盖/schedule/nearest-rank/ratio/noncomparability | child伪result、raw metric artifact、cold-warm隔离、必需集合非空 | 所需全部cohort正式20轮；mature候选5轮不得混入 |
| 24.20 cancellation | verified/unknown-cold union与every state exit | Bridge crash/context loss/unknown禁止publish | workspace/viewport切换 |

一项纯算法测试绿不能替代右侧真实 smoke；真实 smoke失败也不能通过放宽单元 fixture修复。

### 24.23 低能力代理遇到失败时的固定定位决策树

不要同时改五层。按首个违反的不变量向上游定位：

```text
PARAM 行不对
  -> 先比较 physical rowIndex/id/dataOffset/dataLength
  -> 再比较 requested page serializedRows
  -> 再看 renderer page key/state
  -> 最后才看 React 展示

地图有尖刺/长三角
  -> 先检查 FaceSet index bit width 与每个 index<vertexCount
  -> 再按 sourceVertexIndices重组与 oracle逐 index差分
  -> 再检查 placement matrix/local-world
  -> 前三项全对才看 shader/camera

地图越来越慢
  -> 画随已加载模型数增长曲线
  -> parse/inflate重复：修 native session
  -> retained base64增长：修 wire ownership
  -> draw/triangles增长异常：查 batch/culling
  -> pick单独慢：查 broadphase
  -> 不得先隐藏实体

Gizmo 拖不动/跳变
  -> target.parent/root local matrix
  -> selectionGeneration/sceneGeneration/rendererContextGeneration/晚到attach
  -> pointer event与orbit lock
  -> objectChange GPU-only
  -> pointerup单次 semantic commit

角色缩在原点/只有骨架
  -> context bodyParts是否齐全且 provenance真实
  -> mesh boneIndexSpace是否flver-global
  -> 首个正权重 missing/ambiguous/out-of-range
  -> part/leader bind-world差分
  -> CPU bind-pose raw identity
  -> CPU动画pose
  -> 最后才看 GPU shader/material/camera

启动慢
  -> discovery contentRead计数是否0
  -> warm hashRead是否0
  -> 是否有第二次 scan/analyze
  -> 前台到达后后台 reader是否让步
  -> 最后才看 loading UI
```

每次只修决策树中第一个失败节点。修完重跑该节点以及所有下游断言；如果上游仍失败，不允许通过下游视觉补丁继续。

### 24.24 接手者可以直接照抄的单次编辑循环

```text
INPUT: current-state 第一个 FAIL 阶段和 firstFailure.nextActionCode

1. 运行 git/gov 并发检查；发现他人写 main则停止。
2. capture source snapshot S0。
3. 阅读该阶段正文 + 本节对应算法卡；列出 input/output/owner/invariants。
4. 用 rg 找全部调用点；禁止只改第一个命中。
5. 运行最小失败测试，保存 F0；若无法复现，不写实现。
6. 先补能表达不变量的 failing test。
7. 只改一个 owner layer及必要协议调用方；不顺手重构。
8. 运行单元测试；失败就留在第7步。
9. 运行跨层集成；分别核对workspace-session/path-source/scene/renderer-context计数与释放；失败就留在第7步。
10. 按本卡跑真实 corpus/Electron smoke；失败按24.23定位，不换样本。
11. 运行 typecheck/Bridge build/前端 build和该阶段回归。
12. capture S1；若测试期间非预期漂移，整轮作废重来。
13. runner计算阶段 PASS/FAIL；人工不得改 current-state。
14. PASS才进入紧邻下一阶段；FAIL只执行静态 registry 给出的唯一 nextActionCode。
```

这 14 步不是“建议工作方式”，而是防止低能力代理在多个表象间来回打补丁的控制回路。
