using System.Buffers.Binary;
using System.Globalization;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Text.Json;

/// <summary>
/// SoulForge-owned Sekiro 1.6.x TAE schema.
///
/// The checked-in payload is a compact, derived registry: it contains event
/// ids, field widths/offsets, enum labels and assert bytes, but no third-party
/// executable, XML file or installation path. The Bridge is the only consumer
/// of this registry in production.
/// </summary>
internal static class TaeFirstPartySchema
{
    public const string Package = "soulforge-sekiro-tae-schema";
    public const string Version = "1.0.0";
    public const string ContentDigest = "sha256:3ef0d412b3742bbe6b230f289ef0f65e5f76baecc1831df313614e8ae22b099d";

    private static readonly Lazy<TaeSchemaDocument> Loaded = new(Load, LazyThreadSafetyMode.ExecutionAndPublication);

    public static TaeSchemaDocument Document => Loaded.Value;

    public static IReadOnlyList<TaeSchemaEvent> Variants(int eventTypeId) =>
        Document.Banks.SelectMany(bank => bank.Events
            .Where(item => item.Id == eventTypeId)
            .Select(item => item with { BankId = bank.Id, BankName = bank.Name }))
            .ToArray();

    public static TaeSchemaResolution Resolve(int eventTypeId, int parameterLength, int? bankId = null)
    {
        var candidates = Variants(eventTypeId);
        if (bankId is { } requestedBank)
            candidates = candidates.Where(item => item.BankId == requestedBank).ToArray();
        var exact = candidates.Where(item => item.ParamSize == parameterLength).ToArray();
        // A TAE event's native parameter span can contain alignment or
        // intentionally preserved trailing bytes beyond the known template.
        // Prefer an exact variant, otherwise select the largest known layout
        // that fits.  A shorter native span remains a real coverage gap.
        var fitting = candidates
            .Where(item => item.ParamSize <= parameterLength)
            .OrderByDescending(item => item.ParamSize)
            .ThenBy(item => item.BankId)
            .ToArray();
        var selected = exact.FirstOrDefault() ?? fitting.FirstOrDefault();
        var selectedSize = selected?.ParamSize;
        var sameSizeMatches = fitting.Count(item => selectedSize.HasValue && item.ParamSize == selectedSize.Value);
        return new TaeSchemaResolution(
            selected,
            sameSizeMatches > 1,
            candidates,
            selected is null);
    }

    public static TaeSchemaDecodeResult Decode(
        int eventTypeId,
        ReadOnlySpan<byte> parameterBytes,
        int? bankId = null)
    {
        var resolution = Resolve(eventTypeId, parameterBytes.Length, bankId);
        if (resolution.Event is null)
        {
            return new TaeSchemaDecodeResult(
                false,
                Array.Empty<object>(),
                resolution,
                Array.Empty<string>(),
                parameterBytes.ToArray());
        }

        var fields = new List<object>(resolution.Event.Fields.Count);
        var assertFailures = new List<string>();
        foreach (var field in resolution.Event.Fields)
        {
            if (field.Offset < 0 || field.Offset + field.Size > parameterBytes.Length)
                return new TaeSchemaDecodeResult(false, fields, resolution, assertFailures, parameterBytes.ToArray());

            var raw = parameterBytes.Slice(field.Offset, field.Size);
            var value = ReadValue(field.Type, raw);
            var assertValid = !field.Assert.HasValue || NumericValue(value) == field.Assert.Value;
            if (!assertValid) assertFailures.Add(field.Name);
            var enumName = field.Enum?.FirstOrDefault(item => item.Value == NumericValue(value))?.Name;
            fields.Add(new
            {
                index = field.Index,
                name = field.Name,
                type = field.Type,
                offset = field.Offset,
                size = field.Size,
                value,
                rawValue = NumericValue(value),
                displayValue = enumName ?? FormatValue(value),
                isPadding = IsPaddingField(field),
                assert = field.Assert,
                assertValid,
                enumEntries = field.Enum?.Select(item => new { value = item.Value, name = item.Name }).ToArray()
                    ?? Array.Empty<object>()
            });
        }
        return new TaeSchemaDecodeResult(
            assertFailures.Count == 0,
            fields,
            resolution,
            assertFailures,
            parameterBytes.ToArray());
    }

