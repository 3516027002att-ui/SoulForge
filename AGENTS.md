# SoulForge AGENTS.md

These rules are mandatory for Codex and all AI coding agents working in this repository.

## Project identity

SoulForge is an AI-native mod workbench for FromSoftware games.

Current milestone: **Super Event Editor v0.1**.

The v0.1 goal is to open a native ModEngine-style mod directory, inspect event-related packaged resources, build a lightweight searchable index, and provide an AI-ready evidence chain for event understanding.

## Hard constraints

1. v0.1 must be lightweight. Do not eagerly parse all resources on startup.
2. The renderer process must not access the filesystem directly. Filesystem access belongs to the Electron main process and bridge processes.
3. Do not write into user mod workspaces directly. All writes must go through the Patch Engine.
4. Direct `fs.writeFile` to mod resources is forbidden outside the Patch Engine.
5. Do not claim a binary format is parsed unless a real parser implementation exists.
6. Unsupported formats must return structured diagnostics with `parseStatus = "unsupported"`.
7. Failed parses must return structured diagnostics with `parseStatus = "failed"`.
8. All resource outputs must include `sourceUri`, `sourcePath`, `game`, `resourceKind`, and `diagnostics`.
9. AI explanations must be evidence-based. If the index has no evidence, return `insufficient_evidence` instead of guessing.
10. External FromSoftware modding tools may be studied as references only. Do not copy their source code into this repository.
11. No real game assets, unpacked copyrighted data, or user mod files should be committed.
12. Keep mock data tiny and synthetic.

## Performance rules

SoulForge should feel closer to a lightweight workspace tool than a heavy 3D editor.

- Do not load full maps, params, or text databases into the renderer at startup.
- Use lazy parsing and incremental indexing.
- Long tasks must run asynchronously and report progress.
- Long tasks must be cancelable where practical.
- Bridge processes must have timeouts.
- Use virtualized lists for large tables.
- Do not add Blender, 3D map rendering, embedding/vector search, or local LLM runtimes in v0.1.
- AI sidebar must be optional and idle by default.

## v0.1 resource priority

Deep parsing targets:

1. `event` — EMEVD/event resources.
2. `map` — MSB map entity and region symbols.
3. `param` — PARAM rows and fields.
4. `msg` — FMG text entries.

File-level indexing only for v0.1:

- `menu`
- `script`
- `action`
- `ai`
- `sfx`
- other unknown resources

## Architecture rules

Preferred monorepo layout:

```text
apps/desktop/              Electron + React + TypeScript app
packages/shared/           shared TypeScript types and schemas
packages/core/             workspace, index, references, patch logic
bridge/SoulForge.Bridge/   C# helper for FromSoftware resource inspection/export
mcp/                       future MCP server adapter, not required for v0.1
docs/                      design notes and Codex tasks
```

The Electron app should call the C# bridge as a helper process. TypeScript should not directly reimplement all FromSoftware binary parsing.

## Patch Engine rules

Saving must follow this pipeline:

```text
change request
  -> patch proposal
  -> apply patch to staging copy
  -> validate staged files
  -> backup original files
  -> atomic replace
  -> re-read/re-parse saved files
  -> update index
  -> write operation log
```

If validation fails:

- Normal mode: stop and return diagnostics to the user.
- Plan mode: stop before execution and show the plan/diff only.
- Full-permission mode: AI may retry against staging copies only, up to a small configured retry limit. It must not damage original files.

## AI rules

The AI sidebar is part of the product shell, but model integration may start as a placeholder/tool-console mode.

Provider abstraction should allow:

- OpenAI-compatible provider.
- Anthropic-compatible provider.
- Mock/local tool-console provider.

Supported UX concepts:

- Thinking intensity: `fast`, `normal`, `deep`, `extreme`.
- Plan mode: AI proposes a plan and diff, but does not execute.
- Full-permission mode: AI may run approved tools automatically, but still cannot bypass the Patch Engine.

## CodexPro bridge

CodexPro is available as a development-time bridge for connecting ChatGPT Developer Mode to this local repository. It is not part of the SoulForge Electron runtime and must not be treated as a production feature.

Use it when another ChatGPT/Codex conversation needs to inspect or edit this repository through a local MCP bridge:

```powershell
cd D:\Repository\SoulForge
npm run codexpro:start
```

Default behavior in this repository:

- ChatGPT may read and edit SoulForge source files inside this workspace.
- Bash is `safe` and requires the CodexPro bash session id `soulforge`.
- Runtime Server URLs and tokens are temporary; do not commit them.
- If a task should only create a plan and not edit files directly, use `npm run codexpro:start:handoff`.

For copy-paste startup instructions, read `docs/CODEXPRO_QUICKSTART.md`.

## Testing rules

Every core module must be testable with synthetic mock workspaces.

Minimum tests for v0.1:

- Workspace scanning does not write into the workspace.
- Unsupported binary files return diagnostics instead of crashing.
- Search returns paths and source URIs.
- Reference builder distinguishes high-confidence and lower-confidence references.
- Patch Engine validation failure does not alter original files.

## Coding style

- Prefer small, explicit modules.
- Prefer typed schemas over ad-hoc objects.
- Prefer structured diagnostics over thrown opaque errors.
- Keep user-facing strings ready for Chinese UI, but keep internal code identifiers in English.
- Avoid premature plugin systems, 3D rendering, embeddings, or real AI execution before the core event-resource pipeline works.
