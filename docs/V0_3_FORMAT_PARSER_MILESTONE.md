# SoulForge v0.3 — Fixture-Confirmed Parser Milestone

v0.3 turns the low-confidence parser candidates from v0.1/v0.2 into reviewed, fixture-confirmed resource exports.

This milestone is not about expanding the UI surface. v0.2 makes the Super Editor visible; v0.3 makes its core resource understanding more trustworthy.

## Product goal

Replace candidate-only resource understanding with fixture-confirmed parsers for the core FromSoftware mod resource chain:

```text
event -> map -> param -> msg
```

The goal is not to conquer every format at once. The goal is to upgrade the most important candidate outputs into stable, testable, evidence-backed exports that the Super Editor and AI tools can rely on.

## Progress snapshot

- FMG has a first fixture-confirmed plumbing path through the SoulForge synthetic FMG fixture layout.
- Synthetic PARAM and event fixture export helpers exist in `SyntheticFixtureExports.cs`.
- The synthetic fixture paths prove Bridge result shapes, stable IDs, typed fields, instruction argument roles, and diagnostic labeling without committing real game assets.
- Native FMG, PARAM, and EMEVD authority is still not claimed. Real native support still requires reviewed native fixtures or documented native layout implementations.
- The guarded native candidates and raw fallbacks remain available and must stay explicitly labeled.
- Current caveat: synthetic event/PARAM helpers still require final router wire-up through `SemanticCandidateExports.TryExport` or `Program.cs` when GitHub write filtering allows direct router edits.

## Required parser upgrades

### 1. FMG text table parser

Current state:

- SoulForge synthetic FMG fixtures can produce confirmed fixture entries through `MSG_FMG_SYNTHETIC_FIXTURE_CONFIRMED`.
- FMG-like payloads may produce guarded table candidates through `MSG_FMG_TABLE_CANDIDATE`.
- Raw string fallback may use file offsets as temporary text IDs through `MSG_TEXT_EXPORT_PARTIAL`.

v0.3 target:

- fixture-confirmed native FMG text ID table parsing;
- stable textId extraction;
- category inference when available;
- raw fallback still available but clearly separated from confirmed IDs;
- tests for little-endian and big-endian fixtures if both are supported.

Acceptance:

- confirmed FMG fixtures export `MsgExport.entries` with stable text IDs;
- raw offset fallback is never treated as confirmed game text ID;
- malformed FMG returns structured diagnostics, not crashes.

### 2. BND child table listing

Current state:

- Inspect can expose low-confidence visible-string `binderChildCandidate` evidence.

v0.3 target:

- fixture-confirmed BND3/BND4 child table listing;
- child names, offsets, compressed/uncompressed sizes where available;
- child resource kind inference;
- no eager extraction of large child payloads unless explicitly requested.

Acceptance:

- BND fixtures produce a child inventory;
- visible-string fallback remains labeled low-confidence;
- offsets and sizes are bounded and validated before use.

### 3. EMEVD event and instruction export

Current state:

- EMEVD candidate export may expose event ID candidates.
- SoulForge synthetic event fixture export helpers can produce event IDs, instruction rows, one numeric argument, argument roles, and high-confidence fixture metadata.
- Final router wire-up is still pending if direct edits to the router file are blocked.

v0.3 target:

- fixture-confirmed native event table parsing;
- event IDs;
- instruction list shape;
- numeric arguments;
- raw instruction metadata;
- confidence labeling for recognized vs unknown instruction semantics.

Acceptance:

- event fixtures export `EventExport.events` with instruction arrays;
- unknown instructions are preserved as raw structured data;
- event calls, flags, entity IDs, text IDs, and param IDs are only high-confidence when instruction semantics justify it.

### 4. PARAM row and field export

Current state:

- PARAM candidate export may expose low-confidence row ID candidates.
- SoulForge synthetic PARAM fixture export helpers can produce row IDs, row names, one typed field per row, and high-confidence fixture metadata.
- Final router wire-up is still pending if direct edits to the router file are blocked.

v0.3 target:

- fixture-confirmed native PARAM row table parsing;
- row IDs;
- row names where available;
- typed fields when layout metadata exists;
- unknown fields preserved without inventing semantics.

Acceptance:

- PARAM fixtures export `ParamExport.rows`;
- fields are typed only when layout evidence exists;
- candidate row IDs are not mixed with confirmed rows without confidence labels.

### 5. MSB entity, region, transform, and model export

Current state:

- MSB candidate export may expose visible entity-name candidates.

v0.3 target:

- fixture-confirmed MSB entity and region tables;
- entity IDs where available;
- names;
- kinds;
- model references;
- positions, rotations, and region sizes where available;
- raw unknown sections preserved.

Acceptance:

- MSB fixtures export `MapExport.entities` and `MapExport.regions`;
- transforms are not fabricated;
- visible-name fallback remains low-confidence.

## Reference graph upgrade

v0.3 should improve reference confidence.

High-confidence references are allowed only when parser or instruction semantics identify a value role. Numeric coincidences remain medium or low confidence.

Required upgrades:

- event instruction role mapping feeds reference builder;
- confirmed map entity IDs can match event args;
- confirmed param rows can match typed param references;
- confirmed text IDs can match text references;
- ambiguous numeric matches stay uncertain.

## Testing requirements

No real game assets or user mods may be committed.

Required test sources:

- tiny synthetic binary fixtures;
- handcrafted JSON bridge fixtures;
- small malformed samples;
- smoke tests around bridge commands.

Required commands:

```bash
npm install
npm run typecheck
npm run build
npm test --workspaces --if-present
dotnet build bridge/SoulForge.Bridge/SoulForge.Bridge.csproj
```

Bridge smoke checks should cover:

```bash
dotnet run --project bridge/SoulForge.Bridge -- inspect path/to/synthetic.bin
dotnet run --project bridge/SoulForge.Bridge -- export-msg path/to/synthetic.fmg
dotnet run --project bridge/SoulForge.Bridge -- export-event path/to/synthetic.emevd
dotnet run --project bridge/SoulForge.Bridge -- export-param path/to/synthetic.param
dotnet run --project bridge/SoulForge.Bridge -- export-map path/to/synthetic.msb
```

Repository smoke scripts:

```powershell
.\bridge\SoulForge.Bridge\scripts\verify-magic.ps1
.\bridge\SoulForge.Bridge\scripts\verify-fmg-fixture.ps1
```

## Hard boundaries

- Do not copy external parser implementations.
- Do not commit real game assets.
- Do not claim authoritative native parsing before native fixtures prove it.
- Do not bypass Bridge for native binary parsing.
- Do not let renderer parse native binary resources directly.
- Do not write into user mod workspaces directly.
- Keep unsupported and failed results structured.

## Done definition

v0.3 is done when the Super Editor shell can show confirmed resource data for at least the core chain:

```text
confirmed text entries
confirmed binder child inventory
confirmed event IDs and instruction arrays
confirmed param rows
confirmed map entities/regions
```

Candidate outputs may still exist as fallbacks, but the UI and AI must be able to distinguish confirmed parser output from low-confidence evidence.

## Relationship to v0.5

v0.3 makes resource understanding reliable enough for large-scale edits.

It does not yet make global AI modification safe. That requires v0.4/v0.5 work on patch planning, dependency analysis, validation, backups, staged writes, rollback, and operation logs.
