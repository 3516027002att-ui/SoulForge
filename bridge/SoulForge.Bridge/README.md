# SoulForge.Bridge

SoulForge 的 C# 原生格式辅助进程。

当前产品里程碑是 V0.5，唯一实施标准见 [`docs/V0_5_IMPLEMENTATION_HANDOFF.md`](../../docs/V0_5_IMPLEMENTATION_HANDOFF.md)。Bridge 已切换到 .NET 10、自包含 `win-x64` 与 `1.0.0` NDJSON 常驻协议；现有格式能力仍只有受限检查、synthetic 样本验证和候选导出，尚未完成 KRAK/BND4 以及四类语义资源原生写回闭环。未达到 `native-verified` 的能力不得宣称为原生权威。

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

`inspect` performs a bounded prefix read only. It reads at most 512 KiB with
`FileShare.ReadWrite`, checks envelope magic at offset 0, and returns evidence
plus next steps. It does not decompress, unpack, or semantically parse resources.

## 当前命令

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

Packed DCX/BND containers remain semantic export boundaries until decompression/unpacking exists.

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
