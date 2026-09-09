using System.Buffers.Binary;
using System.Text.Json;

/// <summary>
/// Sekiro-era FXR3（FFX particle effect）字段 writer（VFX-54C）。
///
/// 只接受 typed `vfx-field-set` mutation：把某个「已知布局」容器里 Section11 的
/// 一个 Int32（混合 int/float 位模式，无 schema，按不透明值）字节级外科替换。
/// 容器定位用结构性路径（host 收集序 + property/§8 下标 + Section11 值下标），
/// 与 read 侧 FxrNativeDocument 的树遍历顺序一一对应。
///
/// 三种容器（见 <see cref="FxrNativeDocument"/> 的布局注释）：
///   · <c>host</c>      —— FFXDrawEntityHost 的 Section11 值数组（Properties1 前的
///     直连区，Section11Count1+Section11Count2）。
///   · <c>property</c>  —— FFXProperty 的 Section11 值数组。
///   · <c>section8</c>  —— Section8 条目自己的 Section11 值数组。
///
/// <b>已知布局门（硬约束：未知字段无法无损保留时不得开放 writer）</b>：
/// 写入口只在整份文件的结构被完全理解时开放。字节级外科替换天然保留目标区间
/// 之外的一切字节，但「结构完全已知」是更严的前提——任何以下情形都 fail-closed
/// （<see cref="FxrWriteBlockedException"/>，FXR_WRITE_BLOCKED_UNKNOWN_STRUCTURE）：
///   · 出现未识别的 node type（unknown-type:/unexpected-type: gap）——树遍历不可信；
///   · 出现 layout warning（Section1/2 的 +0x00/+0x0C 非零等）——布局可能与已登记形态不同；
///   · Section9 非空——布局取自 SoulsFormats、121 个真实样本从未实测（section9-not-verified）；
///   · Section12/13/14 非空——非空布局未验证（section12-14:opaque-int-array）。
/// Section11 的 opacity（section11:opaque-int-array）与 Section12-14 恒空
/// （section12-14-empty-samples-only）是「能力边界」而非「未知结构」，不阻止写。
///
/// 无损策略：克隆源字节后只改写目标 Int32，其余字节逐位保留；写回重读后
/// unparsedGaps 必须逐项一致（能力边界不变），且字节级 diff 必须恰好落在目标
/// Int32 上。重读 roundTrip.consistent 必须保持。
///
/// 只接受 loose .fxr：FXR 在 Sekiro 中位于 ffxbnd.dcx 容器内子项，容器外层重建由
/// Patch Engine 在 main 侧完成（与 ESD/TAE/MTD 同一分工），本 writer 不重复实现
/// 容器逻辑。
/// </summary>
internal static class FxrNativeWriter
{
    // ── Layout constants（与 FxrNativeDocument.cs 同源；改动必须同步）──
    private const int HeaderSize = 0x90;
    private const int Section4Size = 0x30;
    private const int Section5Size = 0x20;
    private const int Section6Size = 0x40;
    private const int Section7Size = 0x28;
    private const int Section8Size = 0x20;
    private const int Section11ValueSize = 4;
    private const long MaxSourceBytes = 12L * 1024 * 1024;

    private const int MaxSection23Count = 1_000_000;
    private const int MaxSection6Count = 100_000;
    private const int MaxHostProperties = 100_000;
    private const int MaxPropertyCount = 1_000_000;

    public static async Task<object> WriteAsync(
        string sourcePath,
        string outputPath,
        JsonElement options,
        CancellationToken cancellationToken)
    {
        var source = await File.ReadAllBytesAsync(sourcePath, cancellationToken);
        if (source.Length < HeaderSize || source.Length > MaxSourceBytes)
            throw new InvalidDataException($"FXR 大小 {source.Length} 超出安全范围。");
        if (!source.AsSpan(0, 4).SequenceEqual("FXR\0"u8))
            throw new InvalidDataException("write-fxr-document 只接受裸 .fxr（缺少 \"FXR\\0\" 魔数）。");
        var document = FxrNativeDocument.Read(source);
        RequireHash(options, "expectedDocumentHash", document.SourceHash, "FXR source hash");

        // 已知布局门：任何「结构未完全理解」的迹象都 fail-closed。
        EnsureKnownLayout(document);

        var mutations = new List<FxrMutation>();
        if (options.TryGetProperty("mutations", out var mutationArray) && mutationArray.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in mutationArray.EnumerateArray())
                mutations.Add(ParseMutation(item));
        }
        else
        {
            mutations.Add(ParseMutation(options));
        }
        if (mutations.Count == 0)
            throw new InvalidDataException("FXR writer 需要至少一条 mutation。");

