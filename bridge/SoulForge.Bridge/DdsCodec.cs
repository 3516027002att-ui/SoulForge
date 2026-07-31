using System.IO.Compression;

/// <summary>
/// DDS（BC1/BC4/BC5 块压缩）解码为 RGBA8，以及 RGBA8 编码为 PNG。
/// 用于 TPF 纹理的只读 PNG 导出。BC 块解码与 PNG 容器均为公开规格实现。
/// </summary>
internal static class DdsCodec
{
    /// <summary>从 DDS blob 解码为 RGBA8 像素（行优先，自顶向下）。返回 (width, height, rgba)。</summary>
    public static (int Width, int Height, byte[] Rgba) DecodeDds(byte[] dds)
    {
        if (dds.Length < 128 || dds[0] != (byte)'D' || dds[1] != (byte)'D' || dds[2] != (byte)'S' || dds[3] != 0x20)
            throw new InvalidDataException("不是有效的 DDS 文件。");

        int height = BitConverter.ToInt32(dds, 12);
        int width = BitConverter.ToInt32(dds, 16);
        // Pixel format fourCC at offset 0x54 (84).
        string fourCc = new string(new[]
        {
            (char)dds[84], (char)dds[85], (char)dds[86], (char)dds[87]
        });

        int blocksWide = Math.Max(1, (width + 3) / 4);
        int blocksHigh = Math.Max(1, (height + 3) / 4);
        var rgba = new byte[width * height * 4];

        // Resolve the BC format and pixel data offset. DX10 fourCC means a 20-byte
        // DXGI extended header follows the 124-byte DDS header (data starts at 148).
        string bcFormat;
        int dataOffset;
        if (fourCc == "DX10")
        {
            if (dds.Length < 148) throw new InvalidDataException("DX10 DDS 头不完整。");
            uint dxgiFormat = BitConverter.ToUInt32(dds, 128);
            bcFormat = dxgiFormat switch
            {
                71 or 72 => "BC1",   // BC1_UNORM / BC1_UNORM_SRGB
                77 => "BC3",         // BC3_UNORM
                80 => "BC4",         // BC4_UNORM
                83 => "BC5",         // BC5_UNORM
                _ => throw new NotSupportedException($"不支持的 DXGI 格式：{dxgiFormat}。")
            };
            dataOffset = 148;
        }
        else
        {
            bcFormat = fourCc switch
            {
                "DXT1" => "BC1",
                "DXT5" => "BC3",
                "ATI1" or "BC4U" => "BC4",
                "ATI2" or "BC5U" => "BC5",
                _ => throw new NotSupportedException($"不支持的 DDS 压缩格式：{fourCc}。")
            };
            dataOffset = 128;
        }

        switch (bcFormat)
        {
            case "BC1":
                DecodeBc1(dds, dataOffset, blocksWide, blocksHigh, width, height, rgba);
                break;
            case "BC3":
                DecodeBc3(dds, dataOffset, blocksWide, blocksHigh, width, height, rgba);
                break;
            case "BC4":
                DecodeBc4(dds, dataOffset, blocksWide, blocksHigh, width, height, rgba, channel: 0);
                break;
            case "BC5":
                DecodeBc5(dds, dataOffset, blocksWide, blocksHigh, width, height, rgba);
                break;
        }

        return (width, height, rgba);
    }

    /// <summary>BC3 (DXT5)：BC4 alpha 块 + BC1 颜色块（带显式 alpha）。</summary>
    static void DecodeBc3(byte[] src, int offset, int blocksWide, int blocksHigh, int width, int height, byte[] rgba)
    {
        for (int by = 0; by < blocksHigh; by++)
        {
            for (int bx = 0; bx < blocksWide; bx++)
            {
                int block = offset + (by * blocksWide + bx) * 16;
                if (block + 16 > src.Length) return;
                // First 8 bytes: alpha block (BC4-style) into channel 3.
                DecodeBc4Block(src, block, rgba, width, height, bx, by, channel: 3);
                // Next 8 bytes: BC1 color block (but keep the alpha we just wrote).
                DecodeBc1ColorOnly(src, block + 8, rgba, width, height, bx, by);
            }
        }
    }

    /// <summary>BC1 颜色解码，但保留目标已有的 alpha 通道（供 BC3 复用）。</summary>
    static void DecodeBc1ColorOnly(byte[] src, int block, byte[] rgba, int width, int height, int bx, int by)
    {
        ushort c0 = BitConverter.ToUInt16(src, block);
        ushort c1 = BitConverter.ToUInt16(src, block + 2);
        uint indices = BitConverter.ToUInt32(src, block + 4);
        Span<byte> palette = stackalloc byte[12]; // 4 colors × RGB
        Expand565Rgb(c0, palette, 0);
        Expand565Rgb(c1, palette, 3);
        if (c0 > c1)
        {
            for (int i = 0; i < 3; i++)
            {
                palette[6 + i] = (byte)((2 * palette[i] + palette[3 + i]) / 3);
                palette[9 + i] = (byte)((palette[i] + 2 * palette[3 + i]) / 3);
            }
        }
        else
        {
            for (int i = 0; i < 3; i++) palette[6 + i] = (byte)((palette[i] + palette[3 + i]) / 2);
            palette[9] = 0; palette[10] = 0; palette[11] = 0;
        }
        for (int p = 0; p < 16; p++)
        {
            int idx = (int)((indices >> (2 * p)) & 0x3);
            int px = bx * 4 + (p % 4);
            int py = by * 4 + (p / 4);
            if (px >= width || py >= height) continue;
            int dest = (py * width + px) * 4;
            rgba[dest + 0] = palette[idx * 3 + 0];
            rgba[dest + 1] = palette[idx * 3 + 1];
            rgba[dest + 2] = palette[idx * 3 + 2];
            // BC3 explicit alpha already written; for transparent index in c0<=c1 mode set 0.
            if (c0 <= c1 && idx == 3) rgba[dest + 3] = 0;
        }
    }

