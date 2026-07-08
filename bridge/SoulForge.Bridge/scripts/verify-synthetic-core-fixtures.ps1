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

function UInt32ToBigEndianBytes([uint32]$Value) {
  return [byte[]]((($Value -shr 24) -band 0xFF), (($Value -shr 16) -band 0xFF), (($Value -shr 8) -band 0xFF), ($Value -band 0xFF))
}

function Write-BigEndianUInt32([System.IO.BinaryWriter]$Writer, [uint32]$Value) {
  $Writer.Write((UInt32ToBigEndianBytes $Value))
}

function Get-Adler32([byte[]]$Bytes) {
  [uint32]$mod = 65521
  [uint32]$a = 1
  [uint32]$b = 0
  foreach ($byte in $Bytes) {
    $a = ($a + $byte) % $mod
    $b = ($b + $a) % $mod
  }
  return [uint32](($b -shl 16) -bor $a)
}

function Compress-Zlib([byte[]]$Bytes) {
  $deflatedStream = New-Object System.IO.MemoryStream
  $deflater = New-Object System.IO.Compression.DeflateStream($deflatedStream, [System.IO.Compression.CompressionMode]::Compress, $true)
  $deflater.Write($Bytes, 0, $Bytes.Length)
  $deflater.Dispose()
  $deflated = $deflatedStream.ToArray()
  $deflatedStream.Dispose()
  $adler = UInt32ToBigEndianBytes (Get-Adler32 $Bytes)
  return Join-ByteArrays @([byte[]](0x78, 0xDA), $deflated, $adler)
}

function Invoke-BridgeJson([string]$Command, [string]$FixturePath) {
  $json = dotnet run --project $ProjectPath -- $Command $FixturePath
  if ($LASTEXITCODE -ne 0) {
    throw "Bridge command failed: $Command $FixturePath`n$json"
  }
  return $json | ConvertFrom-Json
}

function Assert-DiagnosticCode($Result, [string]$Code) {
  $codes = @($Result.diagnostics | ForEach-Object { $_.code })
  if ($codes -notcontains $Code) {
    throw "Expected $Code diagnostic, got: $($codes -join ', ')"
  }
}

function Assert-Partial($Result, [string]$Command) {
  if ($Result.parseStatus -ne 'partial') {
    throw "Expected $Command parseStatus partial, got $($Result.parseStatus)"
  }
}

function Write-FmgFixture([string]$Path) {
  $textA = Utf16LeZ 'Sekiro text fixture'
  $textB = Utf16LeZ 'Patch Engine first'
  $stringPool = Join-ByteArrays @($textA, $textB)

  $tableStart = 24
  $stringPoolStart = 40

  $stream = New-Object System.IO.MemoryStream
  $writer = New-Object System.IO.BinaryWriter($stream)
  $writer.Write([byte[]](0x46, 0x4D, 0x47, 0x00)) # FMG\0
  $writer.Write([byte[]](0x53, 0x46, 0x46, 0x58)) # SFFX
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
  [System.IO.File]::WriteAllBytes($Path, $stream.ToArray())
}

function Write-EventFixture([string]$Path) {
  $eventTableStart = 20
  $instructionTableStart = 36

  $stream = New-Object System.IO.MemoryStream
  $writer = New-Object System.IO.BinaryWriter($stream)
  $writer.Write([byte[]](0x45, 0x56, 0x44, 0x00)) # EVD\0
  $writer.Write([byte[]](0x53, 0x46, 0x45, 0x56)) # SFEV
  $writer.Write([int]1)
  $writer.Write([int]1)
  $writer.Write([int]$eventTableStart)

  $writer.Write([int]1000) # eventId
  $writer.Write([int]2) # instructionCount
  $writer.Write([int]$instructionTableStart)
  $writer.Write([int]0) # reserved

  $writer.Write([int]0) # declaredIndex
  $writer.Write([int]2000) # opcode
  $writer.Write([int]1) # role: flag
  $writer.Write([int]71000000) # argValue
  $writer.Write([int]0) # paramNameCode
  $writer.Write([int]0) # reserved

  $writer.Write([int]1) # declaredIndex
  $writer.Write([int]2001) # opcode
  $writer.Write([int]5) # role: paramId
  $writer.Write([int]4000) # argValue
  $writer.Write([int]1) # paramNameCode: SpEffectParam
  $writer.Write([int]0) # reserved

  $writer.Flush()
  [System.IO.File]::WriteAllBytes($Path, $stream.ToArray())
}

