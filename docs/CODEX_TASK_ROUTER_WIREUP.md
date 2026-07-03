# Codex Task — Wire Synthetic Fixture Exports

## Goal

Finish the tiny router wire-up for the synthetic fixture exporters that already exist in the repository.

Do not expand scope into native parsers.

## Current state

Already present:

- `bridge/SoulForge.Bridge/FmgTableParser.cs`
- `bridge/SoulForge.Bridge/SyntheticFixtureExports.cs`
- `bridge/SoulForge.Bridge/SyntheticMapFixtureExports.cs`
- `docs/V0_3_FMG_SYNTHETIC_FIXTURE.md`
- `docs/V0_3_SYNTHETIC_EVENT_PARAM_FIXTURES.md`

FMG is already wired through `export-msg`.

Event, PARAM, and map synthetic helpers exist, but they still need final router connection.

## Required code changes

### 1. Route event and PARAM synthetic fixtures first

In `bridge/SoulForge.Bridge/SemanticCandidateExports.cs`, update:

- `TryExportEvent`
- `TryExportParam`

Both functions should keep the existing packed-container boundary check first.

After that, before the low-confidence native candidate scan, add:

```csharp
var fixture = SyntheticFixtureExports.TryExport(sourcePath, "event");
if (fixture != null) return fixture;
```

and:

```csharp
var fixture = SyntheticFixtureExports.TryExport(sourcePath, "param");
if (fixture != null) return fixture;
```

### 2. Route map synthetic fixtures first

In `TryExportMap`, keep the packed-container boundary check first.

Then add:

```csharp
var fixture = SyntheticMapFixtureExports.TryExport(sourcePath);
if (fixture != null) return fixture;
```

Then keep the existing low-confidence visible-name fallback.

### 3. Fix PARAM synthetic field value typing if needed

In `SyntheticFixtureExports.cs`, make sure the bool/int field value compiles cleanly.

Preferred shape:

```csharp
object fieldValue = typeCode == 2 ? value != 0 : value;
```

Then use:

```csharp
value = fieldValue
```

Do not change the exported JSON shape.

## Smoke scripts to add

Add one PowerShell script:

```text
bridge/SoulForge.Bridge/scripts/verify-synthetic-core-fixtures.ps1
```

It should generate temporary synthetic files and run:

```powershell
dotnet run --project bridge/SoulForge.Bridge -- export-msg <synthetic.fmg>
dotnet run --project bridge/SoulForge.Bridge -- export-event <synthetic.emevd>
dotnet run --project bridge/SoulForge.Bridge -- export-param <synthetic.param>
dotnet run --project bridge/SoulForge.Bridge -- export-map <synthetic.msb>
```

Expected diagnostic codes:

```text
MSG_FMG_SYNTHETIC_FIXTURE_CONFIRMED
EMEVD_SYNTHETIC_FIXTURE_CONFIRMED
PARAM_SYNTHETIC_FIXTURE_CONFIRMED
MSB_SYNTHETIC_FIXTURE_CONFIRMED
```

## Build/check commands

Run:

```bash
dotnet build bridge/SoulForge.Bridge/SoulForge.Bridge.csproj
npm run typecheck
npm run build
```

## Hard boundaries

- Do not copy external parser implementations.
- Do not claim native EMEVD/PARAM/MSB authority.
- Do not commit real game assets.
- Do not bypass Bridge for native binary parsing.
- Do not touch Patch Engine.
- Do not redesign the UI.
- Do not remove low-confidence native candidate fallbacks.

## Done definition

The task is done when all four synthetic fixture routes can be exercised from Bridge commands and still fall back to existing candidate behavior for non-synthetic native-looking inputs.
