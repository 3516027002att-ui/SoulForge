using System.Buffers.Binary;
using System.Text;

/// <summary>
/// Resolves Sekiro TAE animation identity from the animation-file mini header.
///
/// This class deliberately stops at the logical HKX source animation ID. Binder entry
/// resolution belongs to the ANIBND/HKX layer and must not be replaced with generated
/// filename candidates here.
///
/// Layout/behavior was independently cross-checked against the permissively licensed
/// SoulsFormats TAE model carried by Smithbox (`Formats/TAE/Animation.cs`) and against
/// observable DSAnimStudio resolution behavior. No GPL implementation text is used here.
/// </summary>
internal static class TaeAnimationIdentityResolver
{
    private const int MiniHeaderRequiredBytes = 0x20;
    private const int MaxUtf16NameBytes = 4096;

    internal enum MiniHeaderType : int
    {
        Standard = 0,
        ImportOtherAnim = 1
    }

    internal sealed record MiniHeader(
        MiniHeaderType Type,
        string? AnimFileName,
        bool IsLoopByDefault,
        bool ImportsHkx,
        bool AllowDelayLoad,
        int? ImportHkxSourceAnimId,
        int? ImportFromAnimId,
        int? ImportOtherUnknown);

    internal sealed record ResolutionStep(
        long AnimId,
        MiniHeaderType Type,
        string? AnimFileName,
        bool ImportsHkx,
        int? ImportHkxSourceAnimId,
        int? ImportFromAnimId);

    internal sealed record Resolution(
        long RequestedAnimId,
        long ResolvedTaeAnimId,
        long MotionSourceAnimId,
        bool IsLoopByDefault,
        bool AllowDelayLoad,
        string? ResolvedTaeAnimFileName,
        IReadOnlyList<ResolutionStep> Steps);

    /// <summary>
    /// Resolve a requested TAE animation to the Standard mini-header that owns its event
    /// body, then resolve the logical HKX motion source declared by that header.
    ///
    /// ImportOtherAnim chains are followed transitively and cycle-checked. A Standard
    /// header with ImportsHKX=true yields ImportHKXSourceAnimID as motion identity.
    /// Nothing in this method formats or guesses an HKX filename.
    /// </summary>
    internal static Resolution Resolve(TaeNativeDocument document, long requestedAnimId)
    {
        ArgumentNullException.ThrowIfNull(document);

        var animationsById = new Dictionary<long, TaeAnimation>();
        foreach (var animation in document.Animations)
        {
            if (!animationsById.TryAdd(animation.AnimId, animation))
            {
                throw new InvalidDataException(
                    $"TAE animation identity is ambiguous: duplicate animId {animation.AnimId}.");
            }
        }

        if (!animationsById.TryGetValue(requestedAnimId, out var current))
        {
            throw new InvalidDataException(
                $"TAE animation {requestedAnimId} does not exist in this document.");
        }

        var visited = new HashSet<long>();
        var steps = new List<ResolutionStep>();

        while (true)
        {
            if (!visited.Add(current.AnimId))
            {
                var chain = string.Join(" -> ", steps.Select(step => step.AnimId).Append(current.AnimId));
                throw new InvalidDataException($"TAE ImportOtherAnim cycle detected: {chain}.");
            }

            var header = ReadMiniHeader(document.SourceBytes, current.AnimFileInfoOffset);
            steps.Add(new ResolutionStep(
                current.AnimId,
                header.Type,
                header.AnimFileName,
                header.ImportsHkx,
                header.ImportHkxSourceAnimId,
                header.ImportFromAnimId));

            if (header.Type == MiniHeaderType.ImportOtherAnim)
            {
                if (header.ImportFromAnimId is not int importedAnimId || importedAnimId < 0)
                {
                    throw new InvalidDataException(
                        $"TAE animation {current.AnimId} imports another animation but has no valid source ID.");
                }

                if (!animationsById.TryGetValue(importedAnimId, out var imported))
                {
                    throw new InvalidDataException(
                        $"TAE animation {current.AnimId} imports missing animation {importedAnimId}.");
                }

                current = imported;
                continue;
            }

            long motionSourceAnimId = current.AnimId;
            if (header.ImportsHkx)
            {
                if (header.ImportHkxSourceAnimId is not int sourceAnimId || sourceAnimId < 0)
                {
                    throw new InvalidDataException(
                        $"TAE animation {current.AnimId} sets ImportsHKX but its source animation ID is invalid.");
                }

                motionSourceAnimId = sourceAnimId;
            }

            return new Resolution(
                requestedAnimId,
                current.AnimId,
                motionSourceAnimId,
                header.IsLoopByDefault,
                header.AllowDelayLoad,
                header.AnimFileName,
                steps.ToArray());
        }
    }

