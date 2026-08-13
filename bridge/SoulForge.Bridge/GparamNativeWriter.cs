using System.Security.Cryptography;
using System.Text.Json;

/// <summary>
/// Sekiro GPARAM typed writer（GPARAM-11C）。
///
/// 只接受 typed field-set mutation：定位 group→param→valueIndex，改一处值，
/// 其余全部保留并重建。重建路径复用 GparamNativeDocument.Rebuild（11A 已
/// 逐字节 round-trip 验证），本 writer 只负责 mutation 定位、范围校验与
/// 输出后重读验证。
///
/// 不提供「通用 bytes replace fallback」：没有 typed 定位就没有写入口。
/// 值范围按类型收紧（byte 0-255、bool 0/1、short int16、int int32），
/// 越界即拒绝，不截断。
/// </summary>
internal static class GparamNativeWriter
{
    private sealed record FieldSetMutation(int GroupId, int ParamId, int ValueIndex, double Value);

    public static async Task<object> WriteAsync(
        string sourcePath,
        string outputPath,
        JsonElement options,
        CancellationToken cancellationToken,
        string? oodleRuntimeRoot = null)
    {
        var isDcx = Path.GetExtension(sourcePath).Equals(".dcx", StringComparison.OrdinalIgnoreCase);
        var source = await File.ReadAllBytesAsync(sourcePath, cancellationToken);
        // DCX 源：先解压再解析（与 read-gparam-document 同一路径）；写回时按
        // 原压缩格式重建（DFLT 内置、KRAK 需 Oodle compress session）。
        var payload = isDcx
            ? DcxNativeDocument.Read(sourcePath, oodleRuntimeRoot).Payload
            : source;
        var document = GparamNativeDocument.Read(payload);
        RequireHash(options, "expectedDocumentHash", document.SourceHash, "GPARAM source hash");

        var mutations = ParseMutations(options);
        if (mutations.Count == 0) throw new InvalidDataException("GPARAM writer 需要至少一条 mutation。");

        // 定位预检：负 groupId/paramId 与越界 valueIndex 必须是结构化失败
        // （InvalidDataException → GPARAM_STAGING_WRITE_FAILED），不能靠集合
        // 索引抛 ArgumentOutOfRangeException —— 那会变成 daemon 崩溃语义。
        foreach (var m in mutations)
        {
            if (m.GroupId < 0 || m.GroupId >= document.Groups.Count)
                throw new InvalidDataException($"group {m.GroupId} 越界（0..{document.Groups.Count - 1}）。");
            var targetGroup = document.Groups[m.GroupId];
            if (m.ParamId < 0 || m.ParamId >= targetGroup.Params.Count)
                throw new InvalidDataException($"param {m.ParamId} 越界（0..{targetGroup.Params.Count - 1}）。");
            if (m.ValueIndex < 0 || m.ValueIndex >= targetGroup.Params[m.ParamId].Values.Length)
                throw new InvalidDataException(
                    $"valueIndex {m.ValueIndex} 越界（0..{targetGroup.Params[m.ParamId].Values.Length - 1}）。");
        }

        // groupId/paramId 是序号语义（与 read envelope 的 groupId/paramId 一致）：
        // groupId = group 在文档中的序号，paramId = param 在 group 内的序号。
        // 定位并构造新的 groups：只替换目标 param 的 Values，其余对象原样复用。
        var updatedGroups = new List<GparamGroup>(document.Groups.Count);
        for (var g = 0; g < document.Groups.Count; g++)
        {
            var group = document.Groups[g];
            var paramsList = new List<GparamParam>(group.Params.Count);
            var groupMutations = mutations.Where(m => m.GroupId == g).ToList();
            for (var p = 0; p < group.Params.Count; p++)
            {
                var param = group.Params[p];
                var target = groupMutations.Where(m => m.ParamId == p).ToList();
                if (target.Count == 0)
                {
                    paramsList.Add(param);
                    continue;
                }
                var values = (double[])param.Values.Clone();
                foreach (var m in target)
                {
                    if (m.ValueIndex < 0 || m.ValueIndex >= values.Length)
                        throw new InvalidDataException(
                            $"param {param.Name1} valueIndex {m.ValueIndex} 越界（0..{values.Length - 1}）。");
                    ValidateRange(param.Type, m.Value);
                    values[m.ValueIndex] = m.Value;
                }
                paramsList.Add(new GparamParam
                {
                    Name1 = param.Name1,
                    Name2 = param.Name2,
                    Type = param.Type,
                    ValueCount = param.ValueCount,
                    Values = values,
                    ValueIds = param.ValueIds,
                    UnkFloats = param.UnkFloats
                });
            }
            updatedGroups.Add(new GparamGroup
            {
                Name1 = group.Name1,
                Name2 = group.Name2,
                Params = paramsList
            });
        }

        cancellationToken.ThrowIfCancellationRequested();
        var rebuiltPayload = document.WithGroups(updatedGroups).Rebuild();
        // DCX 输出：按原压缩格式包回。KRAK 需要 compress session（Oodle 运行库）；
        // 无 session 时明确失败，不静默降级为 DFLT（那会改变 storage profile）。
        var rebuilt = isDcx
            ? RebuildDcx(sourcePath, rebuiltPayload, oodleRuntimeRoot)
            : rebuiltPayload;

        var directory = Path.GetDirectoryName(outputPath) ?? throw new InvalidDataException("outputPath 没有父目录。");
        Directory.CreateDirectory(directory);
        var temporary = Path.Combine(directory, $".soulforge-{Guid.NewGuid():N}.tmp");
        try
        {
            await File.WriteAllBytesAsync(temporary, rebuilt, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            File.Move(temporary, outputPath, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }

        // 重读并逐条验证 mutation 效果：目标值匹配（兄弟值由重建不变性覆盖）。
        // DCX 输出必须按 DCX 解压后再解析（ReadFile 只认裸 GPARAM 的 "filt" magic）。
        var rereadPayload = isDcx
            ? DcxNativeDocument.Read(outputPath, oodleRuntimeRoot).Payload
            : File.ReadAllBytes(outputPath);
        var reread = GparamNativeDocument.Read(rereadPayload);
        foreach (var m in mutations)
        {
            if (m.GroupId >= reread.Groups.Count) throw new InvalidDataException($"重读后 group {m.GroupId} 不存在。");
            var group = reread.Groups[m.GroupId];
            if (m.ParamId >= group.Params.Count) throw new InvalidDataException($"重读后 param {m.ParamId} 不存在。");
            var param = group.Params[m.ParamId];
            if (m.ValueIndex >= param.Values.Length) throw new InvalidDataException("重读后 valueIndex 越界。");
            var actual = param.Values[m.ValueIndex];
            if (!ValuesMatch(m.Value, actual, param.Type))
                throw new InvalidDataException(
                    $"重读后 param {param.Name1}[{m.ValueIndex}] 值不匹配（期望 {m.Value}，实际 {actual}）。");
        }

        return new
        {
            mutationCount = mutations.Count,
            outputHash = reread.SourceHash,
            groupCount = reread.GroupCount,
            paramCount = reread.Groups.Sum(g => g.Params.Count),
            outputSize = reread.SourceBytes.Length,
            rereadVerified = true
        };
    }

    private static byte[] RebuildDcx(string sourcePath, byte[] nextPayload, string? oodleRuntimeRoot)
    {
        var dcx = DcxNativeDocument.Read(sourcePath, oodleRuntimeRoot);
        if (dcx.CompressionFormat == "DFLT") return dcx.RebuildDflt(nextPayload);
        if (dcx.CompressionFormat == "KRAK")
        {
            var oodle = OodleRuntimeLocator.Open(oodleRuntimeRoot);
            if (oodle.Session == null || !oodle.Session.CanCompress)
                throw new NotSupportedException("KRAK 写回需要支持压缩的 Oodle 运行库。");
            using var session = oodle.Session;
            return dcx.RebuildKrak(nextPayload, session);
        }
        throw new NotSupportedException($"DCX 压缩格式 {dcx.CompressionFormat} 无法重建。");
    }

    private static List<FieldSetMutation> ParseMutations(JsonElement options)
    {
        var list = new List<FieldSetMutation>();
        if (options.TryGetProperty("mutations", out var array) && array.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in array.EnumerateArray())
                list.Add(ParseSingle(item));
        }
        else
        {
            list.Add(ParseSingle(options));
        }
        return list;
    }

    private static FieldSetMutation ParseSingle(JsonElement element)
    {
        return new FieldSetMutation(
            RequiredInt(element, "groupId"),
            RequiredInt(element, "paramId"),
            RequiredInt(element, "valueIndex"),
            RequiredDouble(element, "value"));
    }

    private static void ValidateRange(GparamValueType type, double value)
    {
        switch (type)
        {
            case GparamValueType.Byte:
            case GparamValueType.Byte4:
                if (value < 0 || value > 255 || Math.Truncate(value) != value)
                    throw new InvalidDataException($"byte 值必须在 0..255 整数范围，收到 {value}。");
                break;
            case GparamValueType.BoolA:
            case GparamValueType.BoolB:
                if (value != 0 && value != 1)
                    throw new InvalidDataException($"bool 值必须是 0 或 1，收到 {value}。");
                break;
            case GparamValueType.Short:
                if (value < short.MinValue || value > short.MaxValue || Math.Truncate(value) != value)
                    throw new InvalidDataException($"short 值必须在 {short.MinValue}..{short.MaxValue} 整数范围，收到 {value}。");
                break;
            case GparamValueType.IntA:
            case GparamValueType.IntB:
                if (value < int.MinValue || value > int.MaxValue || Math.Truncate(value) != value)
                    throw new InvalidDataException($"int 值必须在 {int.MinValue}..{int.MaxValue} 整数范围，收到 {value}。");
                break;
            default:
                // float 家族：double → f32 的精度损失由重读比对容忍（见 WriteSingle 语义）
                break;
        }
    }

    /// <summary>
    /// 重读比对：float 家族允许 f32 精度损失（double → f32 → double 的 ULP 级
    /// 漂移是存储格式的固有行为，不是 writer 错误）；整数域必须精确相等。
    /// </summary>
    private static bool ValuesMatch(double expected, double actual, GparamValueType type)
    {
        if (type is GparamValueType.Float
            or GparamValueType.Float2 or GparamValueType.Float3 or GparamValueType.Float4)
        {
            const double tolerance = 1e-6;
            return Math.Abs(expected - actual) <= tolerance * Math.Max(1.0, Math.Abs(expected));
        }
        return expected == actual;
    }

    private static void RequireHash(JsonElement options, string field, string actual, string label)
    {
        if (!RequiredString(options, field).Equals(actual, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException($"{label} 不匹配。");
    }

    private static string RequiredString(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString())
            ? value.GetString()! : throw new InvalidDataException($"options.{field} 是必填字符串。");

    private static int RequiredInt(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.Number
            ? value.GetInt32() : throw new InvalidDataException($"options.{field} 是必填整数。");

    private static double RequiredDouble(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind is JsonValueKind.Number or JsonValueKind.String
            ? value.GetDouble() : throw new InvalidDataException($"options.{field} 是必填数值。");
}
