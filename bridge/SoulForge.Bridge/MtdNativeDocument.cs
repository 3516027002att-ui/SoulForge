using System.Security.Cryptography;
using System.Text;
using System.Xml;

/// <summary>
/// Sekiro-era MTD (MaTerial Definition) read-only document — candidate/partial。
///
/// MTD 在 Sekiro 中是 XML 文本材质定义（魂系列格式家族；正式样本位于游戏数据包
/// <c>mtd/</c> 树与 mtdbnd 容器内，FLVER material 通过 MtdPath 引用）。本机已登记
/// corpus 中未发现真实 .mtd 文件，因此本解析器只做安全 XML 结构投影：
/// root/name/header/param/texture 引用收集，不做语义解释（infer-mtd-schema
/// 永久禁令，见 scope.json SCOPE-ASSET-MTD 的 resumeRequires）。
///
/// 三页 wire 形状（MATERIAL-53A）：
///  - material：name/version/shaderPath（shaderPath 仅当 param type="shader" 且
///    text 内容非空时给出，属约定式 best-effort，不构成 schema authority）；
///  - properties：param → { id, type, name, value, unknown }，未知属性原样保留
///    在 unknown 里，同时登记 unparsedGaps 并降 partial；
///  - textureReferences：texture → { path, type, name }。
///
/// authority 判据：重复解析一致且无未识别结构 → candidate；发现未识别 XML
/// 元素/属性（登记 unparsedGaps）或重复解析不一致 → partial。未以真实 .mtd
/// 样本验证，语义读取不构成 native authority。
///
/// 安全约束：
/// - DTD 与外部实体一律拒绝（DtdProcessing.Prohibit + 空 XmlResolver）；
/// - 文档大小与元素数量设上限；
/// - 只读，无 writer、无字节重建。
/// </summary>
internal sealed class MtdNativeDocument
{
    private const long MaxSourceBytes = 16L * 1024 * 1024;
    private const int MaxElements = 5_000;
    private const int MaxParamSamples = 200;

    private MtdNativeDocument(
        byte[] sourceBytes,
        string rootElement,
        string? name,
        string? version,
        string? header,
        string? shaderPath,
        int materialCount,
        IReadOnlyList<MtdParamEntry> params_,
        IReadOnlyList<MtdTextureReference> textures,
        IReadOnlyList<string> unparsedGaps,
        IReadOnlyList<string> layoutWarnings,
        IReadOnlyList<Diagnostic> diagnostics)
    {
        SourceBytes = sourceBytes;
        RootElement = rootElement;
        Name = name;
        Version = version;
        Header = header;
        ShaderPath = shaderPath;
        MaterialCount = materialCount;
        Params = params_;
        Textures = textures;
        UnparsedGaps = unparsedGaps;
        LayoutWarnings = layoutWarnings;
        Diagnostics = diagnostics;
    }

    public byte[] SourceBytes { get; }
    public string RootElement { get; }
    public string? Name { get; }
    public string? Version { get; }
    public string? Header { get; }
    public string? ShaderPath { get; }
    public int MaterialCount { get; }
    public IReadOnlyList<MtdParamEntry> Params { get; }
    public IReadOnlyList<MtdTextureReference> Textures { get; }
    public IReadOnlyList<string> UnparsedGaps { get; }
    public IReadOnlyList<string> LayoutWarnings { get; }
    public IReadOnlyList<Diagnostic> Diagnostics { get; }
    public string SourceHash => Hash(SourceBytes);

