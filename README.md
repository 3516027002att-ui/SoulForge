# SoulForge

SoulForge is an AI-native mod workbench for FromSoftware games.

The first milestone is **Super Event Editor v0.1**: a lightweight desktop application that opens a native ModEngine-style mod directory, reads packaged resources such as DCX/BND/EMEVD/MSB/PARAM/FMG, and builds an evidence-based event understanding workspace.

## Product direction

SoulForge is not a Smithbox clone. Existing tools are references for user experience and domain coverage, but SoulForge rewrites its own architecture around AI-native workflows:

- Open a native mod directory without requiring manual unpacking.
- Understand event-related resources across `event`, `map`, `param`, and `msg`.
- Turn opaque numeric IDs into traceable symbols and references.
- Show evidence chains before AI explains or changes anything.
- Use a staging/validation/backup/rollback pipeline before saving changes.
- Keep resource usage low by indexing and parsing lazily.

## v0.1 scope

Core resource chain:

```text
event -> map -> param -> msg
```

Secondary resources such as `menu`, `script`, `action`, `ai`, and `sfx` may be indexed at file level but are not deep parsing targets for v0.1.

## Technical direction

- Desktop shell: Electron + React + TypeScript.
- Bridge/parser layer: C# helper process.
- Index: SQLite + FTS5.
- AI: right sidebar with provider abstraction for OpenAI and Anthropic, initially allowed to run as a placeholder/tool-console mode.
- External tools: reference only. Do not copy Smithbox/DSMapStudio/DarkScript implementation code.

## Safety direction

All writes must go through SoulForge's patch engine:

```text
AI/user change request
  -> patch proposal
  -> staging copy
  -> validation
  -> backup original
  -> atomic save
  -> re-index
  -> rollback available
```

Direct writes to mod files are forbidden.