# SoulForge v0.1 — Super Event Editor

## 1. Product target

SoulForge v0.1 is a lightweight AI-native event workbench for FromSoftware modding.

It opens a native ModEngine-style mod directory and builds an event-centered understanding layer across:

```text
event -> map -> param -> msg
```

The primary job of v0.1 is not to replace Smithbox/DSMapStudio. The primary job is to let humans and AI understand event logic with evidence:

- What event is this?
- Which flags does it read/write?
- Which map entities or regions does it reference?
- Which param rows may be involved?
- Which text entries give semantic meaning?
- Which conclusions are certain, and which are only guesses?

## 2. Non-goals for v0.1

v0.1 should intentionally avoid the giant trap of becoming a full 3D editor too early.

Not included in v0.1:

- Full 3D map viewport.
- Blender bridge implementation.
- Mesh/model editing.
- Animation/TAE editing.
- AI autonomous binary rewriting without validation.
- Full plugin system.
- Embedding/vector database/RAG.
- Local LLM runtime.
- Complete replacement for Smithbox.

## 3. Workspace model

SoulForge opens a native mod directory, usually a ModEngine overlay directory.

Example logical layout:

```text
<MOD_WORKSPACE>/
  event/
  map/
  param/
  msg/
  menu/
  script/
  action/
  ai/
  sfx/
  ...
```

The workspace may contain packaged FromSoftware resources such as:

```text
*.dcx
*.bnd
*.bdt
*.emevd.dcx
*.msb.dcx
*.parambnd.dcx
*.msgbnd.dcx
*.fmg
```

SoulForge should not require users to manually unpack these files before opening the workspace.

## 4. Architecture

Recommended monorepo structure:

```text
apps/desktop/
  Electron + React + TypeScript desktop shell

packages/shared/
  resource schemas, diagnostics, AI tool schemas

packages/core/
  workspace scanning, index management, reference graph, patch engine

bridge/SoulForge.Bridge/
  C# helper process for FromSoftware format inspection/export

mcp/
  future MCP adapter, not required for initial v0.1 execution

docs/
  project rules, architecture, Codex tasks
```

### 4.1 Desktop app

The desktop app owns the user experience:

- Home/start page.
- Recent projects.
- Workspace selector.
- Top editor-mode navigation.
- File/resource tree.
- Resource viewer.
- Reference panel.
- AI sidebar.
- Diagnostics/log panel.

It should not parse heavy binary formats in the renderer.

### 4.2 Core package

The core package owns common logic:

- Workspace discovery.
- Resource URI generation.
- Index schema.
- Search.
- Reference building.
- Patch proposal model.
- Validation result model.

### 4.3 Bridge

The bridge is a helper process, preferably C#, responsible for FromSoftware-specific binary inspection and JSON export.

The bridge should expose commands such as:

```text
soulforge-bridge inspect <file>
soulforge-bridge export-event <file>
soulforge-bridge export-map <file>
soulforge-bridge export-param <file>
soulforge-bridge export-msg <file>
```

Every command must return structured JSON. If a format is unsupported, it must return `parseStatus = "unsupported"` rather than pretending to parse.

## 5. UI structure

### 5.1 Start page

The start page should look like a real project tool rather than a toy file picker.

Core sections:

- Recent projects.
- Open mod directory.
- Game profile selector.
- Settings/API keys.
- Diagnostics/toolchain status.

### 5.2 Workspace shell

After opening a workspace, the top navigation should expose editor modes:

```text
Events | Params | Text | Maps | Files | AI | Settings
```

The top editor-mode navigation is inspired by the workflow of existing tools such as Smithbox, but SoulForge's implementation should be rewritten.

### 5.3 Layout

Recommended layout:

```text
+------------------------------------------------------------+
| Project / Game / Editor mode navigation                    |
+-------------------+---------------------+------------------+
| Resource tree     | Main resource view  | AI sidebar       |
|                   |                     | Evidence/tools   |
+-------------------+---------------------+------------------+
| Diagnostics / references / logs / patch preview             |
+------------------------------------------------------------+
```

The AI sidebar should be present in v0.1, but may initially function as a placeholder or tool console.

## 6. Resource model

Every indexed object should be addressable by a stable URI.

Examples:

```text
file://event/m11_00_00_00.emevd.dcx
event://m11_00_00_00/11002800
map://m11_00_00_00/entity/1102800
param://SpEffectParam/123456
msg://item/1000
```

### 6.1 Resource metadata

Minimum resource metadata:

```ts
interface ResourceMeta {
  sourceUri: string;
  sourcePath: string;
  game: string;
  resourceKind: 'event' | 'map' | 'param' | 'msg' | 'menu' | 'script' | 'action' | 'ai' | 'sfx' | 'unknown';
  parseStatus: 'unparsed' | 'parsed' | 'unsupported' | 'failed';
  diagnostics: Diagnostic[];
}
```

## 7. Event understanding pipeline

### 7.1 Scan

Scan the workspace for event-related directories and packaged resources.

Do not deep parse everything on startup. Start with lightweight indexing:

- path
- extension
- resource kind guess
- size
- mtime
- optional/lazy hash

### 7.2 Inspect

When a resource is opened or scheduled for indexing, call the bridge to inspect it.

Inspection should determine:

- resource type
- container status
- known inner files
- whether deep export is supported

### 7.3 Export

Deep export converts binary resources into JSON symbols.

Event export should include:

- event file/map id
- event ids
- instruction list
- numeric arguments
- called events
- flag operations when recognizable
- raw diagnostic data

Map export should include:

- map id
- parts
- regions
- entity ids
- names
- models
- positions
- rotations
- raw diagnostic data

Param export should include:

- param name
- row id
- row name if available
- fields
- raw diagnostic data

Msg export should include:

- text category if known
- text id
- text
- raw diagnostic data

### 7.4 Index

Persist exported symbols into SQLite.

Use SQLite + FTS5 for:

- file search
- event search
- map entity search
- param row search
- text search

### 7.5 Build references

Reference building should start conservative.

High-confidence examples:

- Event instruction has a recognized Entity ID argument and matches a map entity.
- Event calls another event by event id.
- Event reads/writes a recognized flag argument.
- Text ID is referenced by a known instruction or known table field.

Lower-confidence examples:

- A numeric argument matches multiple params.
- A numeric argument appears in several resource categories.
- A match comes only from raw number search without instruction semantics.

References must include confidence and reason.

## 8. AI sidebar

The AI sidebar must be in the product shell but does not need to be fully wired on day one.

Required UI concepts:

- Provider: OpenAI / Anthropic / mock.
- Thinking intensity: fast / normal / deep / extreme.
- Plan mode: AI proposes steps and patch, no execution.
- Full-permission mode: AI may run approved tools automatically, but cannot bypass Patch Engine.
- Current context: selected resource + references + diagnostics.

AI tools should operate on SoulForge's indexed resource graph, not raw filesystem guessing.

Initial tool set:

```text
search_resources(query, kinds?)
open_resource(uri)
list_events(filter?)
open_event(uri)
find_references(uri)
open_map_entity(uri)
open_param_row(uri)
open_text(uri)
explain_event(uri)
```

## 9. Write safety model

Although v0.1 may include write-capable architecture, all saves must go through a staging/validation pipeline.

### 9.1 Save pipeline

```text
request change
  -> generate patch proposal
  -> apply patch to staging copy
  -> run validation against staging copy
  -> if valid, backup original
  -> atomic replace original
  -> re-parse saved resource
  -> update index
  -> write operation log
```

### 9.2 Validation

Validation should include:

- File can be reopened.
- Container can be inspected.
- Target resource can be exported again.
- Resource count does not unexpectedly collapse.
- Diagnostics are not worse than before unless explicitly allowed.

### 9.3 Failure behavior

Normal mode:

- Stop.
- Do not save.
- Show diagnostics to user.

Plan mode:

- Never save.
- Show patch and validation plan only.

Full-permission mode:

- AI may retry against staging copies only.
- Retry count must be limited.
- Original files remain untouched until validation passes.

## 10. Lightweight design principles

SoulForge should not become a resource hog.

Rules:

- Lazy parse.
- Incremental index.
- Cancelable background jobs.
- Virtualized lists.
- No 3D viewport in v0.1.
- No embeddings in v0.1.
- No local LLM runtime in v0.1.
- Bridge process should be CLI-style at first; daemon mode can come later only if needed.
- Large resource bodies should not live in React state.

## 11. v0.1 acceptance picture

A successful v0.1 demo should look like this:

1. User opens a ModEngine-style native mod directory.
2. SoulForge scans event/map/param/msg resources without unpacking everything manually.
3. User opens an event.
4. SoulForge shows the event structure.
5. The right panel shows referenced map entities, params, texts, and confidence labels.
6. The AI sidebar can summarize the event using only indexed evidence.
7. Unsupported resources are reported honestly.
8. The app stays responsive and does not eagerly load the whole project.

If this works, SoulForge has already become something different from a normal editor: it is a FromSoftware mod understanding layer.