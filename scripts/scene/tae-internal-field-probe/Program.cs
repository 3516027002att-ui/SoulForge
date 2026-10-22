using System.Buffers.Binary;
using System.Collections;
using System.Reflection;
using System.Runtime.Loader;
using System.Security.Cryptography;
using System.Text.Json;

// Validation executable only. The product assembly remains the native parser.
// Supplemental layout reads are marked separately and never become product fields.
internal static class Program
{
    private const BindingFlags PublicInstance = BindingFlags.Public | BindingFlags.Instance;
    private static object Get(object value, string name) =>
        value.GetType().GetProperty(name, PublicInstance)?.GetValue(value)
        ?? throw new InvalidDataException($"Decoded property {value.GetType().Name}.{name} unavailable.");
    private static object? Optional(object value, string name) =>
        value.GetType().GetProperty(name, PublicInstance)?.GetValue(value);
    private static object[] Items(object value, string name) => ((IEnumerable)Get(value, name)).Cast<object>().ToArray();
    private static long Long(object value, string name) => Convert.ToInt64(Get(value, name));
    private static int Int(object value, string name) => checked((int)Long(value, name));
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    private static int Offset(byte[] bytes, long offset, int length)
    {
        if (offset < 0 || length < 0 || offset > bytes.Length - length)
            throw new InvalidDataException($"Supplemental layout range {offset}+{length} is out of bounds.");
        return checked((int)offset);
    }
    private static long I64(byte[] bytes, long offset) => BinaryPrimitives.ReadInt64LittleEndian(bytes.AsSpan(Offset(bytes, offset, 8), 8));
    private static int I32(byte[] bytes, long offset) => BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(Offset(bytes, offset, 4), 4));

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length != 3 || !Path.IsPathFullyQualified(args[0]))
                throw new ArgumentException("Usage: TAEInternalFields <product-dll> <a232.tae> <a250.tae>");
            var productBytes = File.ReadAllBytes(args[0]);
            var assembly = AssemblyLoadContext.Default.LoadFromAssemblyPath(args[0]);
            var nativeType = assembly.GetType("TaeNativeDocument", throwOnError: true)!;
            var read = nativeType.GetMethod("Read", BindingFlags.Public | BindingFlags.Static, new[] { typeof(byte[]) })!;
            var motionType = assembly.GetType("SekiroTaeMotionReferenceReader", throwOnError: true)!;
            var motionRead = motionType.GetMethod("ReadOne", BindingFlags.Public | BindingFlags.Static)!;
            var resources = new List<object>();
            foreach (var path in args.Skip(1))
            {
                var bytes = File.ReadAllBytes(path);
                if (bytes.Length > 32 * 1024) throw new InvalidDataException("Bounded TAE leaf exceeds 32 KiB.");
                var originalHash = Hash(bytes);
                var document = read.Invoke(null, new object[] { bytes })!;
                var animations = Items(document, "Animations");
                if (animations.Length > 10 || animations.Sum(a => Int(a, "EventCount")) > 100)
                    throw new InvalidDataException("Bounded TAE sample exceeds animation/event limits.");
                // Product retains Section1Offset but does not retain animation/event-table bases.
                // Read those two pointer roots solely to translate its decoded group offsets.
                var animTableOffset = I64(bytes, Long(document, "Section1Offset") + 8);
                var animationResults = new List<object>();
                for (var ai = 0; ai < animations.Length; ai++)
                {
                    var animation = animations[ai];
                    var animId = Long(animation, "AnimId");
                    var events = Items(animation, "Events");
                    var groups = Items(animation, "EventGroups");
                    var tableEntry = checked(animTableOffset + ai * 16L);
                    if (I64(bytes, tableEntry) != animId) throw new InvalidDataException("Decoded animation order differs from native table order.");
                    var animationEntry = I64(bytes, tableEntry + 8);
                    var eventTableOffset = I64(bytes, animationEntry);
                    Offset(bytes, eventTableOffset, checked(events.Length * 24));
                    for (var ei = 0; ei < events.Length; ei++)
                        if (I64(bytes, eventTableOffset + ei * 24L + 16) != Long(events[ei], "EventDataOffset"))
                            throw new InvalidDataException("Supplemental event-header map differs from decoded event-data pointers.");
                    var groupOrdinals = new int?[events.Length];
                    var groupResults = new List<object>();
                    for (var gi = 0; gi < groups.Length; gi++)
                    {
                        var group = groups[gi];
                        var offsets = (int[])Get(group, "EventOffsets");
                        if (Long(group, "GroupEventCount") != offsets.Length) throw new InvalidDataException("Decoded group count differs from decoded offset array.");
                        var indices = offsets.Select(offset =>
                        {
                            var relative = (long)offset - eventTableOffset;
                            if (relative < 0 || relative % 24 != 0 || relative / 24 >= events.Length)
                                throw new InvalidDataException($"Decoded group {gi} offset {offset} does not identify an event header.");
                            var index = checked((int)(relative / 24));
                            if (groupOrdinals[index].HasValue)
                                throw new InvalidDataException($"Decoded event {index} belongs to multiple groups or appears twice.");
                            groupOrdinals[index] = gi;
                            return index;
                        }).ToArray();
                        groupResults.Add(new
                        {
                            ordinal = gi, groupType = Int(group, "EventType"),
                            groupEventCount = Long(group, "GroupEventCount"), eventOffsets = offsets,
                            eventIndices = indices, groupTypeUnknown = Long(group, "GroupTypeUnknown")
                        });
                    }
                    var reference = motionRead.Invoke(null, new[] { bytes, animation })!;
                    var infoOffset = Long(animation, "AnimFileInfoOffset");
                    animationResults.Add(new
                    {
                        ordinal = ai, animId, hkxName = Optional(animation, "HkxName"),
                        eventCount = Int(animation, "EventCount"), groupCount = Int(animation, "EventGroupCount"),
                        groups = groupResults, eventGroupOrdinals = groupOrdinals,
                        motionReference = new
                        {
                            animationId = Long(reference, "AnimationId"), kind = Get(reference, "Kind").ToString(),
                            sourceAnimationId = Optional(reference, "SourceAnimationId"),
                            hkxAnimationId = Optional(reference, "HkxAnimationId")
                        },
                        supplementalNativeLayout = new
                        {
                            animationEntryOffset = animationEntry, eventTableOffset,
                            animFileInfoOffset = infoOffset, miniHeader = MiniHeader(bytes, infoOffset)
                        }
                    });
                }
                if (Hash(bytes) != originalHash || Hash(File.ReadAllBytes(path)) != originalHash)
                    throw new InvalidDataException("TAE input changed during reflection capture.");
                resources.Add(new
                {
                    id = Path.GetFileNameWithoutExtension(path), leafPath = Path.GetFullPath(path),
                    sourceHash = (string)Get(document, "SourceHash"), sourceByteLength = bytes.Length,
                    eventBank = Long(document, "EventBank"), animationCount = animations.Length,
                    totalEventCount = Int(document, "TotalEventCount"), totalGroupCount = Int(document, "TotalGroupCount"),
                    animations = animationResults
                });
            }
            if (Hash(File.ReadAllBytes(args[0])) != Hash(productBytes)) throw new InvalidDataException("Product assembly changed during capture.");
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                schema = "soulforge.tae-internal-observations.v1", producerSha256 = Hash(productBytes), resources,
                groupMembershipTranslation = "Decoded TaeEventGroup.EventOffsets mapped to ordinals using supplemental event-header base and native 24-byte stride; decoded event-data pointers checked against each raw header.",
                supplementalLayoutBasis = "Pinned SoulsFormatsNEXT SDT Animation.cs: 64-bit miniheader type at +0, filename-field pointer at +8, filename pointer +16, semantics +24; zero filename-field pointer means null header. No supplemental field is a retained product miniheader property."
            }));
            return 0;
        }
        catch (Exception error)
        {
            var detail = error is TargetInvocationException && error.InnerException is not null ? error.InnerException : error;
            Console.Error.WriteLine(JsonSerializer.Serialize(new { ok = false, error = detail.GetType().Name, detail.Message }));
            return 1;
        }
    }

    private static object MiniHeader(byte[] bytes, long offset)
    {
        Offset(bytes, offset, 16);
        var type = I32(bytes, offset);
        if (I32(bytes, offset + 4) != 0) throw new InvalidDataException("Supplemental SDT miniheader high word is nonzero.");
        var fieldPointer = I64(bytes, offset + 8);
        var isNullHeader = fieldPointer == 0;
        if (!isNullHeader && fieldPointer != offset + 16) throw new InvalidDataException("Supplemental SDT miniheader filename-field pointer differs.");
        if (type == 0)
        {
            if (isNullHeader) return new { type = "Standard", isNullHeader, IsLoopByDefault = false, ImportsHKX = false, AllowDelayLoad = false, ImportHKXSourceAnimID = 0 };
            var p = Offset(bytes, offset + 24, 8);
            return new { type = "Standard", isNullHeader, IsLoopByDefault = bytes[p] != 0, ImportsHKX = bytes[p + 1] != 0, AllowDelayLoad = bytes[p + 2] != 0, ImportHKXSourceAnimID = I32(bytes, p + 4) };
        }
        if (type == 1)
            return new { type = "ImportOtherAnim", isNullHeader, ImportFromAnimID = isNullHeader ? 0 : I32(bytes, offset + 24), Unknown = isNullHeader ? -1 : I32(bytes, offset + 28) };
        throw new InvalidDataException($"Supplemental SDT miniheader type {type} unsupported.");
    }
}
