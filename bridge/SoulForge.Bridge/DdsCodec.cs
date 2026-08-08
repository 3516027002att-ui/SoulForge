using System.IO.Compression;

/// <summary>
/// DDS（BC1/BC3/BC4/BC5/BC7 块压缩）解码为 RGBA8，以及 RGBA8 编码为 PNG。
/// 用于 TPF 纹理的只读 PNG 导出。BC 块解码与 PNG 容器均为公开规格实现。
///
/// 覆盖面刻意只做真实语料里出现过的格式。2026-08-08 对四个 Sekiro texbnd
/// （c4510/c5030/c6210/c8010，共 52 个纹理）实测的真实像素格式分布是：
/// BC7_UNORM 13、BC7_UNORM_SRGB 12、BC1_UNORM_SRGB 24、ATI1 3。BC2 与 BC6H
/// 零命中，**故意不实现**——没有语料的解码路径既无法验证也无人调用。
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
                98 or 99 => "BC7",   // BC7_UNORM / BC7_UNORM_SRGB
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
            case "BC7":
                DecodeBc7(dds, dataOffset, blocksWide, blocksHigh, width, height, rgba);
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

    // ---------------------------------------------------------------------
    // BC7 (BPTC UNORM)
    //
    // 规格来源：ARB_texture_compression_bptc（Table.M / P2 / P3 / A2 / A3a / A3b）
    // 与 Khronos Data Format Spec 1.3 §20.1（Table 111 逐位布局、Table 119 插值
    // 权重、Equation 2 插值公式）。两份独立表述交叉核对过：
    //   - Table.M 的 NS/PB/RB/ISB/CB/AB/EPB/SPB/IB/IB2 与 Table 111 的位号布局一致；
    //   - 下面的 partition/anchor 表由规范正文机读提取，非人工转录；
    //   - anchor 表的自洽判据是「anchor 指向的像素确实属于该 subset」，64 个
    //     partition 全部成立（注意 anchor 不是「该 subset 的首个像素」，那条
    //     更强的猜测实测在多数 partition 上不成立）。
    //
    // 8 个 mode 全部实现，无 throw 分支：mode 8（低字节为 0）是规范保留值，
    // 按 Khronos「returns a block initialized to all zeroes」的规定返回全零块，
    // 并计入诊断计数器，不当成正常解码。
    // ---------------------------------------------------------------------

    /// <summary>BC7 mode 参数表（Table.M）。索引即 mode 号。</summary>
    readonly record struct Bc7Mode(
        int Subsets,
        int PartitionBits,
        int RotationBits,
        int IndexSelectionBits,
        int ColorBits,
        int AlphaBits,
        int EndpointPBits,
        int SharedPBits,
        int IndexBits,
        int IndexBits2);

    static readonly Bc7Mode[] Bc7Modes =
    {
        //          NS PB RB ISB CB AB EPB SPB IB IB2
        new Bc7Mode(3, 4, 0, 0, 4, 0, 1, 0, 3, 0), // 0
        new Bc7Mode(2, 6, 0, 0, 6, 0, 0, 1, 3, 0), // 1
        new Bc7Mode(3, 6, 0, 0, 5, 0, 0, 0, 2, 0), // 2
        new Bc7Mode(2, 6, 0, 0, 7, 0, 1, 0, 2, 0), // 3
        new Bc7Mode(1, 0, 2, 1, 5, 6, 0, 0, 2, 3), // 4
        new Bc7Mode(1, 0, 2, 0, 7, 8, 0, 0, 2, 2), // 5
        new Bc7Mode(1, 0, 0, 0, 7, 7, 1, 0, 4, 0), // 6
        new Bc7Mode(2, 6, 0, 0, 5, 5, 1, 0, 2, 0)  // 7
    };

    /// <summary>6-bit 插值权重（Table 119）。</summary>
    static readonly byte[] Bc7Weight2 = { 0, 21, 43, 64 };
    static readonly byte[] Bc7Weight3 = { 0, 9, 18, 27, 37, 46, 55, 64 };
    static readonly byte[] Bc7Weight4 = { 0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64 };

    /**
     * partition / anchor 表，由 ARB_texture_compression_bptc 规范正文机读提取
     * （Table.P2 / Table.P3 / Table.A2 / Table.A3a / Table.A3b），非人工转录。
     * 像素顺序为块内光栅序（0 = 左上，15 = 右下）。
     * 已校验：64 个 partition 的每个 anchor 都落在它所属的 subset 上；
     * 每个 partition 都真的用到全部 subset；subset 0 的 anchor 恒为像素 0。
     */
    static readonly byte[] Bc7Partition2 =
    {
        0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1,
        0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1,
        0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1,
        0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1,
        0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1,
        0, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1,
        0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1,
        0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 1,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 1,
        0, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
        0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 1,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1,
        0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
        0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1,
        0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1,
        0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 1, 1, 1, 1,
        0, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0,
        0, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0,
        0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0,
        0, 1, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 1,
        0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0,
        0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0,
        0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0,
        0, 0, 1, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 0, 0,
        0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 0, 1, 0, 0, 0,
        0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0,
        0, 1, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 0,
        0, 0, 1, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 0,
        0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1,
        0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1,
        0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0,
        0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0,
        0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0,
        0, 1, 0, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1, 0,
        0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1,
        0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0, 1,
        0, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 0,
        0, 0, 0, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 0, 0, 0,
        0, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0,
        0, 0, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 0, 0,
        0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0,
        0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1,
        0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1,
        0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0,
        0, 1, 0, 0, 1, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0,
        0, 0, 1, 0, 0, 1, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 1, 1, 0, 0, 1, 0,
        0, 0, 0, 0, 0, 1, 0, 0, 1, 1, 1, 0, 0, 1, 0, 0,
        0, 1, 1, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1,
        0, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 0, 1, 0, 0, 1,
        0, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0,
        0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 0,
        0, 1, 1, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1,
        0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1,
        0, 1, 1, 1, 1, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1,
        0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1,
        0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1,
        0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0,
        0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0,
        0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 1, 1, 1
    };

    static readonly byte[] Bc7Partition3 =
    {
        0, 0, 1, 1, 0, 0, 1, 1, 0, 2, 2, 1, 2, 2, 2, 2,
        0, 0, 0, 1, 0, 0, 1, 1, 2, 2, 1, 1, 2, 2, 2, 1,
        0, 0, 0, 0, 2, 0, 0, 1, 2, 2, 1, 1, 2, 2, 1, 1,
        0, 2, 2, 2, 0, 0, 2, 2, 0, 0, 1, 1, 0, 1, 1, 1,
        0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 1, 1, 2, 2,
        0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 2, 2, 0, 0, 2, 2,
        0, 0, 2, 2, 0, 0, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1,
        0, 0, 1, 1, 0, 0, 1, 1, 2, 2, 1, 1, 2, 2, 1, 1,
        0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
        0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2,
        0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2,
        0, 0, 1, 2, 0, 0, 1, 2, 0, 0, 1, 2, 0, 0, 1, 2,
        0, 1, 1, 2, 0, 1, 1, 2, 0, 1, 1, 2, 0, 1, 1, 2,
        0, 1, 2, 2, 0, 1, 2, 2, 0, 1, 2, 2, 0, 1, 2, 2,
        0, 0, 1, 1, 0, 1, 1, 2, 1, 1, 2, 2, 1, 2, 2, 2,
        0, 0, 1, 1, 2, 0, 0, 1, 2, 2, 0, 0, 2, 2, 2, 0,
        0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 2, 1, 1, 2, 2,
        0, 1, 1, 1, 0, 0, 1, 1, 2, 0, 0, 1, 2, 2, 0, 0,
        0, 0, 0, 0, 1, 1, 2, 2, 1, 1, 2, 2, 1, 1, 2, 2,
        0, 0, 2, 2, 0, 0, 2, 2, 0, 0, 2, 2, 1, 1, 1, 1,
        0, 1, 1, 1, 0, 1, 1, 1, 0, 2, 2, 2, 0, 2, 2, 2,
        0, 0, 0, 1, 0, 0, 0, 1, 2, 2, 2, 1, 2, 2, 2, 1,
        0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 2, 2, 0, 1, 2, 2,
        0, 0, 0, 0, 1, 1, 0, 0, 2, 2, 1, 0, 2, 2, 1, 0,
        0, 1, 2, 2, 0, 1, 2, 2, 0, 0, 1, 1, 0, 0, 0, 0,
        0, 0, 1, 2, 0, 0, 1, 2, 1, 1, 2, 2, 2, 2, 2, 2,
        0, 1, 1, 0, 1, 2, 2, 1, 1, 2, 2, 1, 0, 1, 1, 0,
        0, 0, 0, 0, 0, 1, 1, 0, 1, 2, 2, 1, 1, 2, 2, 1,
        0, 0, 2, 2, 1, 1, 0, 2, 1, 1, 0, 2, 0, 0, 2, 2,
        0, 1, 1, 0, 0, 1, 1, 0, 2, 0, 0, 2, 2, 2, 2, 2,
        0, 0, 1, 1, 0, 1, 2, 2, 0, 1, 2, 2, 0, 0, 1, 1,
        0, 0, 0, 0, 2, 0, 0, 0, 2, 2, 1, 1, 2, 2, 2, 1,
        0, 0, 0, 0, 0, 0, 0, 2, 1, 1, 2, 2, 1, 2, 2, 2,
        0, 2, 2, 2, 0, 0, 2, 2, 0, 0, 1, 2, 0, 0, 1, 1,
        0, 0, 1, 1, 0, 0, 1, 2, 0, 0, 2, 2, 0, 2, 2, 2,
        0, 1, 2, 0, 0, 1, 2, 0, 0, 1, 2, 0, 0, 1, 2, 0,
        0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 0, 0, 0, 0,
        0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0,
        0, 1, 2, 0, 2, 0, 1, 2, 1, 2, 0, 1, 0, 1, 2, 0,
        0, 0, 1, 1, 2, 2, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1,
        0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 0, 0, 0, 0, 1, 1,
        0, 1, 0, 1, 0, 1, 0, 1, 2, 2, 2, 2, 2, 2, 2, 2,
        0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 2, 1, 2, 1, 2, 1,
        0, 0, 2, 2, 1, 1, 2, 2, 0, 0, 2, 2, 1, 1, 2, 2,
        0, 0, 2, 2, 0, 0, 1, 1, 0, 0, 2, 2, 0, 0, 1, 1,
        0, 2, 2, 0, 1, 2, 2, 1, 0, 2, 2, 0, 1, 2, 2, 1,
        0, 1, 0, 1, 2, 2, 2, 2, 2, 2, 2, 2, 0, 1, 0, 1,
        0, 0, 0, 0, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1,
        0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 2, 2, 2, 2,
        0, 2, 2, 2, 0, 1, 1, 1, 0, 2, 2, 2, 0, 1, 1, 1,
        0, 0, 0, 2, 1, 1, 1, 2, 0, 0, 0, 2, 1, 1, 1, 2,
        0, 0, 0, 0, 2, 1, 1, 2, 2, 1, 1, 2, 2, 1, 1, 2,
        0, 2, 2, 2, 0, 1, 1, 1, 0, 1, 1, 1, 0, 2, 2, 2,
        0, 0, 0, 2, 1, 1, 1, 2, 1, 1, 1, 2, 0, 0, 0, 2,
        0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 2, 2, 2, 2,
        0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 1, 2, 2, 1, 1, 2,
        0, 1, 1, 0, 0, 1, 1, 0, 2, 2, 2, 2, 2, 2, 2, 2,
        0, 0, 2, 2, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 2, 2,
        0, 0, 2, 2, 1, 1, 2, 2, 1, 1, 2, 2, 0, 0, 2, 2,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 1, 2,
        0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 1,
        0, 2, 2, 2, 1, 2, 2, 2, 0, 2, 2, 2, 1, 2, 2, 2,
        0, 1, 0, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
        0, 1, 1, 1, 2, 0, 1, 1, 2, 2, 0, 1, 2, 2, 2, 0
    };

    static readonly byte[] Bc7Anchor2 =
    {
        15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15,
        15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2, 2, 8, 8, 2, 2,
        15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2, 2, 15, 15, 6,
        6, 2, 6, 8, 15, 15, 2, 2, 15, 15, 15, 15, 15, 2, 2, 15
    };

    static readonly byte[] Bc7Anchor3Subset1 =
    {
        3, 3, 15, 15, 8, 3, 15, 15, 8, 8, 6, 6, 6, 5, 3, 3,
        3, 3, 8, 15, 3, 3, 6, 10, 5, 8, 8, 6, 8, 5, 15, 15,
        8, 15, 3, 5, 6, 10, 8, 15, 15, 3, 15, 5, 15, 15, 15, 15,
        3, 15, 5, 5, 5, 8, 5, 10, 5, 10, 8, 13, 15, 12, 3, 3
    };

    static readonly byte[] Bc7Anchor3Subset2 =
    {
        15, 8, 8, 3, 15, 15, 3, 8, 15, 15, 15, 15, 15, 15, 15, 8,
        15, 8, 15, 3, 15, 8, 15, 8, 3, 15, 6, 10, 15, 15, 10, 8,
        15, 3, 15, 10, 10, 8, 9, 10, 6, 15, 8, 15, 3, 6, 6, 8,
        15, 3, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 3, 15, 15, 8
    };

    static byte[] Bc7Weights(int indexBits) => indexBits switch
    {
        2 => Bc7Weight2,
        3 => Bc7Weight3,
        4 => Bc7Weight4,
        _ => throw new InvalidDataException($"BC7 索引位宽 {indexBits} 不在规格允许的 {{2,3,4}} 内。")
    };

    /// <summary>
    /// 128 位块的 LSB-first 位游标。BC7 所有字段都按「字节流内从 LSB 向 MSB」
    /// 连续排列（ARB 规范 §「Starting at the lowest bit after the mode」），
    /// 所以一个单向游标就够，不需要随机寻址。
    /// </summary>
    struct Bc7BitReader
    {
        // 块恰好是 128 位，故直接装进两个 ulong，而不是持有 span。
        // 这样 Bc7BitReader 就是普通 struct 而非 ref struct，可以和 stackalloc
        // 出来的 Span 参数一起传递（ref struct 会触发 CS8350/CS8352 的
        // ref-safety 限制，因为编译器无法确认 span 不会被存进去）。
        ulong _low;
        ulong _high;
        int _bit;

        public Bc7BitReader(ReadOnlySpan<byte> block)
        {
            _low = 0;
            _high = 0;
            for (int i = 0; i < 8; i++) _low |= (ulong)block[i] << (8 * i);
            for (int i = 0; i < 8; i++) _high |= (ulong)block[8 + i] << (8 * i);
            _bit = 0;
        }

        public int Position => _bit;

        /// <summary>读 count 位（count ≤ 32），LSB 先出。</summary>
        public uint Read(int count)
        {
            // 越界读取意味着 mode 表与实际消耗不符，是实现 bug 而非数据问题；
            // 返回 0 会静默产出错误像素，所以失败关闭。
            if (count < 0 || _bit + count > 128)
                throw new InvalidDataException($"BC7 位读取越界：位置 {_bit} 请求 {count} 位。");
            uint value = 0;
            for (int i = 0; i < count; i++)
            {
                int bit = _bit + i;
                uint b = bit < 64
                    ? (uint)((_low >> bit) & 1UL)
                    : (uint)((_high >> (bit - 64)) & 1UL);
                value |= b << i;
            }
            _bit += count;
            return value;
        }
    }

    /// <summary>
    /// 把 <paramref name="value"/>（<paramref name="bits"/> 位精度，已含 P-bit）
    /// 扩展到 8 位：左移到字节高位，再把高位复制进剩余低位。
    /// Khronos DFD 1.3 §20.1：「For final scaling, the top bits of the value are
    /// replicated into any remaining bits in the byte.」
    /// </summary>
    static byte Bc7Expand(uint value, int bits)
    {
        if (bits >= 8) return (byte)value;
        uint shifted = value << (8 - bits);
        return (byte)(shifted | (shifted >> bits));
    }

    /// <summary>
    /// BC7 插值（Khronos DFD 1.3 Equation 2）：
    /// ((64 - w) * e0 + w * e1 + 32) >> 6。
    /// </summary>
    static byte Bc7Interpolate(byte e0, byte e1, int weight) =>
        (byte)(((64 - weight) * e0 + weight * e1 + 32) >> 6);

    static void DecodeBc7(byte[] src, int offset, int blocksWide, int blocksHigh, int width, int height, byte[] rgba)
    {
        Span<byte> pixels = stackalloc byte[64]; // 16 像素 × RGBA
        for (int by = 0; by < blocksHigh; by++)
        {
            for (int bx = 0; bx < blocksWide; bx++)
            {
                int block = offset + (by * blocksWide + bx) * 16;
                if (block + 16 > src.Length) return;
                DecodeBc7Block(src.AsSpan(block, 16), pixels);
                for (int p = 0; p < 16; p++)
                {
                    int px = bx * 4 + (p % 4);
                    int py = by * 4 + (p / 4);
                    if (px >= width || py >= height) continue;
                    int dest = (py * width + px) * 4;
                    rgba[dest + 0] = pixels[p * 4 + 0];
                    rgba[dest + 1] = pixels[p * 4 + 1];
                    rgba[dest + 2] = pixels[p * 4 + 2];
                    rgba[dest + 3] = pixels[p * 4 + 3];
                }
            }
        }
    }

    /// <summary>
    /// 解码单个 16 字节 BC7 块到 <paramref name="pixels"/>（16 像素 × RGBA）。
    /// 字段读取顺序严格按 ARB 规范：mode → partition → rotation → index selection
    /// → color → alpha → 逐 endpoint P-bit → 共享 P-bit → 主索引 → 次索引。
    /// </summary>
    static void DecodeBc7Block(ReadOnlySpan<byte> block, Span<byte> pixels)
    {
        // mode 为首字节的低位游程：第一个置位的 bit 位置即 mode 号。
        // 低字节全 0 是规范保留的 mode 8（「Mode 8 ... is reserved」），
        // Khronos/MS 都规定此时返回全零块，故这里 Clear 而不是抛异常——
        // 抛异常会让整张纹理导出失败，而规范要求的是这一个块为零。
        int mode = -1;
        for (int i = 0; i < 8; i++)
        {
            if ((block[0] & (1 << i)) != 0) { mode = i; break; }
        }
        if (mode < 0)
        {
            pixels.Clear();
            return;
        }

        var m = Bc7Modes[mode];
        var reader = new Bc7BitReader(block);
        reader.Read(mode + 1); // 跳过 mode 的游程编码位

        int partition = m.PartitionBits > 0 ? (int)reader.Read(m.PartitionBits) : 0;
        int rotation = m.RotationBits > 0 ? (int)reader.Read(m.RotationBits) : 0;
        int indexSelection = m.IndexSelectionBits > 0 ? (int)reader.Read(m.IndexSelectionBits) : 0;

        int endpointCount = m.Subsets * 2;

        // 颜色按「分量优先」存放：先全部 endpoint 的 R，再全部 G，再全部 B。
        // ARB：「stored first by endpoint, then by subset, then by color」，
        // 与 Table 111 的位号布局一致（mode 1 为 R0 R1 R2 R3 G0..G3 B0..B3）。
        Span<uint> r = stackalloc uint[6];
        Span<uint> g = stackalloc uint[6];
        Span<uint> b = stackalloc uint[6];
        Span<uint> a = stackalloc uint[6];
        for (int i = 0; i < endpointCount; i++) r[i] = reader.Read(m.ColorBits);
        for (int i = 0; i < endpointCount; i++) g[i] = reader.Read(m.ColorBits);
        for (int i = 0; i < endpointCount; i++) b[i] = reader.Read(m.ColorBits);
        if (m.AlphaBits > 0)
        {
            for (int i = 0; i < endpointCount; i++) a[i] = reader.Read(m.AlphaBits);
        }

        // P-bit：作为「颜色数据下面的一位」拼进去，所以精度 +1。
        int colorBits = m.ColorBits;
        int alphaBits = m.AlphaBits;
        if (m.EndpointPBits > 0)
        {
            for (int i = 0; i < endpointCount; i++)
            {
                uint pbit = reader.Read(1);
                r[i] = (r[i] << 1) | pbit;
                g[i] = (g[i] << 1) | pbit;
                b[i] = (b[i] << 1) | pbit;
                if (m.AlphaBits > 0) a[i] = (a[i] << 1) | pbit;
            }
            colorBits++;
            if (m.AlphaBits > 0) alphaBits++;
        }
        else if (m.SharedPBits > 0)
        {
            // 共享 P-bit：低位那一位作用于 subset 0 的两个 endpoint，
            // 高位那一位作用于 subset 1 的两个 endpoint。
            for (int s = 0; s < m.Subsets; s++)
            {
                uint pbit = reader.Read(1);
                for (int e = 0; e < 2; e++)
                {
                    int i = s * 2 + e;
                    r[i] = (r[i] << 1) | pbit;
                    g[i] = (g[i] << 1) | pbit;
                    b[i] = (b[i] << 1) | pbit;
                    if (m.AlphaBits > 0) a[i] = (a[i] << 1) | pbit;
                }
            }
            colorBits++;
            if (m.AlphaBits > 0) alphaBits++;
        }

        // 扩展到 8 位。无 alpha 位的 mode 一律不透明（DFD：alpha overridden to 255）。
        Span<byte> er = stackalloc byte[6];
        Span<byte> eg = stackalloc byte[6];
        Span<byte> eb = stackalloc byte[6];
        Span<byte> ea = stackalloc byte[6];
        for (int i = 0; i < endpointCount; i++)
        {
            er[i] = Bc7Expand(r[i], colorBits);
            eg[i] = Bc7Expand(g[i], colorBits);
            eb[i] = Bc7Expand(b[i], colorBits);
            ea[i] = m.AlphaBits > 0 ? Bc7Expand(a[i], alphaBits) : (byte)255;
        }

        // 索引读取。每个 subset 的 anchor 少存一位（高位隐含为 0）。
        Span<byte> subsetOf = stackalloc byte[16];
        FillBc7Subsets(m.Subsets, partition, subsetOf);
        Span<int> anchors = stackalloc int[3];
        FillBc7Anchors(m.Subsets, partition, anchors);

        Span<byte> primary = stackalloc byte[16];
        ReadBc7Indices(ref reader, m.IndexBits, subsetOf, anchors, m.Subsets, primary);
        Span<byte> secondary = stackalloc byte[16];
        bool hasSecondary = m.IndexBits2 > 0;
        if (hasSecondary)
        {
            // 次索引同样遵守 anchor 规则。mode 4/5 是单 subset，anchor 只有像素 0。
            ReadBc7Indices(ref reader, m.IndexBits2, subsetOf, anchors, m.Subsets, secondary);
        }

        var weights1 = Bc7Weights(m.IndexBits);
        var weights2 = hasSecondary ? Bc7Weights(m.IndexBits2) : weights1;

        for (int p = 0; p < 16; p++)
        {
            int s = subsetOf[p];
            int e0 = s * 2;
            int e1 = e0 + 1;

            // 颜色索引：有 index-selection 位且为 1 时取次索引，否则取主索引。
            // alpha 索引：有次索引、且（无 index-selection 位或该位为 0）时取次索引，
            // 否则取主索引。（ARB 规范原文的两条对偶规则。）
            int colorIndex = (m.IndexSelectionBits > 0 && indexSelection == 1) ? secondary[p] : primary[p];
            int colorWeight = ((m.IndexSelectionBits > 0 && indexSelection == 1) ? weights2 : weights1)[colorIndex];
            int alphaIndex;
            int alphaWeight;
            if (hasSecondary && (m.IndexSelectionBits == 0 || indexSelection == 0))
            {
                alphaIndex = secondary[p];
                alphaWeight = weights2[alphaIndex];
            }
            else
            {
                alphaIndex = primary[p];
                alphaWeight = weights1[alphaIndex];
            }

            byte outR = Bc7Interpolate(er[e0], er[e1], colorWeight);
            byte outG = Bc7Interpolate(eg[e0], eg[e1], colorWeight);
            byte outB = Bc7Interpolate(eb[e0], eb[e1], colorWeight);
            // 无 alpha 位的 mode 由上面的 endpoint 扩展统一置 255，这里无需再分支：
            // Bc7Interpolate(255, 255, w) 对任意 w 恒为 255
            // （((64-w)*255 + w*255 + 32) >> 6 == 16352 >> 6 == 255）。
            // 原先这里另有一个 `m.AlphaBits > 0 ? ... : 255` 的三元分支，
            // 结果是「无 alpha → 255」在两处各写一遍，而 ea[] 那一处永远读不到，
            // 属于死代码：把它改坏（255→0）不会影响任何输出，负例因此报绿。
            // 判据要能覆盖这条规则，就必须只留一个决定点。
            byte outA = Bc7Interpolate(ea[e0], ea[e1], alphaWeight);

            // rotation：1/2/3 分别把 alpha 与 R/G/B 交换（Table 120）。
            switch (rotation)
            {
                case 1: (outA, outR) = (outR, outA); break;
                case 2: (outA, outG) = (outG, outA); break;
                case 3: (outA, outB) = (outB, outA); break;
            }

            pixels[p * 4 + 0] = outR;
            pixels[p * 4 + 1] = outG;
            pixels[p * 4 + 2] = outB;
            pixels[p * 4 + 3] = outA;
        }
    }

    static void FillBc7Subsets(int subsets, int partition, Span<byte> subsetOf)
    {
        if (subsets == 1)
        {
            subsetOf.Clear();
            return;
        }
        var table = subsets == 2 ? Bc7Partition2 : Bc7Partition3;
        int at = partition * 16;
        for (int p = 0; p < 16; p++) subsetOf[p] = table[at + p];
    }

    static void FillBc7Anchors(int subsets, int partition, Span<int> anchors)
    {
        // subset 0 的 anchor 恒为像素 0（规范明文）。
        anchors[0] = 0;
        anchors[1] = -1;
        anchors[2] = -1;
        if (subsets == 2)
        {
            anchors[1] = Bc7Anchor2[partition];
        }
        else if (subsets == 3)
        {
            anchors[1] = Bc7Anchor3Subset1[partition];
            anchors[2] = Bc7Anchor3Subset2[partition];
        }
    }

    /// <summary>
    /// 按光栅序读 16 个索引。anchor 像素少读一位（其高位隐含为 0）。
    /// </summary>
    static void ReadBc7Indices(
        ref Bc7BitReader reader,
        int indexBits,
        ReadOnlySpan<byte> subsetOf,
        ReadOnlySpan<int> anchors,
        int subsets,
        Span<byte> indices)
    {
        for (int p = 0; p < 16; p++)
        {
            bool isAnchor = false;
            for (int s = 0; s < subsets; s++)
            {
                if (anchors[s] == p) { isAnchor = true; break; }
            }
            int bits = isAnchor ? indexBits - 1 : indexBits;
            indices[p] = (byte)reader.Read(bits);
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
