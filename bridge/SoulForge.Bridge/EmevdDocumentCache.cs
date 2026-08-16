using System.Collections.Concurrent;
using System.IO;
using System.Threading;

/// <summary>
/// EMEVD 文档会话缓存（event-common-load.md §5A，最大头）。
///
/// 现状问题：`read-emevd-document` 每次指令分页都重新
/// `DcxNativeDocument.Read`（读盘 + 解 DCX）+ `EmevdNativeDocument.Read`
/// （整份解析）。common.emevd.dcx 约 33k 条指令 = 65 页，一页一次整文件
/// 解析，用户点开事件域就卡死。
///
/// 本缓存保证**同一份文件（realpath + mtime + length 不变）只解压/解析一次**：
///  - 命中：直接切内存页（ToEnvelope 是纯 Skip/Take，不再触盘）；
///  - 未命中：解压 + 解析一次入缓存；
///  - 写回（write-emevd）成功：按路径失效，下一次重读重新解析（写回后的
///    重读另计，完成标准第 4 条）。
///
/// 计数钩子（仅 debug / 测试钩子，event-common-load.md §9「测 A」）：
/// `DcxReadCount` / `EmevdReadCount` 是进程级累计计数，read-emevd-document
/// 带 `reportReadCounts` 时随 diagnostics 返回，供「同一 hash 连续 10 页
/// Read 仍为 1」的断言读取。守护进程是每请求 new BridgeCommandService，
/// 缓存必须静态持有才能跨请求命中。
/// </summary>
internal static class EmevdDocumentCache
{
    /// <summary>测试/调试钩子：`DcxNativeDocument.Read` 累计调用次数。 */
    public static int DcxReadCount;
    /// <summary>测试/调试钩子：`EmevdNativeDocument.Read` 累计调用次数。 */
    public static int EmevdReadCount;

    /// <summary>测试/调试钩子：`Invalidate` 累计调用次数（写回失效是否真发生）。 */
    public static int InvalidationCount;

    private sealed class Entry
    {
        public required EmevdNativeDocument Document;
        public required string SourceFormat;
        public required string? OuterFileHash;
    }

    private static readonly ConcurrentDictionary<string, Entry> Entries = new(StringComparer.Ordinal);

    /// <summary>缓存键：realpath + mtime(ticks) + length。mtime/大小变即换键，
    /// 旧键自然淘汰（缓存容量有界，见下文 Evict）。 */
    private static string FileKey(string path)
    {
        var full = Path.GetFullPath(path);
        FileInfo info;
        try
        {
            info = new FileInfo(full);
        }
        catch (IOException)
        {
            return $"{full}|0|0";
        }
        return $"{full}|{(info.Exists ? info.LastWriteTimeUtc.Ticks : 0)}|{info.Length}";
    }

    /// <summary>
    /// 取文档：未命中时解压 + 解析一次并计数（钩子），命中时零触盘。
    /// 缓存容量：common 级文件约 0.5–2 MB 解析结果，按 4 份上限淘汰最旧，
    /// 防止「两份 common + 若干地图」把守护进程内存打爆。
    /// </summary>
    public static (EmevdNativeDocument Document, string SourceFormat, string? OuterFileHash) GetOrRead(
        string path, string? oodleRuntimeRoot)
    {
        var key = FileKey(path);
        if (Entries.TryGetValue(key, out var entry))
            return (entry.Document, entry.SourceFormat, entry.OuterFileHash);

        string sourceFormat;
        string? outerFileHash;
        EmevdNativeDocument document;
        if (BridgeCommandService.IsDcxFile(path))
        {
            var dcx = DcxNativeDocument.Read(path, oodleRuntimeRoot);
            Interlocked.Increment(ref DcxReadCount);
            document = EmevdNativeDocument.Read(dcx.Payload);
            Interlocked.Increment(ref EmevdReadCount);
            sourceFormat = "dcx";
            outerFileHash = dcx.SourceHash;
        }
        else
        {
            document = EmevdNativeDocument.ReadFile(path);
            Interlocked.Increment(ref EmevdReadCount);
            sourceFormat = "emevd";
            outerFileHash = document.SourceHash;
        }

        // 容量上限：4 份后淘汰最早插入的条目（有界缓存，防止长期驻留泄漏）。
        // ConcurrentDictionary 的枚举序不保证插入序，但淘汰目标只要「任一旧
        // 条目」即可——多份 common 轮流打开时旧键也会被 mtime 换键自然淘汰。
        if (Entries.Count >= 4)
        {
            var victim = Entries.Keys.FirstOrDefault();
            if (victim is not null) Entries.TryRemove(victim, out _);
        }
        Entries[key] = new Entry { Document = document, SourceFormat = sourceFormat, OuterFileHash = outerFileHash };
        return (document, sourceFormat, outerFileHash);
    }

    /// <summary>写回成功后按文件失效（写回后的重读重新解析，另计）。 */
    public static void Invalidate(string path)
    {
        Interlocked.Increment(ref InvalidationCount);
        var full = Path.GetFullPath(path);
        foreach (var key in Entries.Keys)
        {
            if (key.StartsWith(full + "|", StringComparison.Ordinal))
                Entries.TryRemove(key, out _);
        }
    }

    /// <summary>测试/调试钩子：清空全部缓存（写回后的重读另计验证用）。 */
    public static void Clear()
    {
        Entries.Clear();
    }

    /// <summary>测试/调试钩子复位（只在测试进程使用；生产路径不调用）。 */
    public static void ResetCounters()
    {
        Interlocked.Exchange(ref DcxReadCount, 0);
        Interlocked.Exchange(ref EmevdReadCount, 0);
    }
}
