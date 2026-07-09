# v0.5 Write Path Consolidation Status

**Task:** `V0_5_P0_WRITE_PATH_CONSOLIDATION`  
**Date:** 2026-07-09

## Outcome

**PatchIR + WorkspaceTransaction is the only production commit trunk.**

```text
saveTextResource
  -> writer gate / session deny / confirmation
  -> read original → beforeHash
  -> PatchProposal (compat shape)
  -> compilePatchProposalToPatchIr (expectedHash)
  -> WorkspaceTransaction (addPatch → stage → validate → commit)
  -> operation log (history + file rollback)
```

Legacy `createStagingArea` + `commitValidatedStagingArea` remain as **compat APIs**, but production commit **re-executes the proposal through WorkspaceTransaction** and does **not** apply `staging.files` bytes to the overlay.

## Completed items

### 1. saveTextResource on new trunk

- Uses `commitPatchProposal` → `executePatchProposalThroughTransaction`
- Does **not** call `createStagingArea` / independent overlay apply
- Returns compatible `SaveTextResourceResult` (`ok`, `opId`, `backupRoot`, `changedFiles`, `diagnostics`, `risk`, optional `graph`)
- Operation log still records committed ops for `rollbackOperation`

### 2. Text edit hash precondition

- Production `saveTextResource` reads target file and sets `beforeHash`
- Adapter maps `beforeHash` → PatchIR `expectedHash` + `content_hash` precondition
- `createTextEditOperation` accepts optional `expectedHash` (required on production path)
- `TextFileValidator` / `TextFileWriter` / `WorkspaceTransaction.commit` enforce hash via `textHash.ts`
- Codes:
  - `TEXT_EDIT_HASH_MISMATCH` (pre-stage / apply)
  - `ORIGINAL_CHANGED_DURING_STAGING` (after stage / before commit)
  - `TEXT_EDIT_HASH_REQUIRED` (available for production-only strict modes)

### 3. Explicit writer staging mapping

- `WriterApplyResult.writtenTargets: { opId, targetUri, targetPath?, stagingPath }[]`
- `writtenPaths` kept as deprecated compat
- All writers return explicit mapping
- `WorkspaceTransaction.stage` uses **only** `writtenTargets` (no URI `includes` guessing)
- Missing mapping → `WRITER_TARGET_MAPPING_MISSING` / `WRITER_STAGING_OUTPUT_MISSING`

### 4. Legacy patchEngine

- `commitValidatedStagingArea` / `commitPatchProposal` / dry-run → WorkspaceTransaction
- Marked as wrapper; not an independent production writer
- Staging-bytes-ignored is proven in smoke

### 5. VFS bounded scan

- `boundedFileProbe.ts`: prefix read (default 64KB), small-file full hash, large/packed deferred
- `VfsNode.hashStatus`: `full | partial | deferred | unavailable`
- Large binary/packed files are **not** full-read at open
- `nativeFormatAuthority` remains false for synthetic/unsupported

### 6. Default tests self-contained

```json
"test": "... foundation + p1 + architecture + write-path consolidation"
"test:real-mod": "runRealModOpenSmoke.js ../../mods"
```

Root `npm test` no longer requires `../../mods`.

### 7. Consolidation smoke

`runV05WritePathConsolidationSmoke.ts` covers:

| Section | Proof |
|---------|--------|
| A | saveTextResource commit + op log + rollback; no base write |
| B | stage → mutate original → commit fails stale hash |
| C | same basename different dirs via writtenTargets |
| D | raw edit hash ok + wrong hash blocked |
| E | large binary bounded probe; hashStatus not full |

## Explicit non-claims

- **no frontend UI changes**
- **no native FromSoftware parser**
- **no native BND/DCX/EMEVD/MSB/PARAM/FMG writer**
- synthetic never native authority
- scaffold text/raw/synthetic writers only

## Verification

```powershell
npm run typecheck
npm run build
npm run test -w @soulforge/core
npm run test:v05-architecture -w @soulforge/core
npm run test:v05-write-path -w @soulforge/core
npm test
# opt-in:
npm run test:real-mod -w @soulforge/core
```

## Remaining follow-ups (non-blocking)

- Optionally delete staging-file apply helpers once zero external callers remain
- Unify audit log + operation log persistence later
- Native writers must plug into WriterAdapterContract + transaction only
