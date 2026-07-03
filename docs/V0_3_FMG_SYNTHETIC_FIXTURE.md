# v0.3 Synthetic FMG Fixture Layout

This document defines the tiny SoulForge-owned FMG fixture format used to prove Bridge routing, message export shape, stable text IDs, and confidence labeling without committing real game assets.

It is not a FromSoftware native FMG specification.

## Purpose

The fixture exists so v0.3 parser work can move forward safely:

- no real game assets are committed;
- `export-msg` can exercise a confirmed fixture path;
- AI and UI can distinguish confirmed fixture output from native-format candidates and raw string fallback;
- later native FMG parsers can replace or sit beside this path without breaking the Bridge contract.

## Binary layout

All integer fields are little-endian signed 32-bit values.

```text
0x00  4 bytes   ASCII magic: FMG\0
0x04  4 bytes   ASCII marker: SFFX
0x08  int32     version, currently 1
0x0C  int32     entry count
0x10  int32     table start offset
0x14  int32     string pool start offset

row table:
  repeated entry count times:
    int32 textId
    int32 stringPoolRelativeUtf16Offset

string pool:
  UTF-16LE null-terminated strings
```

The current smoke fixture uses:

```text
tableStart = 24
stringPoolStart = 40
rows = 2
```

## Bridge behavior

When `MsgTextExport` sees this layout, `FmgTableParser` returns a `FmgParseCandidate` with:

```text
Confidence = confirmed-fixture
Metadata.parser = soulforge-synthetic-fmg-fixture-v1
Metadata.nativeFormatAuthority = false
```

The Bridge diagnostic code is:

```text
MSG_FMG_SYNTHETIC_FIXTURE_CONFIRMED
```

Each exported text entry receives stable fixture `textId` values and `raw.confidence = high`.

## Required smoke script

```powershell
.\bridge\SoulForge.Bridge\scripts\verify-fmg-fixture.ps1
```

The script creates the fixture in a temporary directory, runs:

```powershell
dotnet run --project bridge/SoulForge.Bridge -- export-msg synthetic.fmg
```

and validates:

- `parseStatus = partial`;
- diagnostic code includes `MSG_FMG_SYNTHETIC_FIXTURE_CONFIRMED`;
- two entries are exported;
- stable text IDs are preserved;
- text values round-trip from UTF-16LE strings.

## Boundaries

Do not use this fixture format to claim native FMG support. Native support requires reviewed native fixtures or a documented native layout implementation.

Do not replace the guarded native FMG table candidate with this synthetic format. They are separate confidence tiers.
