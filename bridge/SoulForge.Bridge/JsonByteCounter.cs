using System.Text.Json;

// Exact default System.Text.Json preflight size, without retaining an output
// array/string. The final daemon serialization and wire budgets remain intact.
internal static class JsonByteCounter
{
    internal static long Count<T>(T value)
    {
        using var sink = new CountingStream();
        JsonSerializer.Serialize(sink, value);
        return sink.BytesWritten;
    }

    private sealed class CountingStream : Stream
    {
        internal long BytesWritten { get; private set; }
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => BytesWritten;
        public override long Position
        {
            get => BytesWritten;
            set => throw new NotSupportedException();
        }
        public override void Flush() { }
        public override void Write(byte[] buffer, int offset, int count) => Write(buffer.AsSpan(offset, count));
        public override void Write(ReadOnlySpan<byte> buffer) => BytesWritten = checked(BytesWritten + buffer.Length);
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
    }
}
