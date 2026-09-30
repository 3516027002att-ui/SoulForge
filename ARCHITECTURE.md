# SoulForge authority and ownership

- `packages/shared` contains neutral domain/protocol types and logical resource identities
- `packages/agent` contains the independent finite control protocol/kernel and bounded process/event transport. It has no dependency on Electron, renderer, core, native parsers or the workspace index
- `packages/core` owns workspace/domain services, Agent domain adaptation and shared session assembly. ToolRegistry declares permissions, effects and concurrency; bridge projection and CLI guards consume that single declaration
- `apps/desktop` owns trusted UI/IPC, credentials and domain host state. Agent provider/control runs execute in the fixed `agentUtility` utilityProcess; only bounded capability RPC crosses that boundary
- `bridge/SoulForge.Bridge` owns production native format authority. Writers produce controlled staging output, never arbitrary user resource replacements
- Patch Engine owns proposals, locks, source/hash checks, staging, backup, journal, commit, native verification and recovery. Existing journal/operation records remain transaction truth
- The renderer derives session/UI state from events and bounded projections. Resource documents, indexes, semantic scenes and render objects remain different layers

Model output, tool execution, transaction state and independently evaluated task completion are separate facts. Process restart does not authorize replay. Read-only and already-satisfied tasks can pass an applicable independent validator without a write; actual wrong values fail; missing evidence stays unverified.

The old loop remains available for controlled comparisons and the desktop default during validation. It now shares assembly and process hosting with the finite path. This does not claim the real-provider switch criterion or every prior OOM root cause is satisfied. Domain registration is being migrated without rewriting established readers, writers or PatchIR.

Checks are executable risk-specific tests. Discovery and compatibility labels select them; manual claim/seal/freshness data cannot prohibit an independently runnable product check. Historical release/deferral compatibility data remains until its meaningful consumers are migrated. See `docs/DECISIONS.md` and `docs/AGENT_RUNTIME.md`.
