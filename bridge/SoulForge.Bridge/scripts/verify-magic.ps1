param(
  [string]$ProjectPath = (Join-Path $PSScriptRoot '..\SoulForge.Bridge.csproj')
)

$ErrorActionPreference = 'Stop'

$cases = @(
  @{ Name = 'DCX'; Bytes = [byte[]](0x44, 0x43, 0x58, 0x00, 0x01, 0x02); Expected = 'DCX' },
  @{ Name = 'BND3'; Bytes = [byte[]](0x42, 0x4E, 0x44, 0x33, 0x01, 0x02); Expected = 'BND3' },
  @{ Name = 'BND4'; Bytes = [byte[]](0x42, 0x4E, 0x44, 0x34, 0x01, 0x02); Expected = 'BND4' },
  @{ Name = 'EMEVD'; Bytes = [byte[]](0x45, 0x56, 0x44, 0x00, 0x01, 0x02); Expected = 'EMEVD' },
  @{ Name = 'FMG'; Bytes = [byte[]](0x46, 0x4D, 0x47, 0x00, 0x01, 0x02); Expected = 'FMG' }
)

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("soulforge-bridge-magic-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempRoot | Out-Null

try {
  foreach ($case in $cases) {
    $path = Join-Path $tempRoot ($case.Name + ".bin")
    [System.IO.File]::WriteAllBytes($path, $case.Bytes)

    $json = dotnet run --project $ProjectPath -- inspect $path
    $result = $json | ConvertFrom-Json

    if ($result.parseStatus -ne 'partial') {
      throw "Expected parseStatus partial for $($case.Name), got $($result.parseStatus)"
    }

    if ($result.data.rootFormat -ne $case.Expected) {
      throw "Expected rootFormat $($case.Expected), got $($result.data.rootFormat)"
    }

    if (-not $result.data.evidence -or $result.data.evidence.Count -lt 1) {
      throw "Expected evidence for $($case.Name)"
    }

    if (-not $result.data.nextSteps -or $result.data.nextSteps.Count -lt 1) {
      throw "Expected nextSteps for $($case.Name)"
    }

    Write-Output "$($case.Name): ok"
  }
}
finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
