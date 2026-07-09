# v0.6 Native Container Workbench — Status

Honest status for container-level open/read/write.  
Do **not** read this as “all FromSoftware formats fully supported.”

## Three layers of “all files readable/writable”

| Layer | Meaning | v0.6 status |
| --- | --- | --- |
| **raw-level** | Any indexed file: byte range read, full UTF-8 text attempt, whole-file replace / byte-range patch with confirmation | **yes** (v0.5, retained) |
| **container-level** | DCX / BND / nested unpack, child replace, repack | **partial → fixture-confirmed** (see matrix) |
| **semantic-level** | Structured FMG / PARAM / EMEVD / MSB roundtrip | **FMG synthetic only**; others **no** |

## Security fixes (pre-v0.6)

### expectedHash TOCTOU

- `ProposeWholeFileReplaceInput.expectedHash?` and `ProposeRawByteEditInput.expectedHash` (required).
- `saveRawReplace` / `saveRawByteRange` pass the **caller** hash into proposal; proposal **must not recompute/overwrite** it.
- `WorkspaceTransaction` / hash validators still enforce the same hash at before_staging / before_commit.
- Smoke: `runV06NativeContainerWorkbenchSmoke` → `expectedHash-TOCTOU`.

### Strict base64

- `decodeStrictBase64` in `packages/core/src/util/base64.ts`:
  - charset + padding + length % 4
  - decode → re-encode normalize equality
  - `allowEmpty=false` rejects empty payload
- Wired into `saveRawReplace` / `saveRawByteRange` / `RawFileWriter` / container writers.
- Smoke: `strict-base64` / `strict-base64 no-stage`.

## Capability matrix (new fields)

In `packages/core/src/capabilities/resourceCapabilities.ts`:

- `containerReadableLevel`: `none | candidate | partial | authoritative`
- `containerWritableLevel`: `none | raw-replace | child-replace | authoritative-repack`
- `containerRoundTripSafe`, `canListChildren`, `canReadChild`, `canReplaceChild`, `canRepackContainer`
- `decompressionStatus`, `compressionStatus`
- `childEditWritable`, `childEditRequiresConfirmation`
- `semanticAuthorityByFormat?` (`fmg` / `param` / `emevd` / `msb`)

Use `probeContainerCapabilityOptions(path)` + `resolveResourceCapabilities(file, options)` after byte probe.

## Container support matrix

| Format | Read | List children | Child replace | Repack | Authority |
| --- | --- | --- | --- | --- | --- |
| Raw file | yes (raw) | n/a | n/a | n/a | n/a |
| **DCX DFLT** (zlib) | full decompress | via nested BND | via nested | recompress (payload-equivalent; may not be byte-identical) | partial / fixture-confirmed when nested SFBN |
| **DCX KRAK/EDGE/ZSTD** | unsupported decompress | no | no (raw only) | no | candidate / unsupported |
| **BND3/BND4 synthetic SFBN** | full | yes | yes | yes (child hashes preserved) | **fixture-confirmed authoritative-repack** |
| **Native BND3/BND4** (no SFBN) | magic only | no claim | **blocked** | no | candidate; raw-replace only |
| **DCX(DFLT)+SFBN BND** nested | yes | yes | yes | yes | fixture-confirmed when probe succeeds |

### Supported DCX variants (explicit)

- **Supported**: `DFLT` (zlib), standard DCS/DCP/DCA boundary layout used by bridge probe.
- **Unsupported**: `KRAK`, `EDGE`, `ZSTD`, unknown compression — diagnostic `DCX_COMPRESSION_UNSUPPORTED`; raw-level still works.

### Supported BND variants (explicit)

- **Supported for child replace/repack**: SoulForge synthetic `SFBN` marker BND3/BND4 (docs/V0_3_SYNTHETIC_BND_FIXTURE.md).
- **Not claimed**: real game BND3/BND4 layouts (SoulsFormats-class native). Those stay **candidate + raw-replace**.

## Semantic formats

| Format | Tier | Writable |
| --- | --- | --- |
| **FMG** synthetic SFFX | `fixture-confirmed` (entries roundtrip) | yes (rebuild FMG bytes → container child replace if nested) |
| **FMG** native (no SFFX) | candidate | no |
| **PARAM** | none | no |
| **EMEVD** binary | none (raw/container only) | no instruction writer |
| **MSB** | none / candidate names only if scanned elsewhere | no writer |

`nativeFormatAuthority` remains **false** everywhere. Fixture-confirmed ≠ native game authority.

## APIs (core)

- `inspectContainerTree(path)`
- `listContainerChildren(path, { recursive? })`
- `readContainerChild(path, childUri)`
- `replaceContainerChildInMemory(...)` / `replaceContainerChild(...)` (PatchIR path)
- `roundTripContainer(path)`
- `validateContainer(path)`
- `exportContainerTree(path, outDir)`
- `decodeStrictBase64`
- DCX: `decompressDcx`, `compressDcxDflt`, `recompressDcx`, `roundTripDcx`
- BND: `readSyntheticBnd`, `buildSyntheticBnd`, `replaceSyntheticBndChild`
- FMG: `parseSyntheticFmg`, `buildSyntheticFmg`, `updateSyntheticFmgEntry`

### Stable childUri

```text
file://msg/item.msgbnd.dcx#dcx/bnd/child/item.fmg
file://bin/pack.bnd#bnd/child/note.txt
```

Not tied to temp absolute paths.

## PatchIR

- Operation: **`container_child_replace`** (not reused `file_replace`)
- Required: `expectedContainerHash`, `expectedChildHash`, `childContentBase64`, `childPath`/`childUri`, confirmation
- Writer: `ContainerChildReplaceWriter` (`writer:container-child-replace`)
- Validator: `ContainerRoundTripValidator` (`container_roundtrip`)
- Still blocked: `container_child_add|delete|rename|move`

## Minimal IPC / preload

- `resource.inspectContainerTree`
- `resource.listContainerChildren`
- `resource.readContainerChild`
- `resource.replaceContainerChild`
- `resource.roundTripContainer`
- `resource.validateContainer`
- `resource.probeContainerCapabilities`

No renderer UI overhaul.

## Tests

```powershell
npm run typecheck -w @soulforge/core
npm run test -w @soulforge/core
npm run test:v05-raw-file-workbench -w @soulforge/core
npm run test:v06-native-container-workbench -w @soulforge/core
```

Smoke `runV06NativeContainerWorkbenchSmoke` covers TOCTOU, strict base64, DCX, BND, nested, Patch Engine, FMG, semantic honesty, regression.

## Explicit non-claims

- Not all FromSoftware formats are fully supported.
- Native BND3/BND4 game files are **not** authoritative-repack.
- Non-DFLT DCX is **not** decompressed.
- PARAM / EMEVD / MSB semantic writers are **not** implemented.
- FMG fixture-confirmed is **not** native FMG authority.

## Next steps

1. Real BND4 header/table reader with fixture-confirmed roundtrip before claiming native.
2. PARAMDEF-aware PARAM read (write only with fixtures).
3. EMEVD text dump path; binary remains container/raw.
4. MSB name listing candidate only.
5. Optional C# bridge commands mirroring core (`inspect-container`, `list-children`, …) when bridge is the preferred authority path.
