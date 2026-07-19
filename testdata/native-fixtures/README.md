# Has-game native fixture registry

Private hash-bound fixture registry contract for local Sekiro installs.

## Paths
- Registry: a repository-external JSON file that conforms to
  `schemas/native-fixture-registry.schema.json`
- Fixture/game root: a user-supplied read-only Sekiro installation

## Env
- SOULFORGE_NATIVE_FIXTURE_ROOT
- SOULFORGE_NATIVE_FIXTURE_REGISTRY
- SOULFORGE_SEKIRO_GAME_ROOT

## Hard rules
- Never write into game root or mods.
- Native writers must use Patch Engine staging/backup/atomic replace/reread/audit/rollback only.
- Do not claim V0.5 complete from registry alone.

## Required roles
- bnd4-primary
- fmg-primary
- param-primary
- emevd-primary
- msb-primary
- chrbnd-primary
- one DCX-DFLT document
- one DCX-KRAK document

Each entry must bind its relative path to the expected SHA-256 hash. Do not
commit a populated private registry or fixture paths from a local machine.

## Validate
node scripts/verify-native-fixture-registry.mjs
npm run test:private-native-gate

`npm run test:has-game-flver-candidate` never discovers local paths. Set all
three environment variables explicitly before running it; missing paths remain
fail-closed.