    public static MtdNativeDocument Read(byte[] source)
    {
        if (source.Length <= 0 || source.Length > MaxSourceBytes)
            throw new InvalidDataException($"MTD 大小 {source.Length} 超出安全读取范围（0..{MaxSourceBytes}）。");

        var diagnostics = new List<Diagnostic>();
        using var stream = new MemoryStream(source, writable: false);

        XmlReaderSettings settings = new()
        {
            DtdProcessing = DtdProcessing.Prohibit,
            XmlResolver = null,
            MaxCharactersInDocument = MaxSourceBytes,
            MaxCharactersFromEntities = 0,
            IgnoreWhitespace = true,
            IgnoreComments = true
        };

        string? rootElement = null;
        string? name = null;
        string? version = null;
        string? header = null;
        string? shaderPath = null;
        var params_ = new List<MtdParamEntry>();
        var textures = new List<MtdTextureReference>();
        var unparsedGaps = new List<string>();
        var layoutWarnings = new List<string>();
        var elementCount = 0;

        try
        {
            using var reader = XmlReader.Create(stream, settings);
            while (reader.Read())
            {
                if (reader.NodeType == XmlNodeType.Element)
                {
                    elementCount++;
                    if (elementCount > MaxElements)
                        throw new InvalidDataException($"MTD 元素数量超过安全上限 {MaxElements}。");

                    if (reader.Depth == 0)
                    {
                        rootElement = reader.LocalName;
                        name = reader.GetAttribute("name");
                        version = reader.GetAttribute("version");
                        CollectUnknownAttributes(reader, new[] { "name", "version" }, unparsedGaps, "root");
                        continue;
                    }

                    if (reader.LocalName.Equals("param", StringComparison.OrdinalIgnoreCase))
                    {
                        var id = reader.GetAttribute("id");
                        var type = reader.GetAttribute("type");
                        var paramName = reader.GetAttribute("name");
                        var unknown = CollectUnknownAttributes(
                            reader, new[] { "id", "type", "name" }, unparsedGaps, "param");
                        var value = ReadElementText(reader, MaxElements, ref elementCount, unparsedGaps);
                        params_.Add(new MtdParamEntry(id, type, paramName, value, unknown));
                        if (shaderPath is null
                            && type != null
                            && type.Equals("shader", StringComparison.OrdinalIgnoreCase)
                            && !string.IsNullOrWhiteSpace(value))
                        {
                            shaderPath = value.Trim();
                        }
                    }
                    else if (reader.LocalName.Equals("texture", StringComparison.OrdinalIgnoreCase))
                    {
                        var path = reader.GetAttribute("path");
                        var type = reader.GetAttribute("type");
                        var textureName = reader.GetAttribute("name");
                        CollectUnknownAttributes(
                            reader, new[] { "path", "type", "name" }, unparsedGaps, "texture");
                        ReadElementText(reader, MaxElements, ref elementCount, unparsedGaps);
                        textures.Add(new MtdTextureReference(path, type, textureName));
                    }
                    else if (reader.LocalName.Equals("header", StringComparison.OrdinalIgnoreCase))
                    {
                        var headerName = reader.GetAttribute("name");
                        CollectUnknownAttributes(reader, new[] { "name" }, unparsedGaps, "header");
                        header = headerName ?? ReadElementText(reader, MaxElements, ref elementCount, unparsedGaps);
                    }
                    else
                    {
                        unparsedGaps.Add($"unexpected-element:{reader.LocalName}");
                    }
                }
            }
        }
        catch (XmlException ex) when (IsDtdRejection(ex))
        {
            throw new NotSupportedException("MTD 文档包含 DTD 或外部实体引用；出于安全考虑拒绝解析。", ex);
        }
        catch (XmlException ex)
        {
            throw new InvalidDataException($"MTD 不是可解析的 XML：{ex.Message}", ex);
        }

        if (rootElement is null)
            throw new InvalidDataException("MTD 文档缺少根元素。");

        if (elementCount == 1)
        {
            layoutWarnings.Add("MTD XML 只包含根元素，无 param/texture 子结构；投影保持空。");
            diagnostics.Add(new Diagnostic(
                "info",
                "MTD_XML_ROOT_ONLY",
                "MTD XML 只包含根元素，无 param/texture 子结构；投影保持空。",
                null));
        }
        if (params_.Count > MaxParamSamples)
            layoutWarnings.Add($"param 投影截断于 {MaxParamSamples} 条采样上限（实际 {params_.Count} 条）。");
        if (textures.Count > MaxParamSamples)
            layoutWarnings.Add($"texture 投影截断于 {MaxParamSamples} 条采样上限（实际 {textures.Count} 条）。");

        return new MtdNativeDocument(
            source,
            rootElement,
            name,
            version,
            header,
            shaderPath,
            // 单个 MTD 文件 = 单材质定义。若真实结构是复数材质容器（如
            // &lt;materials&gt; 包多个 &lt;material&gt;），子元素会被登记为
            // unexpected-element 并降 partial，不会冒充已解析。
            1,
            params_,
            textures,
            unparsedGaps,
            layoutWarnings,
            diagnostics);
    }

