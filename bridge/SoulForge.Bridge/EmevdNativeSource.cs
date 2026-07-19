internal sealed class EmevdNativeSource
{
    private EmevdNativeSource(
        EmevdNativeDocument document,
        DcxNativeDocument? dcx)
    {
        Document = document;
        Dcx = dcx;
    }

    public EmevdNativeDocument Document { get; }
    public DcxNativeDocument? Dcx { get; }
    public byte[] SourceBytes => Dcx?.SourceBytes ?? Document.SourceBytes;
    public string SourceHash => Dcx?.SourceHash ?? Document.SourceHash;
    public string ContainerKind => Dcx is null ? "raw" : "dcx";
    public string? CompressionFormat => Dcx?.CompressionFormat;
    public bool WriteSupported => Dcx is null || Dcx.CompressionFormat == "DFLT";

    public static EmevdNativeSource Read(string path, string? oodleRuntimeRoot = null)
    {
        Span<byte> magic = stackalloc byte[4];
        using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            stream.ReadExactly(magic);
        }

        if (magic.SequenceEqual("EVD\0"u8))
            return new EmevdNativeSource(EmevdNativeDocument.ReadFile(path), null);
        if (!magic.SequenceEqual("DCX\0"u8))
            throw new InvalidDataException("输入既不是裸 EMEVD，也不是 DCX-wrapped EMEVD。");

        var dcx = DcxNativeDocument.Read(path, oodleRuntimeRoot);
        if (dcx.Payload.Length < 4 || !dcx.Payload.AsSpan(0, 4).SequenceEqual("EVD\0"u8))
            throw new InvalidDataException("DCX payload 不是 EMEVD。");
        return new EmevdNativeSource(EmevdNativeDocument.Read(dcx.Payload), dcx);
    }

    public byte[] RebuildSource(byte[] rebuiltDocument)
    {
        if (Dcx is null) return rebuiltDocument;
        if (Dcx.CompressionFormat != "DFLT")
            throw new NotSupportedException("EMEVD writer 当前只允许裸 EMEVD 或已验证的 DFLT 外层；KRAK 重压未启用。");
        return Dcx.RebuildDflt(rebuiltDocument);
    }

    public EmevdSourceInfo Describe()
    {
        var containerRoundTrip = Dcx?.VerifyRoundTrip();
        return new EmevdSourceInfo(
            SourceHash,
            SourceBytes.Length,
            ContainerKind,
            CompressionFormat,
            WriteSupported,
            containerRoundTrip);
    }
}

internal sealed record EmevdSourceInfo(
    string SourceHash,
    int SourceSize,
    string ContainerKind,
    string? CompressionFormat,
    bool WriteSupported,
    DcxRoundTripReport? ContainerRoundTrip);
