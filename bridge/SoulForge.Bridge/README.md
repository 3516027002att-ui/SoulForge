# SoulForge.Bridge

SoulForge 的 C# 原生格式辅助进程。

当前产品里程碑是 V0.5，唯一实施标准见 [`docs/V0_5_IMPLEMENTATION_HANDOFF.md`](../../docs/V0_5_IMPLEMENTATION_HANDOFF.md)。Bridge 已切换到 .NET 10、自包含 `win-x64` 与 `1.0.0` NDJSON 常驻协议，并已有 DFLT、DFLT 外层 BND4、FMG、PARAM、EMEVD、MSB 的分层实现与真实样本 smoke。它们的 authority 必须按命令结果分别解释：DFLT 与部分语义样本已有 `native-verified` 证据，registry/hash 绑定的真实 Oodle/KRAK 解压成功路径已验证，BND4/MSB 公共文档仍返回 `candidate`；KRAK 重压与完整发布 corpus 仍未完成。任何子能力通过都不代表完整 P2/P3 或 V0.5 完成。

本机没有全局 .NET 10 SDK 时：

```powershell
.\scripts\install-dotnet-sdk.ps1
npm run bridge:build
```

SDK 安装在 `%LOCALAPPDATA%\SoulForge\dotnet`，不写入仓库；项目脚本会自动发现。

## 常驻协议

```powershell
npm run bridge:build
.\bridge\SoulForge.Bridge\bin\Debug\net10.0\win-x64\SoulForge.Bridge.exe daemon
```

stdin/stdout 每行一个 JSON 帧。首帧必须是 `handshake`，由 Electron main 提供 `workspaceSessionId`、允许根目录、帧大小和并发限制；随后可发送 `request`、`cancel`、`health` 和 `capabilities`。返回事件为 `request/accepted`、`progress`、`result`、`failed` 或 `cancelled`。Bridge 会再次验证真实路径，拒绝允许根目录外路径和 junction/symlink 越界。

验证：

```powershell
npm run bridge:verify:daemon
npm run bridge:verify:client
```

`inspect` 仍只做 bounded envelope evidence；原生解压、文档读取和暂存写入由下列独立命令处理，不能从 `inspect` 结果推断语义 authority。

Oodle 验证分为两类：`npm run bridge:verify:oodle` 只验证缺失、版本、架构、加载和导出错误会失败关闭；`npm run bridge:verify:oodle:real` 必须使用合法 Sekiro 目录和私有 KRAK DCX 完成真实解压。前者通过不能替代后者，也不能把 KRAK 标为 `native-verified`。

## 当前 daemon 原生命令

- `probe-oodle`
- `read-dcx-document`
- `snapshot-bnd4-child`
- `extract-bnd4-child`（大子项写入 main 授权的暂存区，避免 Base64 帧膨胀）
- `write-bnd4`
- `read-fmg-document` / `write-fmg`
- `read-param-document` / `write-param`
- `read-emevd-document` / `write-emevd`
- `read-msb-document` / `write-msb`

writer 只允许写 main 注册的 `writableRoots` 暂存目录，不得直接写 Mod。
`extract-bnd4-child` 同样受 `writableRoots`、容器 hash、子项 hash 和提取后重读 hash 约束；它是大子项的 file-backed 读取通道，不是绕过 Patch Engine 的 Mod 写入口。

`read-param-document` 的 daemon `options` 支持 `rowOffset`、`rowLimit`（1..500）、`rowId` 和 `includePayloads`。分页与按 ID 筛选在 Bridge 内执行；单次所选行 payload 合计超过 256 KiB 时只返回 row hash 和结构化省略原因，调用方不得先取全表再在 TypeScript 中伪分页。用户派生字段修改由 core 校验定义、旧 row hash 和字段字节范围后编译为完整 row，再复用 `write-param` 写暂存区并按 hash 重读；这不表示 Bridge 已解析官方 `.paramdef`。

`read-fmg-document` 为每个条目返回连续 `stringIndex`、`id`、文本，以及 source/document hash、revision、schema/layout 绑定。`write-fmg` 的 typed 路径支持已有槽位 `set_text`、精确槽位 `delete`、`insert` 和 `reorder`；源槽位与重排锚点都必须同时匹配 `stringIndex + id`。reorder 使用 move-before 语义，无锚点表示 append，并在写后重读比较完整槽位顺序；重复 ID 不能退回 ID-only 查找。当前证据只覆盖已抽取/Mod 工作区 raw `.fmg`，嵌套 msgbnd 单事务字段替换与完整发布 corpus 未完成。

