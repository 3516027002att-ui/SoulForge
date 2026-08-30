# report1：MAP / ACTION 决定性运行时重捕报告（已执行）

生成于 2026-08-30。本报告是 `mission/runtime-first-divergence.md` §R 章节的独立成文版，数据同源（同一批采集），可单独阅读。上一份外发的「Runtime First Divergence — focused recapture」报告结论是"无法在本会话执行"；本报告是该重捕的**完成版**，在其机器上、其仓库里、对其真实游戏文件执行。

## 0. 一句话

两条链路的 First Bad 都从 HIGH-CONFIDENCE CANDIDATE 提升为 **RUNTIME-CONFIRMED**，而且都和静态审计的预测**不同**：MAP 的失败变体不是预测的 "multiple Flags==0" 而是 "no Flags==0"（19/80 模型）；ACTION c0000 根本没走到 HKX→FLVER 映射那一步——**100% 的动画 clip 在 anibnd 条目解析就全灭**（1e9 binder-ID 不变量对玩家容器完全不适用，0/40）。c0000 骨骼不动的直接原因就是这条：renderer 永远拿不到 sampler。

## 1. 执行环境与证据等级

- 仓库：`D:\Repository\SoulForge`，`main`，HEAD `abb14982edc38c40a880a3169e58bb0ae813067d`，采集前后 `git status` 干净。
- 采集前重建，确保被测二进制与提交源码一致：`npm run bridge:publish`（Release win-x64，publish 产物 mtime 2026-08-30 00:17，晚于 abb14982 对 `BridgeCommandService.cs` 的提交时间 23:41）；`npm run build -w @soulforge/shared` / `-w @soulforge/core` 通过。
- 执行通道：**不是 Electron UI**。`runBridge`（生产 pooled NDJSON daemon 入口）→ 桌面应用同一个 Release publish 的 `SoulForge.Bridge.exe` → 真实游戏文件 `D:\mystream\Sekiro Shadows Die Twice\Sekiro`。位姿计算用产品自带的 `ActionContinuousSampler` / `eulerXYZToQuaternion`（`packages/shared/dist`），输入输出与 `TaeWorkbenchPanel.tsx:926-986` 的 renderer 路径完全一致（leader 骨骼名来自 `read-chrbnd-flver-preview`）。
- 证据等级标签：**UI-observation**（用户口述观察）/ **STATIC**（源码证明）/ **RUNTIME-BRIDGE**（生产 Bridge 二进制 × 真实文件的追踪级测量）/ **RUNTIME-SAMPLER**（产品采样器代码跑 RUNTIME-BRIDGE 数据，不含 three.js 应用层）。

## 2. MAP：决策表 case 3 触发

对象：`mods/map/mapstudio/m10_00_00_00.msb.dcx` → RUNTIME-BRIDGE 读取成功：models=864、parts=7404、按 part 顺序 807 个去重模型名。容器分布：overlay `mods/map/m10_00_00_00/` 只有 1 个 mapbnd（`m10_00_00_00_600050.mapbnd.dcx`），其余在 base（overlay+base 共 550 个）。所有抽样模型的短名精确探针都命中 `map/<mapId>/<mapId>_<suffix>.mapbnd.dcx`。

样本：按 renderer part 顺序前 80 个去重模型，逐个走生产解析顺序（精确探针 → `read-map-static-geometry`，含分页跟随），另跑 `read-map-part-flver-preview` 对照。

| 结果 | 数量 | 明细 |
|---|---|---|
| 有效非空 chunks | 61 / 80 | 首块 triangleCount 55~8000，`selectedFaceSetOrdinals=[0]`，规则 `sekiro-flver-strip-restart-v1`；38 个模型多页分页正常（abb14982 分页修复运行时有效） |
| 整模型 fail-closed | **19 / 80** | 全部为 `MAP_STATIC_GEOMETRY_FAILED: FLVER_DISPLAY_FACESET_UNSUPPORTED: no Flags==0 FaceSet in mesh reference order`（m001500、m001510、m001550、m002001、m002002、m002010、m002021~23、m002025、m002030、m002032、m002033、m002050、m002051、m002400、m002401、m002410、m002420） |
| mapbnd 解析失败（case 1） | 0 | 证伪 |
| binder 条目失败（case 2） | 0 | 证伪 |
| "multiple Flags==0" 变体 | 0 / 19 | 静态审计预测的变体一例都没出现 |

