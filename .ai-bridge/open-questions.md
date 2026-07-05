# CodexPro Open Questions

- Should SoulForge use a stable ChatGPT Server URL?
  - Default quick Cloudflare tunnel is enough for temporary testing.
  - A stable daily URL needs local ngrok or Cloudflare named tunnel setup.
- Should a particular task be handled by direct ChatGPT edits or handoff?
  - Current default allows direct ChatGPT edits to the SoulForge repo.
  - Use `npm run codexpro:start:handoff` when ChatGPT should only write a plan.
- Should CodexPro read local Codex session metadata?
  - Current scripts leave this off.
  - Enable manually only when a task needs local Codex history context.