`read-emevd-document` 可直接读取 raw `EVD` 或 `.emevd.dcx`，并为每个事件返回文档修订内的 `eventIndex` 与由完整事件语义计算的 `eventHash`。请求 `snapshotEventIndex` 时还会返回 `soulforge.emevd.event-semantic-v1` / `1.0.0` 完整事件快照，覆盖 ID/rest、全部 instruction bank/id/layer/args 和 parameter substitution；快照必须为 canonical Base64、SHA-256 与 `eventHash` 一致且不超过 256 KiB。请求 instruction snapshot/order 时返回 `soulforge.emevd.instruction-semantic-v1` / `1.0.0` 快照及父事件完整指令顺序；instructionHash 同时覆盖 bank/id/layer/args 和附属 parameter substitution，快照与完整事件投影均受 256 KiB 单事件边界约束。请求 `authorInstruction*` 完整字段时，Bridge 还可为指定父事件和插入位置生成 `layerOffset=-1`、零 parameter substitution 的 canonical instruction snapshot；该能力只编码原生结构，不声称 raw args 已通过 EMEDF 类型校验。为保证 delete inverse 精确恢复原参数表顺序，该 typed 路径还要求父事件的 parameter substitution 按 instructionIndex 非递减分组，遇到非分组布局失败关闭。`insert_event_snapshot` / `insert_instruction_snapshot` 只接受完整 format/schema/hash/索引绑定，用于 PatchIR inverse 的精确原位恢复。`sourceHash`/`sourceSize` 指输入容器的外层字节，`documentHash`/`documentSize` 指解压后的 EMEVD 文档；`write-emevd` 使用 `expectedSourceHash` 校验前者，旧 `expectedDocumentHash` 仅作为兼容别名，两者同时提供却不一致时失败关闭。真实 EMEVD 的事件 ID 可能重复，因此 ID-only mutation 只在 ID 唯一时接受；重复 ID 必须同时绑定外层 hash、`eventIndex` 和预期 `eventId`，索引越界、ID 不匹配或 ID-only 歧义均失败关闭。`add_event` 只追加 ID 唯一的空事件；`reorder_event` 同时绑定源事件与可选 move-before 锚点的 index/ID，省略锚点表示追加，并拒绝无变化重排。instruction 增删、复制和重排还必须绑定事件 occurrence、事件内局部索引及预期 bank/id；GC 会同步移动、删除、克隆或按原顺序恢复 event-local parameter substitution，目标指令与参数字节范围在读取和重建时都验证。envelope 只返回最多 256 条普通 instruction/parameter substitution 样本；完整顺序仅在显式、受界请求时返回。writer 仅写暂存区；raw 与 DFLT 外层可写，KRAK 重压未启用，非零 layer 因尚未解析而拒绝读取和写入。落盘后必须同时重读外层容器和内层文档，并要求二者与已验证重建结果一致。

仓库外 registry 中登记的 EMEVD corpus 可运行：

```powershell
npm run bridge:verify:emevd:corpus -- <registry.json> <fixture-root>
```

当前实测 10 个 DFLT-wrapped EMEVD 均可直接经 `.emevd.dcx` 完成暂存与重读，事件和 instruction 的增删、复制/删除、重排/逆操作都恢复内层 `documentHash`；`common_func` 额外验证 parameter substitution 在插入/重排时重映射、在复制时克隆。zlib 重压保持 payload/variant，但 10/10 外层字节均不相同，因此精确外层回滚依赖 Patch Engine 的事务备份。`npm run bridge:verify:emevd:transaction` 已验证 `common.emevd.dcx` 的字段编辑、空事件新增、既有非空事件删除/复制、事件完整顺序重排，以及 instruction 零参数新增、既有指令复制/删除/重排 typed PatchIR；新增指令由 Bridge 生成 canonical snapshot，实测 `parameterCount=0`、`layerOffset=-1`。事件快照恢复 7 条 instruction/6 条 parameter substitution，instruction 快照恢复目标的 2 条 parameter substitution。上述子能力的 resource-entry rollback 恢复原 `documentHash`/完整顺序，operation rollback 恢复提交前外层字节。10 个样本的 `layerCount` 全为 0；33 个 KRAK EMEVD 仍因缺合法 Oodle runtime 未进入语义验证。该结果不等于 EMEDF-aware typed authoring、完整三层回滚 corpus、完整 EMEDF、类型转换、专业四视图或 P3 完成；当前 `common` 语料也未提供可用于 typed delete 正向验证的重复 ID 非空事件 occurrence。

## 兼容的一次性候选命令

```bash
dotnet run --project bridge/SoulForge.Bridge -- inspect <file>
dotnet run --project bridge/SoulForge.Bridge -- export-event <file>
dotnet run --project bridge/SoulForge.Bridge -- export-map <file>
dotnet run --project bridge/SoulForge.Bridge -- export-param <file>
dotnet run --project bridge/SoulForge.Bridge -- export-msg <file>
dotnet run --project bridge/SoulForge.Bridge -- validate <file>
```

`validate` only checks that a file can be opened and reports basic metadata. It
does not claim to parse FromSoftware binary formats.

## 当前导出置信等级

`export-msg` has three deliberately separate paths:

1. `MSG_FMG_SYNTHETIC_FIXTURE_CONFIRMED`: confirms SoulForge's reviewed synthetic FMG fixture layout and bridge plumbing. It does not claim native game-format authority.
2. `MSG_FMG_TABLE_CANDIDATE`: guarded FMG-like table candidate. Stronger than raw string scan, but still candidate evidence.
3. `MSG_TEXT_EXPORT_PARTIAL`: bounded readable-string fallback. File offsets are temporary text IDs.

`export-event`, `export-param`, and `export-map` currently emit low-confidence bootstrap candidates only. They preserve enough structure for the evidence graph while avoiding fake authoritative parsing.

这些 `export-*` 命令是历史候选/fixture 兼容入口，不是 daemon 原生文档命令，也不能覆盖上述真实格式命令返回的 authority。

## 冒烟验证

```powershell
.\bridge\SoulForge.Bridge\scripts\verify-magic.ps1
.\bridge\SoulForge.Bridge\scripts\verify-fmg-fixture.ps1
```

## 兼容的一次性命令契约

All commands write one JSON object to stdout.

The desktop app should parse stdout as a `BridgeResult<T>` shape:

```json
{
  "sourceUri": "file://...",
  "sourcePath": "...",
  "game": "unknown",
  "resourceKind": "event",
  "parseStatus": "unsupported",
  "diagnostics": [],
  "data": null
}
```

不要依赖只供人阅读的控制台文本。一次性命令只用于 fixture 脚本和人工诊断；桌面生产路径由 TypeScript 常驻客户端复用 `1.0.0` daemon，不得重新扩展一次性生产协议。
