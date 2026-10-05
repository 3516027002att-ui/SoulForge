using System.Text;

// Only the daemon's stream entry creates this marker/borrowed sink. Injected
// TextWriter callers retain their original serialization and write contracts.
internal sealed class BridgeUtf8StreamWriter : TextWriter
{
    private static readonly byte[] Newline = [(byte)'\n'];
    private readonly Stream output;

    public BridgeUtf8StreamWriter(Stream output)
    {
        this.output = output;
        // Setting AutoFlush=true on the former BOMless StreamWriter flushed
        // its empty buffer synchronously before daemon startup.
        output.Flush();
    }

    public override Encoding Encoding => Encoding.UTF8;

    public async Task WriteFrameAsync(ReadOnlyMemory<byte> utf8)
    {
        // Preserve body AutoFlush, newline AutoFlush and the explicit final
        // flush as distinct observable failure boundaries. Output writes were
        // never request-cancellable; cancellation must not split an admitted
        // frame or retry a partially written frame through another sink.
        await output.WriteAsync(utf8).ConfigureAwait(false);
        await output.FlushAsync().ConfigureAwait(false);
        await output.WriteAsync(Newline).ConfigureAwait(false);
        await output.FlushAsync().ConfigureAwait(false);
        await output.FlushAsync().ConfigureAwait(false);
    }

    // Match the previous await-using StreamWriter's final flush/leaveOpen=true.
    public override ValueTask DisposeAsync() => new(output.FlushAsync());
}
