# Codex Task: v0.5 Architecture Scaffold

## Goal

Build the **SoulForge v0.5 architecture scaffold** — a testable core closed loop:

```text
open workspace
  -> VFS
  -> ResourceURI / FieldURI
  -> ResourceGraph
  -> provenance / confidence / diagnostics
  -> PatchIR
  -> WorkspaceTransaction
  -> staging
  -> validation
  -> commit
  -> audit log
  -> rollback
  -> AI tool permission model
```

This task is **scaffold only**. It is not a product-complete super editor, and it is not a native FromSoftware parser/writer implementation.

## Hard boundaries

- **No frontend UI changes** (no React components, CSS, layout, renderer pages).
- **No real native parser** (BND / DCX / EMEVD / MSB / PARAM / FMG).
- **No real native writer** (no BND repack, DCX recompress, EMEVD/MSB/PARAM write-back).
- **No Blender / MCP external control / local LLM / vector DB / embedding RAG**.
- Synthetic fixtures must never claim `nativeFormatAuthority = true`.
- Writes only through staging → validation → commit → rollback on sandbox/temp workspaces.

## Delivered modules

### shared (`packages/shared/src/`)

| File | Responsibility |
|------|----------------|
| `resource-uri.ts` | ResourceURI / FieldURI create, format, parse, validate |
| `provenance.ts` | Provenance sources/chains; synthetic cannot be native authority |
| `confidence.ts` | Score/level/reasons + simple fusion |
| `diagnostics.ts` | Structured diagnostics with target URI / provenance hooks |
| `resource-graph.ts` | Temporal property graph types + SQLite-ready row shapes |
| `patch-ir.ts` | Graph PatchIR operations + scaffold support lists |
| `writer-contract.ts` | Operational `WriterAdapterContract` (distinct from metadata WriterContract) |
| `validator-contract.ts` | ValidatorContract scopes |
| `audit-log.ts` | Audit log entry + store interface |
| `ai-tools.ts` | Tool permission model, policy, evidence pack, agent plan |
| `vfs.ts` | VFS node/tree types |
| `bridge-protocol.ts` | Versioned envelope, failures, capability matrix |

### core (`packages/core/src/`)

| Area | Responsibility |
|------|----------------|
| `resource-graph/` | In-memory temporal graph |
| `patch-engine/patchIr.ts` | validatePatchIr, collectAffectedResources, estimatePatchRisk |
| `writers/` | TextFileWriter, RawFileWriter, SyntheticResourceWriter, UnsupportedResourceWriter |
| `validators/` | TextFileValidator, RawFileValidator |
| `staging/` | Content-addressed staging |
| `backup/` | Restore points |
| `audit-log/` | Memory + JSONL audit stores |
| `transactions/` | WorkspaceTransaction closed loop |
| `vfs/` | Build VFS from sandbox workspace |
| `ai-tools/` | PolicyGate + ScaffoldToolRegistry |
| `bridge/bridgeProtocolScaffold.ts` | Capability matrix + envelope helpers |

## Runnable vertical slice

```text
temp sandbox workspace
  -> create text/raw files
  -> ResourceURI
  -> VFS
  -> ResourceGraph
  -> PatchIR (text / raw / reject native container ops)
  -> WorkspaceTransaction stage/validate/commit
  -> audit log
  -> rollback restore
  -> AI tools through policy gate
```

## Verification

```powershell
npm run typecheck
npm run test:v05-architecture -w @soulforge/core
npm run test
npm run build
```

## Explicit non-claims

- no frontend UI changes
- no native parser implementation
- no native writer implementation
- scaffold only

## Follow-on: how to plug real writers

1. Implement Bridge command + capability cell with `nativeFormatAuthority` only after fixture-confirmed parsers.
2. Add a resource-specific `WriterAdapterContract` (e.g. `FmgWriter`) that:
   - accepts structured PatchIR ops
   - writes **staging only**
   - emits rollback metadata
3. Register validators for staged native bytes / schema.
4. Keep commit ownership in `WorkspaceTransaction` / Patch Engine.
5. Never bypass policy gate for commit/rollback.
