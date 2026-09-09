using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

/// <summary>
/// Tri-state action for row name mutation:
/// - Keep: omit name property; existing name and raw encoded bytes are preserved verbatim.
/// - Clear: explicit null; name is removed.
/// - Set: explicit string (empty or non-empty); name is updated.
/// </summary>
internal enum ParamNameAction
{
    Keep,
    Clear,
    Set
}

/// <summary>
/// Ordered semantic post-image projection for a single row in the simulated PARAM.
/// Used for slot-by-slot independent verification against re-read native bytes.
/// </summary>
internal sealed record ParamFinalRowProjection(
    int Id,
    string? Name,
    byte[] Data,
    string DataHash,
    byte[]? NameBytes,
    string? NameEncoding,
    int OriginalNameOffset = 0,
    int OriginalDataOffset = 0);

/// <summary>
/// Patch describing a single PARAM row mutation.
/// </summary>
internal sealed record ParamPatch
{
    public string Kind { get; init; }
    public int Id { get; init; }
    public string? DataBase64 { get; init; }
    public string? Name { get; init; }
    public int? RowIndex { get; init; }
    public string? ExpectedDataHash { get; init; }
    public ParamNameAction NameAction { get; init; }

    public ParamPatch(
        string kind,
        int id,
        string? dataBase64 = null,
        string? name = null,
        int? rowIndex = null,
        string? expectedDataHash = null,
        ParamNameAction? nameAction = null)
    {
        Kind = kind;
        Id = id;
        DataBase64 = dataBase64;
        Name = name;
        RowIndex = rowIndex;
        ExpectedDataHash = expectedDataHash;
        NameAction = nameAction ?? (name != null ? ParamNameAction.Set : ParamNameAction.Keep);
    }
}

/// <summary>
/// Two-pass mutation planner and final state simulator for PARAM documents.
/// Pass 1: Binds mutations to immutable snapshot handles and validates expectedId,
/// expectedDataHash, row index bounds, and layout constraints (fail-fast, zero disk staging).
/// Pass 2: Simulates mutations on working copy, preserves binder order, resolves multiple
/// sequential updates to same handle, tracks deleted handles, and constructs the exact
/// ordered expected projection for post-rebuild verification.
/// </summary>
internal sealed class ParamMutationPlan
{
    public ParamNativeDocument Document { get; }
    public IReadOnlyList<ParamPatch> Mutations { get; }
    public IReadOnlyList<ParamFinalRowProjection> ExpectedProjection { get; }
    public IReadOnlyList<ParamRow> FinalRows { get; }
    public byte[] RebuiltBytes { get; }

    public ParamMutationPlan(
        ParamNativeDocument document,
        IReadOnlyList<ParamPatch> mutations,
        IReadOnlyList<ParamFinalRowProjection> expectedProjection,
        IReadOnlyList<ParamRow> finalRows,
        byte[] rebuiltBytes)
    {
        Document = document;
        Mutations = mutations;
        ExpectedProjection = expectedProjection;
        FinalRows = finalRows;
        RebuiltBytes = rebuiltBytes;
    }