    /// <summary>
    /// 与 TpfNativeDocument 对齐的文件入口；把文件级失败归为 InvalidDataException/IOException。
    /// </summary>
    public static MtdNativeDocument ReadFile(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists) throw new FileNotFoundException("MTD 文件不存在。", path);
        if (info.Length <= 0 || info.Length > MaxSourceBytes)
            throw new InvalidDataException($"MTD 文件大小 {info.Length} 超出安全读取范围。");
        return Read(File.ReadAllBytes(path));
    }

    /// <summary>
    /// 结构一致性验证：同一字节流重复解析后关键投影一致（只读，不重建字节）。
    /// 与 TpfNativeDocument.VerifyRoundTrip 语义对齐：只证明确定性，不构成
    /// 解析完整性声明。
    /// </summary>
    public MtdStructureVerification VerifyStructure()
    {
        var reparsed = Read(SourceBytes);
        var consistent = reparsed.RootElement == RootElement
            && reparsed.Name == Name
            && reparsed.ShaderPath == ShaderPath
            && reparsed.Params.Select(p => (p.Id, p.Type, p.Name, p.Value))
                .SequenceEqual(Params.Select(p => (p.Id, p.Type, p.Name, p.Value)))
            && reparsed.Textures.Select(t => (t.Path, t.Type, t.Name))
                .SequenceEqual(Textures.Select(t => (t.Path, t.Type, t.Name)))
            && reparsed.UnparsedGaps.SequenceEqual(UnparsedGaps);
        return new MtdStructureVerification(
            consistent,
            SourceHash,
            reparsed.SourceHash,
            Params.Count,
            Textures.Count,
            consistent ? null : "MTD 重复解析的结构投影不一致。");
    }

    /// <summary>
    /// 三页 wire 形状的 envelope（MATERIAL-53A）。authority：重复解析一致且无
    /// 未识别结构 → candidate；有 unparsedGaps 或往返不一致 → partial。
    /// </summary>
    public object ToEnvelope(MtdStructureVerification? verification = null)
    {
        var roundTrip = verification ?? VerifyStructure();
        return new
        {
            format = "MTD-XML",
            formatId = "mtd",
            sourceSize = SourceBytes.Length,
            sourceHash = SourceHash,
            rootElement = RootElement,
            name = Name,
            version = Version,
            header = Header,
            shaderPath = ShaderPath,
            materialCount = MaterialCount,
            properties = Params.Take(MaxParamSamples).Select(p => new
            {
                id = p.Id,
                type = p.Type,
                name = p.Name,
                value = p.Value,
                unknown = p.Unknown
            }).ToArray(),
            propertiesTruncated = Params.Count > MaxParamSamples,
            textureRefs = Textures.Take(MaxParamSamples).Select(t => new
            {
                path = t.Path,
                type = t.Type,
                name = t.Name
            }).ToArray(),
            textureRefsTruncated = Textures.Count > MaxParamSamples,
            unparsedGaps = UnparsedGaps,
            layoutWarnings = LayoutWarnings,
            roundTrip = roundTrip,
            authority = UnparsedGaps.Count > 0 || !roundTrip.Consistent ? "partial" : "candidate"
        };
    }

    /// <summary>
    /// 收集当前元素上不在 recognized 集合里的属性：登记 unparsedGaps（降 partial
    /// 的依据），param 的未知属性同时原样保留到返回字典（unknown property 不丢弃）。
    /// 返回 null 表示没有未知属性。
    /// </summary>
    private static Dictionary<string, string>? CollectUnknownAttributes(
        XmlReader reader,
        IReadOnlyCollection<string> recognized,
        List<string> unparsedGaps,
        string owner)
    {
        if (!reader.HasAttributes) return null;
        Dictionary<string, string>? unknown = null;
        for (var i = 0; i < reader.AttributeCount; i++)
        {
            reader.MoveToAttribute(i);
            var attrName = reader.LocalName;
            if (recognized.Contains(attrName)) continue;
            unparsedGaps.Add($"unexpected-attribute:{owner}/{attrName}");
            (unknown ??= new Dictionary<string, string>(StringComparer.Ordinal)).Add(attrName, reader.Value);
        }
        reader.MoveToElement();
        return unknown;
    }

    private static string ReadElementText(
        XmlReader reader,
        int maxElements,
        ref int elementCount,
        List<string> unparsedGaps)
    {
        // 元素属性收集完后读取其文本内容。param/texture/header 期望是叶文本元素；
        // 若内部出现子元素，按未识别结构登记并参与元素上限计数。
        if (reader.IsEmptyElement) return string.Empty;
        using var sub = reader.ReadSubtree();
        var first = true;
        string? text = null;
        while (sub.Read())
        {
            if (sub.NodeType == XmlNodeType.Element)
            {
                if (first)
                {
                    // ReadSubtree 的首个节点就是元素自身，跳过；后续 Element 才是子元素。
                    first = false;
                    continue;
                }
                elementCount++;
                if (elementCount > maxElements)
                    throw new InvalidDataException($"MTD 元素数量超过安全上限 {maxElements}。");
                unparsedGaps.Add($"unexpected-child-element:{sub.LocalName}");
                continue;
            }
            first = false;
            if (sub.NodeType is XmlNodeType.Text or XmlNodeType.CDATA)
            {
                var value = sub.Value?.Trim();
                if (text is null && !string.IsNullOrEmpty(value)) text = value;
            }
        }
        return text ?? string.Empty;
    }

    private static bool IsDtdRejection(XmlException ex)
    {
        // DtdProcessing.Prohibit 抛出的消息为 "DTD is prohibited..."；按消息与异常链判断。
        var message = ex.Message ?? string.Empty;
        return message.Contains("DTD", StringComparison.OrdinalIgnoreCase)
            || message.Contains("prohibit", StringComparison.OrdinalIgnoreCase)
            || message.Contains("entity", StringComparison.OrdinalIgnoreCase);
    }

    private static string Hash(byte[] bytes) =>
        Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}

internal sealed record MtdParamEntry(
    string? Id,
    string? Type,
    string? Name,
    string? Value,
    IReadOnlyDictionary<string, string>? Unknown = null);

internal sealed record MtdTextureReference(string? Path, string? Type, string? Name);

internal sealed record MtdStructureVerification(
    bool Consistent,
    string SourceHash,
    string ReparsedHash,
    int ParamCount,
    int TextureRefCount,
    string? Note);
