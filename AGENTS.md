# SoulForge engineering entry

## Find the task and the boundary

GitHub Issues describe work. `docs/DECISIONS.md` records owner choices. `ARCHITECTURE.md` describes authority and ownership. Format implementations and specifications remain alongside their domain code. Historical governance projections are compatibility material, not an instruction to claim work, seal evidence or refresh the whole repository before starting a scoped fix.

## Execute checks

- Inspect available checks: `node scripts/check.mjs --list`
- Run a named suite or convention file: `node scripts/check.mjs --suite <name>`
- Conventional `*.test.ts`, `*.test.mjs`, `*.fixture.mjs` and core `run*Smoke.ts` checks are discovered without manual registration
- Check reports distinguish passed, failed, unavailable and not_run. Read the actual legs; an aggregate's static reachability is not evidence that its tail executed
- Run affected tests, build/typecheck and the applicable aggregate. A missing platform, corpus, native binding or GPU is an explicit verification limit, never a green result

## Preserve product authority

- C# Bridge owns production native parsing/writing. TypeScript uses domain services and stable identities; do not add a second production native parser
- Mod writes go through Patch Engine, controlled staging, source/version checks, backup, persistent journal and native readback. Unknown bytes must be preserved or the writer stays unavailable
- The renderer receives logical identifiers and bounded projections, never real filesystem authority or absolute resource paths
- Permission modes cannot bypass native proof, staging, audit, backup, recovery or approval boundaries
- Cancellation and request status do not erase transaction facts. Unknown writes require existing operation/request journal lookup before any retry; never automatically replay them

## Keep work isolated

Use a separate worktree with its own dependencies, mutable native bindings, build outputs and test storage. Do not replace these with links to another checkout. Explicit isolation failures fail closed. Preserve original game/source data, rescue bundles and unconfirmed existing artifacts. Inspect links before removing worktrees.

## Agent work

Use `createAgentRunAssembly` for desktop, CLI and evaluator sessions. The independent finite kernel is in `packages/agent`; domain authority remains in core. See `docs/AGENT_RUNTIME.md` for utility hosting, protocol, budgets, unresolved-operation handling and comparison limits. Real-provider experiments need a selected provider and configured cost budget. Never put credentials in events, reports or repository files.

There are no AGENTS line-count budgets or blanket bans on adding an effective regression check. Add a negative test for the concrete failure, preserve existing valid boundaries, and report what was actually verified. Do not infer publication, merge, deployment or issue-closure authority from permission to implement code.
