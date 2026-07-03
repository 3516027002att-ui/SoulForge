# Logic layer review checklist

This checkpoint is for reviewing the v0.1 logic layer before more UI work.

## Completed scope

- Bridge uses a bounded prefix reader for inspect and validate.
- Bridge inspect returns partial envelope evidence rather than pretending semantic parsing succeeded.
- Parser result types are separated from Program.cs.
- Envelope inspection recognizes common native resource envelopes by header magic.
- Bridge has a conservative partial message export for readable raw strings.
- Message export stops at DCX/BND container boundaries until unpacking exists.
- Workspace analysis now has a native inspection pass in addition to text and JSON semantic ingestion.
- Workspace analysis can ingest partial native msg exports when the bridge returns a valid MsgExport shape.
- Native inspection diagnostics are recorded as workspace diagnostics and are not ingested as semantic symbols.
- Electron IPC now surfaces both parsedFiles and inspectedFiles from analysis.

## Hard boundaries

- No external parser code is copied.
- Inspect is evidence only.
- Native msg export is partial and offset-based; it is not an authoritative FMG ID table parser yet.
- Event, map, and param semantic exports remain unsupported until each format has fixtures and validation.
- AI and UI must not directly parse native binary resources.
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

Expected inspect shape:

- parseStatus is partial;
- diagnostics is not empty;
- data.rootFormat exists;
- data.evidence exists;
- data.nextSteps exists.

Expected export-msg behavior:

- for readable raw text, parseStatus may be partial and data.entries should exist;
- for packed DCX/BND containers, parseStatus should remain unsupported;
- exported text IDs are offsets, not authoritative FMG IDs.

## Next parser milestones

1. Authoritative FMG text ID table parser.
2. Binder child table listing.
3. EMEVD event and instruction export.
4. PARAM row export.
5. MSB entity and region export.
