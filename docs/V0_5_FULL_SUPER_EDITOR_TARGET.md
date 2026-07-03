# SoulForge v0.5 — Full Super Editor Target

v0.5 is the first target where SoulForge should feel like a full-featured Super Editor rather than a shell plus parser pipeline.

By v0.5, the user should be able to work across the whole mod with AI assistance, including global modifications, while still protected by staging, validation, backups, rollback, diagnostics, and operation logs.

## Product goal

SoulForge v0.5 should be a usable all-in-one FromSoftware mod workbench:

```text
Open native mod workspace
  -> inspect and index resources
  -> understand event/map/param/msg relationships
  -> edit across resource modes
  -> ask AI to plan local or global changes
  -> preview all affected files
  -> validate against staged copies
  -> apply safely with backup and rollback
```

The important shift is AI scope:

- v0.1/v0.2 AI explains and queries.
- v0.3 AI can rely on stronger confirmed parsers.
- v0.5 AI may propose and execute approved global mod changes through the Patch Engine.

## Required product capabilities

### 1. Full workspace shell

The Super Editor shell should be usable as the main app experience:

- Start page;
- recent projects;
- open native mod directory;
- workspace shell;
- Events / Params / Text / Maps / Files / AI / Settings modes;
- diagnostics/log panel;
- resource tree/list;
- viewer/editor panel;
- AI sidebar/tool console.

### 2. Core resource editing

v0.5 should support practical editing workflows for the core chain:

```text
event -> map -> param -> msg
```

Expected editing capability:

- text entries can be edited through structured text patches;
- param rows can be edited through structured row/field patches where parser support exists;
- event changes can be proposed through structured instruction/event patches where parser support exists;
- map entity/region changes can be proposed where parser support exists;
- unsupported binary edits remain unavailable unless a validated writer exists.

No feature should directly mutate original mod files.

### 3. AI global modification

By v0.5, the AI should be able to perform global mod modification workflows after user approval.

Examples:

- Rename an item and update related text/param references.
- Find all event references to a flag and propose a coordinated change.
- Adjust a param family across multiple rows.
- Change a boss reward flow across event, param, and msg resources.
- Audit a mod for broken references and propose fixes.
- Generate a patch plan for a gameplay rebalance across many files.

The AI must not directly write files. It must use this pipeline:

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
  -> user approval or full-permission policy gate
  -> backup originals
  -> atomic replace
  -> re-index changed resources
  -> operation log
  -> rollback available
```

### 4. AI permission modes

v0.5 should have real behavior behind permission modes.

#### Plan mode

- AI may inspect, search, explain, and build a patch proposal.
- AI may not apply changes.
- User sees plan, affected files, confidence, diagnostics, and diff.

#### Normal mode

- AI may create a patch proposal.
- User must approve before staging/apply.
- Validation failure stops the operation.

#### Full-permission mode

- AI may run approved tools automatically.
- AI may apply to staging copies.
- AI may retry against staging copies within a configured retry limit.
- AI may not bypass Patch Engine.
- AI may not overwrite originals without passing validation and policy gates.
- All operations must be logged.

Full-permission mode is not "do anything" mode. It is bounded automation inside the safety pipeline.

### 5. Patch Engine maturity

v0.5 requires the Patch Engine to become a real core subsystem.

Required features:

- patch proposal model;
- structured text edits;
- structured param edits;
- structured event/map edits where writers exist;
- binary write refusal when no safe writer exists;
- staging workspace;
- before/after hashes;
- validation hooks;
- backups;
- atomic replace;
- rollback;
- operation logs;
- changed-resource re-indexing;
- diagnostics comparison before and after patch.

### 6. Dependency and impact analysis

Global modification requires understanding what may break.

Required features:

- reference graph traversal;
- impacted resource list;
- confidence labels;
- ambiguous reference warnings;
- cross-resource patch grouping;
- conflict detection;
- stale index detection;
- validation of changed resource kind and symbol counts.

### 7. AI tool layer

AI tools should support global work while staying safe.

Read tools:

- workspace_stats;
- search_resources;
- search_events;
- search_param_rows;
- search_text_entries;
- search_map_entities;
- find_references;
- explain_event;
- lookup_text_id;
- find_text_references;
- explain_text_entry;
- inspect_resource;
- summarize_diagnostics;
- analyze_impact.

Write-planning tools:

- propose_text_patch;
- propose_param_patch;
- propose_event_patch;
- propose_map_patch;
- compose_global_patch;
- validate_patch;
- preview_patch;

Write-execution tools, gated by permission mode:

- apply_patch_to_staging;
- validate_staging;
- commit_staged_patch;
- rollback_operation.

The renderer and AI tools must not directly write mod files.

## Required parser/writer foundation

v0.5 depends on parser work from v0.3 and writer work from v0.4.

The app should have at least:

- confirmed FMG parser and writer for text edits;
- confirmed BND child listing and safe repack/replacement path where needed;
- confirmed PARAM parser and writer for common row edits;
- confirmed EMEVD parser and limited writer for supported event operations;
- confirmed MSB parser and limited writer for supported map operations;
- structured unsupported behavior for anything not safely writable.

## Suggested v0.4 bridge milestone

v0.4 should sit between v0.3 and v0.5.

Recommended v0.4 target:

```text
Safe Writer + Patch Engine Milestone
```

v0.4 should focus on:

- writer contracts;
- staged patch application;
- text writer;
- param writer;
- limited event/map writer if ready;
- validation hooks;
- backup and rollback;
- operation log;
- AI patch proposal format.

Then v0.5 can safely enable global AI-driven modification.

## Acceptance picture

v0.5 is acceptable when a user can perform a real global workflow:

1. Open a native mod workspace.
2. Ask AI for a cross-resource change.
3. AI searches indexed evidence and explains the impact.
4. AI proposes a patch touching multiple resource modes.
5. User sees affected files, confidence labels, warnings, and diffs.
6. Patch is applied to staging copies.
7. Validators run.
8. User approves or permission mode allows guarded execution.
9. Original files are backed up.
10. Changes are atomically applied.
11. Workspace is re-indexed.
12. Operation log records exactly what happened.
13. Rollback is available.

If this works, SoulForge is no longer only an editor. It becomes an AI-native mod operating system for FromSoftware modding.

## Non-goals for v0.5

Still not required for v0.5:

- full 3D editor parity with professional map editors;
- Blender MCP implementation;
- mesh modeling;
- animation authoring;
- local LLM runtime;
- vector database RAG;
- unsafe autonomous binary rewriting;
- blind edits to unsupported formats.

## Safety line

The v0.5 promise is not that AI can freely mutate anything.

The v0.5 promise is:

```text
AI can make global mod changes only through evidence, plans, staged patches, validators, backups, logs, and rollback.
```

That is the difference between a Super Editor and a mod-destroying hallucination machine.
