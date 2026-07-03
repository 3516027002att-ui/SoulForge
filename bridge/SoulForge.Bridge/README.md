# SoulForge.Bridge

C# helper process for SoulForge.

The bridge is responsible for FromSoftware resource inspection/export. v0.1 starts with a command shell that returns structured JSON and honest `unsupported` diagnostics until real parsers are implemented.

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
