# SoulForge Codex Task Chain

This file contains the first implementation tasks for Codex.

Do not ask Codex to build the full editor in one pass. Use these tasks in order.

## Task 0 — Read project rules

Before coding, read:

- `README.md`
- `AGENTS.md`
- `docs/V0_1_SUPER_EVENT_EDITOR.md`
- `docs/CORE_LOGIC.md`

Then summarize the current milestone and constraints in your own words.

Do not start implementation before acknowledging the hard constraints:

- v0.1 must be lightweight.
- No direct writes into mod workspaces.
- All saves must go through Patch Engine.
- Unsupported parsers must fail honestly.
- No 3D viewport, embeddings, or Blender bridge in v0.1.

---

## Task 1 — Initialize monorepo skeleton

Goal: create a clean monorepo skeleton without implementing heavy features.

Requirements:

1. Use npm workspaces unless there is a strong reason not to.
2. Create this layout:

```text
apps/desktop/
packages/shared/
packages/core/
bridge/SoulForge.Bridge/
docs/
```

3. `apps/desktop` should be an Electron + React + TypeScript app.
4. It should have dev/build/typecheck scripts.
5. The app should start to a simple Home page.
6. The Home page should show:
   - SoulForge title.
   - Current milestone: Super Event Editor v0.1.
   - Button placeholder: Open Mod Workspace.
   - AI sidebar placeholder status.
7. Add minimal lint/typecheck setup.
8. Do not add 3D rendering, AI SDKs, database libraries, or bridge parsing yet.

Acceptance:

- `npm install` works.
- `npm run typecheck` works.
- `npm run build` works if packaging is not required yet.
- `npm run dev` starts the desktop app.

---

## Task 2 — Add shared schemas

Goal: define TypeScript schemas and types used by the app and core modules.

Create shared types for:

- `Diagnostic`
- `ParseStatus`
- `ResourceKind`
- `ResourceMeta`
- `IndexedFile`
- `ReferenceEdge`
- `ReferenceEvidence`
- `PatchProposal`
- `PatchChange`
- `ValidationResult`

Requirements:

1. Put shared definitions in `packages/shared`.
2. Export them from a single public entry point.
3. Keep identifiers in English.
4. Do not depend on renderer-specific code.
5. Add basic unit tests or type-level smoke tests if the project setup supports it.

Acceptance:

- Desktop and core packages can import shared types.
- Typecheck passes.

---

## Task 3 — Workspace scanner, read-only

Goal: implement read-only workspace scanning.

Requirements:

1. Implement scanning in `packages/core`.
2. Scan known directories:

```text
event
map
param
msg
menu
script
action
ai
sfx
```

3. Generate `IndexedFile` records.
4. Classify resource kind by path and extension.
5. Record path, relative path, size, mtime, extension, resource kind, and parse status.
6. Do not hash every file by default.
7. Do not parse binary files yet.
8. Do not write into the workspace.
9. Add cancellation/progress structure if practical.

Acceptance:

- A mock workspace can be scanned.
- Scanner returns stable `file://...` URIs.
- Unsupported files do not crash the scanner.
- Tests confirm no files are created inside the workspace.

---

## Task 4 — Electron IPC for workspace opening

Goal: connect the desktop UI to the scanner safely.

Requirements:

1. The renderer must not access the filesystem directly.
2. Implement main-process IPC commands:

```text
openWorkspaceDialog
scanWorkspace
searchIndexedFiles
openResourcePreview
```

3. `openWorkspaceDialog` lets user select a directory.
4. `scanWorkspace` calls core scanner.
5. `openResourcePreview` returns metadata and either text preview or hex preview.
6. Binary previews should be limited in size.
7. Renderer shows:
   - workspace path
   - indexed file count
   - resource kind counts
   - file list/tree

Acceptance:

- User can choose a folder.
- App scans known directories.
- UI stays responsive for small mock workspace.
- Binary file preview does not load entire large file.

---

## Task 5 — Add lightweight index storage

Goal: add SQLite + FTS5-backed index storage.

Requirements:

1. Use SQLite for file index and search.
2. Store only metadata and small searchable text snippets initially.
3. Do not store large binary data.
4. Index database should live outside the mod workspace, under app data/cache.
5. Implement tables for:
   - workspaces
   - files
   - diagnostics
6. Add FTS table for file path/name search.
7. Keep schema migrations simple and explicit.

Acceptance:

- Scan results persist in SQLite.
- Reopening workspace can reuse existing index when mtime/size did not change.
- Search returns files by name/path.
- Database is not created inside the mod workspace.