**判定：MAP First Bad = 原生 display-FaceSet 投影，CONFIRMED（RUNTIME-BRIDGE）。** 位置：`FlverNativeDocument.GetMeshIndexSize` / `GetMeshIndicesBase64`（`bridge/SoulForge.Bridge/FlverNativeDocument.cs:726-790`），由 `MapStaticGeometryService.BuildMeshInfos` 逐 mesh 调用。失败是全有全无的：一个 mesh 触发规则 → 整模型 `MAP_STATIC_GEOMETRY_FAILED` → 这些 part 永远是 proxy。静态审计的机制判断（Flags==0 过严）正确，但失败方向被运行时修正：真实世界是「引用的全部 FaceSet 都非 0 Flags」，不是「多个 Flags==0」。

两个如实交代的缺口：

1. **每个失败 mesh 的 FaceSet 明细**（Flags/TriangleStrip/IndexSize/IndexCount）Bridge 诊断不携带，未采集。修复时应顺手把诊断负载补上。
2. **renderer 热替换（case 4）未测**。61 个 Bridge 层健康的模型，UI 里是否真被替换、以及用户「全方块」观察的会话是否挂了 base（不挂 base 时 overlay 只有 1 个容器，绝大多数模型本来就会 MISS 而保持线框），需要一次带插桩的 UI 运行才能区分。本报告不猜。

## 3. ACTION：c0000 在更上游全灭；c1020 映射全满

leader 骨骼来源（生产路径，RUNTIME-BRIDGE）：c0000 → 467 骨 / 0 mesh（符合预期，狼的网格在 parts）；c1020 → 346 骨 / 36 mesh。

### 3.1 c0000（玩家，症状主角）

- `read-tae-document` 正常：939 个动画（overlay、base 两份 anibnd 同）。
- **RUNTIME-BRIDGE：散布抽样 40 个 animId，0 个能读出 clip**（base 副本再抽 6 个，同样 0）。错误统一：`TAE_ANIMATION_CLIP_READ_FAILED: ANIBND contains no animation entry with logical HKX ID <id>`，抛自 `ActionAnimationSemantics.ResolveAnimationBinderEntryIndex`（`ActionAnimationSemantics.cs:85-105`）——它只接受 `EntryId ≥ 1,000,000,000 且 EntryId % 1e9 == motionId` 的条目。
- 容器普查（RUNTIME-BRIDGE，`read-dcx-document` 嵌套 binder envelope）：`c0000.anibnd.dcx` 共 109 条目，**0 个 ID ≥ 1e9**。家族分布：1 × 4M（`skeleton.hkx`）、65 × 5M、42 × 6M、1 × 9M。5M 家族与 animId 有可证对应：5000010↔10、5000050↔50、5000070↔70、5000100~103↔100~103、5000110↔110、5000200/01↔200/01。但全量交集只有 13 个条目低位直接命中某个 TAE animId——**5M/6M → animId 的完整换算规则还没弄清**，这是修复前必须做的普查。
- 对照：`c1020.anibnd.dcx` 293 条目中 289 个 ≥ 1e9——不变量对敌方容器成立，对玩家容器完全不成立。

**判定：ACTION/c0000 First Bad = ANIBND binder 条目身份解析（1e9 不变量），CONFIRMED（RUNTIME-BRIDGE，0/40）。** 它在静态审计点名的 HKX→FLVER 映射候选**上游一处**，且把该候选整个屏蔽了：clip 读不出 → `TaeWorkbenchPanel` 置空 clip/sampler → `sampledPose` 恒为 undefined → 骨骼永远保持参考姿势。这与用户 UI-observation（"骨骼绑定可见但动画不动骨头"）在 RUNTIME-BRIDGE + STATIC renderer 接线层面完全吻合；只是 UI 屏幕帧本身没有拍（无 UI 运行）。

### 3.2 c1020（对照角色）