    static void Expand565Rgb(ushort color, Span<byte> palette, int offset)
    {
        int r = (color >> 11) & 0x1F;
        int g = (color >> 5) & 0x3F;
        int b = color & 0x1F;
        palette[offset + 0] = (byte)((r << 3) | (r >> 2));
        palette[offset + 1] = (byte)((g << 2) | (g >> 4));
        palette[offset + 2] = (byte)((b << 3) | (b >> 2));
    }

    static void DecodeBc1(byte[] src, int offset, int blocksWide, int blocksHigh, int width, int height, byte[] rgba)
    {
        for (int by = 0; by < blocksHigh; by++)
        {
            for (int bx = 0; bx < blocksWide; bx++)
            {
                int block = offset + (by * blocksWide + bx) * 8;
                if (block + 8 > src.Length) return;
                ushort c0 = BitConverter.ToUInt16(src, block);
                ushort c1 = BitConverter.ToUInt16(src, block + 2);
                uint indices = BitConverter.ToUInt32(src, block + 4);

                byte[] palette = new byte[16]; // 4 colors × RGBA
                Expand565(c0, palette, 0);
                Expand565(c1, palette, 4);
                if (c0 > c1)
                {
                    for (int i = 0; i < 3; i++)
                    {
                        palette[8 + i] = (byte)((2 * palette[i] + palette[4 + i]) / 3);
                        palette[12 + i] = (byte)((palette[i] + 2 * palette[4 + i]) / 3);
                    }
                    palette[11] = 255;
                    palette[15] = 255;
                }
                else
                {
                    for (int i = 0; i < 3; i++)
                    {
                        palette[8 + i] = (byte)((palette[i] + palette[4 + i]) / 2);
                        palette[12 + i] = 0;
                    }
                    palette[11] = 255;
                    palette[15] = 0; // transparent
                }

                WriteBlock(rgba, width, height, bx, by, palette, indices, 2);
            }
        }
    }

    static void DecodeBc4(byte[] src, int offset, int blocksWide, int blocksHigh, int width, int height, byte[] rgba, int channel)
    {
        for (int by = 0; by < blocksHigh; by++)
        {
            for (int bx = 0; bx < blocksWide; bx++)
            {
                int block = offset + (by * blocksWide + bx) * 8;
                if (block + 8 > src.Length) return;
                DecodeBc4Block(src, block, rgba, width, height, bx, by, channel);
            }
        }
    }

    static void DecodeBc5(byte[] src, int offset, int blocksWide, int blocksHigh, int width, int height, byte[] rgba)
    {
        for (int by = 0; by < blocksHigh; by++)
        {
            for (int bx = 0; bx < blocksWide; bx++)
            {
                int block = offset + (by * blocksWide + bx) * 16;
                if (block + 16 > src.Length) return;
                DecodeBc4Block(src, block, rgba, width, height, bx, by, channel: 0);     // R
                DecodeBc4Block(src, block + 8, rgba, width, height, bx, by, channel: 1); // G
            }
        }
    }

    static void DecodeBc4Block(byte[] src, int block, byte[] rgba, int width, int height, int bx, int by, int channel)
    {
        byte r0 = src[block];
        byte r1 = src[block + 1];
        Span<byte> ramp = stackalloc byte[8];
        ramp[0] = r0;
        ramp[1] = r1;
        if (r0 > r1)
        {
            for (int i = 1; i < 7; i++) ramp[i + 1] = (byte)(((7 - i) * r0 + i * r1) / 7);
        }
        else
        {
            for (int i = 1; i < 5; i++) ramp[i + 1] = (byte)(((5 - i) * r0 + i * r1) / 5);
            ramp[6] = 0;
            ramp[7] = 255;
        }

        // 6 bytes of 3-bit indices (16 pixels).
        ulong bits = 0;
        for (int i = 0; i < 6; i++) bits |= (ulong)src[block + 2 + i] << (8 * i);

        for (int p = 0; p < 16; p++)
        {
            int idx = (int)((bits >> (3 * p)) & 0x7);
            int px = bx * 4 + (p % 4);
            int py = by * 4 + (p / 4);
            if (px >= width || py >= height) continue;
            int dest = (py * width + px) * 4;
            rgba[dest + channel] = ramp[idx];
            if (channel == 0)
            {
                // BC4 grayscale: replicate to G/B and set opaque alpha.
                rgba[dest + 1] = ramp[idx];
                rgba[dest + 2] = ramp[idx];
                rgba[dest + 3] = 255;
            }
            else if (channel == 1)
            {
                // BC5 green channel (normal map): B unused, opaque alpha.
                rgba[dest + 2] = 0;
                rgba[dest + 3] = 255;
            }
            // channel == 3 (BC3 alpha): only alpha is written; RGB comes from the color block.
        }
    }

