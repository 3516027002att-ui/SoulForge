using System.Buffers.Binary;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using Xunit;

public sealed class MsbOwnedVerificationTests
{
    private static Func<MsbNativeDocument, MsbRoundTripReport> OwnedVerifier()
    {
        var method = typeof(MsbNativeDocument).GetMethod("VerifyOwnedSnapshot", BindingFlags.Instance | BindingFlags.NonPublic);
        Assert.NotNull(method);
        return method!.CreateDelegate<Func<MsbNativeDocument, MsbRoundTripReport>>();
    }

    [Theory]
    [InlineData(0x800)]
    [InlineData(85000)]
    [InlineData(2 * 1024 * 1024)]
    public void OwnedVerificationPreservesReportWhilePublicVerificationStillCopiesMutableSource(int size)
    {
        var bytes = Fixture(size); var document = MsbNativeDocument.Read(bytes); var verifyOwned = OwnedVerifier();
        Assert.Same(bytes, document.SourceBytes); // Existing caller-provided mutable array contract.
        _ = document.SourceHash; // Hash memo allocation excluded in both measured scopes.
        var expected = document.VerifyRoundTrip();
        Assert.Equal(expected, verifyOwned(document));
        Assert.True(expected.SemanticIdentical); Assert.False(expected.ByteIdentical);
        for (var index = 0; index < 4; index++) { document.VerifyRoundTrip(); verifyOwned(document); }
        var before = GC.GetAllocatedBytesForCurrentThread(); var copied = document.VerifyRoundTrip();
        var copyBytes = GC.GetAllocatedBytesForCurrentThread() - before;
        before = GC.GetAllocatedBytesForCurrentThread(); var owned = verifyOwned(document);
        var ownedBytes = GC.GetAllocatedBytesForCurrentThread() - before;
        Assert.Equal(copied, owned);
        // A large source with tiny geometry localizes the allocation to the public
        // snapshot copy, rather than the parser's model/part work or an exact total.
        Assert.InRange(copyBytes - ownedBytes, size, size + 64L);
        Assert.Equal(Hash(bytes), expected.SourceHash);
        Assert.Equal(Hash(bytes), expected.RebuiltHash);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void PostReadMutableFieldChangeStillFailsCompleteSemanticVerification(bool memoBeforeChange)
    {
        var bytes = Fixture(0x800); var document = MsbNativeDocument.Read(bytes); var verifyOwned = OwnedVerifier();
        var originalHash = Hash(bytes);
        if (memoBeforeChange) _ = document.SourceHash;
        bytes[0x70] = (byte)'Z'; // Native model display name: original document still says MODEL.
        var expected = document.VerifyRoundTrip(); var actual = verifyOwned(document);
        Assert.Equal(expected, actual); Assert.False(actual.SemanticIdentical);
        Assert.Equal("MODEL", document.Models[0].Name); Assert.Equal("ZODEL", MsbNativeDocument.Read(bytes).Models[0].Name);
        Assert.Equal(Hash(bytes), actual.RebuiltHash);
        Assert.Equal(memoBeforeChange ? originalHash : Hash(bytes), actual.SourceHash);
    }

    [Fact]
    public void InvalidSourceMutationStillThrowsInsteadOfReusingEarlierVerifiedState()
    {
        var bytes = Fixture(0x800); var document = MsbNativeDocument.Read(bytes); var verifyOwned = OwnedVerifier();
        Assert.True(document.VerifyRoundTrip().SemanticIdentical);
        bytes[0] = 0;
        var expected = Assert.Throws<InvalidDataException>(() => document.VerifyRoundTrip());
        var actual = Assert.Throws<InvalidDataException>(() => verifyOwned(document));
        Assert.Equal(expected.Message, actual.Message);
    }

    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static byte[] Fixture(int size)
    {
        var families = new[] { "MODEL_PARAM_ST", "EVENT_PARAM_ST", "POINT_PARAM_ST", "ROUTE_PARAM_ST", "LAYER_PARAM_ST", "PARTS_PARAM_ST", "MAPSTUDIO_PARTS_POSE_ST", "MAPSTUDIO_BONE_NAME_STRING" };
        var bytes = new byte[size]; "MSB "u8.CopyTo(bytes); BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(4), 3);
        for (var index = 0; index < families.Length; index++)
        {
            var offset = 0x10 + index * 0x100;
            BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(offset), 1);
            BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(offset + 4), index == 0 ? 2 : 1);
            BinaryPrimitives.WriteInt64LittleEndian(bytes.AsSpan(offset + 8), offset + 0xA0);
            if (index == 0) BinaryPrimitives.WriteInt64LittleEndian(bytes.AsSpan(offset + 16), 0x40);
            BinaryPrimitives.WriteInt64LittleEndian(bytes.AsSpan(offset + (index == 0 ? 24 : 16)), index == families.Length - 1 ? 0 : offset + 0x100);
            Encoding.Unicode.GetBytes(families[index] + "\0").CopyTo(bytes, offset + 0xA0);
        }
        BinaryPrimitives.WriteInt64LittleEndian(bytes.AsSpan(0x40), 0x30);
        Encoding.Unicode.GetBytes("MODEL\0").CopyTo(bytes, 0x70);
        return bytes;
    }
}
