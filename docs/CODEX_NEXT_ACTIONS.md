# Codex Next Actions Checkpoint

This is the current handoff checkpoint for Codex.

## Current state

SoulForge v0.3 is focused on fixture-confirmed parser plumbing for the core chain:

event -> map -> param -> msg

Already present:

- FMG synthetic fixture path is wired through export-msg.
- SyntheticFixtureExports.cs exists for event and PARAM synthetic fixtures.
- SyntheticMapFixtureExports.cs exists for map synthetic fixtures.
- CODEX_TASK_ROUTER_WIREUP.md exists with the narrow router task.
- GitHub issue #1 exists for this router wire-up.

Important caveat:

- Event, PARAM, and map synthetic helpers are written but not yet routed through SemanticCandidateExports or Program.cs.
- Do not claim these three are fully wired until the build and smoke scripts prove it.

## Codex task 1: router wire-up

In SemanticCandidateExports.cs:

- TryExportEvent should keep packed-container boundary handling first.
- Then it should call SyntheticFixtureExports.TryExport for event.
- Then it should keep the existing low-confidence event ID candidate scan.

In TryExportParam:

- Keep packed-container boundary handling first.
- Then call SyntheticFixtureExports.TryExport for param.
- Then keep the existing low-confidence PARAM row ID candidate scan.

In TryExportMap:

- Keep packed-container boundary handling first.
- Then call SyntheticMapFixtureExports.TryExport.
- Then keep the existing low-confidence visible-name candidate scan.

Do not remove existing fallback behavior.

## Codex task 2: fix a possible PARAM typing issue

Check SyntheticFixtureExports.cs.

If the synthetic PARAM field value mixes bool and int in one conditional expression, make it compile-safe by assigning the result to an object before exporting it.

Do not change the JSON shape.

## Codex task 3: add one smoke script

Add:

bridge/SoulForge.Bridge/scripts/verify-synthetic-core-fixtures.ps1

It should generate temporary synthetic fixtures and run export-msg, export-event, export-param, and export-map.

It should assert these diagnostic codes:

- MSG_FMG_SYNTHETIC_FIXTURE_CONFIRMED
- EMEVD_SYNTHETIC_FIXTURE_CONFIRMED
- PARAM_SYNTHETIC_FIXTURE_CONFIRMED
- MSB_SYNTHETIC_FIXTURE_CONFIRMED

Do not commit binary fixture files.

## Codex task 4: run checks

Run:

- dotnet build bridge/SoulForge.Bridge/SoulForge.Bridge.csproj
- npm run typecheck
- npm run build

If any command fails, fix only the smallest compile/type issue needed for this task.

## Codex task 5: update status docs after success

After the router wire-up and smoke script pass, update:

- docs/V0_3_FORMAT_PARSER_MILESTONE.md
- docs/LOGIC_LAYER_REVIEW.md

Remove caveats saying event, PARAM, and map synthetic helpers still need router wire-up.

Add that synthetic routes for msg, event, param, and map are wired.

Do not claim native FMG, EMEVD, PARAM, MSB, or BND parsing is complete.

## Hard boundaries

Codex must not:

- copy external parser implementations;
- commit real game assets or user mod files;
- claim native parser authority from synthetic fixtures;
- remove low-confidence candidate fallbacks;
- let renderer parse native binaries directly;
- change UI scope;
- touch Patch Engine;
- implement native BND, EMEVD, PARAM, or MSB parsers in this task;
- start Blender, MCP, local LLM, or vector database work.

## Done definition

This checkpoint is complete when:

1. export-msg can return MSG_FMG_SYNTHETIC_FIXTURE_CONFIRMED for a generated synthetic FMG fixture.
2. export-event can return EMEVD_SYNTHETIC_FIXTURE_CONFIRMED for a generated synthetic event fixture.
3. export-param can return PARAM_SYNTHETIC_FIXTURE_CONFIRMED for a generated synthetic PARAM fixture.
4. export-map can return MSB_SYNTHETIC_FIXTURE_CONFIRMED for a generated synthetic map fixture.
5. Existing non-synthetic inputs still fall back to low-confidence candidates or structured unsupported results.
6. Build and typecheck pass, or exact failures are documented honestly.
