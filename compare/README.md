# compare

The comparison oracle. It decides whether a SoulForge read is correct by comparing it with a mature reference
tool on the same input. This directory is in the trust zone: change it only in its own PR.

## Run

```
npm run build
node compare/run.mjs
```

Environment:

- `SOULFORGE_SEKIRO_GAME_ROOT`: the game root. The run only reads it.
- `SOULFORGE_REFCLI`: the reference CLI entry (`refcli.mjs`) whose builds match `references.json`.

Each case in `corpus.json` gets one status per game x format x operation:

| status | meaning |
|---|---|
| `match` | every item equals the reference |
| `diff` | an item differs and is not recorded in `known-diffs.json` |
| `known-diff` | every difference is recorded with its exact fingerprint, a reason and an issue |
| `reference-unsupported` | the reference tool cannot read this input |
| `reference-unavailable` | the reference CLI, its pinned build or its result was not available |

Exit code: `0` all groups `match` or `known-diff`; `1` any `diff`, or a recorded difference that no longer
occurs; `2` the run failed; `3` something was not compared. Only `0` counts as compared.

The full report goes to `output/compare/report.json`. It contains extracted game text: keep it local, and post
only the stdout summary in PRs and issues.

## Files

- `references.json`: the pinned reference projects (repository and commit). A result from any other build is
  `reference-unavailable`.
- `corpus.json`: inputs by game, format and operation, relative to the game root.
- `known-diffs.json`: `[{ "key", "fingerprint", "reason", "issue" }]`. Copy `key` and `comparison.fingerprint`
  from the report. A changed difference has a new fingerprint and is a `diff` again.
- `lib.mjs`: the comparison and status rules, tested by `compare.test.mjs` in the gate.
- `run.mjs`: reads both sides and applies the rules.

## Formats

| format | SoulForge | reference | compared |
|---|---|---|---|
| `fmg` | Bridge `read-text-catalog` | SoulsFormats `entries` + `decode` (FMG) | msgbnd FMG table list (ordinal, entry name); every table's ordered (id, text) |
| `tae` | Bridge `read-tae-document` | SoulsFormatsNEXT `entries` + `decode` (TAE) | anibnd TAE entry list (ordinal, id, name); every TAE's ordered (animation id, hkx name, event count) |
| `emevd` | Bridge `read-emevd-document`, every instruction page | SoulsFormats `decode` (EMEVD) | events (id, rest behavior, instruction and parameter counts); flattened instructions (event, index, bank, id, ArgData length and sha256, layer present); flattened parameters |
| `fmg` `write-roundtrip` | Bridge `write-fmg` into a temp staging root | SoulsFormats reads source and output | L0 identity upsert and L1 one-entry text edit; every table's ordered (id, text) against the reference read of the source with the same edit applied |
| `tae` `write-roundtrip` | core `commitTaeEventContainerViaBridge` (extract child, `write-tae-document`, `write-bnd4`) into a temp staging root | SoulsFormatsNEXT reads source and output | L0 rewrites one event's times unchanged, L1 moves them one frame; the edited TAE's ordered animations (id, hkx name, events: type, start/end float32 bits, Unk04) against the source read with the edit applied; every other entry's child size and sha256 unchanged |
| `msb` | Bridge `read-msb-document` | SoulsFormatsNEXT `decode` (MSBS) | per type, ordered: models (name, sib path); parts (name, model, position/rotation/scale float32 bits, entity id); regions (name, shape, position/rotation bits, entity id); events (name, event id) |
| `param` `read-rows` | Bridge `read-dcx-document` entries; per entry `extract-bnd4-child` + `readParamDocumentViaBridge` (trusted row width) | SoulsFormats `entries` + `decode` (PARAM, no paramdef) | parambnd .param entry list (ordinal, id, name); every param's (ParamType, row count) and ordered row (id, name) |

Original SoulsFormats does not read Sekiro TAE, so the TAE rule uses SoulsFormatsNEXT. An animation without an hkx
is `""` in SoulsFormats and `null` in the Bridge; both are compared as "no file name".

The FMG write round trip (`compare/roundtrip.mjs`) writes only into `<os temp>/soulforge-roundtrip-<uuid>`, the
only writable root it negotiates; it refuses a staging root inside the game root, deletes it afterwards and fails if
the source file's sha256 changed. The expectation is the reference tool's read of the source with the edit applied,
never the Bridge result. `byteIdentical` (output sha256 equals the source) is recorded, not judged: the writer
recompresses the DCX, so an L0 match does not claim a byte-lossless write.

The TAE write round trip uses the same staging and source checks. Its target is the first event, in native order, of
the first TAE entry that has one, whose times the writer accepts moving (it refuses an event whose time slot a sibling
shares; refusals are recorded in `refused`). The pinned SoulsFormatsNEXT does not expose an event's parameter bytes
(`Parameters` stays null without a template), so field writes (`set-event-field`) and inserted events are not
compared by this rule; untouched TAE entries are still checked byte for byte through their child sha256.
`childByteIdentical` (the edited child's bytes unchanged) is recorded, not judged.

EMEVD layer values are not compared yet; no corpus file has a layer. MSB compares only what the Bridge exposes:
per-type inner payloads, entity groups, gparam, event part/region references and routes are not compared, so a
`match` covers names, types, transforms and entity ids only. SoulsFormats renames duplicate and empty model,
region and part names in memory (` {n}`, MSB.cs DisambiguateNames); the rule applies the same transform to the
Bridge's raw names instead of stripping suffixes from the reference, so a truncated name is still a `diff`.

PARAM field values are not compared yet. The reference decodes without a paramdef (header and row index only); a
`PARAMDEF_*` diagnostic makes the item `reference-unsupported` whatever the status says. A row without a name is
`null` in SoulsFormats and has no `name` in the Bridge; `""` is folded into "no name" on both sides because the
Bridge cannot return an empty name. The Bridge reads only loose .param files, so each entry is extracted to a
private temporary directory that the run deletes afterwards. The Bridge read is the production one
(`readParamDocumentViaBridge`): a single-row param needs a row width, taken from the trusted first-party metadata by
the PARAM editor's own lookup (`resolveTrustedParamRowWidth`); a param without a trusted width is a `diff` (`PARAM_METADATA_ROW_WIDTH_UNRESOLVED`),
not a skip. refcli runs one request per project at a time; the report records the reference call count and total
time in `referenceCalls`. refcli writes one result directory per call and never deletes them; a clean run (exit 0)
deletes the ones it created, any other outcome keeps them to inspect, and `SOULFORGE_COMPARE_KEEP_REFERENCE_RESULTS=1`
keeps them always (`referenceResults` in stdout counts both).

To add a format, add a rule to `run.mjs`, its extraction to `lib.mjs` with a test that fails on a wrong
extraction, and its inputs to `corpus.json`.
