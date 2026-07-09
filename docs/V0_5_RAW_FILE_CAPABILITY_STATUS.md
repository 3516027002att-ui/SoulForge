# v0.5 Raw File Capability Status

**Date:** 2026-07-09

## Honest definition of “all files open/read/write”

| Layer | Meaning | Status |
|-------|---------|--------|
| File-level open | Indexed, capabilities, metadata | **Yes** |
| Raw readable | Range + full bytes (stream/range API) | **Yes** |
| Preview readable | Bounded prefix (not full) | **Yes** |
| Raw writable | whole-file replace / byte-range via Patch Engine | **Yes** (confirmation required) |
| Text semantic editable | text_edit for text-like files | **Yes** |
| Native semantic editable | EMEVD/MSB/PARAM/FMG structured | **No** |
| Native roundtrip safe | decompress/repack write-back | **No** |

## Capability matrix fields

`resolveResourceCapabilities(file)` in `packages/core/src/capabilities/resourceCapabilities.ts`:

- openable, rawReadable, fullRawReadable, previewReadable
- semanticReadable + semanticReadTier
- rawWritable, textWritable, binaryPatchWritable
- semanticWritable, nativeRoundTripSafe
- containerReadable, containerWritable
- textCapability / rawCapability / semanticCapability
- reasonCodes, diagnostics, requiredConfirmation, riskLevel
- **nativeFormatAuthority is always false** in this matrix

## Core APIs

| API | Module |
|-----|--------|
| `resolveResourceCapabilities` | capabilities/resourceCapabilities.ts |
| `readRawResourceMetadata` | files/rawRead.ts |
| `readRawResourceRange` | files/rawRead.ts |
| `readTextResourceFull` | files/rawRead.ts |
| `saveRawReplace` | editing/saveRawResource.ts |
| `saveRawByteRange` | editing/saveRawResource.ts |
| `evaluateRawWriterGate` / `resolveWriterCapabilities` | patch/writerContract.ts |
| raw schemas in adapter | patch/patchProposalAdapter.ts |

## IPC (minimal, no visual UI redesign)

- `resource.capabilities`
- `resource.readRawMetadata`
- `resource.readRawRange`
- `resource.saveRawReplace`
- `resource.saveRawByteRange`
- `resource.createConfirmation`

## Explicitly NOT implemented

- DCX full production decompression/repack
- BND full unpack/repack as authoritative
- PARAM / EMEVD / MSB / FMG authoritative parser/writer
- Semantic writable for native packed formats

## Tests

```powershell
npm run test:v05-raw-file-workbench -w @soulforge/core
npm run test -w @soulforge/core
npm run typecheck
npm run build
```