        var context = new WriteContext(source, document);
        var appliedResults = new List<FxrApplied>(mutations.Count);
        foreach (var mutation in mutations)
        {
            cancellationToken.ThrowIfCancellationRequested();
            appliedResults.Add(context.Apply(mutation));
        }

        var rebuilt = context.Bytes;
        var directory = Path.GetDirectoryName(outputPath) ?? throw new InvalidDataException("outputPath 没有父目录。");
        Directory.CreateDirectory(directory);
        var temporary = Path.Combine(directory, $".soulforge-fxr-{Guid.NewGuid():N}.tmp");
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

        // ── Reopen reread 校验：已知布局 + 能力边界 + 累积字节外科 ──
        var reread = FxrNativeDocument.ReadFile(outputPath);
        EnsureKnownLayout(reread);
        if (!reread.UnparsedGaps().SequenceEqual(document.UnparsedGaps()))
            throw new InvalidDataException("重读后 unparsedGaps 变化（未知结构未无损保留）。");
        if (!reread.VerifyRoundTrip().Consistent)
            throw new InvalidDataException("重读后 FXR 往返一致性失败。");

        var summaries = new List<object>(mutations.Count);
        context.VerifyReopen(reread, mutations, appliedResults);
        foreach (var applied in appliedResults)
            summaries.Add(applied.ToSummary());

