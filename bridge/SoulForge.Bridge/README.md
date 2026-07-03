# SoulForge.Bridge

C# helper process for SoulForge.

The bridge is responsible for FromSoftware resource inspection/export. v0.1 starts with a command shell that returns structured JSON and honest `unsupported` diagnostics until real parsers are implemented.

`inspect` performs a bounded prefix read only. It reads at most 512 KiB with
`FileShare.ReadWrite`, checks envelope magic at offset 0, and returns evidence
plus next steps. It does not decompress, unpack, or semantically parse resources.

## Commands

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

## Export confidence tiers

`export-msg` has three deliberately separate paths:

1. `MSG_FMG_SYNTHETIC_FIXTURE_CONFIRMED`: confirms SoulForge's reviewed synthetic FMG fixture layout and bridge plumbing. It does not claim native game-format authority.
2. `MSG_FMG_TABLE_CANDIDATE`: guarded FMG-like table candidate. Stronger than raw string scan, but still candidate evidence.
3. `MSG_TEXT_EXPORT_PARTIAL`: bounded readable-string fallback. File offsets are temporary text IDs.

`export-event`, `export-param`, and `export-map` currently emit low-confidence bootstrap candidates only. They preserve enough structure for the evidence graph while avoiding fake authoritative parsing.

Packed DCX/BND containers remain semantic export boundaries until decompression/unpacking exists.

## Smoke checks

```powershell
.\bridge\SoulForge.Bridge\scripts\verify-magic.ps1
.\bridge\SoulForge.Bridge\scripts\verify-fmg-fixture.ps1
```

## Contract

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

Never rely on human-only console text.
