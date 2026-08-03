# Release Corpus Registry 稳定格式规格

- 规格版本：`1.0.0`
- 归属能力：`REL-B`（切片 `W-REL-B-CORPUS-02`）
- 机器可读权威：`packages/core/src/bridge/releaseCorpusRegistry.schema.json`
- 实现：`packages/core/src/bridge/releaseCorpusRegistry.ts`（TS 常量必须与 schema 的 `x-constants` 逐值一致，由 `test:release-corpus-registry` 同步门禁强制）

本文件只定义一种稳定数据格式，不描述产品范围、进度或 authority 声明。格式变更的工程判定见「Schema 版本提升/变更流程」。

## 1. 用途与边界

Release corpus registry 是**纯元数据**登记：

- 只登记 `logicalId / sha256 / size / containerChain / resourceKind / format / observedVariant / permittedOperations / expectedAuthority / privacyClass`；
- **不携带样本字节**、不携带本地文件系统路径、不携带 URI scheme；
- 校验只证明「元数据可分类」，**不授予任何 native format authority**（`nativeFormatAuthority` 恒为 `false`）；
- 未知字段、缺失字段、fixture 冒名、路径泄露一律失败关闭。

## 2. 文档结构

一个 registry shard 是单一 JSON object：

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `registryId` | string | 脱敏 opaque 标识 `^[a-z0-9][a-z0-9._-]{2,127}$`，非路径 |
| `game` | string | 冻结枚举 `sekiro` |
| `gameBuild` | string | 短、稳定、不含路径的 build 标识 |
| `schemaVersion` | string | 必须等于 `x-constants.schemaVersion`（当前 `1.0.0`） |
| `createdAt` | string | 带时区的 RFC 3339 时间 |
| `entryCount` | integer | 正安全整数，`<= x-constants.maxEntries`，必须严格等于 `entries.length` |
| `entries` | array | 非空，最多 `maxEntries` 条 |

单个 entry：

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `logicalId` | string | opaque 标识，registry 内唯一 |
| `sha256` | string | 小写 64 位十六进制摘要，registry 内唯一 |
| `size` | integer | 正安全整数 |
| `containerChain` | string[] | 非空的相对逻辑标识数组，禁绝对路径/drive-relative/UNC/URI/`.`,`..` 段/重复 |
| `resourceKind` | string | 冻结枚举（12 值） |
| `format` | string | 冻结枚举 `DFLT | BND4 | KRAK`，registry 内三类必须各出现至少一次 |
| `observedVariant` | string | 必须属于对应 `format` 的冻结闭集（见 §4） |
| `permittedOperations` | string[] | 非空、不重复、必须含 `classify` |
| `expectedAuthority` | string | 冻结枚举（5 值），禁止 `fixture-confirmed` |
| `privacyClass` | string | 冻结枚举（3 值），禁止 `synthetic-fixture` |

跨条目不变量（`logicalId` / `sha256` 唯一、三类 format 全覆盖、未知字段失败关闭）由 `releaseCorpusRegistry.ts` 的 `validateReleaseCorpusRegistry` 强制；JSON Schema 表达不了的唯一性/覆盖性不变量全部落在该实现，两者互补。

## 3. Schema 版本提升/变更流程

版本号语义：`MAJOR.MINOR.PATCH`。

- **PATCH（1.0.0 → 1.0.1）**：纯文档性修订。不改变任何字段、枚举值或约束。只需要改本规格与 schema 的 `description`，不换 `schemaVersion` 常量值。同步门禁无需变化。
- **MINOR（1.0.0 → 1.1.0）**：**兼容扩展**。新增枚举值（例如新的 `observedVariant`、新的 `resourceKind`）、放宽已冻结约束、新增可选字段。旧数据必须仍然合法（不删除/不放宽已有合法值的校验）。旧 `schemaVersion` 的 registry 仍可被读，但新 registry 必须写新版本号。
- **MAJOR（1.0.0 → 2.0.0）**：**破坏性变更**。删除字段、收紧约束、重命名、改变语义。旧 registry 不再合法。

任何提升到 `1.1.0` 及以上（或任何破坏兼容的变更）必须同时满足：

1. 更新 `packages/core/src/bridge/releaseCorpusRegistry.schema.json` 的 `x-constants.schemaVersion` 与 `$defs` 闭集；
2. 更新 `releaseCorpusRegistry.ts` 的 `RELEASE_CORPUS_REGISTRY_SCHEMA_VERSION` 与对应常量，使其与 schema `x-constants` 逐值一致；
3. 更新本规格的版本号并记录变更说明；
4. `test:release-corpus-registry` 同步门禁必须实测：变更后枚举与 schema 不一致时 `exit=1`（负向证明），一致时 `exit=0`。

禁止「只改 TS 常量、不改 schema 文件」或反之——两者是同一冻结规格的两份投影，漂移即失败关闭。

## 4. observedVariant 与 Bridge variant 的对账约定

Bridge `read-dcx-document` 对 DCX 信封输出 `data.variant`（无 `DCX_` 前缀），例如：

- DFLT 信封：`DFLT_11000_44_9_0`、`DFLT_10000_44_9_0`
- KRAK 信封：`KRAK_11000_44_6_0`

registry 的 `observedVariant` 是 registry 侧的分类标签，闭集由 `x-constants.observedVariantsByFormat` 冻结。两者换算规则：

| registry `format` | registry `observedVariant` | 来源 |
| --- | --- | --- |
| `DFLT`（信封非 BND4） | `DCX_<Bridge variant>`，如 `DCX_DFLT_11000_44_9_0` | `DCX_` 前缀 + `data.variant` |
| `KRAK` | `DCX_<Bridge variant>`，如 `DCX_KRAK_11000_44_6_0` | `DCX_` 前缀 + `data.variant` |
| `BND4`（DFLT 信封内嵌 BND4） | 字面量 `BND4_40_24` | 内嵌 BND4 header 布局（fileHeaderSize `0x24`），与信封 `data.variant` 无关 |

