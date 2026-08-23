namespace SoulForge.Doctor;

public static class UxmDoctor
{
    public static DoctorItem Inspect(string? sekiroDir)
    {
        var item = new DoctorItem
        {
            Key = "uxm_unpack_status",
            Title = "只狼原版游戏解包状态 (UXM)",
            Fixable = false
        };

        if (string.IsNullOrWhiteSpace(sekiroDir) || !Directory.Exists(sekiroDir))
        {
            item.Status = DoctorStatus.Warn;
            item.Message = "未指定有效的只狼游戏目录。";
            return item;
        }

        var hasMsg = Directory.Exists(Path.Combine(sekiroDir, "msg"));
        var hasEvent = Directory.Exists(Path.Combine(sekiroDir, "event"));
        var hasParam = Directory.Exists(Path.Combine(sekiroDir, "param"));
        var hasMap = Directory.Exists(Path.Combine(sekiroDir, "map"));

        var isUnpacked = hasMsg || hasEvent || hasParam || hasMap;

        item.Details = new
        {
            isUnpacked,
            hasMsg,
            hasEvent,
            hasParam,
            hasMap
        };

        if (isUnpacked)
        {
            item.Status = DoctorStatus.Pass;
            item.Message = "已检测到只狼原生解包目录 (UXM)，支持完整的原版资源索引与对照参考。";
        }
        else
        {
            item.Status = DoctorStatus.Pass;
            item.Message = "游戏本体处于标准封包状态；SoulForge 支持基于虚拟层与 ModEngine 直接编辑。";
        }

        return item;
    }
}