    static void Expand565(ushort color, Span<byte> palette, int offset)
    {
        int r = (color >> 11) & 0x1F;
        int g = (color >> 5) & 0x3F;
        int b = color & 0x1F;
        palette[offset + 0] = (byte)((r << 3) | (r >> 2));
        palette[offset + 1] = (byte)((g << 2) | (g >> 4));
        palette[offset + 2] = (byte)((b << 3) | (b >> 2));
        palette[offset + 3] = 255;
    }

    static void WriteBlock(byte[] rgba, int width, int height, int bx, int by, Span<byte> palette, uint indices, int bitsPerPixel)
    {
        for (int p = 0; p < 16; p++)
        {
            int idx = (int)((indices >> (bitsPerPixel * p)) & (bitsPerPixel == 2 ? 0x3 : 0x7));
            int px = bx * 4 + (p % 4);
            int py = by * 4 + (p / 4);
            if (px >= width || py >= height) continue;
            int dest = (py * width + px) * 4;
            int src = idx * 4;
            rgba[dest + 0] = palette[src + 0];
            rgba[dest + 1] = palette[src + 1];
            rgba[dest + 2] = palette[src + 2];
            rgba[dest + 3] = palette[src + 3];
        }
    }

    /// <summary>将 RGBA8 像素编码为 PNG（非隔行，8-bit RGBA）。使用 ZLibStream 压缩 IDAT。</summary>
    public static byte[] EncodePng(int width, int height, byte[] rgba)
    {
        using var output = new MemoryStream();
        // PNG signature.
        output.Write(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A });

        // IHDR.
        var ihdr = new byte[13];
        WriteInt32BigEndian(ihdr, 0, width);
        WriteInt32BigEndian(ihdr, 4, height);
        ihdr[8] = 8;  // bit depth
        ihdr[9] = 6;  // color type RGBA
        ihdr[10] = 0; // compression
        ihdr[11] = 0; // filter
        ihdr[12] = 0; // interlace
        WriteChunk(output, "IHDR", ihdr);

        // IDAT: each scanline prefixed with filter byte 0, then zlib-compressed.
        using var idatData = new MemoryStream();
        using (var zlib = new ZLibStream(idatData, CompressionLevel.Fastest, leaveOpen: true))
        {
            var filterByte = new byte[] { 0 };
            int stride = width * 4;
            for (int y = 0; y < height; y++)
            {
                zlib.Write(filterByte);
                zlib.Write(rgba, y * stride, stride);
            }
        }
        WriteChunk(output, "IDAT", idatData.ToArray());

        // IEND.
        WriteChunk(output, "IEND", Array.Empty<byte>());

        return output.ToArray();
    }

    static void WriteChunk(Stream output, string type, byte[] data)
    {
        var lengthBytes = new byte[4];
        WriteInt32BigEndian(lengthBytes, 0, data.Length);
        output.Write(lengthBytes);

        var typeBytes = new byte[4];
        for (int i = 0; i < 4; i++) typeBytes[i] = (byte)type[i];
        output.Write(typeBytes);
        output.Write(data);

        // CRC32 over type + data.
        uint crc = Crc32(typeBytes, data);
        var crcBytes = new byte[4];
        WriteInt32BigEndian(crcBytes, 0, unchecked((int)crc));
        output.Write(crcBytes);
    }

    static void WriteInt32BigEndian(byte[] buffer, int offset, int value)
    {
        buffer[offset + 0] = (byte)((value >> 24) & 0xFF);
        buffer[offset + 1] = (byte)((value >> 16) & 0xFF);
        buffer[offset + 2] = (byte)((value >> 8) & 0xFF);
        buffer[offset + 3] = (byte)(value & 0xFF);
    }

    static readonly uint[] Crc32Table = BuildCrc32Table();

    static uint[] BuildCrc32Table()
    {
        var table = new uint[256];
        for (uint n = 0; n < 256; n++)
        {
            uint c = n;
            for (int k = 0; k < 8; k++)
                c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
            table[n] = c;
        }
        return table;
    }

    static uint Crc32(byte[] typeBytes, byte[] data)
    {
        uint crc = 0xFFFFFFFFu;
        foreach (byte b in typeBytes) crc = Crc32Table[(crc ^ b) & 0xFF] ^ (crc >> 8);
        foreach (byte b in data) crc = Crc32Table[(crc ^ b) & 0xFF] ^ (crc >> 8);
        return crc ^ 0xFFFFFFFFu;
    }
}
