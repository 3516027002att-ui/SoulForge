# Decisions

## Governance replacement

[Issue #49](https://github.com/3516027002att-ui/SoulForge/issues/49) supersedes the former line-budget and blanket-no-new-check premises in #22/#38/#39. Necessary product constraints stay at their actual execution boundaries. A scoped regression needs a scoped negative test, not a whole-repository claim/seal/freshness ceremony.

GitHub Issues describe work; CI records actual execution; this document records owner decisions; ARCHITECTURE.md and AGENTS.md expose stable boundaries and entry points. `check` discovers convention files and workspace aliases. Registration/audit findings remain reportable but cannot stop all independently parsed checks. Each actual failure, unavailable leg and not-run dependency remains visible.

The obsolete gov claim/heartbeat/release/complete/seal command authority and its dedicated self-checks are retired. Historical handoff/governance material is retained for still-meaningful release/deferral compatibility consumers and as background; it does not acquire freshness authority over new scoped product work. Existing user artifacts are not implicitly authorized for deletion.

## Agent and native editing

[Issue #29](https://github.com/3516027002att-ui/SoulForge/issues/29) requires an independent control boundary while preserving native domain capability and Patch Engine authority. The finite kernel is independent, shared assembly serves desktop/CLI, and desktop control runs in a utilityProcess. Native read proofs are automatic host evidence, not model-authored proof labels or a mutation budget ledger.

Actual transaction results remain in the existing operation/journal system. Request cancellation, worker exit or transport loss does not imply not_committed. Unknown outcomes are queried rather than replayed.

Deterministic protocol/boundary comparisons do not establish real-provider quality or cost. The old loop remains the desktop comparison baseline until equal-input/provider/budget/validator evidence supports the default switch. No fixed task count or universal format oracle becomes a new startup gate.

## Platform and scope

Windows and Linux are both product delivery targets, as explicitly confirmed by the user on 2026-09-30. Shared domain and Agent implementations use thin platform adapters. Builds, actual runtime, native ABI, resource support and packaging evidence are reported separately for each platform; portable tests do not establish Windows execution or GPU/image parity. Unsupported format/runtime behavior remains explicit. Unspecified owner choices and unconfirmed user-data cleanup are local blockers, not reasons to stop unrelated scoped work.

## 2026-09-30: oversized containers use optional read-only unpack transport (#43)

Keep the 64 MiB native in-memory read limit. Use an independently installed,
user-imported WitchyBND process only to split oversized DCX/BND containers into a
source-hash/tool-configuration-bound local cache outside game/Mod roots. The cache
publishes only complete validated entry manifests. Bridge parses extracted native
leaves and preserves original container/entry/version provenance. This is the
limited production-authority exception for container transport, not a second
leaf parser. No WitchyBND code or binary is redistributed by SoulForge.

Unpacking does not authorize repacking or Mod writes. Oversized repack remains
unsupported until a separate issue designs verified repack and Patch Engine
writeback. License, configuration, platform, cancellation and verification details
are documented in [Bridge read cache](bridge-read-cache.md).
