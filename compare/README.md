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
| `msb` | Bridge `read-msb-document` | SoulsFormatsNEXT `decode` (MSBS) | per type, ordered: models (name, sib path); parts (name, model, position/rotation/scale float32 bits, entity id); regions (name, shape, position/rotation bits, entity id); events (name, event id) |

Original SoulsFormats does not read Sekiro TAE, so the TAE rule uses SoulsFormatsNEXT. An animation without an hkx
is `""` in SoulsFormats and `null` in the Bridge; both are compared as "no file name".

EMEVD layer values are not compared yet; no corpus file has a layer. MSB compares only what the Bridge exposes:
per-type inner payloads, entity groups, gparam, event part/region references and routes are not compared, so a
`match` covers names, types, transforms and entity ids only. SoulsFormats renames duplicate and empty model,
region and part names in memory (` {n}`, MSB.cs DisambiguateNames); the rule applies the same transform to the
Bridge's raw names instead of stripping suffixes from the reference, so a truncated name is still a `diff`.

To add a format, add a rule to `run.mjs`, its extraction to `lib.mjs` with a test that fails on a wrong
extraction, and its inputs to `corpus.json`.
