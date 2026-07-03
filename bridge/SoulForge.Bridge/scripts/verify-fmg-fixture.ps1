param(
  [string]$ProjectPath = (Join-Path $PSScriptRoot '..\SoulForge.Bridge.csproj')
)

$ErrorActionPreference = 'Stop'

function Join-ByteArrays([byte[][]]$Arrays) {
  $length = 0
  foreach ($array in $Arrays) { $length += $array.Length }
  $output = New-Object byte[] $length
  $offset = 0
  foreach ($array in $Arrays) {
    [System.Array]::Copy($array, 0, $output, $offset, $array.Length)
    $offset += $array.Length
  }
  return $output
}

function Utf16LeZ([string]$Text) {
  return Join-ByteArrays @([System.Text.Encoding]::Unicode.GetBytes($Text), [byte[]](0x00, 0x00))
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("soulforge-fmg-fixture-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempRoot | Out-Null

try {
  $fixturePath = Join-Path $tempRoot 'synthetic.fmg'
  $stream = New-Object System.IO.MemoryStream
  $writer = New-Object System.IO.BinaryWriter($stream)

  $textA = Utf16LeZ 'Sekiro text fixture'
  $textB = Utf16LeZ 'Patch Engine first'
  $stringPool = Join-ByteArrays @($textA, $textB)

  $tableStart = 24
  $stringPoolStart = 40

  # Synthetic SoulForge FMG fixture layout, little-endian:
  # 0x00: 'FMG\0'
  # 0x04: 'SFFX'
  # 0x08: version = 1
  # 0x0C: entry count
  # 0x10: table start
  # 0x14: string pool start
  # rows: int32 textId, int32 stringPoolRelativeUtf16Offset
  $writer.Write([byte[]](0x46, 0x4D, 0x47, 0x00))
  $writer.Write([byte[]](0x53, 0x46, 0x46, 0x58))
  $writer.Write([int]1)
  $writer.Write([int]2)
  $writer.Write([int]$tableStart)
  $writer.Write([int]$stringPoolStart)
  $writer.Write([int]1000)
  $writer.Write([int]0)
  $writer.Write([int]2000)
  $writer.Write([int]$textA.Length)
  $writer.Write($stringPool)
  $writer.Flush()

  [System.IO.File]::WriteAllBytes($fixturePath, $stream.ToArray())

  $json = dotnet run --project $ProjectPath -- export-msg $fixturePath
  $result = $json | ConvertFrom-Json

  if ($result.parseStatus -ne 'partial') {
    throw "Expected parseStatus partial, got $($result.parseStatus)"
  }

  $codes = @($result.diagnostics | ForEach-Object { $_.code })
  if ($codes -notcontains 'MSG_FMG_SYNTHETIC_FIXTURE_CONFIRMED') {
    throw "Expected MSG_FMG_SYNTHETIC_FIXTURE_CONFIRMED diagnostic, got: $($codes -join ', ')"
  }

  if (-not $result.data.entries -or $result.data.entries.Count -ne 2) {
    throw "Expected two message entries"
  }

  if ($result.data.entries[0].textId -ne 1000 -or $result.data.entries[0].text -ne 'Sekiro text fixture') {
    throw "First entry mismatch"
  }

  if ($result.data.entries[1].textId -ne 2000 -or $result.data.entries[1].text -ne 'Patch Engine first') {
    throw "Second entry mismatch"
  }

  Write-Output 'synthetic FMG fixture: ok'
}
finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
