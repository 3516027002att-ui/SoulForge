# Issue24: stale expectations and independent negatives

The changes correct test contracts without changing production parsing or write authority. Fixed expectations below come from reviewed source contracts or hand-written control inputs. The GLB matrix is structural self-consistency on an arbitrary corpus; it explicitly does not claim independent-reference correctness.

## Changed expectations

| Test | Why the old expectation was wrong | Reviewed replacement and source | Input that still fails |
| --- | --- | --- | --- |
| Renderer localized workbenches | Assertions still looked for English labels after the UI was localized | Literal Chinese region names from ParamWorkbench, GparamWorkbench, EsdWorkbenchPanel, TaeWorkbenchPanel and FmgWorkbenchPanel; no labels are imported from production at assertion time | Replace any required localized assertion with an incorrect label; the source contract fixture rejects it. Real UI checks still require Electron |
| Renderer suite continuation | Serial mode stopped the rest of the file after one failure; a shared profile also retained cross-test UI state | Default Playwright mode, one profile per test, retained across relaunches within that test; afterEach closes launched apps and removes the owned directory | A real Playwright control deliberately fails its first test, requires the tail to execute, checks different clean profiles and checks both directories were removed |
| SF10 native, and SF29's SF10 leg | Sekiro AI bytecode was assumed to have canWriteBack=false and to reject all source editing | Literal profile `sekiro-ai-luabnd`, representation `bytecode`, canWriteBack=true; scriptLoaderProfile.ts registers this profile, luabndEdit.ts carries it on the native snapshot | Wrong profile or false canWriteBack fails the fixed snapshot assertion. Empty HKS source must return `HKS_SOURCE_EMPTY` and leave the staged container hash unchanged; HksSemanticService.cs defines this error |
| SF10 unit Case9 | Generic byte encoding was expected to perform profile checks; it now rejects every bytecode-to-text encoding before any profile logic | Missing/disabled-profile errors belong to canEditScriptAsSource. The generic encoder must always return `SCRIPT_HKS_BRIDGE_REQUIRED`, including when profiles are missing or disabled | An undefined profile and a hand-disabled bytecode profile remain denied; valid-looking source is still rejected by the generic encoder |
| Indexed TAE URI search | The bounded adapter returns record.matches, not data.items | Require exactly one chr match for the literal expected source URI in data.record.matches; search_resources deliberately omits its redundant items array | Missing record.matches, a wrong URI or duplicate expected identities fail. Native URI ambiguity/outside-overlay negatives remain in the smoke |
| Reference optimization rollback | The original missing-opId call was already fixed in baseline; its nonempty-id check only accumulated a failure and could still invoke rollback with undefined | Require a nonempty string from the committed record before invoking rollback_operation; use the existing operation id, never a fabricated one | Missing, blank and non-string operation ids throw before the rollback invocation; restored native fields/bytes remain required |
| me3 directory changes | The loader's own root mod_loader_log.txt was treated as game resource tampering | Only adding/updating that exact root filename is classified as an expected runtime artifact, and it is separately disclosed | Changing sekiro.exe metadata, removing the loader log, or adding another log is unexpected. This preserves the prior root-file size/mtime observation scope, not recursive/content-hash proof |
| me3 cleanup and section28 outcomes | Every failure cleanup was reported as a watchdog timeout; the kill list recorded unsuccessful commands. Zero exit status also hid skipped section28 legs | Cleanup reason, elapsed/limit, actual PID attempts, final per-image residual observations and unknown observations are explicit. Existing classifyOutcome keeps skipped/partial legs distinct from passed legs | An early 8.6-second failure is not timed out; unsuccessful/unobserved termination is not reported successful; later clean observations supersede intermediate residuals; a zero-exit skipped leg is not passed |
| FLVER/GLB sample selection | Valid empty FLVER documents were fed to an exporter that requires drawable meshes | Preflight native document/topology; exclude and report valid empty entries; reuse summarizeFlverValidation so empty-only/no-sample matrices are unverified | Failed, unsupported, unparsed, malformed-count or wrong-identity reads fail. Empty topology without its explicit diagnostic fails. An omitted drawable export fails the coverage invariant |

All native SF10 mutations, including the negative compiler input, target a private staged container copy. Original game resources remain input only. This change does not authorize executing original binaries or writing original resources.

## Verification in the isolated stale-validation worktree

Verified on Linux with Node 24.19.0:

- `node --test scripts/stale-validation.fixture.mjs`: 10 passed, 0 failed, 0 skipped; includes the actual Playwright continuation/profile control
- Shared/core TypeScript project build: passed using an owned static dependency tree
- `npm run test:audit-sf-10-unit` (and direct built smoke): 10 cases passed; the obsolete Case9 was observed failing before correction
- FLVER validation report and check-runner fixtures: 9 passed, 0 failed, 0 skipped
- Strict typecheck of the new evidence/assertion helpers: passed
- Renderer syntax and actual Playwright collection: passed; 63 tests collected
- me3 runner on Linux: explicit `ME3_SEKIRO_PLATFORM_UNAVAILABLE` skip before desktop build
- section28 without a game root: explicit skipped report
- `git diff --check`: passed

The native SF10/SF29, native indexed TAE/rollback/GLB paths, real me3/game session and Electron UI scenarios were not executed. No original game binary/DLL was read or executed for these checks. UI source/control negatives are not a claim of Electron behavior coverage.

The root `npm test` was attempted and stopped in pretest with `HOST_NATIVE_BINDING_LOAD_FAILED`: the owned dependency tree contains no built better-sqlite3 native binding. Full desktop typecheck was attempted and is unavailable due absent React/react-dom typings. A related desktop-test-build suite ran 12 checks successfully and one dependency-bound case failed before its assertion because electron-vite is absent. No full install or native-output link was used to mask these boundaries.

The named affected check executed SF10 unit and the new convention fixture successfully (two passed legs). The old 3f005c7 base's aggregate registration audit separately rejected bridge:publish:linux, bridge:commands:generate and bridge:commands:check; those ownership errors are already corrected on the newer integrated lead, and are not introduced by this change.
