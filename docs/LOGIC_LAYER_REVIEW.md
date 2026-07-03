# Logic layer review checklist

This checkpoint is for reviewing the v0.1 logic layer before more UI work.

## Completed scope

- Bridge uses a bounded prefix reader for inspect and validate.
- Bridge inspect returns partial envelope evidence rather than pretending semantic parsing succeeded.
- Parser result types are separated from Program.cs.
- Envelope inspection recognizes common native resource envelopes by header magic.
- Workspace analysis now has a native inspection pass in addition to text and JSON semantic ingestion.
- Native inspection diagnostics are recorded as workspace diagnostics and are not ingested as semantic symbols.
- Electron IPC now surfaces both parsedFiles and inspectedFiles from analysis.

## Hard boundaries

- No external parser code is copied.
- Inspect is evidence only.
- Semantic exports remain unsupported until each format has fixtures and validation.
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

Bridge smoke check:

```bash
dotnet run --project bridge/SoulForge.Bridge -- inspect README.md
```

Expected shape:

- parseStatus is partial;
- diagnostics is not empty;
- data.rootFormat exists;
- data.evidence exists;
- data.nextSteps exists.

## Next parser milestones

1. FMG text table export.
2. Binder child table listing.
3. EMEVD event and instruction export.
4. PARAM row export.
5. MSB entity and region export.