对账门禁（双向）：

- **native 方向**（`scripts/verify-native-dcx-documents.mjs`）：对每个成功读取的 DCX，断言 `data.variant` 属于 schema `x-constants` 推导出的 Bridge 信封变体闭集（`DFLT`/`KRAK` 各自去掉 `DCX_` 前缀后的并集）；未识别变体以 `UNRECOGNIZED_BRIDGE_VARIANT` 失败关闭。
- **synthetic 方向**（`test:release-corpus-registry`）：断言 TS 常量与 schema `x-constants` 逐值一致；断言每个 `DFLT`/`KRAK` `observedVariant` 都符合 `DCX_` 前缀约定、`BND4` 恰为 `BND4_40_24`；断言 schema 内部 `$defs` 闭集与 `x-constants` 一致。

约定变化（例如 Bridge 输出新 variant）必须走 §3 的 MINOR 流程：先扩展冻结闭集，再让 native 门禁重新对账。

## 5. 跨机复现 manifest

`testdata/corpus/sekiro-1.6.corpus-manifest.json` 是本机 corpus 的**去重内容清单**（198 唯一内容条目），由 `scripts/build-release-corpus-manifest.mjs` 从本机生成的 registry（`%LOCALAPPDATA%/SoulForge/corpus-registries/v0.5/sekiro-1.6.release-corpus.json`）投影得到。manifest 只含元数据（`logicalId/sha256/size/containerChain/resourceKind/format/observedVariant` 与汇总），**不携带文件内容与本地路径**，可安全入库。

manifest 结构：

| 字段 | 说明 |
| --- | --- |
| `schemaVersion` | 与 registry schema 一致（`1.0.0`） |
| `manifestId` | 与源 registry 同源标识 |
| `game` / `gameBuild` | 与源 registry 一致 |
| `generatedAt` | 投影时间（RFC 3339） |
| `entryCount` | 唯一内容条目数 |
| `summary` | `uniqueContentEntries`、`formatCounts`、`observedVariantCounts`（`filesScanned` 是机器时间事实，manifest 不携带，由比对工具在目标机实际扫描报告） |
| `entries` | 唯一内容条目，字段与 registry entry 相同但只含上述七个数据字段 |

跨机比对工具 `scripts/verify-corpus-manifest.mjs`：

- 输入：manifest 路径（默认 `testdata/corpus/sekiro-1.6.corpus-manifest.json`）、corpus 根（`SOULFORGE_NATIVE_FIXTURE_ROOT` 或 `SOULFORGE_SEKIRO_GAME_ROOT`）、Bridge 可执行文件；
- 流程：扫描 corpus 根下全部 `.dcx` → 对每个文件算 sha256/size → 用 Bridge `read-dcx-document` 分类（`format`/`observedVariant` 换算同 §4）→ 与 manifest 按 sha256 匹配比对；
- 成功条件：manifest 每条唯一内容至少被一个文件匹配、无 sha256/size/分类不一致、无未识别 Bridge variant；
- 失败关闭：缺失条目、sha256/size/format/observedVariant 不一致、未知 Bridge variant、manifest 结构非法均 `exit=1` 并输出结构化诊断；
- 未匹配到 manifest 的文件（例如第二台机器独有的 mod）以 `extraFiles` 报告，不构成失败——manifest 不要求 corpus 恰好等于清单。

跨机复现的完整步骤（第二台机器）：

1. 配置 `SOULFORGE_SEKIRO_GAME_ROOT` 与 `SOULFORGE_NATIVE_FIXTURE_ROOT` 指向同一份 Sekiro 1.6 资源；
2. 用 `testdata/native-fixtures/has-game-registry.json` 的 12 个锚点做同构身份校验（`build-local-release-corpus-registry.mjs` 会对锚点做 sha256 断言）；
3. 运行 `node scripts/verify-corpus-manifest.mjs`，比对 sha256 与分类与入库 manifest 一致，即证明第二台机器重建出同一 registry。

## 6. 锚点覆盖评估（12 个跨机锚点）

`testdata/native-fixtures/has-game-registry.json` 的 12 个锚点按 DCX 信封变体分布如下：

| 观察到的 envelope 变体 | 覆盖锚点 | 数量 |
| --- | --- | --- |
| `DFLT_11000_44_9_0`（内嵌 BND4） | `dcx-dflt-c0000-anibnd`、`chrbnd-c1020`、`luabnd-aicommon`、`bnd4-menu-msgbnd` | 4 |
| `DFLT_11000_44_9_0`（纯 DFLT） | `emevd-common`、`emevd-m11` | 2 |
| `DFLT_10000_44_9_0`（纯 DFLT） | `msb-m11` | 1 |
| `KRAK_11000_44_6_0` | `dcx-krak-m10-emevd` | 1 |

当前本机 corpus 的全部 3 个观察变体（`DFLT_11000_44_9_0`、`DFLT_10000_44_9_0`、`KRAK_11000_44_6_0`）均已被锚点覆盖；`observedVariant` 冻结闭集中的其余值（`10000_24_9`、`10000_44_9`、`11000_44_8`、`11000_44_9`、`11000_44_9_15`、`KRAK_6`、`KRAK_9`）不属于本 corpus，属于其它构建族/样本，不要求在锚点中出现。跨机复现的完整变体覆盖由 §5 的 198 条 manifest 承担，锚点只负责「同构身份」证明。**结论：无需扩 DCX 容器分布锚点**；若未来登记其它游戏构建族，再按 §3 流程扩展冻结闭集并补充锚点。