    /// <summary>
    /// Encodes one user-supplied field value using the exact first-party field
    /// type.  The writer calls this only after resolving an event by native
    /// parameter length, so a caller cannot turn a field name into an
    /// arbitrary byte-range write.
    /// </summary>
    public static byte[] EncodeValue(TaeSchemaField field, JsonElement value)
    {
        using var enumDocument = TryResolveEnumValue(field, value);
        if (enumDocument is not null) value = enumDocument.RootElement;
        var output = new byte[field.Size];
        switch (field.Type)
        {
            case "b":
            {
                var boolean = ReadBoolean(value);
                output[0] = boolean ? (byte)1 : (byte)0;
                break;
            }
            case "u8":
                output[0] = checked((byte)ReadUnsigned(value, byte.MaxValue));
                break;
            case "s8":
                output[0] = unchecked((byte)checked((sbyte)ReadSigned(value, sbyte.MinValue, sbyte.MaxValue)));
                break;
            case "u16":
                BinaryPrimitives.WriteUInt16LittleEndian(output, checked((ushort)ReadUnsigned(value, ushort.MaxValue)));
                break;
            case "s16":
                BinaryPrimitives.WriteInt16LittleEndian(output, checked((short)ReadSigned(value, short.MinValue, short.MaxValue)));
                break;
            case "u32":
                BinaryPrimitives.WriteUInt32LittleEndian(output, checked((uint)ReadUnsigned(value, uint.MaxValue)));
                break;
            case "s32":
                BinaryPrimitives.WriteInt32LittleEndian(output, checked((int)ReadSigned(value, int.MinValue, int.MaxValue)));
                break;
            case "s64":
                BinaryPrimitives.WriteInt64LittleEndian(output, ReadSigned(value, long.MinValue, long.MaxValue));
                break;
            case "f32":
            {
                var number = ReadFloat(value);
                BinaryPrimitives.WriteSingleLittleEndian(output, number);
                break;
            }
            default:
                throw new InvalidDataException($"FIRST_PARTY_TAE_SCHEMA_INVALID: 未知字段类型 {field.Type}。");
        }
        return output;
    }

    public static int TypeSize(string type) => type switch
    {
        "b" or "u8" or "s8" => 1,
        "u16" or "s16" => 2,
        "u32" or "s32" or "f32" => 4,
        "s64" => 8,
        _ => throw new InvalidDataException($"FIRST_PARTY_TAE_SCHEMA_INVALID: 未知字段类型 {type}。")
    };

    public static object Metadata() => new
    {
        origin = "first-party",
        package = Package,
        version = Version,
        contentDigest = ContentDigest,
        game = "sekiro",
        format = "TAE",
        nativeFormatAuthority = false,
        bankCount = Document.Banks.Count,
        eventCount = Document.Banks.Sum(item => item.Events.Count),
        fieldCount = Document.Banks.Sum(item => item.Events.Sum(eventItem => eventItem.Fields.Count))
    };

