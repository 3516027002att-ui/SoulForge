# SoulForge

SoulForge is an AI-native mod workbench for FromSoftware games.

The project started from **Super Event Editor v0.1**, but the roadmap has now expanded into a full **Super Editor**: a unified desktop workbench for opening native ModEngine-style mod directories, understanding event/map/param/msg relationships, editing resources safely, and eventually allowing AI to perform approved global mod changes through the Patch Engine.

## Project source

SoulForge comes from a very concrete modding pain: editing FromSoftware mods used to mean unpacking resources, opening Lua or event files in crude text tools, guessing numeric IDs, repacking, launching the game, and hoping nothing silently broke.

The project source and full super-editor vision are recorded in:

- [`docs/PROJECT_SOURCE.md`](docs/PROJECT_SOURCE.md)

Core slogan:

```text
Stop modding in the dark.
```

## Product direction

SoulForge is not a Smithbox clone. Existing tools are references for user experience and domain coverage, but SoulForge rewrites its own architecture around AI-native workflows:

- Open a native mod directory without requiring manual unpacking.
- Understand resources across `event`, `map`, `param`, `msg`, and file-level auxiliary resources.
- Turn opaque numeric IDs into traceable symbols and references.
- Show evidence chains before AI explains or changes anything.
- Provide a full Super Editor shell with Events, Params, Text, Maps, Files, AI, and Settings modes.
- Use a staging/validation/backup/rollback pipeline before saving changes.
- Keep resource usage low by indexing and parsing lazily.

## Roadmap

### v0.1 — Super Event Editor logic layer

v0.1 is the event-centered foundation.

Core chain:

```text
event -> map -> param -> msg
```

Goals:

- open a native ModEngine-style mod workspace;
- scan packaged resources such as DCX/BND/EMEVD/MSB/PARAM/FMG;
- inspect native resources honestly with diagnostics;
- build a lightweight evidence graph;
- provide AI-safe read tools over indexed evidence;
- keep unsupported resources structured instead of pretending they are parsed.

Status: logic-layer routing, native inspect/export separation, and smoke checks are the current v0.1 closeout focus.

Reference docs:

- [`docs/V0_1_SUPER_EVENT_EDITOR.md`](docs/V0_1_SUPER_EVENT_EDITOR.md)
- [`docs/LOGIC_LAYER_REVIEW.md`](docs/LOGIC_LAYER_REVIEW.md)

### v0.2 — Super Editor shell

v0.2 makes SoulForge visibly become a Super Editor rather than only a large event editor.

Target modes:

```text
Start
  -> Workspace
    -> Events
    -> Params
    -> Text
    -> Maps
    -> Files
    -> AI
    -> Settings
```

Goals:

- start page;
- workspace shell;
- top resource-mode navigation;
- resource tree/list;
- safe viewer placeholders by resource kind;
- diagnostics/log panel;
- AI sidebar/tool-console placeholder;
- provider and permission mode UI shape.

Reference doc:

- [`docs/SUPER_EDITOR_MILESTONE.md`](docs/SUPER_EDITOR_MILESTONE.md)

### v0.3 — Fixture-confirmed parsers

v0.3 upgrades low-confidence candidate parsers into fixture-confirmed exports.

Targets:

- FMG text table parser;
- BND child table listing;
- EMEVD event and instruction export;
- PARAM row and field export;
- MSB entity, region, transform, and model export.

The key rule: candidate outputs may remain as fallbacks, but UI and AI must distinguish confirmed parser output from low-confidence evidence.

Reference doc:

- [`docs/V0_3_FORMAT_PARSER_MILESTONE.md`](docs/V0_3_FORMAT_PARSER_MILESTONE.md)

### v0.4 — Safe writer and Patch Engine milestone

v0.4 is the bridge between reliable parsing and safe global editing.

Expected focus:

- writer contracts;
- staged patch application;
- text writer;
- param writer;
- limited event/map writers where ready;
- validation hooks;
- backup and rollback;
- operation log;
- AI patch proposal format.

v0.4 exists so v0.5 can enable global AI-driven modifications without turning the editor into a mod-destroying hallucination machine.

### v0.5 — Full Super Editor target

By v0.5, SoulForge should feel like a full-featured all-in-one FromSoftware mod workbench.

AI scope expands from explanation/querying to approved global modification:

```text
user request
  -> AI gathers evidence through read-only tools
  -> AI builds a global change plan
  -> dependency and impact analysis
  -> patch proposal
  -> user review
  -> apply to staging copies
  -> validate staged workspace
  -> show diff and diagnostics
  -> backup originals
  -> atomic replace
  -> re-index changed resources
  -> operation log
  -> rollback available
```

The v0.5 promise is not that AI can freely mutate anything. The promise is that AI can make global mod changes only through evidence, plans, staged patches, validators, backups, logs, and rollback.

Reference doc:

- [`docs/V0_5_FULL_SUPER_EDITOR_TARGET.md`](docs/V0_5_FULL_SUPER_EDITOR_TARGET.md)

## Technical direction

- Desktop shell: Electron + React + TypeScript.
- Bridge/parser layer: C# helper process.
- Index: SQLite + FTS5.
- AI: right sidebar with provider abstraction for OpenAI-compatible, Anthropic-compatible, and mock/tool-console providers.
- Patch Engine: the only write path for mod resource changes.
- External tools: reference only. Do not copy Smithbox/DSMapStudio/DarkScript/WitchyBND/SoulsFormats implementation code.

## Safety direction

All writes must go through SoulForge's Patch Engine:

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

## Current engineering stance

SoulForge should fail honestly:

- `inspect` returns evidence, not fake semantic parsing.
- Candidate parsers must be labeled low-confidence.
- Unsupported formats return structured diagnostics.
- AI tools query indexes and reference graphs; they do not parse or write native files directly.
- Full-permission AI mode still cannot bypass the Patch Engine.
