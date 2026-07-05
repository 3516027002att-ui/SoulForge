# CodexPro Status

Last updated: 2026-07-05

Integrated:

- Root npm dev dependency: `codexpro@0.28.5`.
- Root npm scripts:
  - `codexpro:doctor`
  - `codexpro:setup`
  - `codexpro:start`
  - `codexpro:start:agent`
  - `codexpro:start:handoff`
  - `codexpro:pro-bundle`
- Stable `.ai-bridge` context files and runtime ignores.
- Default CodexPro start mode allows ChatGPT workspace edits with safe bash and
  required bash session id `soulforge`.
- Chinese setup and safety notes in `docs/CODEXPRO_INTEGRATION.md`.
- Copy-paste quickstart for future chats in `docs/CODEXPRO_QUICKSTART.md`.

Latest verification:

- `npm install --save-dev codexpro@0.28.5`: passed, npm audit reported 0 vulnerabilities.
- `npm run codexpro:doctor`: passed with warnings:
  no saved workspace profile, `cloudflared` not currently installed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm run test`: passed; no workspace currently defines a test script.