- RUNTIME-BRIDGE：散布抽样 40 个，**33 个 clip 成功**（全部 SplineCompressed）。7 个失败里 5 个是 import/dummy 条目缺 HKX（合理 fail-closed）、1 个 `ACTION_HKX_SPLINE_OFFSET_BOUNDS_INVALID: floatBlockOffsets[1]=9644 dataLength=114800`（真实解码守卫）、1 个 import 链源缺失。
- RUNTIME-SAMPLER（5 个成功 clip）：`mappedBoneCount = 126/126`，`mappedAnimatedTrackCount = 106/106`（或 126/126），动起来的骨骼映射数一致；HKX 空位姿增量非零（animId 7600：最大平移 0.987、最大旋转 1.67 rad、64/126 骨移动；animId 12311：1.269 / 2.83 rad / 92 骨）；FLVER 空增量与 HKX 完全一致（满映射）。

**判定：c1020 的 case 1/2 被证伪**——映射完整、clip 会动。若 c1020 的 UI 会话同样冻结，剩下的候选才是 renderer 位姿应用（case 3），本轮按停止规则不下探。§3 的「零映射静默成功」仍是真实的 STATIC 缺陷，但运行时未观察到实例。

## 4. 更新后的 First Divergence 矩阵

| Flow | 运行时证实的最后好阶段 | First Bad（证据等级） | 剩余问题 |
|---|---|---|---|
| MAP | mapbnd + 条目 + FLVER 解析 + 分页全链路（61/80） | 原生 FaceSet 投影 case 3，**CONFIRMED RUNTIME-BRIDGE**（19/80 fail-closed） | 一次带插桩的 UI 运行区分「健康模型在 UI 仍是 proxy」vs「用户会话没挂 base」；诊断补 FaceSet 明细 |
| ACTION c0000 | TAE 文档（939 条目）、chrbnd 预览（467 骨） | ANIBND 条目身份（1e9 不变量），**CONFIRMED RUNTIME-BRIDGE（0/40）** | 修复前普查 5M/6M 家族 → animId 换算规则；UI 帧取证可选 |
| ACTION c1020 | clip 解码 + 映射 + 双空位姿增量全部健康（33/40） | Bridge 链路健康；case 3（renderer 应用）未测，按停止规则不查 | 仅当 c1020 UI 会话同样冻结时才需要 |
| PARAM | 同外发重捕报告 §5 | renderer legacy `loadAll=true` API 选择，STATIC | 只差量级 profiling |
| ROLLBACK | 同外发重捕报告 §6 | 历史 First Bad UNKNOWN | 真实 PRE→COMMIT→ROLLBACK authority 环 |

## 5. 边界声明

- §2/§3 的每个数字都是 RUNTIME 测量：Release publish 的生产 Bridge 二进制 × 真实游戏/mod 文件。原始 JSON 全部保留在 `tmp/runtime-recapture/`（`action-trace.json`、`map-trace.json`、`map-trace-80.json`），harness 为 `action-trace.mjs` / `map-trace.mjs`，可重跑复核。
- 没有合成 fixture、mock 或静态推断冒充运行时值；UNKNOWN 项按 UNKNOWN 列出。
- 本轮零产品源码改动、未认领任何治理切片、不提升任何 authority。会话开始时治理面板的 5 个 `GATE_EVIDENCE_STALE` 为既有问题，与本轮无关。
- 未做 Electron UI 运行：MAP case 4、ACTION c1020 case 3、以及「用户会话环境」问题因此保持开放——这是构造性的边界，不是遗漏。

## 6. 修复方向（只指位置，不开工）

1. **MAP**：`FlverNativeDocument` 的 display FaceSet 选择规则（Flags==0 单选 + 缺失即抛）。真实数据里大量 mesh 引用的 FaceSet 全部非 0 Flags，需要按 FLVER 语义做投影化选择（或按引用顺序取首个可用 display），同时把逐 FaceSet 明细放进结构化诊断。改完必须过 `bridge:publish` + 对应 native smoke。
2. **ACTION c0000**：`ActionAnimationSemantics.ResolveAnimationBinderEntryIndex` 的 1e9 不变量不能覆盖玩家容器。修前先做全容器条目普查（5M/6M 家族的低位与 TAE animId 的换算关系只有 13/107 直接命中，规则未定），不要拍脑袋把 base 换成 5,000,000 了事。
3. 两者都是独立切片；共享 Bridge 但不共享文件，可并行认领。
