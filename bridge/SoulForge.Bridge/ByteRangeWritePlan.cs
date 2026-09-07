using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;

/// <summary>
/// 表示受控修改的有限字节区间 (SF-11 §2.6.3)。
/// 仅保存原文件的有限预映像 pre-image (OldBytes) 与待写入后映像 post-image (NewBytes)。
/// </summary>
internal sealed class WriteInterval
{
    public int Offset { get; }
    public int Length { get; }
    public byte[] OldBytes { get; }
    public byte[] NewBytes { get; set; }
    public string Owner { get; }
    public int OperationCount { get; set; }
    public List<string> Operations { get; } = new();

    public WriteInterval(int offset, byte[] oldBytes, byte[] newBytes, string owner, string opDesc)
    {
        Offset = offset;
        Length = newBytes.Length;
        OldBytes = oldBytes;
        NewBytes = newBytes;
        Owner = owner;
        OperationCount = 1;
        Operations.Add(opDesc);
    }
}

/// <summary>
/// 表示写入尾部的追加数据块 (SF-11 §2.6.3)。
/// </summary>
internal sealed class AppendBlock
{
    public int Offset { get; }
    public byte[] Bytes { get; }
    public string Owner { get; }
    public int Alignment { get; }
    public string Hash { get; }

    public AppendBlock(int offset, byte[] bytes, string owner, int alignment, string hash)
    {
        Offset = offset;
        Bytes = bytes;
        Owner = owner;
        Alignment = alignment;
        Hash = hash;
    }
}

/// <summary>
/// 不可变基线 + 离散修改区间 + 尾部追加块计划 (SF-11 §2.6.3 / §2.6.4)。
/// 保证内存复杂度降为 O(B + A + W + M)，彻底消除全文件克隆复制。
/// </summary>
internal sealed class ByteRangeWritePlan
{
    private readonly byte[] _baseline;
    private readonly Dictionary<int, WriteInterval> _intervals = new();
    private readonly List<AppendBlock> _appends = new();
    private int _currentAppendOffset;

    public ByteRangeWritePlan(byte[] baseline)
    {
        _baseline = baseline ?? throw new ArgumentNullException(nameof(baseline));
        _currentAppendOffset = baseline.Length;
    }

    public byte[] SourceBaseline => _baseline;
    public int CurrentAppendOffset => _currentAppendOffset;
    public IReadOnlyDictionary<int, WriteInterval> Intervals => _intervals;
    public IReadOnlyList<AppendBlock> Appends => _appends;

    /// <summary>
    /// 添加或更新修改区间。相同区间支持顺序合成，非法部分重叠直接报错冲突。
    /// </summary>
    public void AddOrUpdateInterval(int offset, byte[] newBytes, string owner, string opDesc)
    {
        if (offset < 0 || offset + newBytes.Length > _baseline.Length)
            throw new InvalidDataException($"修改区间 [{offset}..{offset + newBytes.Length}) 超出基线范围 [0..{_baseline.Length})。");

        if (_intervals.TryGetValue(offset, out var existing))
        {
            if (existing.Length != newBytes.Length)
                throw new InvalidDataException($"区间长度不一致冲突: 偏移 {offset} 原长度 {existing.Length}，新长度 {newBytes.Length}。");

            existing.NewBytes = (byte[])newBytes.Clone();
            existing.OperationCount++;
            existing.Operations.Add(opDesc);
            return;
        }

        // 检查与已有区间是否发生部分非对齐重叠
        foreach (var kvp in _intervals)
        {
            var otherStart = kvp.Key;
            var otherEnd = otherStart + kvp.Value.Length;
            var thisStart = offset;
            var thisEnd = offset + newBytes.Length;

            if (Math.Max(thisStart, otherStart) < Math.Min(thisEnd, otherEnd))
            {
                throw new InvalidDataException(
                    $"未知重叠冲突: 区间 [{thisStart}..{thisEnd}) 与已有区间 [{otherStart}..{otherEnd}) 发生重叠。");
            }
        }

        var oldBytes = _baseline.AsSpan(offset, newBytes.Length).ToArray();
        _intervals[offset] = new WriteInterval(offset, oldBytes, (byte[])newBytes.Clone(), owner, opDesc);
    }

