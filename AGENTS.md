# SoulForge agent entry

SoulForge is a desktop editor and AI agent for FromSoftware game mods (Sekiro first). This file is the only
engineering entry point. It is written for AI agents from any harness; `CLAUDE.md` imports it.

The owner does not review code and reads only product documents. Your work is judged by machines:

1. the merge gate (CI) decides whether a change may land;
2. comparison against mature reference tools and the agent simulation chains decide what actually works.

Nothing else counts as completion: not a report, not a seal, not a ledger entry, not an exit code of a skipped check.

## Workflow

1. Find work in GitHub Issues. Prefer issues labelled `ready`; their acceptance criteria are commands.
2. Claim by assigning yourself and opening a draft PR. A claim with no push for 3 days is abandoned and may be taken over.
3. Work in your own git worktree with its own dependencies and build outputs. Never share a working tree with another agent.
4. Keep PRs small and independent, targeting `main`. No long-lived integration branches.
5. Run `npm run gate` before pushing. It is exactly what CI runs.
6. For read/decode work also run the comparison (see "Completion"); for agent behaviour run a simulation chain.
7. In the PR description list what you ran and what you did not run. Unrun is not passed.

A red `main` stops the line: fixing it comes before any other merge.

## Merge gate

`npm run gate` = typecheck, tests, synthetic Bridge verification, build, trust-zone check, no added local paths.

- Machine paths (game, mods, tools, corpora) come from `SOULFORGE_*` environment variables, never from the repository.
  The gate compares added lines with this machine's real paths, so run it locally before pushing: CI only knows its
  own runner paths.
- It must be green to merge. It must not depend on game files, private corpora, GPUs or network models.
- A check that needs the game belongs in the comparison or native layer, not in the gate.
- A new gate check must be shown to fail on the concrete bad case it targets, in the PR that adds it.
- Do not weaken, skip or delete an existing check to make your change pass. If a check is wrong, fix it in its
  own trust-zone PR and say why.

## Trust zone

These paths are the judge. A PR that touches any of them must touch nothing outside them
(`node scripts/trust-zone-check.mjs` enforces this in the gate), and needs the owner's approval through CODEOWNERS.
Isolation applies once the target branch carries the checker; the one change that first brings it to main is exempt.
The list is `TRUST_ZONE` in that script; `.github/CODEOWNERS` and this section must match it (the gate tests this):

- CI and entry documents: `.github/`, `AGENTS.md`, `CLAUDE.md`
- the gate: `scripts/gate.mjs`, `scripts/gate.test.mjs`, `scripts/trust-zone-check.mjs`,
  `scripts/trust-zone-check.test.mjs`
- the check runner that discovers and runs tests: `scripts/check.mjs`, `scripts/check.fixture.mjs`, `scripts/verify/`,
  `scripts/verify-verify-entrypoint-fixtures.mjs`, `scripts/verify-scheduling-fixtures.mjs`
- the comparison oracle: `compare/` (reference-tool pin, corpus manifest, known differences, comparison rules)
- the Patch Engine transaction core: `packages/core/src/patch/`

Ordinary unit tests are not in the trust zone; change them together with the code they test.
Correctness of reads is protected by the external comparison, not by self-written expected values.

## Completion

- Read/decode: compare SoulForge output with the mature reference tools on the same input
  (`node compare/run.mjs`; setup and formats in `compare/README.md`). Each
  game x format x operation gets one status: `match`, `diff`, `known-diff`, `reference-unsupported` or
  `reference-unavailable`. A `known-diff` needs a recorded reason and an issue. When two reference tools disagree,
  report a reference conflict; the owner decides game facts. A format with no comparison rule is `unverified`.
- Writes: the Patch Engine invariants (staging, backup, journal, rollback, unknown-byte preservation) are tested in
  the gate with synthetic fixtures. Real writes are validated by round trip: write to a temporary copy, read it back
  with a reference tool, and only the intended fields may differ. Never write into the game or mod directories.
- Agent behaviour: the two simulation chains (unpacked `npm run agent:simulate`, and the installed EXE) report a pass
  rate over fixed scenarios. A single run proves the chain works, not that the agent is reliable.
- Areas with no oracle are reported as `unverified`, never as passed.

Game files and the Oodle runtime cannot go to public CI. Comparison runs on a machine that has the game; results run
by someone else's agent are informational.

## Product invariants

- The C# Bridge is the only production authority for native FromSoftware formats. Do not add a second production
  native parser in TypeScript.
- Every mod write goes through Patch Engine: controlled staging, source/version checks, backup, persistent journal,
  native readback. If unknown bytes cannot be preserved, the writer stays unavailable.
- The renderer receives logical identifiers and bounded projections, never filesystem access or absolute paths.
- Permission modes never bypass staging, audit, backup, recovery or approval.
- Unsupported, partial or failed operations return structured diagnostics; never swallow errors.
- Cancellation does not erase transaction facts. Unknown writes require a journal lookup before any retry; never
  replay them automatically.
- Long tasks are asynchronous, report progress, are cancellable and have timeouts.

Agent runtime details (`createAgentRunAssembly`, `packages/agent`, budgets, hosting) are in `docs/AGENT_RUNTIME.md`.
Module ownership and dependency direction are in `ARCHITECTURE.md`.

## Documents

- Owner documents: `README.md`, `docs/PRODUCT_VISION.md`, `docs/DECISIONS.md` (owner decisions only), release notes,
  and the generated capability table.
- Agent documents: this file, `ARCHITECTURE.md`, `docs/AGENT_RUNTIME.md`, and README files next to the code.
- Documents never hold live status. Status comes from running a command. Generated reports go to `output/`
  (untracked) or to the capability issue.
- Do not create milestone, status, task, progress or evidence documents. Do not add ledgers or seals.
- Prefer turning a rule into a check. A rule that cannot be checked states the failure it prevents.

## Public repository

The repository is public. Never commit or post credentials, local absolute paths, game files or extracted game data,
model provider names tied to private configurations, or personal data. Use placeholders such as `<GAME_ROOT>`.
Do not infer authority to publish, merge, deploy or close issues from permission to implement code.
