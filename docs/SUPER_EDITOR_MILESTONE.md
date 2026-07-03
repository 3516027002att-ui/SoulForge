# SoulForge Super Editor Milestone

This document moves SoulForge beyond the v0.1 Super Event Editor scope into the first visible shape of the full Super Editor.

The Super Event Editor remains the first deep module, but it is no longer the whole product target. From this milestone onward, SoulForge should feel like a multi-resource FromSoftware mod workbench with an event-first intelligence core.

## Product goal

SoulForge should open a native ModEngine-style mod workspace and show a unified workbench for multiple resource modes:

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

The first complete experience does not need authoritative parsers for every binary format. It does need a coherent shell, shared resource model, shared diagnostics, shared AI tools, and honest low-confidence evidence where deep parsing is not ready.

## Milestone name

`v0.2-super-editor-shell`

This is not a full release version number. It is the next engineering milestone after the v0.1 event-centered logic layer.

## What should be visible

A user should be able to:

1. Open a native mod workspace.
2. See a start page with recent/open project affordances.
3. Enter a workspace shell with top resource-mode navigation.
4. Switch between Events, Params, Text, Maps, Files, AI, and Settings.
5. See a resource tree/list filtered by the current mode.
6. Select a resource and see a safe viewer panel.
7. See diagnostics and parser confidence labels.
8. Ask the AI/tool console about indexed resources using read-only tools.
9. Create patch proposals in plan mode without writing original mod files.

## Resource modes

### Events

Events remain the first deep module.

Current acceptable state:

- parsed text fixtures;
- partial native EMEVD candidate exports;
- event search;
- explain_event;
- references to map/param/text where evidence exists.

Not acceptable:

- claiming authoritative instruction parsing unless fixtures prove it.

### Params

Params should become a first-class mode even before full PARAM layout support.

Current acceptable state:

- indexed param files;
- partial row ID candidates;
- param row search;
- diagnostics explaining candidate confidence;
- future-ready table viewer shape.

Not acceptable:

- pretending fields or row layouts are known when only row ID candidates exist.

### Text

Text should expose FMG/msg entries and raw/candidate text exports.

Current acceptable state:

- text search;
- lookup_text_id;
- find_text_references;
- explain_text_entry;
- confidence labels for raw offset IDs vs table candidate IDs.

Not acceptable:

- treating raw string offsets as stable game text IDs.

### Maps

Maps should expose map files and entity/region candidates.

Current acceptable state:

- indexed map files;
- partial visible-name MSB candidates;
- map entity search;
- evidence labels.

Not acceptable:

- pretending transforms, regions, models, or entity IDs are parsed until fixtures confirm them.

### Files

Files is the honest fallback mode.

Current acceptable state:

- full workspace inventory;
- resource kind, extension, size, modified time;
- bridge inspect diagnostics;
- path hints, binder child candidates, nested magic candidates.

### AI

AI is a workbench sidebar and tool console, not an autonomous binary editor.

Current acceptable state:

- provider settings shape for OpenAI-compatible, Anthropic-compatible, and mock/tool-console providers;
- thinking intensity: fast, normal, deep, extreme;
- plan mode and full-permission mode concepts;
- read-only tool execution over WorkspaceIndex/reference graph;
- patch proposal creation without direct writes.

Not acceptable:

- requiring AI to use the app;
- letting AI bypass Patch Engine;
- direct file scanning from AI tools.

### Settings

Settings should expose project and AI configuration without hiding safety state.

Current acceptable state:

- game/profile placeholder;
- bridge path/status;
- provider config placeholder;
- tool permission mode display;
- diagnostics/log visibility.

## Architecture target

The next implementation should introduce a resource-mode shell rather than separate one-off screens.

Suggested UI state model:

```ts
export type EditorMode = 'events' | 'params' | 'text' | 'maps' | 'files' | 'ai' | 'settings';

export interface WorkspaceViewState {
  mode: EditorMode;
  selectedUri?: string;
  query?: string;
  diagnosticsOpen: boolean;
  aiSidebarOpen: boolean;
}
```

Each mode should consume the same workspace analysis result and query WorkspaceIndex through safe APIs. The renderer must not parse native files directly.

## Implementation priorities

1. Fix the v0.1 logic-layer debts first:
   - direct Program.cs export routes;
   - remove ParserTypes temporary compatibility dispatch;
   - allow native candidate export and inspect evidence pass to both run;
   - keep container-boundary protection.

2. Build the Super Editor shell:
   - start page;
   - workspace shell;
   - top mode navigation;
   - resource list/tree;
   - main viewer placeholder by resource kind;
   - diagnostics/log panel;
   - AI sidebar/tool-console placeholder.

3. Connect existing core tools to the shell:
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
   - explain_text_entry.

4. Keep all deep binary parsing behind Bridge commands.

5. Keep all writes behind Patch Engine.

## Acceptance picture for this milestone

The Super Editor shell is acceptable when a user can open a workspace and immediately understand:

- what resources exist;
- which resources have parsed symbols;
- which resources only have low-confidence candidates;
- which resources are unsupported;
- how to switch between Events, Params, Text, Maps, Files, AI, and Settings;
- how to use AI/tool console to query the existing evidence graph;
- why a claim is certain, uncertain, or unsupported.

This milestone is about product shape and honest intelligence, not full binary format conquest.

## Non-goals

Still out of scope:

- full 3D map viewport;
- Blender MCP integration;
- mesh/model editing;
- animation/TAE editing;
- local LLM runtime;
- embedding/vector database;
- autonomous binary rewriting;
- copying external parser implementations.

## Next milestone after this

After the Super Editor shell exists, the next milestone should replace candidate parsers one by one with fixture-confirmed parsers:

1. FMG text table parser.
2. BND child table listing.
3. EMEVD event and instruction export.
4. PARAM row and field export.
5. MSB entity, region, transform, and model export.
