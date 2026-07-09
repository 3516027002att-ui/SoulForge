# v0.5 Full File Workbench + Semantic Spine Status

**Task:** `V0_5_P1_FULL_FILE_WORKBENCH_AND_SEMANTIC_SPINE`  
**Date:** 2026-07-09

## What this is

Files Mode full-file **safety workbench** + **semantic workspace spine**:

- Every overlay file can open / bounded-read / preview
- Every overlay file can be written via **text_edit / raw_byte_range_edit / file_replace** when policy allows
- All writes go through **PatchIR + WorkspaceTransaction**
- VFS → ResourceGraph ingest, semantic snapshot, Evidence Pack, Patch Impact (core only)

## What this is NOT

- **No real native parser** (BND/DCX/EMEVD/MSB/PARAM/FMG)
- **No real native writer** (repack/recompress/structured write-back)
- raw/replace is **not** a native writer
- **No frontend visual changes**
- synthetic/packed always `nativeFormatAuthority=false`

## Modules

| Area | Path |
|------|------|
| Files Mode API | `packages/core/src/files/*` |
| Durable commit + op-log recovery | `packages/core/src/patch/durablePatchCommit.ts` |
| Semantic index / snapshot / reindex | `packages/core/src/workspace/semanticWorkspaceIndex.ts` |
| Evidence Pack | `packages/core/src/ai/evidencePackBuilder.ts` |
| Patch Impact | `packages/core/src/patch/patchImpactGraph.ts` |
| Risk validators | `packages/core/src/validators/fileRiskValidator.ts` |
| Smoke | `packages/core/src/testing/runV05FullFileWorkbenchSmoke.ts` |

## Operation log recovery strategy

```text
record pending
  -> WorkspaceTransaction commit files
  -> record committed
  -> if committed record fails:
       try auto-rollback
       if rollback fails: write durable recovery JSON (recovery_required)
  -> ok=true only when committed record succeeds
```

Pending record failure refuses file writes entirely.

## Requirement evidence table

| Requirement | Evidence | Pass/Fail |
|-------------|----------|-----------|
| All files can open/read bounded preview | `runV05FullFileWorkbenchSmoke` A | Pass |
| Text file edit through PatchIR + WorkspaceTransaction | smoke B text | Pass |
| Binary raw edit through PatchIR + WorkspaceTransaction | smoke B raw | Pass |
| Native/packed whole-file replace high-risk confirmation | smoke: deny without receipt (`EDIT_CONFIRMATION_REQUIRED`) + allow with receipt + rollback | Pass |
| Unsupported structured write blocked | smoke structured + packed EvidencePack `autoCommitAllowed===false` | Pass |
| Base write blocked | smoke C base | Pass |
| Workspace outside write blocked | smoke C outside | Pass |
| Hash stale commit blocked | smoke D | Pass |
| Operation log failure recovery | smoke E pending + committed | Pass |
| VFS → ResourceGraph ingestion | smoke F | Pass |
| Semantic snapshot persist/reload | smoke F | Pass |
| EvidencePack fields | smoke G | Pass |
| PatchImpactGraph fields | smoke H | Pass |
| No frontend visual changes | core/shared/docs only | Pass |
| No native parser | nativeFormatAuthority false | Pass |
| No native writer | structured blocked | Pass |

## Commands

```powershell
npm run typecheck
npm run build
npm run test -w @soulforge/core
npm run test:v05-write-path -w @soulforge/core
npm run test:v05-full-file-workbench -w @soulforge/core
npm test
# opt-in real mods:
npm run test:real-mod -w @soulforge/core
```

## Follow-ups (not claiming done)

- SQLite-backed operation log / semantic index drivers
- Real native parsers/writers (evidence-first, fixture-gated)
- UI wiring for Files Mode / Evidence Pack / impact graph