    public static ParamMutationPlan Build(ParamNativeDocument document, IReadOnlyList<ParamPatch> mutations)
    {
        if (mutations == null || mutations.Count == 0)
            throw new InvalidDataException("PARAM writer 需要至少一条 mutation。");

        var rowCount = document.Rows.Count;
        var handlesById = new Dictionary<int, List<int>>();
        var originalIds = new HashSet<int>();
        for (var i = 0; i < rowCount; i++)
        {
            var r = document.Rows[i];
            if (!handlesById.TryGetValue(r.Id, out var list))
            {
                list = new List<int>();
                handlesById[r.Id] = list;
            }
            list.Add(i);
            originalIds.Add(r.Id);
        }

        // Pass 1: Bind and Validate preconditions without mutating rows.
        var boundHandles = new int?[mutations.Count];
        for (var m = 0; m < mutations.Count; m++)
        {
            var op = mutations[m];
            var kind = op.Kind.ToLowerInvariant();
            if (kind is not ("upsert" or "update" or "delete" or "add"))
                throw new InvalidDataException($"未知 PARAM mutation：{op.Kind} (ROW_OPERATION_UNSUPPORTED)。");

            if (document.Layout == ParamLayout.Standard32)
            {
                if (kind is "delete" or "add")
                    throw new InvalidDataException("PARAM 32 位布局不支持 delete/add：结构重排未经该格式变体验证。");
            }

            if (kind == "add")
            {
                if (op.DataBase64 is null)
                    throw new InvalidDataException("PARAM add 需要 dataBase64。");
                var addData = Convert.FromBase64String(op.DataBase64);
                if (addData.Length != document.RowDataSize)
                    throw new InvalidDataException($"PARAM add 行宽不匹配：expected={document.RowDataSize}，actual={addData.Length}。");
                if (originalIds.Contains(op.Id))
                    throw new InvalidDataException($"PARAM 普通 add 无法复用原 ID {op.Id}；需要 replace-row 合同 (ADD_REQUIRES_REPLACE_ROW)。");

                boundHandles[m] = null;
                continue;
            }

            // Non-add: resolve target handle against original snapshot
            int targetIndex;
            if (op.RowIndex is int rowIndex)
            {
                if (rowIndex < 0 || rowIndex >= rowCount)
                    throw new InvalidDataException($"PARAM 物理行索引 {rowIndex} 越界。");
                var targetRow = document.Rows[rowIndex];
                if (targetRow.Id != op.Id)
                    throw new InvalidDataException($"PARAM 物理行索引 {rowIndex} 的 ID 已变化：expected={op.Id}，actual={targetRow.Id} (ROW_ID_MISMATCH)。");
                if (op.ExpectedDataHash is not null)
                {
                    var actualHash = ParamNativeDocument.Hash(targetRow.Data);
                    if (!actualHash.Equals(op.ExpectedDataHash, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException($"PARAM 物理行索引 {rowIndex} 的数据哈希已变化 (ROW_PREIMAGE_MISMATCH / PARAM_ROW_HASH_MISMATCH)。");
                }
                targetIndex = rowIndex;
            }
            else
            {
                // ID-only query
                if (!handlesById.TryGetValue(op.Id, out var candidates) || candidates.Count == 0)
                {
                    if (kind == "upsert" && document.Layout != ParamLayout.Standard32)
                    {
                        // In compact layout, upsert on non-existent ID acts as add
                        targetIndex = -1;
                    }
                    else
                    {
                        throw new InvalidDataException($"PARAM 目标 ID {op.Id} 不存在 (SNAPSHOT_HANDLE_UNKNOWN / PARAM_ROW_NOT_FOUND)。");
                    }
                }
                else if (candidates.Count > 1)
                {
                    throw new InvalidDataException($"PARAM ID {op.Id} 存在重复行；mutation 必须携带 rowIndex 和 expectedDataHash (PARAM_ROW_AMBIGUOUS / PARAM_DUPLICATE_ID)。");
                }
                else
                {
                    targetIndex = candidates[0];
                    if (op.ExpectedDataHash is not null)
                    {
                        var actualHash = ParamNativeDocument.Hash(document.Rows[targetIndex].Data);
                        if (!actualHash.Equals(op.ExpectedDataHash, StringComparison.OrdinalIgnoreCase))
                            throw new InvalidDataException($"PARAM ID {op.Id} 的数据哈希已变化 (ROW_PREIMAGE_MISMATCH / PARAM_ROW_HASH_MISMATCH)。");
                    }
                }
            }

            if (document.Layout == ParamLayout.Standard32)
            {
                if (targetIndex < 0)
                    throw new InvalidDataException($"PARAM 32 位布局不支持新增行 upsert：ID {op.Id} 不存在。");
                if (op.NameAction != ParamNameAction.Keep)
                {
                    var targetRow = document.Rows[targetIndex];
                    var newName = op.NameAction == ParamNameAction.Clear ? null : op.Name;
                    if (!string.Equals(newName, targetRow.Name, StringComparison.Ordinal))
                        throw new InvalidDataException("PARAM 32 位布局不支持行名变更（字符串区按字节保留）。");
                }
            }

            if (op.DataBase64 is not null)
            {
                var data = Convert.FromBase64String(op.DataBase64);
                if (data.Length != document.RowDataSize)
                    throw new InvalidDataException($"PARAM mutation 行宽不匹配：expected={document.RowDataSize}，actual={data.Length}。");
            }

            boundHandles[m] = targetIndex;
        }

        // Pass 2: Simulation
        var workingByHandle = new Dictionary<int, WorkingParamRow>();
        var workingOrder = new List<int>();
        var deletedHandles = new HashSet<int>();
        var idCounts = new Dictionary<int, int>();

        for (var i = 0; i < rowCount; i++)
        {
            var r = document.Rows[i];
            workingByHandle[i] = new WorkingParamRow(r);
            workingOrder.Add(i);
            idCounts[r.Id] = idCounts.GetValueOrDefault(r.Id) + 1;
        }

        int nextHandle = rowCount;

        for (var m = 0; m < mutations.Count; m++)
        {
            var op = mutations[m];
            var kind = op.Kind.ToLowerInvariant();
            var bound = boundHandles[m];

            if (kind == "add" || (kind == "upsert" && bound == -1))
            {
                if (idCounts.GetValueOrDefault(op.Id) > 0)
                    throw new InvalidDataException($"PARAM 新增 ID {op.Id} 已被占用 (ADD_ID_OCCUPIED)。");
                if (originalIds.Contains(op.Id))
                    throw new InvalidDataException($"PARAM 新增 ID {op.Id} 曾在原快照中存在，需使用 replace-row 合同 (ADD_REQUIRES_REPLACE_ROW)。");

                var addData = Convert.FromBase64String(op.DataBase64!);
                var name = op.NameAction == ParamNameAction.Set ? op.Name : null;
                var h = nextHandle++;
                workingByHandle[h] = new WorkingParamRow(op.Id, addData, name);
                workingOrder.Add(h);
                idCounts[op.Id] = 1;
                continue;
            }

            int handle = bound!.Value;
            if (deletedHandles.Contains(handle))
                throw new InvalidDataException($"PARAM 目标已在先前操作中删除，无法继续修改 (TARGET_ALREADY_DELETED)。");

            if (kind == "delete")
            {
                var row = workingByHandle[handle];
                idCounts[row.Id] = idCounts[row.Id] - 1;
                workingByHandle.Remove(handle);
                deletedHandles.Add(handle);
                continue;
            }

            // update or upsert
            var target = workingByHandle[handle];
            if (op.DataBase64 is not null)
            {
                target.Data = Convert.FromBase64String(op.DataBase64);
            }
            if (op.NameAction == ParamNameAction.Clear)
            {
                target.Name = null;
                target.NameBytes = null;
            }
            else if (op.NameAction == ParamNameAction.Set)
            {
                target.Name = op.Name;
                if (!string.Equals(target.Name, target.OriginalName, StringComparison.Ordinal))
                {
                    target.NameBytes = null;
                }
            }
        }

        var finalRows = new List<ParamRow>();
        var projections = new List<ParamFinalRowProjection>();

        foreach (var h in workingOrder)
        {
            if (deletedHandles.Contains(h)) continue;
            var w = workingByHandle[h];
            var row = new ParamRow(
                w.Id,
                w.Data,
                w.Name,
                w.NameBytes,
                w.NameEncoding,
                w.OriginalNameOffset,
                w.OriginalDataOffset);
            finalRows.Add(row);
            projections.Add(new ParamFinalRowProjection(
                w.Id,
                w.Name,
                w.Data,
                ParamNativeDocument.Hash(w.Data),
                w.NameBytes,
                w.NameEncoding,
                w.OriginalNameOffset,
                w.OriginalDataOffset));
        }

        var rebuilt = document.Rebuild(finalRows);
        return new ParamMutationPlan(document, mutations, projections, finalRows, rebuilt);
    }

    /// <summary>
    /// Strict slot-by-slot postcondition verifier comparing the simulated post-image
    /// projection against the re-read native document.
    /// </summary>
    public static void VerifyFinalParamProjection(
        IReadOnlyList<ParamFinalRowProjection> expected,
        ParamNativeDocument actual)
    {
        if (expected.Count != actual.Rows.Count)
            throw new InvalidDataException(
                $"PARAM 行数后置条件不满足：expected={expected.Count}，actual={actual.Rows.Count} (ROW_COUNT_POSTCONDITION)。");

        for (var i = 0; i < expected.Count; i++)
        {
            var exp = expected[i];
            var got = actual.Rows[i];
            if (exp.Id != got.Id)
                throw new InvalidDataException(
                    $"PARAM 第 {i} 槽 ID 后置条件不满足：expected={exp.Id}，actual={got.Id} (ROW_ID_POSTCONDITION)。");
            if (!string.Equals(exp.Name, got.Name, StringComparison.Ordinal))
                throw new InvalidDataException(
                    $"PARAM 第 {i} 槽名称后置条件不满足：expected='{exp.Name}'，actual='{got.Name}' (ROW_NAME_POSTCONDITION)。");
            if (!exp.Data.AsSpan().SequenceEqual(got.Data))
                throw new InvalidDataException(
                    $"PARAM 第 {i} 槽数据后置条件不满足：ID {exp.Id} (ROW_DATA_POSTCONDITION)。");
            var gotHash = ParamNativeDocument.Hash(got.Data);
            if (!string.Equals(exp.DataHash, gotHash, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException(
                    $"PARAM 第 {i} 槽数据哈希后置条件不满足：ID {exp.Id} (ROW_DATA_POSTCONDITION)。");
        }
    }

    private sealed class WorkingParamRow
    {
        public int Id { get; set; }
        public byte[] Data { get; set; }
        public string? Name { get; set; }
        public byte[]? NameBytes { get; set; }
        public string? NameEncoding { get; set; }
        public int OriginalNameOffset { get; set; }
        public int OriginalDataOffset { get; set; }
        public string? OriginalName { get; }

        public WorkingParamRow(ParamRow r)
        {
            Id = r.Id;
            Data = r.Data.ToArray();
            Name = r.Name;
            NameBytes = r.NameBytes;
            NameEncoding = r.NameEncoding;
            OriginalNameOffset = r.OriginalNameOffset;
            OriginalDataOffset = r.OriginalDataOffset;
            OriginalName = r.Name;
        }

        public WorkingParamRow(int id, byte[] data, string? name)
        {
            Id = id;
            Data = data;
            Name = name;
            NameBytes = null;
            NameEncoding = null;
            OriginalNameOffset = 0;
            OriginalDataOffset = 0;
            OriginalName = name;
        }
    }
}