    private static TaeSchemaDocument Load()
    {
        var assembly = typeof(TaeFirstPartySchema).Assembly;
        var resourceName = assembly.GetManifestResourceNames()
            .FirstOrDefault(name => name.EndsWith(
                "sekiro-tae-schema.v1.json.gz.base64",
                StringComparison.OrdinalIgnoreCase));
        if (resourceName is null)
            throw new InvalidDataException("FIRST_PARTY_TAE_SCHEMA_MISSING: 内置 TAE schema 资源缺失。");

        using var resource = assembly.GetManifestResourceStream(resourceName)
            ?? throw new InvalidDataException("FIRST_PARTY_TAE_SCHEMA_MISSING: 内置 TAE schema 流不可读。");
        using var reader = new StreamReader(resource);
        var encoded = reader.ReadToEnd().Trim();
        byte[] compressed;
        try { compressed = Convert.FromBase64String(encoded); }
        catch (FormatException ex) { throw new InvalidDataException("FIRST_PARTY_TAE_SCHEMA_INVALID: base64 无效。", ex); }

        using var compressedStream = new MemoryStream(compressed, writable: false);
        using var gzip = new GZipStream(compressedStream, CompressionMode.Decompress);
        using var jsonStream = new MemoryStream();
        gzip.CopyTo(jsonStream);
        var document = JsonSerializer.Deserialize<TaeSchemaDocument>(jsonStream.ToArray(), new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true
        }) ?? throw new InvalidDataException("FIRST_PARTY_TAE_SCHEMA_INVALID: JSON 为空。");

        if (document.Game != "sekiro"
            || document.Format != "TAE"
            || document.Banks.Count != 3
            || document.Banks.Sum(item => item.Events.Count) != 500
            || document.Banks.Sum(item => item.Events.Sum(eventItem => eventItem.Fields.Count)) != 3459)
        {
            throw new InvalidDataException("FIRST_PARTY_TAE_SCHEMA_INVALID: 内置 TAE schema 计数或身份不匹配。");
        }
        // The public XML-derived payload intentionally stores no generated
        // field index.  Assign it deterministically at load time so UI and
        // typed write requests can use a stable selector without shipping the
        // source XML or relying on its runtime parser.
        foreach (var bank in document.Banks)
        {
            foreach (var eventItem in bank.Events)
            {
                for (var index = 0; index < eventItem.Fields.Count; index++)
                    eventItem.Fields[index] = eventItem.Fields[index] with { Index = index };
            }
        }
        return document;
    }

    private static object ReadValue(string type, ReadOnlySpan<byte> bytes) => type switch
    {
        "u8" => bytes[0],
        "s8" => unchecked((sbyte)bytes[0]),
        "b" => bytes[0] != 0,
        "u16" => BinaryPrimitives.ReadUInt16LittleEndian(bytes),
        "s16" => BinaryPrimitives.ReadInt16LittleEndian(bytes),
        "u32" => BinaryPrimitives.ReadUInt32LittleEndian(bytes),
        "s32" => BinaryPrimitives.ReadInt32LittleEndian(bytes),
        "s64" => BinaryPrimitives.ReadInt64LittleEndian(bytes),
        "f32" => BinaryPrimitives.ReadSingleLittleEndian(bytes),
        _ => throw new InvalidDataException($"FIRST_PARTY_TAE_SCHEMA_INVALID: 未知字段类型 {type}。")
    };

    private static long NumericValue(object value) => value switch
    {
        bool boolean => boolean ? 1 : 0,
        byte number => number,
        sbyte number => number,
        ushort number => number,
        short number => number,
        uint number => unchecked((long)number),
        int number => number,
        long number => number,
        float number => BitConverter.SingleToInt32Bits(number),
        _ => 0
    };

    private static string FormatValue(object value) => value switch
    {
        float number => number.ToString("R", System.Globalization.CultureInfo.InvariantCulture),
        _ => Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty
    };

    public static bool IsPaddingField(TaeSchemaField field) => field.Assert.HasValue
        || field.Name.StartsWith("__", StringComparison.Ordinal)
        || field.Name.Contains("padding", StringComparison.OrdinalIgnoreCase)
        || field.Name.StartsWith("pad", StringComparison.OrdinalIgnoreCase);

    private static bool ReadBoolean(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.True) return true;
        if (value.ValueKind == JsonValueKind.False) return false;
        if (value.ValueKind == JsonValueKind.Number)
        {
            var number = value.GetDecimal();
            if (number == 0) return false;
            if (number == 1) return true;
        }
        if (value.ValueKind == JsonValueKind.String
            && bool.TryParse(value.GetString(), out var parsed)) return parsed;
        throw new InvalidDataException("TAE 布尔字段只接受 true/false 或 0/1。");
    }

    private static long ReadSigned(JsonElement value, long minimum, long maximum)
    {
        if (value.ValueKind == JsonValueKind.String)
        {
            var text = value.GetString();
            if (!long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed))
                throw new InvalidDataException($"TAE 整数字段值无效：{text}。");
            if (parsed < minimum || parsed > maximum)
                throw new InvalidDataException($"TAE 整数字段值 {parsed} 超出范围 [{minimum}, {maximum}]。");
            return parsed;
        }
        if (value.ValueKind != JsonValueKind.Number
            || !value.TryGetInt64(out var number)
            || number < minimum
            || number > maximum)
            throw new InvalidDataException($"TAE 整数字段值超出范围 [{minimum}, {maximum}]。");
        return number;
    }

    private static ulong ReadUnsigned(JsonElement value, ulong maximum)
    {
        if (value.ValueKind == JsonValueKind.String)
        {
            var text = value.GetString();
            if (!ulong.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed))
                throw new InvalidDataException($"TAE 无符号整数字段值无效：{text}。");
            return parsed <= maximum ? parsed : throw new InvalidDataException($"TAE 无符号整数字段值 {parsed} 超出范围 [0, {maximum}]。");
        }
        if (value.ValueKind != JsonValueKind.Number
            || !value.TryGetUInt64(out var number)
            || number > maximum)
            throw new InvalidDataException($"TAE 无符号整数字段值超出范围 [0, {maximum}]。");
        return number;
    }

    private static float ReadFloat(JsonElement value)
    {
        float number;
        if (value.ValueKind == JsonValueKind.String)
        {
            if (!float.TryParse(value.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out number))
                throw new InvalidDataException("TAE f32 字段值无效。");
        }
        else if (value.ValueKind == JsonValueKind.Number && value.TryGetSingle(out var parsed))
        {
            number = parsed;
        }
        else
        {
            throw new InvalidDataException("TAE f32 字段值必须是有限数字。");
        }
        if (!float.IsFinite(number)) throw new InvalidDataException("TAE f32 字段值必须是有限数字。");
        return number;
    }

    private static JsonDocument? TryResolveEnumValue(TaeSchemaField field, JsonElement value)
    {
        if (field.Enum is null || value.ValueKind != JsonValueKind.String) return null;
        var text = value.GetString();
        var match = field.Enum.FirstOrDefault(item =>
            string.Equals(item.Name, text, StringComparison.Ordinal)
            || string.Equals(item.Name, text, StringComparison.OrdinalIgnoreCase));
        return match is null
            ? null
            : JsonDocument.Parse(match.Value.ToString(CultureInfo.InvariantCulture));
    }
}

