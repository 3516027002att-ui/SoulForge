using System.Text;
using System.Text.Json;

/// <summary>
/// Sekiro MTD material property set writer（MATERIAL-53C）。
///
/// 只接受 typed property set：paramId 定位一个 param → 字节级外科替换其文本值 →
/// 重读验证。不提供「通用 XML 文本替换 fallback」：没有 typed 定位就没有写入口。
///
/// 无损策略：**字节外科替换**——只替换目标 param 的文本内容区间（content span），
/// 其余字节原样保留。未知元素、未知属性、注释、CDATA、处理指令、空白与换行等
/// 全部随源字节无损保留。因此本 writer 不因文档存在 unparsedGaps 而 block——
/// 字节外科天然无损（重读后 unparsedGaps 必须逐项一致，作为结构无损的证明）。
///
/// 唯一 block 条件：目标 param 的文本内容区间包含任何 XML 标记（&lt; 子元素 /
/// CDATA / 注释）。此时替换会摧毁未解析内容，返回 MTD_WRITE_BLOCKED_UNKNOWN_STRUCTURE
/// 结构化诊断，绝不写坏（硬约束「未知字段无法无损保留时,不得开放 writer」）。
/// 只有「纯文本内容（或自闭合空内容）」的 param 允许写回。
///
/// DCX 输入：.mtd.dcx 先解压再解析（与 read-tpf-document 同一路径）；写回时按原
/// 压缩格式重建（DFLT 内置、KRAK 需 Oodle compress session）。expectedDocumentHash
/// 的语义与 TpfNativeWriter 一致：解压后的 payload 哈希（loose 时即文件哈希）。
/// </summary>
internal static class MtdNativeWriter
{
    public static async Task<object> WriteAsync(
        string sourcePath,
        string outputPath,
        JsonElement options,
        CancellationToken cancellationToken,
        string? oodleRuntimeRoot = null)
    {
        var isDcx = Path.GetExtension(sourcePath).Equals(".dcx", StringComparison.OrdinalIgnoreCase);
        var source = await File.ReadAllBytesAsync(sourcePath, cancellationToken);
        DcxNativeDocument? dcx = null;
        var payload = source;
        if (isDcx)
        {
            dcx = DcxNativeDocument.Read(sourcePath, oodleRuntimeRoot);
            payload = dcx.Payload;
        }
        var document = MtdNativeDocument.Read(payload);
        RequireHash(options, "expectedDocumentHash", document.SourceHash, "MTD source hash");

        var paramId = RequiredString(options, "paramId");
        var newValue = RequiredStringAllowEmpty(options, "newValue").Trim();

        // 目标定位以 reader 为权威：id 不唯一或不存在都是结构化失败，不能靠扫描器
        // 撞上一个就算成功。
        var matches = document.Params.Where(p => p.Id == paramId).ToArray();
        if (matches.Length == 0)
            throw new InvalidDataException($"MTD param id={paramId} 不存在。");
        if (matches.Length > 1)
            throw new InvalidDataException($"MTD param id={paramId} 不唯一（{matches.Length} 处），拒绝写回。");
        var targetBefore = matches[0];

        // 字节级定位目标 param 的开始标签。
        var location = LocateParam(payload, paramId)
            ?? throw new InvalidDataException($"无法在源字节中定位 param id={paramId} 的开始标签。");

        // 内容区间：非自闭合 = 开始标签 `>` 之后到闭合标签 `</name>` 之前；自闭合 =
        // 整个 `/>`。定位闭合标签时跳过注释/CDATA，避免把标记文本误认成闭合。
        int contentStart;
        int contentEnd;
        if (location.SelfClosing)
        {
            contentStart = location.TagEnd;
            contentEnd = location.TagEnd + 2; // `/>`
        }
        else
        {
            contentStart = location.TagEnd + 1;
            var closeLt = FindCloseTag(payload, location.TagName, contentStart);
            if (closeLt < 0)
                throw new InvalidDataException($"MTD param id={paramId} 缺少 </{location.TagName}> 闭合标签。");
            contentEnd = closeLt;
        }

        ValidateContentReplaceable(payload, contentStart, contentEnd, paramId);

        cancellationToken.ThrowIfCancellationRequested();
        var replacementText = location.SelfClosing
            ? $">{EscapeXmlText(newValue)}</{location.TagName}>"
            : EscapeXmlText(newValue);
        var replacement = Encoding.UTF8.GetBytes(replacementText);
        var rebuilt = new byte[payload.Length - (contentEnd - contentStart) + replacement.Length];
        payload.AsSpan(0, contentStart).CopyTo(rebuilt);
        replacement.CopyTo(rebuilt.AsSpan(contentStart));
        payload.AsSpan(contentEnd).CopyTo(rebuilt.AsSpan(contentStart + replacement.Length));

        // DCX 输出：按原压缩格式包回。KRAK 需要 compress session；无 session 时
        // 明确失败，不静默降级为 DFLT（那会改变 storage profile）。
        var output = dcx is not null ? RebuildDcx(dcx, rebuilt, oodleRuntimeRoot) : rebuilt;

        var directory = Path.GetDirectoryName(outputPath) ?? throw new InvalidDataException("outputPath 没有父目录。");
        Directory.CreateDirectory(directory);
        var temporary = Path.Combine(directory, $".soulforge-mtd-{Guid.NewGuid():N}.tmp");
        try
        {
            await File.WriteAllBytesAsync(temporary, output, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            File.Move(temporary, outputPath, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }

        // 重读验证：目标值命中、其余 param/texture/root/unknown 属性/gap 全部不变，
        // 且 payload 在替换区间之外逐字节与源一致（字节外科无损的直接证据）。
        var rereadPayload = isDcx
            ? DcxNativeDocument.Read(outputPath, oodleRuntimeRoot).Payload
            : File.ReadAllBytes(outputPath);
        var reread = MtdNativeDocument.Read(rereadPayload);

        var targetAfter = reread.Params.FirstOrDefault(p => p.Id == paramId)
            ?? throw new InvalidDataException($"重读后 param id={paramId} 不存在。");
        if (targetAfter.Value != newValue)
            throw new InvalidDataException($"重读后 param id={paramId} 值 {targetAfter.Value} 与写入 {newValue} 不一致。");
        if (reread.Params.Count != document.Params.Count)
            throw new InvalidDataException($"重读后 param 数量变化（{reread.Params.Count} vs {document.Params.Count}）。");
        foreach (var before in document.Params)
        {
            var after = reread.Params.FirstOrDefault(p => p.Id == before.Id)
                ?? throw new InvalidDataException($"重读后 param id={before.Id} 丢失。");
            if (after.Type != before.Type || after.Name != before.Name)
                throw new InvalidDataException($"重读后 param id={before.Id} 的 type/name 被改动。");
            if (before.Id != paramId && after.Value != before.Value)
                throw new InvalidDataException($"重读后 param id={before.Id} 值被改动（{after.Value} vs {before.Value}）。");
            if (!UnknownEqual(before.Unknown, after.Unknown))
                throw new InvalidDataException($"重读后 param id={before.Id} 的未知属性被改动。");
        }
        if (!reread.Textures.Select(t => (t.Path, t.Type, t.Name))
                .SequenceEqual(document.Textures.Select(t => (t.Path, t.Type, t.Name))))
            throw new InvalidDataException("重读后 texture 引用被改动。");
        if (reread.RootElement != document.RootElement
            || reread.Name != document.Name
            || reread.Version != document.Version)
            throw new InvalidDataException("重读后 material 头字段被改动。");
        // shaderPath 是 shader param 的约定式 best-effort 投影；目标 param 就是
        // shader 时它的变化正是预期写入，不能当头部损坏判。
        if (!(targetBefore.Type is not null
              && targetBefore.Type.Equals("shader", StringComparison.OrdinalIgnoreCase))
            && reread.ShaderPath != document.ShaderPath)
            throw new InvalidDataException("重读后 material shaderPath 被改动。");
        if (!reread.UnparsedGaps.SequenceEqual(document.UnparsedGaps))
            throw new InvalidDataException("重读后 unparsedGaps 变化（未知结构未无损保留）。");
        VerifyByteSurgical(rereadPayload, payload, contentStart, contentEnd, replacement.Length);

        return new
        {
            paramId,
            paramName = targetBefore.Name,
            paramType = targetBefore.Type,
            valueBefore = targetBefore.Value,
            valueAfter = newValue,
            outputHash = reread.SourceHash,
            outputSize = reread.SourceBytes.Length,
            rereadVerified = true,
            structurePreserved = true,
            byteSurgical = true,
            isDcx,
            compressionFormat = dcx?.CompressionFormat
        };
    }

    /// <summary>
    /// 定位 id 属性等于 paramId 的 <param> 开始标签。
    ///
    /// 扫描器对注释 / CDATA / 处理指令 / 闭合标签一律跳过，避免把标记文本里的
    /// `<param ...>` 误认成真实元素。返回 null 表示未找到。属性值按 XML 实体解码
    /// 后与 paramId 比较（reader 侧 id 已是解码值，两侧口径必须一致）。
    /// </summary>
    private static ParamLocation? LocateParam(byte[] payload, string paramId)
    {
        var pos = 0;
        while (pos < payload.Length)
        {
            var lt = IndexOfByte(payload, (byte)'<', pos, payload.Length);
            if (lt < 0) return null;
            var next = lt + 1;
            if (next >= payload.Length) return null;

            var c = payload[next];
            if (c == (byte)'?')
            {
                var end = IndexOf(payload, "?>"u8, next, payload.Length);
                if (end < 0) return null;
                pos = end + 2;
                continue;
            }
            if (c == (byte)'!')
            {
                if (lt + 4 <= payload.Length && payload.AsSpan(lt, 4).SequenceEqual("<!--"u8))
                {
                    var end = IndexOf(payload, "-->"u8, lt + 4, payload.Length);
                    if (end < 0) return null;
                    pos = end + 3;
                    continue;
                }
                if (lt + 9 <= payload.Length && payload.AsSpan(lt, 9).SequenceEqual("<![CDATA["u8))
                {
                    var end = IndexOf(payload, "]]>"u8, lt + 9, payload.Length);
                    if (end < 0) return null;
                    pos = end + 3;
                    continue;
                }
                // 其他 <!...>（DTD 会被 reader 拒绝；这里跳过以继续扫描）。
                var dtdEnd = IndexOfByte(payload, (byte)'>', next, payload.Length);
                if (dtdEnd < 0) return null;
                pos = dtdEnd + 1;
                continue;
            }
            if (c == (byte)'/')
            {
                var closeEnd = IndexOfByte(payload, (byte)'>', next, payload.Length);
                if (closeEnd < 0) return null;
                pos = closeEnd + 1;
                continue;
            }

            var tagName = ReadTagName(payload, lt, out var afterName);
            if (LocalName(tagName).Equals("param", StringComparison.OrdinalIgnoreCase))
            {
                ParseAttributes(payload, afterName, out var tagEnd, out var selfClosing, out var attrs);
                if (attrs.TryGetValue("id", out var id) && id == paramId)
                    return new ParamLocation(tagName, tagEnd, selfClosing);
                pos = selfClosing ? tagEnd + 2 : tagEnd + 1;
            }
            else
            {
                ParseAttributes(payload, afterName, out var tagEnd, out var selfClosing, out _);
                pos = selfClosing ? tagEnd + 2 : tagEnd + 1;
            }
        }
        return null;
    }

    /// <summary>
    /// 从 contentStart 起找 <param ...> 的闭合标签 <code>&lt;/name&gt;</code> 位置。
    /// 跳过注释与 CDATA：CDATA 里可以合法地出现 `&lt;/name&gt;` 字面量，直接按文本
    /// 搜会把 CDATA 内部误认成闭合。遇到其他标记（子元素、无关闭合标签）继续向后
    /// 扫，直到找到本元素的闭合标签——contentEnd 因此落在真正的闭合处，中间的子元素
    /// 标记进入 content span，由 ValidateContentReplaceable 判定为 block。
    /// </summary>
    private static int FindCloseTag(byte[] payload, string tagName, int contentStart)
    {
        var closeBytes = Encoding.UTF8.GetBytes("</" + tagName);
        var pos = contentStart;
        while (pos < payload.Length)
        {
            var lt = IndexOfByte(payload, (byte)'<', pos, payload.Length);
            if (lt < 0) return -1;
            if (lt + 4 <= payload.Length && payload.AsSpan(lt, 4).SequenceEqual("<!--"u8))
            {
                var end = IndexOf(payload, "-->"u8, lt + 4, payload.Length);
                if (end < 0) return -1;
                pos = end + 3;
                continue;
            }
            if (lt + 9 <= payload.Length && payload.AsSpan(lt, 9).SequenceEqual("<![CDATA["u8))
            {
                var end = IndexOf(payload, "]]>"u8, lt + 9, payload.Length);
                if (end < 0) return -1;
                pos = end + 3;
                continue;
            }
            if (payload.AsSpan(lt).StartsWith(closeBytes))
                return lt;
            // 子元素或其他标记：不是本元素的闭合标签，继续向后扫。
            pos = lt + 1;
        }
        return -1;
    }

    /// <summary>
    /// 目标 param 的文本内容区间必须**不含任何 XML 标记**才允许写回。含子元素 /
    /// CDATA / 注释都意味着替换会摧毁未解析内容（reader 只报告首个 text 节点，
    /// CDATA 包裹或后续文本不被报告——替换即丢失），fail-closed 拒绝。
    /// </summary>
    private static void ValidateContentReplaceable(byte[] payload, int start, int end, string paramId)
    {
        if (IndexOfByte(payload, (byte)'<', start, end) >= 0)
        {
            throw new MtdWriteBlockedException(
                $"MTD param id={paramId} 的文本内容区间含 XML 标记（子元素/CDATA/注释），"
                + "替换会摧毁未解析内容，拒绝写回。",
                new { unparsedStructure = "markup-in-target-param-content", contentOffset = start, paramId });
        }
    }

    /// <summary>
    /// 重建后的 payload 在替换区间之外必须与源 payload 逐字节一致。这是「未知字段
    /// 无损保留」的直接字节级证据：一切不被本 writer 认识的字节都原样保留。
    /// </summary>
    private static void VerifyByteSurgical(
        byte[] rereadPayload, byte[] sourcePayload, int contentStart, int contentEnd, int replacementLength)
    {
        var expectedLength = sourcePayload.Length - (contentEnd - contentStart) + replacementLength;
        if (rereadPayload.Length != expectedLength)
            throw new InvalidDataException($"重读 payload 长度 {rereadPayload.Length} 与重建预期 {expectedLength} 不一致。");
        for (var i = 0; i < contentStart; i++)
        {
            if (rereadPayload[i] != sourcePayload[i])
                throw new InvalidDataException($"重读 payload 在替换区间前偏移 {i} 与源不一致。");
        }
        for (var i = contentEnd; i < sourcePayload.Length; i++)
        {
            var target = contentStart + replacementLength + (i - contentEnd);
            if (rereadPayload[target] != sourcePayload[i])
                throw new InvalidDataException($"重读 payload 在替换区间后偏移 {target} 与源不一致。");
        }
    }

    private static byte[] RebuildDcx(DcxNativeDocument dcx, byte[] nextPayload, string? oodleRuntimeRoot)
    {
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

    private static string EscapeXmlText(string value)
    {
        var sb = new StringBuilder(value.Length + 8);
        foreach (var ch in value)
        {
            if (IsInvalidXmlChar(ch))
                throw new InvalidDataException($"newValue 含 XML 1.0 禁止的控制字符 U+{(int)ch:X4}。");
            switch (ch)
            {
                case '&': sb.Append("&amp;"); break;
                case '<': sb.Append("&lt;"); break;
                case '>': sb.Append("&gt;"); break;
                // XML 1.0 行尾规范化会把文本里的 CR/CRLF 归一成 LF；要保真必须转义。
                case '\r': sb.Append("&#13;"); break;
                default: sb.Append(ch); break;
            }
        }
        return sb.ToString();
    }

    private static bool IsInvalidXmlChar(char ch)
    {
        if (ch is '\t' or '\n' or '\r') return false;
        if (ch < 0x20) return true;
        return ch == '￾' || ch == '￿';
    }

    private static string ReadTagName(byte[] payload, int lt, out int afterName)
    {
        var start = lt + 1;
        var end = start;
        while (end < payload.Length && IsXmlNameChar(payload[end])) end++;
        var firstLen = end - start;
        if (end < payload.Length && payload[end] == (byte)':')
        {
            var colon = end;
            var secondStart = colon + 1;
            var after = secondStart;
            while (after < payload.Length && IsXmlNameChar(payload[after])) after++;
            if (after > secondStart)
            {
                afterName = after;
                return Encoding.UTF8.GetString(payload, start, after - start);
            }
        }
        afterName = end;
        return Encoding.UTF8.GetString(payload, start, firstLen);
    }

    private static string LocalName(string tagName)
    {
        var colon = tagName.IndexOf(':');
        return colon >= 0 ? tagName[(colon + 1)..] : tagName;
    }

    /// <summary>
    /// 解析开始标签的属性表，并返回标签结束位置与是否自闭合。
    /// tagEnd：非自闭合指向 `>`；自闭合指向 `/`（`/>` 占据 [tagEnd, tagEnd+2)）。
    /// 属性值按 XML 实体解码（与 reader 的 id/type/name 口径一致）。
    /// </summary>
    private static void ParseAttributes(
        byte[] payload,
        int afterName,
        out int tagEnd,
        out bool selfClosing,
        out Dictionary<string, string> attributes)
    {
        attributes = new Dictionary<string, string>(StringComparer.Ordinal);
        var pos = afterName;
        while (pos < payload.Length)
        {
            while (pos < payload.Length && IsWhitespace(payload[pos])) pos++;
            if (pos >= payload.Length) break;
            if (payload[pos] == (byte)'>') { tagEnd = pos; selfClosing = false; return; }
            if (payload[pos] == (byte)'/' && pos + 1 < payload.Length && payload[pos + 1] == (byte)'>')
            {
                tagEnd = pos; selfClosing = true; return;
            }
            var attrStart = pos;
            while (pos < payload.Length && IsXmlNameChar(payload[pos])) pos++;
            var attrName = Encoding.UTF8.GetString(payload, attrStart, pos - attrStart);
            while (pos < payload.Length && IsWhitespace(payload[pos])) pos++;
            if (pos < payload.Length && payload[pos] == (byte)'=') pos++;
            while (pos < payload.Length && IsWhitespace(payload[pos])) pos++;
            if (pos < payload.Length && (payload[pos] == (byte)'"' || payload[pos] == (byte)'\''))
            {
                var quote = payload[pos];
                pos++;
                var valueStart = pos;
                while (pos < payload.Length && payload[pos] != quote) pos++;
                var raw = Encoding.UTF8.GetString(payload, valueStart, pos - valueStart);
                if (pos < payload.Length) pos++;
                attributes[attrName] = DecodeXmlEntities(raw);
            }
            else
            {
                var valueStart = pos;
                while (pos < payload.Length && !IsWhitespace(payload[pos])
                    && payload[pos] != (byte)'>'
                    && !(payload[pos] == (byte)'/' && pos + 1 < payload.Length && payload[pos + 1] == (byte)'>'))
                    pos++;
                attributes[attrName] = DecodeXmlEntities(Encoding.UTF8.GetString(payload, valueStart, pos - valueStart));
            }
        }
        tagEnd = afterName;
        selfClosing = false;
    }

    /// <summary>解码 XML 预定义实体与数字字符引用（reader 侧属性值已是解码值）。</summary>
    private static string DecodeXmlEntities(string value)
    {
        if (value.IndexOf('&') < 0) return value;
        var sb = new StringBuilder(value.Length);
        for (var i = 0; i < value.Length; i++)
        {
            var ch = value[i];
            if (ch != '&') { sb.Append(ch); continue; }
            var semicolon = value.IndexOf(';', i + 1);
            if (semicolon < 0 || semicolon - i > 12) { sb.Append(ch); continue; }
            var entity = value.Substring(i + 1, semicolon - i - 1);
            switch (entity)
            {
                case "amp": sb.Append('&'); i = semicolon; continue;
                case "lt": sb.Append('<'); i = semicolon; continue;
                case "gt": sb.Append('>'); i = semicolon; continue;
                case "quot": sb.Append('"'); i = semicolon; continue;
                case "apos": sb.Append('\''); i = semicolon; continue;
            }
            if (entity.StartsWith("#x", StringComparison.OrdinalIgnoreCase)
                && int.TryParse(entity[2..], System.Globalization.NumberStyles.HexNumber, null, out var hex)
                && hex is >= 0 and <= 0x10FFFF)
            {
                sb.Append(char.ConvertFromUtf32(hex)); i = semicolon; continue;
            }
            if (entity.StartsWith('#')
                && int.TryParse(entity[1..], out var dec)
                && dec is >= 0 and <= 0x10FFFF)
            {
                sb.Append(char.ConvertFromUtf32(dec)); i = semicolon; continue;
            }
            sb.Append(ch);
        }
        return sb.ToString();
    }

    private static bool UnknownEqual(
        IReadOnlyDictionary<string, string>? a, IReadOnlyDictionary<string, string>? b)
    {
        if (ReferenceEquals(a, b)) return true;
        if (a is null || b is null) return false;
        if (a.Count != b.Count) return false;
        foreach (var pair in a)
            if (!b.TryGetValue(pair.Key, out var value) || value != pair.Value)
                return false;
        return true;
    }

    private static bool IsWhitespace(byte b) => b is (byte)' ' or (byte)'\t' or (byte)'\r' or (byte)'\n';

    private static bool IsXmlNameChar(byte b) =>
        b >= 0x80
        || (b >= (byte)'a' && b <= (byte)'z')
        || (b >= (byte)'A' && b <= (byte)'Z')
        || (b >= (byte)'0' && b <= (byte)'9')
        || b is (byte)'.' or (byte)'-' or (byte)'_';

    private static int IndexOfByte(byte[] data, byte value, int start, int end)
    {
        var span = data.AsSpan(start, end - start);
        var idx = span.IndexOf(value);
        return idx < 0 ? -1 : start + idx;
    }

    private static int IndexOf(byte[] data, ReadOnlySpan<byte> pattern, int start, int end)
    {
        var span = data.AsSpan(start, end - start);
        var idx = span.IndexOf(pattern);
        return idx < 0 ? -1 : start + idx;
    }

    private static void RequireHash(JsonElement options, string field, string actual, string label)
    {
        if (!RequiredString(options, field).Equals(actual, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException($"{label} 不匹配。");
    }

    private static string RequiredString(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString())
            ? value.GetString()! : throw new InvalidDataException($"options.{field} 是必填字符串。");

    private static string RequiredStringAllowEmpty(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()! : throw new InvalidDataException($"options.{field} 是必填字符串（可为空）。");

    private sealed record ParamLocation(string TagName, int TagEnd, bool SelfClosing);
}

/// <summary>
/// MTD writer 的 fail-closed block 异常：未知结构无法无损保留时抛出，
/// dispatch 捕获后映射为 MTD_WRITE_BLOCKED_UNKNOWN_STRUCTURE + 结构化诊断。
/// </summary>
internal sealed class MtdWriteBlockedException : Exception
{
    public MtdWriteBlockedException(string message, object? details = null) : base(message)
    {
        Details = details;
    }

    public object? Details { get; }
}