    /// <summary>
    /// 追加数据块。按指定对齐填充并在单次分配前预计算绝对偏移。
    /// </summary>
    public int Append(byte[] data, string owner, int alignment = 1)
    {
        if (data == null || data.Length == 0) return _currentAppendOffset;

        if (alignment > 1)
        {
            var rem = _currentAppendOffset % alignment;
            if (rem != 0)
            {
                var pad = alignment - rem;
                var padBytes = new byte[pad];
                var padOffset = _currentAppendOffset;
                var padHash = Convert.ToHexString(SHA256.HashData(padBytes)).ToLowerInvariant();
                _appends.Add(new AppendBlock(padOffset, padBytes, $"{owner}:align_pad", alignment, padHash));
                _currentAppendOffset += pad;
            }
        }

        var offset = _currentAppendOffset;
        var hash = Convert.ToHexString(SHA256.HashData(data)).ToLowerInvariant();
        _appends.Add(new AppendBlock(offset, (byte[])data.Clone(), owner, alignment, hash));
        _currentAppendOffset += data.Length;
        return offset;
    }

    /// <summary>
    /// 获取按偏移排序并确认无重叠的修改区间集合 (复杂度 O(M log M))。
    /// </summary>
    public List<WriteInterval> GetSortedMergedIntervals()
    {
        var sorted = _intervals.Values.OrderBy(i => i.Offset).ToList();
        for (var i = 0; i < sorted.Count - 1; i++)
        {
            if (sorted[i].Offset + sorted[i].Length > sorted[i + 1].Offset)
            {
                throw new InvalidDataException(
                    $"区间重叠冲突: [{sorted[i].Offset}..{sorted[i].Offset + sorted[i].Length}) 与 [{sorted[i + 1].Offset}..)");
            }
        }
        return sorted;
    }

    /// <summary>
    /// 单次分配最终输出缓冲区并应用全部区间与追加块 (O(B+A))。
    /// </summary>
    public byte[] Apply()
    {
        var output = new byte[_currentAppendOffset];
        // 1. 拷贝原始基线
        Buffer.BlockCopy(_baseline, 0, output, 0, _baseline.Length);

        // 2. 覆写修改区间
        foreach (var interval in _intervals.Values)
        {
            Buffer.BlockCopy(interval.NewBytes, 0, output, interval.Offset, interval.Length);
        }

        // 3. 写入追加块
        foreach (var append in _appends)
        {
            Buffer.BlockCopy(append.Bytes, 0, output, append.Offset, append.Bytes.Length);
        }

        return output;
    }

    /// <summary>
    /// 流式校验未触及区间与追加块 (SF-11 §2.6.4)。
    /// </summary>
    public void VerifyStreamingUntouched(byte[] output)
    {
        if (output.Length != _currentAppendOffset)
            throw new InvalidDataException($"输出大小 {output.Length} 与计划大小 {_currentAppendOffset} 不一致。");

        var sortedIntervals = GetSortedMergedIntervals();
        var cursor = 0;

        foreach (var interval in sortedIntervals)
        {
            // 比对 [cursor..interval.Offset) 的非修改区间
            while (cursor < interval.Offset)
            {
                if (output[cursor] != _baseline[cursor])
                {
                    throw new InvalidDataException($"未触及区间在偏移 0x{cursor:X} 发生非预期变更: 实际 0x{output[cursor]:X2} ≠ 基线 0x{_baseline[cursor]:X2}。");
                }
                cursor++;
            }

            // 校验修改区间内容
            if (!output.AsSpan(interval.Offset, interval.Length).SequenceEqual(interval.NewBytes))
            {
                throw new InvalidDataException($"修改区间 0x{interval.Offset:X} 内容未按计划写入。");
            }

            cursor = interval.Offset + interval.Length;
        }

        // 比对最后一个区间到基线末尾的内容
        while (cursor < _baseline.Length)
        {
            if (output[cursor] != _baseline[cursor])
            {
                throw new InvalidDataException($"未触及区间在偏移 0x{cursor:X} 发生非预期变更: 实际 0x{output[cursor]:X2} ≠ 基线 0x{_baseline[cursor]:X2}。");
            }
            cursor++;
        }

        // 校验追加块
        foreach (var append in _appends)
        {
            if (!output.AsSpan(append.Offset, append.Bytes.Length).SequenceEqual(append.Bytes))
            {
                throw new InvalidDataException($"追加块 0x{append.Offset:X} (所有者: {append.Owner}) 内容损坏。");
            }
            var hash = Convert.ToHexString(SHA256.HashData(output.AsSpan(append.Offset, append.Bytes.Length))).ToLowerInvariant();
            if (hash != append.Hash)
            {
                throw new InvalidDataException($"追加块 0x{append.Offset:X} 哈希校验不匹配。");
            }
        }
    }
}
