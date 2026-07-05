# SoulForge CodexPro Bridge

This directory stores durable context for CodexPro handoff workflows.

Tracked files are intentionally small and safe to review:

- `decisions.md` records project-level integration decisions.
- `open-questions.md` records setup choices that still need a human decision.
- `codex-status.md` records the latest local verification snapshot.
- `current-plan.template.md` is a template for ChatGPT handoff plans.

Runtime files such as `current-plan.md`, `agent-status.md`, `implementation-diff.patch`,
`execution-log.jsonl`, and `pro-context.md` are ignored because they may contain
transient task details, command output, or model context.

SoulForge-specific boundaries:

- CodexPro is a development-time MCP bridge, not part of the Electron app runtime.
- Do not put tokens, tunnel credentials, real game assets, or user mod files here.
- ChatGPT must not write to user mod workspaces directly; product writes still go
  through SoulForge's Patch Engine.
- Unsupported binary formats must remain structured diagnostics, not guessed parses.
