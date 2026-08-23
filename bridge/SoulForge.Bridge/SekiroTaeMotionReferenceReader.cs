using System.Buffers.Binary;

/// <summary>
/// Reads only the Sekiro TAE animation mini-header fields needed to resolve motion identity.
///
/// Layout source: Smithbox (MIT), Andre.SoulsFormats Formats/TAE/Animation.cs for the 64-bit
/// DS3/SDT-family TAE layout. This intentionally does not duplicate the general TAE parser.
/// </summary>
internal static class SekiroTaeMotionReferenceReader
{
    private const int MiniHeaderTypeStandard = 0;
    private const int MiniHeaderTypeImportOtherAnim = 1;
    private const int MinimumAnimFileInfoSize = 0x30;

    public static IReadOnlyDictionary<long, ActionAnimationSemantics.TaeMotionReference> ReadAll(
        TaeNativeDocument document)
    {
        var result = new Dictionary<long, ActionAnimationSemantics.TaeMotionReference>();
        foreach (var animation in document.Animations)
        {
            if (!result.TryAdd(animation.AnimId, ReadOne(document.SourceBytes, animation)))
                throw new InvalidDataException($"TAE contains duplicate animation ID {animation.AnimId}; motion identity is ambiguous.");
        }
        return result;
    }

    public static ActionAnimationSemantics.TaeMotionReference ReadOne(
        byte[] source,
        TaeAnimation animation)
    {
        var offset = animation.AnimFileInfoOffset;
        if (offset <= 0 || offset + MinimumAnimFileInfoSize > source.Length)
            throw new InvalidDataException(
                $"TAE animation {animation.AnimId} anim-file info offset {offset} is unavailable or truncated.");

        var p = checked((int)offset);
        var miniHeaderType = ReadInt32(source, p);
        var highWord = ReadInt32(source, p + 0x04);
        if (highWord != 0)
            throw new InvalidDataException(
                $"TAE animation {animation.AnimId} mini-header high word is {highWord}, expected 0 for Sekiro 64-bit layout.");

        // In Sekiro's 64-bit layout the field at +0x08 points to the field at +0x10 which stores
        // the animation filename pointer. Validate this structural invariant instead of silently
        // treating +0x00 as an ad-hoc alias flag.
        var expectedFileNameOffsetField = checked((int)(offset + 0x10));
        var fileNameOffsetField = ReadInt64(source, p + 0x08);
        if (fileNameOffsetField != expectedFileNameOffsetField)
            throw new InvalidDataException(
                $"TAE animation {animation.AnimId} mini-header filename-field pointer is 0x{fileNameOffsetField:X}, expected 0x{expectedFileNameOffsetField:X}.");

        // +0x10 is the filename pointer. Motion semantics begin at +0x18.
        var semantics = p + 0x18;
        return miniHeaderType switch
        {
            MiniHeaderTypeStandard => ReadStandard(source, animation.AnimId, semantics),
            MiniHeaderTypeImportOtherAnim => ReadImportOther(source, animation.AnimId, semantics),
            _ => throw new NotSupportedException(
                $"TAE animation {animation.AnimId} has unsupported mini-header type {miniHeaderType}.")
        };
    }

    private static ActionAnimationSemantics.TaeMotionReference ReadStandard(
        byte[] source,
        long animationId,
        int semantics)
    {
        EnsureRange(source, semantics, 8, animationId);
        var isLoopByDefault = source[semantics] != 0;
        var importsHkx = source[semantics + 1] != 0;
        var allowDelayLoad = source[semantics + 2] != 0;
        var reserved = source[semantics + 3];
        var importHkxSourceAnimationId = ReadInt32(source, semantics + 4);

        if (reserved != 0)
            throw new InvalidDataException(
                $"TAE animation {animationId} Standard mini-header reserved byte is {reserved}, expected 0.");

        _ = isLoopByDefault;
        _ = allowDelayLoad;

        return importsHkx
            ? new ActionAnimationSemantics.TaeMotionReference(
                animationId,
                ActionAnimationSemantics.MotionReferenceKind.ImportHkx,
                importHkxSourceAnimationId)
            : new ActionAnimationSemantics.TaeMotionReference(
                animationId,
                ActionAnimationSemantics.MotionReferenceKind.OwnHkx);
    }

    private static ActionAnimationSemantics.TaeMotionReference ReadImportOther(
        byte[] source,
        long animationId,
        int semantics)
    {
        EnsureRange(source, semantics, 8, animationId);
        var importFromAnimationId = ReadInt32(source, semantics);
        _ = ReadInt32(source, semantics + 4); // unknown field; preserved as opaque for identity purposes

        return new ActionAnimationSemantics.TaeMotionReference(
            animationId,
            ActionAnimationSemantics.MotionReferenceKind.ImportOtherAnimation,
            importFromAnimationId);
    }

    private static void EnsureRange(byte[] source, int offset, int size, long animationId)
    {
        if (offset < 0 || offset + size > source.Length)
            throw new InvalidDataException(
                $"TAE animation {animationId} mini-header semantics at 0x{offset:X} are truncated.");
    }

    private static int ReadInt32(byte[] source, int offset) =>
        BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(offset, 4));

    private static long ReadInt64(byte[] source, int offset) =>
        BinaryPrimitives.ReadInt64LittleEndian(source.AsSpan(offset, 8));
}
