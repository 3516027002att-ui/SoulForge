# Local fixed corpus

`sekiro-1.6.corpus-manifest.json` records content pins and reviewed expectations. Game and Mod bytes stay outside the repository. Set `SOULFORGE_NATIVE_FIXTURE_ROOT` or `SOULFORGE_SEKIRO_GAME_ROOT` to the preserved game root; an explicit test path still must match its recorded hash.

The `correctnessFixtures` version identifies the transferred snapshot used by the three imported EMEVD suites and script-container evidence suite. The original unbound EMEVD expectations (33,266 instructions / 142 kinds) and script threshold (at least 200 entries) described different inputs. Pinned SoulsFormatsNEXT execution establishes these replacement expectations:

| Resource | SHA-256 | Independent expectation |
| --- | --- | --- |
| `mods/event/common.emevd.dcx` | `3a3a0a40f77b558349983e69d30250d9cd900ba70190d32e5e8d4aadabdb4a04` | 1,783 events, 87,892 instructions, 144 kinds, exact per-kind distribution |
| `mods/script/aicommon.luabnd.dcx` | `64bb64f2669157c11c93030da07360e0ed94b45fab7641fea7b3df0ca6be8269` | 106 entries, 104 `.lua` entries |

Oracle commit and assembly/exporter hashes are recorded in the manifest. Oracle code, assemblies and resource bytes are external validation material, with no production dependency. Independent execution shares upstream format knowledge; it does not establish independent discovery of the format.

Each correctness test verifies source bytes and consumes an owned snapshot. Missing or changed inputs produce explicit unavailable legs; they are never interpreted as parser success or failure. Expectations change only through a reviewed manifest edit. The release corpus's original 198 `entries` remain a separate fixed set. `test:corpus-manifest` requires every entry before native classification, then verifies each owned snapshot; an incomplete set is unavailable. A native reader rejecting hash-matched input is a failure.

Live-workspace generic checks remain separate. They can verify requested mutations, native readback, unrelated byte preservation and rollback without claiming the fixed corpus's counts or coverage.
