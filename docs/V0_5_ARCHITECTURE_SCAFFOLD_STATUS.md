# v0.5 Architecture Scaffold Status

**Date:** 2026-07-09  
**Scope:** Architecture scaffold only (D-direction, not full productization)

## Completed

| Area | Status | Notes |
|------|--------|-------|
| ResourceURI / FieldURI | Done | format/parse/validate + overlay/hash/symbol |
| Provenance / Confidence / Diagnostics | Done | synthetic never native authority |
| ResourceGraph (in-memory) | Done | nodes/edges/provenance/diagnostics/version/snapshot |
| PatchIR | Done | text/raw/synthetic + reject container native ops |
| WriterAdapterContract | Done | text / raw / synthetic / unsupported |
| ValidatorContract | Done | text + raw validators |
| WorkspaceTransaction | Done | stage → validate → commit → audit → rollback |
| Content-addressed staging | Done | hash objects + work tree |
| Backup restore points | Done | file copy + hash validation on rollback |
| Audit log | Done | memory + JSONL-ready interface |
| AI tool permission model | Done | read→rollback + policy gate |
| Scaffold ToolRegistry | Done | mock tools listed below |
| VFS scaffold | Done | text/json/unsupported/synthetic nodes |
| Bridge protocol scaffold | Done | envelope, failures, capability matrix |
| Vertical slice tests | Done | `runV05ArchitectureScaffoldSmoke.ts` |

### Mock AI tools

- `workspace.stats`
- `resource.graph.query`
- `patch.proposeTextEdit`
- `patch.stage`
- `patch.validate`
- `patch.commit`
- `patch.rollback`

## Explicitly NOT completed

- Real native BND / DCX / EMEVD / MSB / PARAM / FMG **parser**
- Real native **writer** / repack / recompress
- Frontend UI / renderer changes (**working tree `apps/desktop/**` matches HEAD for this task; no App.tsx / styles.css / renderer / IPC UI path edits remain**)
- SQLite driver wiring for graph/audit (types + schema-ready only)
- Full temporal graph persistence / conflict detection productization
- Bridge daemon streaming / cancellation productization
- Plugin sandbox runtime
- Unrelated untracked `mcps/**` dumps are **not** part of this deliverable

## Runnable vertical slice

```text
ResourceURI
  -> VFS
  -> ResourceGraph
  -> PatchIR
  -> WorkspaceTransaction
  -> staging
  -> validation
  -> commit
  -> audit
  -> rollback
```

Adapters: **text / raw / synthetic** only.

## Test results (this task)

Verified 2026-07-09 locally after UI revert. Evidence logs under:

`C:\Users\ASUS\AppData\Local\Temp\grok-goal-8fc2ace8c4c4\implementer\`

| Command / artifact | Result |
|--------------------|--------|
| `typecheck.log` | pass |
| `v05-scaffold-tests.log` | pass |
| `v05-vertical-slice.log` + `v05-vertical-slice-run2.log` | pass twice (fresh temp workspaces each run) |
| `test-all.log` | pass |
| `build.log` | pass |
| `boundary-check.txt` | no `apps/desktop` / renderer / CSS diffs vs HEAD |

Architecture smoke results (each run):

- ResourceURI/FieldURI ok
- ResourceGraph ok
- PatchIR ok
- Transaction text commit/rollback ok
- Transaction raw commit/rollback ok
- AI tool policy ok
- VFS ok
- Bridge protocol ok

## How to attach real FMG / PARAM / EMEVD / MSB / BND later

1. **Parser path:** Bridge inspect/export with fixture-confirmed evidence → set `nativeFormatAuthority` only when true native parse exists.
2. **Graph path:** ingest parsed symbols as ResourceGraph nodes/edges with provenance.
3. **PatchIR path:** add structured ops (`resource_field_edit`, container child ops) once writers exist.
4. **Writer path:** new adapter implementing `WriterAdapterContract.applyToStaging` only.
5. **Validator path:** schema + profile + reference validators before commit.
6. **Transaction path:** unchanged ownership of commit/backup/audit/rollback.
7. **Policy path:** AI tools still cannot write files directly; commit/rollback remain gated.

## Placeholders remaining

- Container child PatchIR ops → always rejected (`NATIVE_WRITER_REQUIRED`)
- Structured native writers → `UnsupportedResourceWriter`
- Graph SQLite persistence → row types only
- Full multi-evidence confidence fusion → simple weighted scaffold
- Agent loop observe→plan→tool→verify → types + mock tools only