internal sealed record TaeSchemaDocument(
    string Game,
    string Format,
    List<TaeSchemaBank> Banks);

internal sealed record TaeSchemaBank(
    int Id,
    string Name,
    List<TaeSchemaEvent> Events);

internal sealed record TaeSchemaEvent(
    int Id,
    string Name,
    int ParamSize,
    List<TaeSchemaField> Fields)
{
    public int BankId { get; init; }
    public string BankName { get; init; } = string.Empty;
    public bool Variant { get; init; }
    public int? VariantOf { get; init; }
    public string? VariantKind { get; init; }
};

internal sealed record TaeSchemaField(
    int Offset,
    int Size,
    string Type,
    string Name,
    int Index,
    int? Assert,
    string? Default,
    bool RequiresActivation,
    List<TaeSchemaEnumEntry>? Enum);

internal sealed record TaeSchemaEnumEntry(int Value, string Name);

internal sealed record TaeSchemaResolution(
    TaeSchemaEvent? Event,
    bool Ambiguous,
    IReadOnlyList<TaeSchemaEvent> Candidates,
    bool LengthMismatch);

internal sealed record TaeSchemaDecodeResult(
    bool Complete,
    IReadOnlyList<object> Fields,
    TaeSchemaResolution Resolution,
    IReadOnlyList<string> AssertFailures,
    byte[] RawBytes);