    /// <summary>
    /// Parse the Sekiro-era animation-file mini header at animFileInfoOffset.
    ///
    /// 0x00: int32 MiniHeaderType
    /// 0x04: int32 padding / high half in the 64-bit layout
    /// 0x08: pointer bookkeeping used by the format
    /// 0x10: int64 UTF-16 animation filename pointer
    /// 0x18: mini-header payload
    ///
    /// Standard payload at 0x18:
    ///   byte IsLoopByDefault
    ///   byte ImportsHKX
    ///   byte AllowDelayLoad
    ///   byte padding
    ///   int32 ImportHKXSourceAnimID
    ///
    /// ImportOtherAnim payload at 0x18:
    ///   int32 ImportFromAnimID
    ///   int32 Unknown
    /// </summary>
    internal static MiniHeader ReadMiniHeader(byte[] source, long animFileInfoOffset)
    {
        ArgumentNullException.ThrowIfNull(source);

        if (animFileInfoOffset <= 0
            || animFileInfoOffset > int.MaxValue
            || animFileInfoOffset + MiniHeaderRequiredBytes > source.Length)
        {
            throw new InvalidDataException(
                $"TAE animation-file mini header offset {animFileInfoOffset} is out of range.");
        }

        var offset = checked((int)animFileInfoOffset);
        var rawType = ReadInt32(source, offset);
        if (rawType != (int)MiniHeaderType.Standard
            && rawType != (int)MiniHeaderType.ImportOtherAnim)
        {
            throw new NotSupportedException(
                $"Unsupported TAE animation mini-header type {rawType} at 0x{offset:X}.");
        }

        var type = (MiniHeaderType)rawType;
        var fileNamePointer = ReadInt64(source, offset + 0x10);
        var fileName = ReadOptionalUtf16Z(source, fileNamePointer);

        if (type == MiniHeaderType.Standard)
        {
            var isLoopByDefault = source[offset + 0x18] != 0;
            var importsHkx = source[offset + 0x19] != 0;
            var allowDelayLoad = source[offset + 0x1A] != 0;
            var importHkxSourceAnimId = ReadInt32(source, offset + 0x1C);

            return new MiniHeader(
                type,
                fileName,
                isLoopByDefault,
                importsHkx,
                allowDelayLoad,
                importHkxSourceAnimId,
                null,
                null);
        }

        var importFromAnimId = ReadInt32(source, offset + 0x18);
        var unknown = ReadInt32(source, offset + 0x1C);
        return new MiniHeader(
            type,
            fileName,
            false,
            false,
            false,
            null,
            importFromAnimId,
            unknown);
    }

    private static int ReadInt32(byte[] source, int offset) =>
        BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(offset, sizeof(int)));

    private static long ReadInt64(byte[] source, int offset) =>
        BinaryPrimitives.ReadInt64LittleEndian(source.AsSpan(offset, sizeof(long)));

    private static string? ReadOptionalUtf16Z(byte[] source, long pointer)
    {
        if (pointer == 0) return null;
        if (pointer < 0 || pointer > int.MaxValue || pointer + 2 > source.Length)
        {
            throw new InvalidDataException($"TAE animation filename pointer {pointer} is out of range.");
        }

        var start = checked((int)pointer);
        var limit = Math.Min(source.Length, start + MaxUtf16NameBytes);
        var end = start;
        while (end + 1 < limit)
        {
            if (source[end] == 0 && source[end + 1] == 0)
            {
                if (end == start) return null;
                var value = Encoding.Unicode.GetString(source, start, end - start);
                return string.IsNullOrWhiteSpace(value) ? null : value;
            }

            end += 2;
        }

        throw new InvalidDataException(
            $"TAE animation filename at 0x{start:X} is not UTF-16 terminated within {MaxUtf16NameBytes} bytes.");
    }
}