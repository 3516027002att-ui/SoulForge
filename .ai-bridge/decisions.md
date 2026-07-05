# CodexPro Decisions

Date: 2026-07-04

- CodexPro is integrated as a root dev dependency, not as SoulForge runtime code.
- npm is pinned to the latest published package available during integration:
  `codexpro@0.28.5`.
- The upstream GitHub `main` checkout inspected during integration was
  `rebel0789/codexpro@f3558dc595d9b9c51d0ab73266fecbc9f837a9dd`, whose package
  metadata says `0.28.6`; that version was not published to npm at integration time.
- The default project script uses agent mode with workspace writes enabled:
  `npm run codexpro:start`.
- Handoff-only mode is still available through `npm run codexpro:start:handoff`.
- Agent mode keeps bash in safe mode and requires the explicit CodexPro bash session
  id `soulforge`.
- Stable tunnel choice is intentionally not committed. Configure ngrok or Cloudflare
  named tunnel in local CodexPro settings when needed.