---

## Task 6 — Add C# bridge skeleton

Goal: create `SoulForge.Bridge` command-line helper structure.

Requirements:

1. Create a C# console project at `bridge/SoulForge.Bridge`.
2. Implement commands:

```text
inspect <file>
export-event <file>
export-map <file>
export-param <file>
export-msg <file>
```

3. For now, commands may return `unsupported` for real binary resources.
4. Output must be JSON following the `BridgeResult<T>` shape from `docs/CORE_LOGIC.md`.
5. Include source path, resource kind, parse status, and diagnostics.
6. Never throw unstructured errors to stdout.
7. Add bridge README explaining how the TypeScript app should call it.

Acceptance:

- `dotnet build` succeeds.
- Running unsupported command returns valid JSON.
- Errors return JSON diagnostics.

---

## Task 7 — Bridge runner in TypeScript

Goal: let the Electron main process call the C# bridge safely.

Requirements:

1. Add a bridge runner module in `packages/core` or `apps/desktop/src/main`.
2. It should spawn the bridge process with timeout.
3. It should parse JSON output.
4. It should convert failures/timeouts into structured diagnostics.
5. It should not block the renderer.

Acceptance:

- App can call `inspect` on a selected file.
- Unsupported files show honest diagnostics.
- Timeout does not crash the app.

---

## Task 8 — Resource viewer and diagnostics panel

Goal: make the app useful before deep parsing exists.

Requirements:

1. File/resource list on the left.
2. Main resource viewer in the center.
3. Right AI/sidebar placeholder.
4. Bottom diagnostics panel.
5. Text files show text preview.
6. Binary files show metadata and hex preview.
7. Bridge diagnostics are visible.

Acceptance:

- User can inspect files without crashing.
- Unsupported binary resources are clearly marked.
- No false claims of parsing.

---

## Task 9 — Event-resource reference skeleton

Goal: prepare the data model for real event intelligence.

Requirements:

1. Add tables/types for:
   - event symbols
   - map entities
   - param rows
   - text entries
   - reference edges
2. Add a reference builder interface.
3. Implement only trivial/mock reference building for synthetic test data.
4. Support confidence values: high / medium / low.
5. UI can display references for selected resources.

Acceptance:

- Mock event can reference mock map entity.
- UI displays reference edge with confidence and reason.
- No numeric guess is labeled high-confidence without explicit rule.

---

## Task 10 — AI sidebar placeholder/tool console

Goal: reserve the AI-native UX without requiring real model API integration yet.

Requirements:

1. Add right sidebar with tabs or sections:
   - Context
   - Tools
   - Plan
   - Settings
2. Add provider selector UI:
   - Mock
   - OpenAI
   - Anthropic
3. Add thinking intensity selector:
   - fast
   - normal
   - deep
   - extreme
4. Add mode selector:
   - plan
   - normal
   - full permission
5. Do not require API keys yet.
6. Mock mode can call local tools like search/open/find references.

Acceptance:

- Sidebar exists and does not consume model/API resources when idle.
- Mock tool console can search indexed files.
- UI clearly says model integration is not required for v0.1 skeleton.

---

## Task 11 — Patch Engine skeleton, no real writes yet

Goal: define the safety pipeline before enabling editing.

Requirements:

1. Add Patch Engine module.
2. Implement patch proposal objects.
3. Implement staging directory creation outside workspace.
4. Implement validation result model.
5. Implement dry-run validation for mock/text files.
6. Do not enable binary writes yet.
7. Add tests proving original workspace files are untouched after validation failure.

Acceptance:

- Patch proposals can be created.
- Staging copy can be created.
- Validation failure prevents save.
- Original files remain unchanged.

---

## Task 12 — First real parser integration planning

Goal: do not jump into parser code blindly.

Before implementing SoulsFormats integration, Codex should produce a short technical note:

- Which library/package will be used.
- How it will be referenced.
- Which formats will be attempted first.
- Which game profile will be used for tests.
- How unsupported/failed parse statuses are represented.
- How no game assets will be committed.

No real parser implementation should begin until this note is reviewed.

---

# Recommended execution order

Start with:

1. Task 0
2. Task 1
3. Task 2
4. Task 3
5. Task 4

Only after the desktop shell and read-only scanner work should Codex move to SQLite, Bridge, and parser work.

The first satisfying milestone is not "full event parsing".

The first satisfying milestone is:

```text
Open workspace -> scan safely -> preview files -> show diagnostics -> no workspace writes -> app remains lightweight
```

That is the foundation for everything else.