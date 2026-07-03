# Logic layer review checklist

This checkpoint is for reviewing the v0.1 logic layer before more UI work.

## Completed scope

- Bridge uses a bounded prefix reader for inspect and validate.
- Bridge inspect returns partial envelope evidence rather than pretending semantic parsing succeeded.
- Parser result types are separated from Program.cs.
- Program.cs now routes export commands directly instead of relying on BridgeResult.Unsupported compatibility dispatch.
- export-msg routes to conservative partial message export.
- export-event, export-param, and export-map route to low-confidence native semantic candidate exports.
- Envelope inspection recognizes common native resource envelopes by header magic.
- Envelope inspection records visible path-like hints as low-confidence evidence.
- Envelope inspection records low-confidence binderChildCandidate evidence for visible BND child names.
- Envelope inspection records low-confidence nestedMagicCandidate evidence for possible nested native formats.
- Bridge has a conservative partial message export for readable raw strings.
- Message export stops at DCX/BND container boundaries until unpacking exists.
- FMG-like files now get a guarded table-candidate pass before raw string scanning.
- Bridge has low-confidence candidate exports for EMEVD event IDs, PARAM row IDs, and MSB entity names.
- Event/map/param candidate exports stop at DCX/BND container boundaries.
- Workspace analysis now has a native inspection pass in addition to text and JSON semantic ingestion.
- Workspace analysis can ingest partial native msg exports and low-confidence native semantic candidate exports when the bridge returns a valid shape.
- WorkspaceIndex exposes stable stats and multi-match text lookup APIs.
- AI-safe tools include workspace_stats, lookup_text_id, find_text_references, and explain_text_entry.
- AI context builder can produce evidence-first text explanation prompts.
- Native inspection diagnostics are recorded as workspace diagnostics and are not ingested as semantic symbols.
- Electron IPC now surfaces both parsedFiles and inspectedFiles from analysis.

## Hard boundaries

- No external parser code is copied.
- Inspect is evidence only.
- Path hints are low-confidence evidence and are not authoritative binder child tables.
- binderChildCandidate evidence is visible-string evidence only until BND table fixtures confirm offsets, sizes, and names.
- nestedMagicCandidate evidence is bounded-prefix evidence only until DCX decompression and BND unpacking exist.
- Native msg export is still partial; FMG table candidates must be fixture-reviewed before being treated as authoritative.
- EMEVD, PARAM, and MSB candidate exports are low-confidence bootstrap outputs, not final semantic parsers.
- Raw string fallback uses file offsets as temporary text IDs.
- AI and UI must not directly parse native binary resources.
- AI-safe read tools may query indexes and reference graphs but must not parse files or write files.
- Writes must remain behind Patch Engine.

## Commands for reviewer

Run these from the repository root:

```bash
npm install
npm run typecheck
npm run build
dotnet build bridge/SoulForge.Bridge/SoulForge.Bridge.csproj
```

Bridge smoke checks:

```bash
dotnet run --project bridge/SoulForge.Bridge -- inspect README.md
dotnet run --project bridge/SoulForge.Bridge -- export-msg README.md
```

Native candidate smoke checks, using local fixtures or user-provided files:

```bash
dotnet run --project bridge/SoulForge.Bridge -- export-event path/to/file.emevd
dotnet run --project bridge/SoulForge.Bridge -- export-param path/to/file.param
dotnet run --project bridge/SoulForge.Bridge -- export-map path/to/file.msb
```

Expected inspect shape:

- parseStatus is partial;
- diagnostics is not empty;
- data.rootFormat exists;
- data.evidence exists;
- data.nextSteps exists;
- visible resource names may appear as low-confidence pathHint evidence;
- BND files may expose low-confidence binderChildCandidate evidence;
- packed/container files may expose low-confidence nestedMagicCandidate evidence.

Expected export behavior:

- Program.cs routes export commands directly, not through BridgeResult.Unsupported side effects;
- for readable raw text, export-msg parseStatus may be partial and data.entries should exist;
- for FMG-like payloads with a self-consistent table candidate, diagnostics should include MSG_FMG_TABLE_CANDIDATE;
- for packed DCX/BND containers, semantic export parseStatus should remain unsupported with SEMANTIC_EXPORT_CONTAINER_BOUNDARY or equivalent container-boundary diagnostics;
- raw fallback text IDs are offsets, while table-candidate text IDs are read from the candidate rows;
- export-event/export-param/export-map candidate outputs must be treated as low-confidence until fixture-confirmed.

Expected AI tool behavior:

- workspace_stats returns file, symbol, and reference counts from WorkspaceIndex;
- lookup_text_id accepts numeric textId as a number or numeric string, may accept category, and returns all matching text entries;
- find_text_references accepts numeric textId as a number or numeric string, may accept category, and returns matching text entries plus inbound references;
- explain_text_entry returns structured text explanation contexts and prompts;
- lookup_text_id, find_text_references, and explain_text_entry should not scan files directly.

## Next parser milestones

1. Replace FMG table candidate logic with fixture-confirmed FMG text ID table parsing.
2. Replace binderChildCandidate visible-string evidence with fixture-confirmed BND child table listing.
3. Replace EMEVD event ID candidates with fixture-confirmed event and instruction table export.
4. Replace PARAM row ID candidates with fixture-confirmed row and field export.
5. Replace MSB visible-name candidates with fixture-confirmed entity, region, transform, and model export.
