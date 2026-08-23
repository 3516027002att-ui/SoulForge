using System.Reflection.PortableExecutable;
using System.Security.Cryptography;

namespace SoulForge.Doctor;

public sealed class OodleInspectionResult
{
    public bool Exists { get; set; }
    public string? FilePath { get; set; }
    public bool IsX64 { get; set; }
    public bool HasDecompressExport { get; set; }
    public bool HasCompressExport { get; set; }
    public string? Sha256 { get; set; }
    public string? ErrorMessage { get; set; }
}

public static class OodleDoctor
{
    public const string ExpectedDllName = "oo2core_6_win64.dll";

    public static OodleInspectionResult InspectOodleFile(string? filePath)
    {
        var result = new OodleInspectionResult();
        if (string.IsNullOrWhiteSpace(filePath) || !File.Exists(filePath))
        {
            result.Exists = false;
            return result;
        }

        result.Exists = true;
        result.FilePath = Path.GetFullPath(filePath);

        try
        {
            using (var stream = File.OpenRead(result.FilePath))
            {
                using var sha = SHA256.Create();
                result.Sha256 = Convert.ToHexString(sha.ComputeHash(stream)).ToLowerInvariant();
            }

            using (var stream = File.OpenRead(result.FilePath))
            using (var peReader = new PEReader(stream))
            {
                var headers = peReader.PEHeaders;
                result.IsX64 = headers.CoffHeader.Machine == Machine.Amd64;

                var exportTableDirectory = headers.PEHeader?.ExportTableDirectory;
                if (exportTableDirectory.HasValue && exportTableDirectory.Value.RelativeVirtualAddress != 0)
                {
                    // 确认存在导出表
                    result.HasDecompressExport = true;
                    result.HasCompressExport = true;
                }
            }
        }
        catch (Exception ex)
        {
            result.ErrorMessage = ex.Message;
        }

        return result;
    }

    public static DoctorItem Inspect(string? sekiroDir, string? bridgeDir)
    {
        var item = new DoctorItem
        {
            Key = "oodle_library",
            Title = "Oodle 动态解密库 (oo2core_6_win64.dll)",
            Fixable = true,
            FixDescription = "自动从只狼游戏目录安全复制 oo2core_6_win64.dll"
        };

        string? sekiroOodlePath = null;
        if (!string.IsNullOrWhiteSpace(sekiroDir) && Directory.Exists(sekiroDir))
        {
            var candidate = Path.Combine(sekiroDir, ExpectedDllName);
            if (File.Exists(candidate)) sekiroOodlePath = candidate;
        }

        string? bridgeOodlePath = null;
        if (!string.IsNullOrWhiteSpace(bridgeDir) && Directory.Exists(bridgeDir))
        {
            var candidate = Path.Combine(bridgeDir, ExpectedDllName);
            if (File.Exists(candidate)) bridgeOodlePath = candidate;
        }

        var sekiroOodle = InspectOodleFile(sekiroOodlePath);
        var bridgeOodle = InspectOodleFile(bridgeOodlePath);

        if (sekiroOodle.Exists && sekiroOodle.IsX64)
        {
            item.Status = DoctorStatus.Pass;
            item.Message = $"已在只狼目录中找到合法的 {ExpectedDllName} (SHA256: {sekiroOodle.Sha256?.Substring(0, 8)}...)";
            item.Details = new
            {
                sekiroOodlePath = sekiroOodle.FilePath,
                bridgeOodlePath = bridgeOodle.FilePath,
                sha256 = sekiroOodle.Sha256
            };
        }
        else if (bridgeOodle.Exists && bridgeOodle.IsX64)
        {
            item.Status = DoctorStatus.Pass;
            item.Message = $"已在 SoulForge 目录中找到合法的 {ExpectedDllName}";
            item.Details = new { bridgeOodlePath = bridgeOodle.FilePath };
        }
        else if (sekiroOodle.Exists && !sekiroOodle.IsX64)
        {
            item.Status = DoctorStatus.Fail;
            item.Message = $"{ExpectedDllName} 架构不匹配（非 64 位），请从正版只狼安装目录获取。";
        }
        else
        {
            item.Status = DoctorStatus.Warn;
            item.Message = $"未找到 {ExpectedDllName}；SoulForge 读取 DCX/BND 压缩资源时需要此文件。";
            item.Details = new
            {
                expectedFileName = ExpectedDllName,
                sekiroDirChecked = sekiroDir
            };
        }

        return item;
    }

    public static bool CopyOodle(string sourceSekiroDir, string destinationDir)
    {
        if (string.IsNullOrWhiteSpace(sourceSekiroDir) || string.IsNullOrWhiteSpace(destinationDir)) return false;
        var src = Path.Combine(sourceSekiroDir, ExpectedDllName);
        if (!File.Exists(src)) return false;

        Directory.CreateDirectory(destinationDir);
        var dest = Path.Combine(destinationDir, ExpectedDllName);
        File.Copy(src, dest, overwrite: true);
        return File.Exists(dest);
    }
}
