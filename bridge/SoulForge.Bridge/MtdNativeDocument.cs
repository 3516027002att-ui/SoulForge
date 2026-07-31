using System.Security.Cryptography;
using System.Text;
using System.Xml;

/// <summary>
/// Sekiro-era MTD (MaTerial Definition) read-only document — candidate.
///
/// MTD 在 Sekiro 中是 XML 文本材质定义（魂系列格式家族；正式样本位于游戏数据包
/// <c>mtd/</c> 树与 mtdbnd 容器内，FLVER material 通过 MtdPath 引用）。本机已登记
/// corpus 中未发现真实 .mtd 文件，因此本解析器只做安全 XML 结构投影：
/// root/name/header/param/texture 引用收集，不做语义解释。
///
/// 安全约束：
/// - DTD 与外部实体一律拒绝（DtdProcessing.Prohibit + 空 XmlResolver）；
/// - 文档大小与元素数量设上限；
/// - 只读，无 writer、无字节重建。
///
/// Authority: candidate — 未以真实 .mtd 样本验证，语义读取不构成 native authority。
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
        IReadOnlyList<MtdParamEntry> params_,
        IReadOnlyList<MtdTextureReference> textures,
        IReadOnlyList<Diagnostic> diagnostics)
    {
        SourceBytes = sourceBytes;
        RootElement = rootElement;
        Name = name;
        Version = version;
        Header = header;
        Params = params_;
        Textures = textures;
        Diagnostics = diagnostics;
    }

    public byte[] SourceBytes { get; }
    public string RootElement { get; }
    public string? Name { get; }
    public string? Version { get; }
    public string? Header { get; }
    public IReadOnlyList<MtdParamEntry> Params { get; }
    public IReadOnlyList<MtdTextureReference> Textures { get; }
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
        var params_ = new List<MtdParamEntry>();
        var textures = new List<MtdTextureReference>();
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
                        continue;
                    }

                    if (reader.LocalName.Equals("param", StringComparison.OrdinalIgnoreCase))
                    {
                        params_.Add(new MtdParamEntry(
                            reader.GetAttribute("id"),
                            reader.GetAttribute("type"),
                            reader.GetAttribute("name"),
                            ReadElementText(reader)));
                    }
                    else if (reader.LocalName.Equals("texture", StringComparison.OrdinalIgnoreCase))
                    {
                        textures.Add(new MtdTextureReference(
                            reader.GetAttribute("path"),
                            reader.GetAttribute("type"),
                            reader.GetAttribute("name")));
                    }
                    else if (reader.LocalName.Equals("header", StringComparison.OrdinalIgnoreCase))
                    {
                        header = reader.GetAttribute("name") ?? ReadElementText(reader);
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
            diagnostics.Add(new Diagnostic(
                "info",
                "MTD_XML_ROOT_ONLY",
                "MTD XML 只包含根元素，无 param/texture 子结构；投影保持空。",
                null));
        }

        return new MtdNativeDocument(
            source,
            rootElement,
            name,
            version,
            header,
            params_,
            textures,
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
    /// </summary>
    public MtdStructureVerification VerifyStructure()
    {
        var reparsed = Read(SourceBytes);
        var consistent = reparsed.RootElement == RootElement
            && reparsed.Name == Name
            && reparsed.Params.Count == Params.Count
            && reparsed.Textures.Count == Textures.Count;
        return new MtdStructureVerification(
            consistent,
            SourceHash,
            reparsed.SourceHash,
            Params.Count,
            Textures.Count,
            consistent ? null : "MTD 重复解析的结构投影不一致。");
    }

    public object ToEnvelope(MtdStructureVerification? verification = null) => new
    {
        format = "MTD-XML",
        sourceSize = SourceBytes.Length,
        sourceHash = SourceHash,
        rootElement = RootElement,
        name = Name,
        version = Version,
        header = Header,
        paramCount = Params.Count,
        textureRefCount = Textures.Count,
        paramSample = Params.Take(MaxParamSamples).Select(p => new
        {
            id = p.Id,
            type = p.Type,
            name = p.Name,
            value = p.Value
        }).ToArray(),
        textureRefs = Textures.Take(MaxParamSamples).Select(t => new
        {
            path = t.Path,
            type = t.Type,
            name = t.Name
        }).ToArray(),
        verification = verification ?? VerifyStructure(),
        authority = "candidate"
    };

    private static string ReadElementText(XmlReader reader)
    {
        // 元素属性收集完后读取其文本内容（无子元素场景）。
        if (reader.IsEmptyElement) return string.Empty;
        using var sub = reader.ReadSubtree();
        while (sub.Read())
        {
            if (sub.NodeType == XmlNodeType.Text || sub.NodeType == XmlNodeType.CDATA)
            {
                var text = sub.Value?.Trim();
                if (!string.IsNullOrEmpty(text)) return text;
            }
        }
        return string.Empty;
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

internal sealed record MtdParamEntry(string? Id, string? Type, string? Name, string? Value);

internal sealed record MtdTextureReference(string? Path, string? Type, string? Name);

internal sealed record MtdStructureVerification(
    bool Consistent,
    string SourceHash,
    string ReparsedHash,
    int ParamCount,
    int TextureRefCount,
    string? Note);