function Write-DcxDfltFixture([string]$Path) {
  $payload = Join-ByteArrays @([byte[]](0x45, 0x56, 0x44, 0x00, 0x53, 0x46, 0x45, 0x56), [System.Text.Encoding]::ASCII.GetBytes('dcx-preview'))
  $compressed = Compress-Zlib $payload

  $stream = New-Object System.IO.MemoryStream
  $writer = New-Object System.IO.BinaryWriter($stream)
  $writer.Write([byte[]](0x44, 0x43, 0x58, 0x00)) # DCX\0
  Write-BigEndianUInt32 $writer 0x00011000
  Write-BigEndianUInt32 $writer 0x18
  Write-BigEndianUInt32 $writer 0x24
  Write-BigEndianUInt32 $writer 0x44
  Write-BigEndianUInt32 $writer 0x4C
  $writer.Write([byte[]](0x44, 0x43, 0x53, 0x00)) # DCS\0
  Write-BigEndianUInt32 $writer ([uint32]$payload.Length)
  Write-BigEndianUInt32 $writer ([uint32]$compressed.Length)
  $writer.Write([byte[]](0x44, 0x43, 0x50, 0x00)) # DCP\0
  $writer.Write([byte[]](0x44, 0x46, 0x4C, 0x54)) # DFLT
  Write-BigEndianUInt32 $writer 0x20
  $writer.Write([byte[]](0x09, 0x00, 0x00, 0x00))
  Write-BigEndianUInt32 $writer 0x00
  Write-BigEndianUInt32 $writer 0x00
  Write-BigEndianUInt32 $writer 0x00
  Write-BigEndianUInt32 $writer 0x00010100
  $writer.Write([byte[]](0x44, 0x43, 0x41, 0x00)) # DCA\0
  Write-BigEndianUInt32 $writer 0x08
  $writer.Write($compressed)
  $writer.Flush()
  [System.IO.File]::WriteAllBytes($Path, $stream.ToArray())
}

function Write-ParamFixture([string]$Path) {
  $rowA = Utf16LeZ 'Enable Shinobi Fire'
  $rowB = Utf16LeZ 'Posture Damage'
  $stringPool = Join-ByteArrays @($rowA, $rowB)

  $rowTableStart = 24
  $stringPoolStart = 56

  $stream = New-Object System.IO.MemoryStream
  $writer = New-Object System.IO.BinaryWriter($stream)
  $writer.Write([byte[]](0x50, 0x41, 0x52, 0x41)) # PARA
  $writer.Write([byte[]](0x53, 0x46, 0x50, 0x52)) # SFPR
  $writer.Write([int]1)
  $writer.Write([int]2)
  $writer.Write([int]$rowTableStart)
  $writer.Write([int]$stringPoolStart)

  $writer.Write([int]1000) # rowId
  $writer.Write([int]0) # row name offset
  $writer.Write([int]1) # value
  $writer.Write([int]2) # bool32

  $writer.Write([int]2000) # rowId
  $writer.Write([int]$rowA.Length) # row name offset
  $writer.Write([int]45) # value
  $writer.Write([int]1) # int32

  $writer.Write($stringPool)
  $writer.Flush()
  [System.IO.File]::WriteAllBytes($Path, $stream.ToArray())
}

