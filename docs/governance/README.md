# 治理数据（机器可读权威）

本目录是 SoulForge 发布治理的**唯一机器可读权威**。门禁只读这里，不再对
`docs/V0_5_IMPLEMENTATION_HANDOFF.md` 做正则解析。

## 权威归属

| 文件 | 权威内容 | 迁移来源 |
| --- | --- | --- |
| `releases.json` | 版本注册与冻结状态；`frozenFields` 定义门禁物理拦截范围 | 新建 |
| `scope.json` | 27 项范围裁定矩阵、用户批准记录、各项政策 | §18.2.1 冻结 JSON |
| `gates.json` | 11 个必需 Gate 的 `gateState`/`applicability`/引用/后继要求 | §18.1 + §18.3 + `scope.gateCoverage` |
| `slices.json` | 39 个切片的 `lifecycle`/`authority`/`authorityCap`/入口/验证；`activeClaims` 并发占用 | §13.1 + §13.1.1 |
| `validation.json` | 已冻结验证四元组与显式未冻结清单 | §13.4 |
| `blockers.json` | 阻塞项、所需输入、解锁验证、复检触发 | §18.4 |
| `evidence.jsonl` | 实施证据记录（JSONL：并行 agent 追加不产生合并冲突） | §17.1 |
| `schema/*.schema.json` | draft-07，全部 `additionalProperties: false` | 新建 |

交接书中的对应章节改为由这些文件**投影生成**，不再是权威。人工编辑交接书的治理章节
不会改变门禁判定，只会被下一次生成覆盖。

## 跨版本设计

范围条目不按版本拆文件，`scope.json` 用字段区分：

- `targetRelease`：条目最初归属的版本；
- `deferredToRelease`：非空表示已裁定延期，此时 `operations` 必须为空
  （否则等于宣称延期能力仍在本版可用）；
- `deferredTrack`：延期后归属的技术线；
- `resumeRequires`：恢复该条目的强制前置顺序，schema 要求非空。

`releases.json` 的 `frozenFields` **只包含用户裁定字段**。工程进度字段
（`gates[].gateState`、`slices[].lifecycle`、`slices[].authority`、evidence 追加）
不在冻结范围内——否则 V0.5 冻结后自身无法继续推进。

## 修改约束

1. 改数据前先读对应 schema。schema 是 `additionalProperties: false`，加字段必须同步改 schema。
2. `releases.json` 中 `frozen: true` 的版本，其 `frozenFields` 列出的字段由门禁物理拦截；
   需要变更必须先有新的用户裁定并登记 `scope-ruling:user-approved` 证据。
3. `evidence.jsonl` 只追加，不改写既有行。只有 `sealed-current-run` 能用于完成 Gate。
4. `authority` 与 `lifecycle` 的枚举含义见 `docs/V0_5_IMPLEMENTATION_HANDOFF.md`；
   `unsupported`/`candidate`/`fixture-confirmed`/`partial`/`native-verified`/`blocked`/`unverified`
   必须严格区分，不得因为门禁通过而升级。