        return new
        {
            mutationCount = mutations.Count,
            outputHash = reread.SourceHash,
            outputSize = reread.SourceBytes.Length,
            rereadVerified = true,
            structurePreserved = true,
            byteSurgical = true,
            mutations = summaries
        };
    }

    private static void EnsureKnownLayout(FxrNativeDocument document)
    {
        if (document.LayoutWarnings.Count > 0)
        {
            throw new FxrWriteBlockedException(
                $"FXR 存在布局警告（数据可疑，布局可能与已登记形态不同），拒绝写回：{string.Join("; ", document.LayoutWarnings)}",
                new { reason = "layout-warnings-present", warnings = document.LayoutWarnings.ToArray() });
        }
        var gaps = document.UnparsedGaps();
        var unknownTypes = gaps
            .Where(g => g.StartsWith("unknown-type:", StringComparison.Ordinal)
                || g.StartsWith("unexpected-type:", StringComparison.Ordinal))
            .ToArray();
        if (unknownTypes.Length > 0)
        {
            throw new FxrWriteBlockedException(
                $"FXR 存在未识别的 node type，布局未完全已知，拒绝写回：{string.Join("; ", unknownTypes)}",
                new { reason = "unknown-node-types", gaps = unknownTypes });
        }
        if (gaps.Any(g => g.StartsWith("section9-not-verified", StringComparison.Ordinal)))
        {
            throw new FxrWriteBlockedException(
                "FXR Section9 布局从未在真实样本验证（SoulsFormats 来源），拒绝写回。",
                new { reason = "section9-not-verified", section9Count = document.Section9Total });
        }
        if (gaps.Any(g => g.StartsWith("section12-14:opaque-int-array", StringComparison.Ordinal)))
        {
            throw new FxrWriteBlockedException(
                $"FXR Section12-14 非空布局未验证，拒绝写回"
                + $"（section12={document.Section12Count}, section13={document.Section13Count}, section14={document.Section14Count}）。",
                new
                {
                    reason = "section12-14-nonempty",
                    section12 = document.Section12Count,
                    section13 = document.Section13Count,
                    section14 = document.Section14Count
                });
        }
    }

    private static FxrMutation ParseMutation(JsonElement item)
    {
        var kind = RequiredString(item, item.TryGetProperty("kind", out _) ? "kind" : "mutation").ToLowerInvariant();
        if (kind != "vfx-field-set")
            throw new InvalidDataException($"未知 FXR mutation 类型：{kind}（本版只开放 vfx-field-set）。");
        if (!item.TryGetProperty("address", out var addressElement) || addressElement.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("vfx-field-set 需要 address 对象。");
        var container = RequiredString(addressElement, "container").ToLowerInvariant();
        var hostIndex = RequiredInt(addressElement, "hostIndex");
        var propertyIndex = OptionalInt(addressElement, "propertyIndex") ?? -1;
        var section8Index = OptionalInt(addressElement, "section8Index") ?? -1;
        var valueIndex = RequiredInt(addressElement, "valueIndex");
        // Section11 值是无 schema 的 32 位位模式：接受 int32 或 uint32 两种十进制
        // 表达（0xFFFFFFFF = 4294967295 会被截断成 -1 的位模式）。
        var value = ParseInt32Value(item, "value");
        return new FxrMutation(kind, new FxrFieldAddress(container, hostIndex, propertyIndex, section8Index, valueIndex), value);
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
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var parsed)
            ? parsed : throw new InvalidDataException($"options.{field} 是必填 int32。");

    /// <summary>
    /// 读一个 32 位位模式值：接受 int32 十进制，也接受 uint32 十进制
    /// （0x80000000..0xFFFFFFFF 在 JSON 里是无符号正数，按 int64 读后截断成位模式）。
    /// </summary>
    private static int ParseInt32Value(JsonElement options, string field)
    {
        if (!options.TryGetProperty(field, out var value) || value.ValueKind != JsonValueKind.Number)
            throw new InvalidDataException($"options.{field} 是必填 int32。");
        if (value.TryGetInt32(out var asInt32)) return asInt32;
        if (value.TryGetInt64(out var asInt64) && asInt64 is >= int.MinValue and <= uint.MaxValue)
            return unchecked((int)asInt64);
        throw new InvalidDataException($"options.{field} 超出 32 位整数范围。");
    }

    private static int? OptionalInt(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var parsed)
            ? (int?)parsed : null;

    private static int ReadInt32(byte[] data, int offset) =>
        BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset, 4));

    /// <summary>一条 vfx-field-set mutation 的解析后形态。address 是结构性路径。</summary>
    private sealed record FxrMutation(string Kind, FxrFieldAddress Address, int Value);

    private sealed record FxrFieldAddress(
        string Container,
        int HostIndex,
        int PropertyIndex,
        int Section8Index,
        int ValueIndex);

    /// <summary>
    /// writer 对一个 mutation 的应用结果（含写后校验所需的绝对偏移与旧值）。
    /// </summary>
    private sealed class FxrApplied
    {
        public required string Container { get; init; }
        public required int HostIndex { get; init; }
        public int PropertyIndex { get; init; } = -1;
        public int Section8Index { get; init; } = -1;
        public required int ValueIndex { get; init; }
        public required int Value { get; init; }
        public required int ValueAbsOffset { get; init; }
        public required int ValueBefore { get; init; }

        public object ToSummary() => new
        {
            mutation = "vfx-field-set",
            container = Container,
            hostIndex = HostIndex,
            propertyIndex = PropertyIndex >= 0 ? (int?)PropertyIndex : null,
            section8Index = Section8Index >= 0 ? (int?)Section8Index : null,
            valueIndex = ValueIndex,
            valueAbsOffset = ValueAbsOffset,
            valueBefore = ValueBefore,
            valueAfter = Value
        };
    }

    /// <summary>
    /// 写上下文：持有源字节与工作字节，用字节级布局定位目标 Section11 的绝对偏移。
    /// 布局遍历顺序与 FxrNativeDocument.CollectHosts 完全一致（直接 §6 → §5 → 子节点，
    /// visited6 按绝对偏移去重），保证 hostIndex 与 read 信封的 hosts[] 一一对应。
    /// </summary>
    private sealed class WriteContext
    {
        private readonly byte[] _source;
        private byte[] _bytes;
        private readonly FxrLayout _layout;
        private readonly List<int> _targetOffsets = new();

        public WriteContext(byte[] source, FxrNativeDocument document)
        {
            _source = source;
            _bytes = (byte[])source.Clone();
            _layout = FxrLayout.Read(source, document);
        }

        public byte[] Bytes => _bytes;

        public FxrApplied Apply(FxrMutation mutation)
        {
            var absOffset = _layout.ResolveValueOffset(mutation.Address, _bytes);
            if (absOffset < 0 || absOffset + Section11ValueSize > _bytes.Length)
                throw new InvalidDataException($"FXR 目标 Section11 值偏移 {absOffset} 越界。");
            var before = ReadInt32(_bytes, absOffset);
            BinaryPrimitives.WriteInt32LittleEndian(_bytes.AsSpan(absOffset, Section11ValueSize), mutation.Value);
            _targetOffsets.Add(absOffset);
            return new FxrApplied
            {
                Container = mutation.Address.Container,
                HostIndex = mutation.Address.HostIndex,
                PropertyIndex = mutation.Address.PropertyIndex,
                Section8Index = mutation.Address.Section8Index,
                ValueIndex = mutation.Address.ValueIndex,
                Value = mutation.Value,
                ValueAbsOffset = absOffset,
                ValueBefore = before
            };
        }

        /// <summary>
        /// Reopen 校验：结构偏移不变 + 目标值命中 + 累积字节外科
        /// （output 与源只允许在全部目标区间的并集内不同）。多条 mutation 的顺序
        /// 应用各自只对「自己的增量」负责，因此按源做累积比较而不是逐条快照。
        /// 同一次调用内多条 mutation 指向同一偏移时，最终值取最后一条（覆盖式）。
        /// </summary>
        public void VerifyReopen(
            FxrNativeDocument reread,
            IReadOnlyList<FxrMutation> mutations,
            IReadOnlyList<FxrApplied> applieds)
        {
            var output = reread.SourceBytes;
            // 结构未变（vfx-field-set 只改 Int32），重读后布局偏移必须一致。
            var rereadLayout = FxrLayout.Read(output, reread);
            for (var i = 0; i < mutations.Count; i++)
            {
                var applied = applieds[i];
                var absOffset = rereadLayout.ResolveValueOffset(mutations[i].Address, output);
                if (absOffset != applied.ValueAbsOffset)
                    throw new InvalidDataException(
                        $"重读后目标偏移 {absOffset} ≠ 写入时 {applied.ValueAbsOffset}（结构意外变化）。");
            }
            // 每个目标偏移的期望终值 = 该偏移最后一次写入的值（覆盖式语义）。
            var expectedByOffset = new Dictionary<int, int>();
            for (var i = 0; i < applieds.Count; i++)
                expectedByOffset[applieds[i].ValueAbsOffset] = applieds[i].Value;
            foreach (var (offset, expected) in expectedByOffset)
            {
                var actual = ReadInt32(output, offset);
                if (actual != expected)
                    throw new InvalidDataException(
                        $"重读后目标偏移 {offset} 值 {actual} ≠ 写入 {expected}。");
            }
            VerifyCumulativeSurgicalDiff(output, _targetOffsets);
        }

        /// <summary>
        /// 重读 output 与源字节，除全部目标区间外必须逐字节一致（字节外科的直接证据）。
        /// </summary>
        private void VerifyCumulativeSurgicalDiff(byte[] output, IReadOnlyList<int> targetOffsets)
        {
            if (output.Length != _source.Length)
                throw new InvalidDataException($"重读 output 长度 {output.Length} 与源 {_source.Length} 不一致。");
            for (var i = 0; i < output.Length; i++)
            {
                var inRegion = targetOffsets.Any(off => i >= off && i < off + Section11ValueSize);
                if (!inRegion && output[i] != _source[i])
                    throw new InvalidDataException($"重读 output 在偏移 {i} 与源不一致（外科替换区间外）。");
            }
        }
    }

    /// <summary>
    /// 从源字节轻量重走 FXR 布局：按 CollectHosts 顺序收集 host 的绝对偏移与
    /// Section11/§7/§8 引用偏移，供 vfx-field-set 定位目标 Int32。
    /// 与 FxrNativeDocument.Read 的布局口径一致（文档已先通过校验，这里只做
    /// writer 需要的字节级定位）。遍历必须与 read 顺序完全一致，否则 hostIndex
    /// 的语义会漂移。
    /// </summary>
    private sealed class FxrLayout
    {
        private readonly IReadOnlyList<FxrHostLayout> _hosts;

        private FxrLayout(IReadOnlyList<FxrHostLayout> hosts)
        {
            _hosts = hosts;
        }

        public int HostCount => _hosts.Count;

        public int ResolveValueOffset(FxrFieldAddress address, byte[] bytes)
        {
            if (address.HostIndex < 0 || address.HostIndex >= _hosts.Count)
                throw new InvalidDataException(
                    $"FXR hostIndex {address.HostIndex} 越界（hosts={_hosts.Count}）。");
            var host = _hosts[address.HostIndex];
            switch (address.Container)
            {
                case "host":
                    ValidateValueIndex(address.ValueIndex, host.Section11TotalCount, "host");
                    return host.Section11Offset + address.ValueIndex * Section11ValueSize;
                case "property":
                    if (address.PropertyIndex < 0 || address.PropertyIndex >= host.Properties.Count)
                        throw new InvalidDataException(
                            $"FXR host[{address.HostIndex}] propertyIndex {address.PropertyIndex} 越界（properties={host.Properties.Count}）。");
                    var prop = host.Properties[address.PropertyIndex];
                    ValidateValueIndex(address.ValueIndex, prop.Section11Count, "property");
                    return prop.Section11Offset + address.ValueIndex * Section11ValueSize;
                case "section8":
                    if (address.PropertyIndex < 0 || address.PropertyIndex >= host.Properties.Count)
                        throw new InvalidDataException(
                            $"FXR host[{address.HostIndex}] propertyIndex {address.PropertyIndex} 越界（properties={host.Properties.Count}）。");
                    var p = host.Properties[address.PropertyIndex];
                    if (address.Section8Index < 0 || address.Section8Index >= p.Section8s.Count)
                        throw new InvalidDataException(
                            $"FXR host[{address.HostIndex}] property[{address.PropertyIndex}] section8Index {address.Section8Index} 越界（section8s={p.Section8s.Count}）。");
                    var s8 = p.Section8s[address.Section8Index];
                    ValidateValueIndex(address.ValueIndex, s8.Section11Count, "section8");
                    return s8.Section11Offset + address.ValueIndex * Section11ValueSize;
                default:
                    throw new InvalidDataException($"未知 FXR 容器：{address.Container}。");
            }
        }

        private static void ValidateValueIndex(int valueIndex, int count, string container)
        {
            if (valueIndex < 0 || valueIndex >= count)
                throw new InvalidDataException(
                    $"FXR {container} Section11 valueIndex {valueIndex} 越界（count={count}）。");
        }

        public static FxrLayout Read(byte[] source, FxrNativeDocument document)
        {
            var hosts = new List<FxrHostLayout>();
            var visited6 = new HashSet<int>();
            foreach (var root in document.RootNodes)
            {
                CollectHosts(source, root, visited6, hosts);
            }
            if (hosts.Count == 0)
                throw new InvalidDataException("FXR 文件没有可写的 Section6 host（布局未知）。");
            return new FxrLayout(hosts);
        }

        private static void CollectHosts(
            byte[] source,
            FxrSection4Node node,
            HashSet<int> visited,
            List<FxrHostLayout> hosts)
        {
            // 与 FxrNativeDocument.CollectHosts 同一顺序：直接 §6 → §5 → 子节点。
            for (var i = 0; i < node.Section6Count; i++)
            {
                var offset = node.Section6Offset + i * Section6Size;
                if (visited.Add(offset))
                    hosts.Add(ReadHost(source, offset));
            }
            for (var i = 0; i < node.Section5Count; i++)
            {
                var s5 = node.Section5Offset + i * Section5Size;
                var s5Section6Count = ReadInt32(source, s5 + 0x0C);
                if (s5Section6Count is < 0 or > MaxSection6Count)
                    throw new InvalidDataException($"FXR Section5[{s5:X}] section6Count {s5Section6Count} 越界。");
                var s5Section6Offset = ReadInt32(source, s5 + 0x18);
                for (var j = 0; j < s5Section6Count; j++)
                {
                    var offset = s5Section6Offset + j * Section6Size;
                    if (visited.Add(offset))
                        hosts.Add(ReadHost(source, offset));
                }
            }
            foreach (var child in node.Children)
            {
                CollectHosts(source, child, visited, hosts);
            }
        }

        private static FxrHostLayout ReadHost(byte[] source, int offset)
        {
            var section11Count1 = ReadInt32(source, offset + 0x08);
            var section11Count2 = ReadInt32(source, offset + 0x14);
            var section7Count1 = ReadInt32(source, offset + 0x10);
            var section7Count2 = ReadInt32(source, offset + 0x1C);
            if (section11Count1 is < 0 or > MaxSection23Count
                || section11Count2 is < 0 or > MaxSection23Count
                || section7Count1 is < 0 or > MaxHostProperties
                || section7Count2 is < 0 or > MaxHostProperties
                || section7Count1 + section7Count2 > MaxHostProperties)
                throw new InvalidDataException($"FXR Section6[{offset:X}] 计数越界。");
            var section11Offset = ReadInt32(source, offset + 0x20);
            var section7Offset = ReadInt32(source, offset + 0x30);

            var properties = new List<FxrPropertyLayout>(section7Count1 + section7Count2);
            for (var i = 0; i < section7Count1 + section7Count2; i++)
            {
                var propOffset = section7Offset + i * Section7Size;
                var propSection11Count = ReadInt32(source, propOffset + 0x08);
                var propSection8Count = ReadInt32(source, propOffset + 0x20);
                if (propSection11Count is < 0 or > MaxSection23Count
                    || propSection8Count is < 0 or > MaxPropertyCount)
                    throw new InvalidDataException($"FXR Section7[{propOffset:X}] 计数越界。");
                var propSection11Offset = ReadInt32(source, propOffset + 0x10);
                var propSection8Offset = ReadInt32(source, propOffset + 0x18);

                var section8s = new List<FxrSection8Layout>(propSection8Count);
                for (var j = 0; j < propSection8Count; j++)
                {
                    var s8Offset = propSection8Offset + j * Section8Size;
                    var s8Section11Count = ReadInt32(source, s8Offset + 0x08);
                    if (s8Section11Count is < 0 or > MaxSection23Count)
                        throw new InvalidDataException($"FXR Section8[{s8Offset:X}] section11Count {s8Section11Count} 越界。");
                    section8s.Add(new FxrSection8Layout(ReadInt32(source, s8Offset + 0x10), s8Section11Count));
                }

                properties.Add(new FxrPropertyLayout(
                    propSection11Offset, propSection11Count, propSection8Offset, propSection8Count, section8s));
            }

            return new FxrHostLayout(
                offset,
                section11Count1,
                section11Count2,
                section11Offset,
                section7Count1,
                section7Count2,
                section7Offset,
                properties);
        }
    }

    private sealed record FxrHostLayout(
        int AbsOffset,
        int Section11Count1,
        int Section11Count2,
        int Section11Offset,
        int Section7Count1,
        int Section7Count2,
        int Section7Offset,
        IReadOnlyList<FxrPropertyLayout> Properties)
    {
        public int Section11TotalCount => Section11Count1 + Section11Count2;
    }

    private sealed record FxrPropertyLayout(
        int Section11Offset,
        int Section11Count,
        int Section8Offset,
        int Section8Count,
        IReadOnlyList<FxrSection8Layout> Section8s);

    private sealed record FxrSection8Layout(int Section11Offset, int Section11Count);
}

/// <summary>
/// FXR writer 的 fail-closed block 异常：未知结构无法无损保留时抛出，
/// dispatch 捕获后映射为 FXR_WRITE_BLOCKED_UNKNOWN_STRUCTURE + 结构化诊断。
/// 照 EsdWriteBlockedException 模式。
/// </summary>
internal sealed class FxrWriteBlockedException : Exception
{
    public FxrWriteBlockedException(string message, object? details = null) : base(message)
    {
        Details = details;
    }

    public object? Details { get; }
}
