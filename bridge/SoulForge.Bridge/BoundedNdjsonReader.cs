using System.Buffers;
using System.Text;

/// <summary>
/// Byte-oriented, bounded NDJSON reader used by the daemon's production stdin
/// path. The production overload unwraps the existing StreamReader and reads
/// its underlying stream directly, so invalid UTF-8 cannot be replaced before
/// this class sees it.
/// </summary>
internal sealed class BoundedNdjsonReader : IDisposable
{
    public const int DefaultReadBufferBytes = 64 * 1024;

    private static readonly UTF8Encoding StrictUtf8 = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

    private readonly Stream? _stream;
    private readonly TextReader? _textReader;
    private readonly byte[] _readBuffer;
    private readonly char[] _textBuffer;
    private byte[] _frameBuffer;
    private int _frameLength;
    private int _readOffset;
    private int _readCount;
    private int _maxFrameBytes;
    private readonly int _absoluteMaxFrameBytes;
    private bool _ended;
    private bool _failed;

    private BoundedNdjsonReader(
        Stream stream,
        int maxFrameBytes,
        int absoluteMaxFrameBytes,
        int readBufferBytes,
        bool leaveOpen)
    {
        _stream = stream;
        _maxFrameBytes = ValidateLimit(maxFrameBytes, absoluteMaxFrameBytes);
        _absoluteMaxFrameBytes = ValidateLimit(absoluteMaxFrameBytes, absoluteMaxFrameBytes);
        _readBuffer = new byte[Math.Clamp(readBufferBytes, 1024, 64 * 1024)];
        _textBuffer = Array.Empty<char>();
        _frameBuffer = ArrayPool<byte>.Shared.Rent(Math.Min(_maxFrameBytes, _readBuffer.Length));
        LeaveOpen = leaveOpen;
    }

    private BoundedNdjsonReader(
        TextReader textReader,
        int maxFrameBytes,
        int absoluteMaxFrameBytes,
        int readBufferBytes)
    {
        _textReader = textReader;
        _maxFrameBytes = ValidateLimit(maxFrameBytes, absoluteMaxFrameBytes);
        _absoluteMaxFrameBytes = ValidateLimit(absoluteMaxFrameBytes, absoluteMaxFrameBytes);
        _readBuffer = new byte[Math.Clamp(readBufferBytes, 1024, 64 * 1024)];
        _textBuffer = new char[Math.Max(1024, _readBuffer.Length / 4)];
        _frameBuffer = ArrayPool<byte>.Shared.Rent(Math.Min(_maxFrameBytes, _readBuffer.Length));
        LeaveOpen = true;
    }

    private bool LeaveOpen { get; }

    public int MaxFrameBytes => _maxFrameBytes;

    /// <summary>
    /// Uses the raw stream when the caller supplied a StreamReader. Program.cs
    /// creates that reader only to preserve the old host signature and has not
    /// consumed it before calling the daemon, so DiscardBufferedData is safe.
    /// Non-StreamReader callers are retained for small in-process tests.
    /// </summary>
    public static BoundedNdjsonReader FromTextReader(
        TextReader input,
        int maxFrameBytes,
        int absoluteMaxFrameBytes,
        int readBufferBytes = DefaultReadBufferBytes)
    {
        ArgumentNullException.ThrowIfNull(input);
        if (input is StreamReader streamReader)
        {
            streamReader.DiscardBufferedData();
            return new BoundedNdjsonReader(
                streamReader.BaseStream,
                maxFrameBytes,
                absoluteMaxFrameBytes,
                readBufferBytes,
                leaveOpen: true);
        }

        return new BoundedNdjsonReader(input, maxFrameBytes, absoluteMaxFrameBytes, readBufferBytes);
    }

    public void SetMaxFrameBytes(int maxFrameBytes)
    {
        ThrowIfClosed();
        var validated = ValidateLimit(maxFrameBytes, _absoluteMaxFrameBytes);
        if (_frameLength > validated)
            throw new BoundedNdjsonException(
                "BRIDGE_FRAME_TOO_LARGE",
                $"The current NDJSON frame already contains {_frameLength} bytes; negotiated maximum is {validated}.",
                _frameLength);
        _maxFrameBytes = validated;
        EnsureCapacity(Math.Min(_frameLength, _maxFrameBytes));
    }