function Write-MapFixture([string]$Path) {
  $entityA = Utf16LeZ 'c0000_0000_entity'
  $entityB = Utf16LeZ 'o0000_0000_object'
  $region = Utf16LeZ 'region_0000'
  $stringPool = Join-ByteArrays @($entityA, $entityB, $region)

  $entityTableStart = 32
  $regionTableStart = 112
  $stringPoolStart = 148

  $stream = New-Object System.IO.MemoryStream
  $writer = New-Object System.IO.BinaryWriter($stream)
  $writer.Write([byte[]](0x4D, 0x53, 0x42, 0x00)) # MSB\0
  $writer.Write([byte[]](0x53, 0x46, 0x4D, 0x50)) # SFMP
  $writer.Write([int]1)
  $writer.Write([int]2) # entityCount
  $writer.Write([int]$entityTableStart)
  $writer.Write([int]1) # regionCount
  $writer.Write([int]$regionTableStart)
  $writer.Write([int]$stringPoolStart)

  $writer.Write([int]1000)
  $writer.Write([int]0)
  $writer.Write([int]1) # character
  $writer.Write([single]1.0)
  $writer.Write([single]2.0)
  $writer.Write([single]3.0)
  $writer.Write([single]0.0)
  $writer.Write([single]90.0)
  $writer.Write([single]0.0)
  $writer.Write([int]0)

  $writer.Write([int]2000)
  $writer.Write([int]$entityA.Length)
  $writer.Write([int]2) # object
  $writer.Write([single]4.0)
  $writer.Write([single]5.0)
  $writer.Write([single]6.0)
  $writer.Write([single]0.0)
  $writer.Write([single]180.0)
  $writer.Write([single]0.0)
  $writer.Write([int]0)

  $writer.Write([int]3000)
  $writer.Write([int]($entityA.Length + $entityB.Length))
  $writer.Write([int]2) # sphere
  $writer.Write([single]7.0)
  $writer.Write([single]8.0)
  $writer.Write([single]9.0)
  $writer.Write([single]10.0)
  $writer.Write([single]11.0)
  $writer.Write([single]12.0)

  $writer.Write($stringPool)
  $writer.Flush()
  [System.IO.File]::WriteAllBytes($Path, $stream.ToArray())
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("soulforge-core-fixtures-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempRoot | Out-Null

try {
  $fmgPath = Join-Path $tempRoot 'synthetic.fmg'
  $eventPath = Join-Path $tempRoot 'm10_00_00_00.synthetic.emevd'
  $paramPath = Join-Path $tempRoot 'SpEffectParam.synthetic.param'
  $mapPath = Join-Path $tempRoot 'm10_00_00_00.synthetic.msb'
  $dcxPath = Join-Path $tempRoot 'm10_00_00_00.synthetic.emevd.dcx'

  Write-FmgFixture $fmgPath
  Write-EventFixture $eventPath
  Write-ParamFixture $paramPath
  Write-MapFixture $mapPath
  Write-DcxDfltFixture $dcxPath

  $msg = Invoke-BridgeJson 'export-msg' $fmgPath
  Assert-Partial $msg 'export-msg'
  Assert-DiagnosticCode $msg 'MSG_FMG_SYNTHETIC_FIXTURE_CONFIRMED'
  if (-not $msg.data.entries -or $msg.data.entries.Count -ne 2) { throw 'Expected two MSG entries' }

  $event = Invoke-BridgeJson 'export-event' $eventPath
  Assert-Partial $event 'export-event'
  Assert-DiagnosticCode $event 'EMEVD_SYNTHETIC_FIXTURE_CONFIRMED'
  if (-not $event.data.events -or $event.data.events.Count -ne 1) { throw 'Expected one event' }
  if ($event.data.events[0].instructions.Count -ne 2) { throw 'Expected two event instructions' }

  $param = Invoke-BridgeJson 'export-param' $paramPath
  Assert-Partial $param 'export-param'
  Assert-DiagnosticCode $param 'PARAM_SYNTHETIC_FIXTURE_CONFIRMED'
  if (-not $param.data.rows -or $param.data.rows.Count -ne 2) { throw 'Expected two PARAM rows' }

  $map = Invoke-BridgeJson 'export-map' $mapPath
  Assert-Partial $map 'export-map'
  Assert-DiagnosticCode $map 'MSB_SYNTHETIC_FIXTURE_CONFIRMED'
  if (-not $map.data.entities -or $map.data.entities.Count -ne 2) { throw 'Expected two map entities' }
  if (-not $map.data.regions -or $map.data.regions.Count -ne 1) { throw 'Expected one map region' }

  $dcx = Invoke-BridgeJson 'inspect' $dcxPath
  Assert-Partial $dcx 'inspect'
  Assert-DiagnosticCode $dcx 'DCX_PAYLOAD_BOUNDARY_CONFIRMED'
  Assert-DiagnosticCode $dcx 'DCX_DFLT_DECOMPRESSED_PREVIEW_READY'
  $dcxEvidenceKinds = @($dcx.data.evidence | ForEach-Object { $_.kind })
  if ($dcxEvidenceKinds -notcontains 'dcxPayloadBoundary') { throw 'Expected dcxPayloadBoundary evidence' }
  if ($dcxEvidenceKinds -notcontains 'dcxDecompressedPreview') { throw 'Expected dcxDecompressedPreview evidence' }

  Write-Output 'synthetic core fixtures: ok'
}
finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