    public async ValueTask<string?> ReadFrameAsync(CancellationToken cancellationToken)
    {
        ThrowIfClosed();
        if (_ended) return null;

        while (true)
        {
            if (_readOffset >= _readCount)
            {
                _readCount = await ReadChunkAsync(cancellationToken).ConfigureAwait(false);
                _readOffset = 0;
                if (_readCount == 0)
                {
                    _ended = true;
                    if (_frameLength != 0)
                    {
                        throw Fail(
                            "BRIDGE_EOF_INCOMPLETE_FRAME",
                            "Input ended before the NDJSON frame received its LF terminator.",
                            _frameLength);
                    }
                    return null;
                }
            }

            var value = _readBuffer[_readOffset++];
            if (value == (byte)'\n')
                return CompleteFrame();

            AppendByte(value);
        }
    }

    private async ValueTask<int> ReadChunkAsync(CancellationToken cancellationToken)
    {
        if (_stream is not null)
            return await _stream.ReadAsync(_readBuffer.AsMemory(), cancellationToken).ConfigureAwait(false);

        var chars = await _textReader!.ReadAsync(_textBuffer.AsMemory(), cancellationToken).ConfigureAwait(false);
        if (chars == 0) return 0;
        try
        {
            return StrictUtf8.GetBytes(_textBuffer.AsSpan(0, chars), _readBuffer.AsSpan());
        }
        catch (EncoderFallbackException ex)
        {
            throw Fail("BRIDGE_INVALID_UTF8", ex.Message, _frameLength);
        }
    }

    private void AppendByte(byte value)
    {
        if (_frameLength >= _maxFrameBytes)
            throw Fail(
                "BRIDGE_FRAME_TOO_LARGE",
                $"NDJSON frame exceeds the negotiated byte limit of {_maxFrameBytes}.",
                _frameLength + 1);

        EnsureCapacity(_frameLength + 1);
        _frameBuffer[_frameLength++] = value;
    }

    private string CompleteFrame()
    {
        var length = _frameLength;
        if (length > 0 && _frameBuffer[length - 1] == (byte)'\r')
            length -= 1;

        for (var i = 0; i < length; i++)
        {
            if (_frameBuffer[i] == (byte)'\r')
            {
                throw Fail(
                    "BRIDGE_INVALID_CRLF",
                    "A raw carriage return is only valid immediately before the frame LF terminator.",
                    i + 1);
            }
        }

        try
        {
            return StrictUtf8.GetString(_frameBuffer, 0, length);
        }
        catch (DecoderFallbackException ex)
        {
            throw Fail("BRIDGE_INVALID_UTF8", ex.Message, _frameLength);
        }
        finally
        {
            _frameLength = 0;
        }
    }

    private void EnsureCapacity(int needed)
    {
        if (needed <= _frameBuffer.Length) return;
        var nextCapacity = Math.Min(
            _maxFrameBytes,
            Math.Max(needed, Math.Max(1, _frameBuffer.Length) * 2));
        var grown = ArrayPool<byte>.Shared.Rent(nextCapacity);
        _frameBuffer.AsSpan(0, _frameLength).CopyTo(grown);
        ArrayPool<byte>.Shared.Return(_frameBuffer);
        _frameBuffer = grown;
    }

    private BoundedNdjsonException Fail(string code, string message, int byteCount)
    {
        _failed = true;
        return new BoundedNdjsonException(code, message, byteCount);
    }

    private void ThrowIfClosed()
    {
        if (_failed)
            throw new BoundedNdjsonException("BRIDGE_FRAMER_CLOSED", "The NDJSON reader is closed.", _frameLength);
    }

    private static int ValidateLimit(int value, int absoluteMaxFrameBytes)
    {
        if (value < 1 || value > absoluteMaxFrameBytes)
            throw new ArgumentOutOfRangeException(nameof(value), "NDJSON frame limit is outside the absolute bound.");
        return value;
    }

    public void Dispose()
    {
        if (_frameBuffer.Length != 0)
        {
            ArrayPool<byte>.Shared.Return(_frameBuffer);
            _frameBuffer = Array.Empty<byte>();
        }
        _failed = true;
        _ended = true;
        if (!LeaveOpen)
        {
            _stream?.Dispose();
            _textReader?.Dispose();
        }
    }
}

internal sealed class BoundedNdjsonException : IOException
{
    public BoundedNdjsonException(string code, string message, int byteCount)
        : base(message)
    {
        Code = code;
        ByteCount = byteCount;
    }

    public string Code { get; }
    public int ByteCount { get; }
}
