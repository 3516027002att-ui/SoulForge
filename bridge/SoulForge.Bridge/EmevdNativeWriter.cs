using System.Text.Json;

internal static class EmevdNativeWriter
{
    public static async Task<object> WriteAsync(
        string sourcePath,
        string outputPath,
        string? oodleRuntimeRoot,
        JsonElement options,
        CancellationToken cancellationToken)
    {
        var source = await File.ReadAllBytesAsync(sourcePath, cancellationToken);
        // EVENT-30C: the write target is always the outer source resource. When
        // the source is a .dcx wrapper the staged artifact must stay outer too —
        // unwrap → mutate payload → rebuild the DCX natively (DFLT zlib / KRAK
        // via Oodle). The TypeScript side never compresses, and never hands a
        // decompressed temp path back as the Patch target.
        if (source.Length >= 4 && source.AsSpan(0, 4).SequenceEqual("DCX\0"u8))
            return await WriteDcxOuterAsync(sourcePath, outputPath, oodleRuntimeRoot, options, cancellationToken);
        return await WriteRawAsync(sourcePath, outputPath, source, options, cancellationToken);
    }

    /// <summary>Raw .emevd payload path (unchanged behaviour).</summary>
    private static async Task<object> WriteRawAsync(
        string sourcePath,
        string outputPath,
        byte[] source,
        JsonElement options,
        CancellationToken cancellationToken)
    {
        var document = EmevdNativeDocument.Read(source);
        RequireHash(options, "expectedDocumentHash", document.SourceHash, "EMEVD source hash");
        var patches = ParsePatches(options);
        if (patches.Count == 0) throw new InvalidDataException("EMEVD writer 需要至少一条 mutation。");
        cancellationToken.ThrowIfCancellationRequested();
        var rebuilt = document.ApplyMutations(patches);
        await AtomicWriteAsync(outputPath, rebuilt, cancellationToken);
        var reread = EmevdNativeDocument.ReadFile(outputPath);
        VerifyMutations(document, reread, patches);
        return new
        {
            mutationCount = patches.Count,
            outputHash = reread.SourceHash,
            eventCount = reread.Events.Count,
            instructionCount = reread.Instructions.Count,
            outputSize = reread.SourceBytes.Length,
            sourceFormat = "emevd",
            rereadVerified = true
        };
    }

    /// <summary>
    /// Outer .dcx path: the staged artifact is a rebuilt DCX whose outer file
    /// hash is the sealed expectation for the file_replace PatchIR. Payload
    /// semantics are re-read through the native unwrap for mutation verify.
    /// </summary>
    private static async Task<object> WriteDcxOuterAsync(
        string sourcePath,
        string outputPath,
        string? oodleRuntimeRoot,
        JsonElement options,
        CancellationToken cancellationToken)
    {
        var dcx = DcxNativeDocument.Read(sourcePath, oodleRuntimeRoot);
        var document = EmevdNativeDocument.Read(dcx.Payload);
        RequireHash(options, "expectedDocumentHash", document.SourceHash, "EMEVD source hash");
        var patches = ParsePatches(options);
        if (patches.Count == 0) throw new InvalidDataException("EMEVD writer 需要至少一条 mutation。");
        cancellationToken.ThrowIfCancellationRequested();
        var rebuiltPayload = document.ApplyMutations(patches);
        byte[] rebuiltOuter;
        if (dcx.CompressionFormat == "DFLT")
        {
            rebuiltOuter = dcx.RebuildDflt(rebuiltPayload);
        }
        else if (dcx.CompressionFormat == "KRAK")
        {
            using var opened = OodleRuntimeLocator.Open(oodleRuntimeRoot, BridgeResult<object>.MakeSourceUri(sourcePath));
            if (opened.Session is null)
                throw new OodleRuntimeUnavailableException(
                    opened.Diagnostics.FirstOrDefault()?.Message ?? "Oodle 运行库不可用；无法重建 KRAK outer。");
            rebuiltOuter = dcx.RebuildKrak(rebuiltPayload, opened.Session);
        }
        else
        {
            throw new NotSupportedException($"DCX 压缩格式 {dcx.CompressionFormat} 尚不支持 outer 写回。");
        }
        await AtomicWriteAsync(outputPath, rebuiltOuter, cancellationToken);

        // Re-open the staged outer artifact natively and verify every mutation.
        var rereadDcx = DcxNativeDocument.Read(outputPath, oodleRuntimeRoot);
        var reread = EmevdNativeDocument.Read(rereadDcx.Payload);
        VerifyMutations(document, reread, patches);
        return new
        {
            mutationCount = patches.Count,
            // Sealed expectation for the committed .dcx file bytes.
            outputHash = rereadDcx.SourceHash,
            // Same outer container identity, spelled out so the TS staging layer
            // can expose it without guessing (raw path reports the payload hash
            // in both slots; DCX reports the container hash in both).
            outerFileHash = rereadDcx.SourceHash,
            // Payload identity (Bridge read-emevd-document reports this as sourceHash).
            payloadHash = reread.SourceHash,
            eventCount = reread.Events.Count,
            instructionCount = reread.Instructions.Count,
            outputSize = rereadDcx.SourceBytes.Length,
            sourceFormat = "dcx",
            rereadVerified = true
        };
    }

    private static async Task AtomicWriteAsync(string outputPath, byte[] bytes, CancellationToken cancellationToken)
    {
        var directory = Path.GetDirectoryName(outputPath) ?? throw new InvalidDataException("outputPath 没有父目录。");
        Directory.CreateDirectory(directory);
        var temporary = Path.Combine(directory, $".soulforge-{Guid.NewGuid():N}.tmp");
        try
        {
            await File.WriteAllBytesAsync(temporary, bytes, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            File.Move(temporary, outputPath, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    private static void VerifyMutations(EmevdNativeDocument original, EmevdNativeDocument reread, List<EmevdPatch> patches)
    {
        // Build the id rename map (original -> final) so verification can locate
        // events renamed by update_id even when a later patch references the old id.
        var renameMap = new Dictionary<long, long>();
        foreach (var patch in patches)
        {
            if (patch.Kind != "update_id" || patch.EventId == patch.NewEventId) continue;
            var sourceId = patch.EventId;
            var guard = 0;
            while (renameMap.TryGetValue(sourceId, out var mapped) && mapped != patch.NewEventId!.Value && guard++ < 64)
                sourceId = mapped;
            renameMap[sourceId] = patch.NewEventId!.Value;
        }

        foreach (var patch in patches)
        {
            if (patch.Kind is "set_rest_behavior" or "update_id")
            {
                var rawTarget = patch.Kind == "update_id" ? patch.NewEventId!.Value : patch.EventId;
                var targetId = ResolveFinalId(rawTarget, renameMap);
                var ev = reread.Events.FirstOrDefault(e => e.Id == targetId);
                if (ev is null) throw new InvalidDataException("EMEVD mutation 后找不到事件。");
                if (patch.Kind == "set_rest_behavior" && patch.RestBehavior is not null
                    && ev.RestBehavior != (uint)patch.RestBehavior.Value)
                    throw new InvalidDataException("EMEVD restBehavior 未按预期更新。");
            }
            else if (patch.Kind == "set_instruction_args")
            {
                var index = checked((int)patch.InstructionIndex!.Value);
                if (index < 0 || index >= reread.Instructions.Count)
                    throw new InvalidDataException("EMEVD instruction 索引在 reread 后无效。");
                var expected = Convert.FromBase64String(patch.ArgsBase64!);
                if (!reread.Instructions[index].Args.AsSpan().SequenceEqual(expected))
                    throw new InvalidDataException("EMEVD instruction args 未按预期更新。");
            }
            else if (patch.Kind == "add_event" || patch.Kind == "duplicate_event")
            {
                if (!reread.Events.Any(e => e.Id == patch.NewEventId))
                    throw new InvalidDataException("EMEVD add/duplicate 后找不到新事件。");
            }
            else if (patch.Kind == "delete_event")
            {
                if (reread.Events.Any(e => e.Id == patch.EventId))
                    throw new InvalidDataException("EMEVD delete 后事件仍存在。");
            }
            else if (patch.Kind == "insert_instruction")
            {
                var targetId = ResolveFinalId(patch.EventId, renameMap);
                var ev = reread.Events.FirstOrDefault(e => e.Id == targetId);
                if (ev is null) throw new InvalidDataException("EMEVD insert_instruction 后找不到事件。");
                var at = checked((int)patch.InstructionIndex!.Value);
                if (at < 0 || at >= ev.InstructionCount)
                    throw new InvalidDataException("EMEVD insert_instruction 后该位置没有指令。");
                var start = checked((int)(ev.InstructionsOffset / EmevdNativeDocument.InstructionSize));
                var written = reread.Instructions[start + at];
                var expected = Convert.FromBase64String(patch.ArgsBase64!);
                if (written.Bank != patch.Bank!.Value || written.Id != patch.Id!.Value
                    || !written.Args.AsSpan().SequenceEqual(expected))
                    throw new InvalidDataException("EMEVD insert_instruction 后该位置指令内容与预期不一致。");
            }
            else if (patch.Kind == "delete_instruction")
            {
                // 精确口径：该事件的指令总数 = 原始数 - 本批删除数 + 本批插入数。
                var targetId = ResolveFinalId(patch.EventId, renameMap);
                var ev = reread.Events.FirstOrDefault(e => e.Id == targetId);
                if (ev is null) throw new InvalidDataException("EMEVD delete_instruction 后找不到事件。");
                var before = original.Events.FirstOrDefault(e => e.Id == patch.EventId)
                    ?? throw new InvalidDataException("EMEVD delete_instruction 的原始事件不存在。");
                var deletes = patches.Count(p =>
                    p.Kind == "delete_instruction" && p.EventId == patch.EventId);
                var inserts = patches.Count(p =>
                    p.Kind == "insert_instruction" && p.EventId == patch.EventId);
                if (ev.InstructionCount != before.InstructionCount - deletes + inserts)
                    throw new InvalidDataException("EMEVD delete_instruction 后指令数与预期不一致。");
            }
            else if (patch.Kind == "set_event_parameters")
            {
                var targetId = ResolveFinalId(patch.EventId, renameMap);
                var ev = reread.Events.FirstOrDefault(e => e.Id == targetId);
                if (ev is null) throw new InvalidDataException("EMEVD set_event_parameters 后找不到事件。");
                var expectedParams = patch.Parameters ?? new List<EmevdParameter>();
                var actualParams = reread.GetEventParameters(ev);
                if (actualParams.Count != expectedParams.Count)
                    throw new InvalidDataException($"EMEVD set_event_parameters 参数数量不匹配：预期 {expectedParams.Count}，实际 {actualParams.Count}。");
                for (var i = 0; i < expectedParams.Count; i++)
                {
                    var exp = expectedParams[i];
                    var actual = actualParams[i];
                    if (actual.InstructionIndex != exp.InstructionIndex
                        || actual.TargetStartByte != exp.TargetStartByte
                        || actual.SourceStartByte != exp.SourceStartByte
                        || actual.ByteCount != exp.ByteCount
                        || actual.UnkId != exp.UnkId)
                    {
                        throw new InvalidDataException(
                            $"EMEVD parameter[{i}] 不匹配: 预期(instr={exp.InstructionIndex}, target={exp.TargetStartByte}, src={exp.SourceStartByte}, byteCount={exp.ByteCount}, unkId={exp.UnkId})，实际(instr={actual.InstructionIndex}, target={actual.TargetStartByte}, src={actual.SourceStartByte}, byteCount={actual.ByteCount}, unkId={actual.UnkId})。");
                    }
                }
            }
        }
    }

    /// <summary>Follow the rename chain to the final event id after update_id patches.</summary>
    private static long ResolveFinalId(long id, IReadOnlyDictionary<long, long> renameMap)
    {
        var current = id;
        var guard = 0;
        while (renameMap.TryGetValue(current, out var next) && guard++ < 64)
            current = next;
        return current;
    }

    private static List<EmevdPatch> ParsePatches(JsonElement options)
    {
        var patches = new List<EmevdPatch>();
        if (options.TryGetProperty("mutations", out var mutations) && mutations.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in mutations.EnumerateArray())
                patches.Add(ParsePatch(item));
        }
        else
        {
            patches.Add(ParsePatch(options));
        }
        return patches;
    }

    private static EmevdPatch ParsePatch(JsonElement item)
    {
        var kind = RequiredString(item, item.TryGetProperty("kind", out _) ? "kind" : "mutation")
            .ToLowerInvariant();
        if (kind == "set_instruction_args")
        {
            var instructionIndex = RequiredLong(item, "instructionIndex");
            var argsBase64 = RequiredString(item, "argsBase64");
            long eventId = 0;
            if (item.TryGetProperty("eventId", out var eid) && eid.ValueKind == JsonValueKind.Number)
                eventId = eid.GetInt64();
            return new EmevdPatch(kind, eventId, null, null, instructionIndex, argsBase64);
        }

        if (kind is "add_event")
        {
            var newId = RequiredLong(item, "newEventId");
            var rest = OptionalUInt32(item, "restBehavior");
            return new EmevdPatch(kind, 0, rest, newId);
        }

        if (kind is "duplicate_event")
        {
            var eventId = RequiredLong(item, "eventId");
            var newId = RequiredLong(item, "newEventId");
            return new EmevdPatch(kind, eventId, null, newId);
        }

        if (kind is "delete_event")
        {
            var eventId = RequiredLong(item, "eventId");
            return new EmevdPatch(kind, eventId, null, null);
        }

        if (kind is "insert_instruction")
        {
            var eventId = RequiredLong(item, "eventId");
            var index = RequiredLong(item, "instructionIndex");
            var bank = RequiredLong(item, "bank");
            var id = RequiredLong(item, "id");
            // 零参数指令（如 EndEvent）的 argsBase64 是空串，允许为空。
            var argsBase64 = item.TryGetProperty("argsBase64", out var argsEl)
                && argsEl.ValueKind == JsonValueKind.String
                ? argsEl.GetString()!
                : throw new InvalidDataException("options.argsBase64 是必填字符串。");
            return new EmevdPatch(kind, eventId, null, null, index, argsBase64, bank, id);
        }

        if (kind is "delete_instruction")
        {
            var eventId = RequiredLong(item, "eventId");
            var index = RequiredLong(item, "instructionIndex");
            return new EmevdPatch(kind, eventId, null, null, index);
        }

        if (kind is "set_event_parameters")
        {
            var eventId = RequiredLong(item, "eventId");
            var parameters = new List<EmevdParameter>();
            if (item.TryGetProperty("parameters", out var paramsEl) && paramsEl.ValueKind == JsonValueKind.Array)
            {
                foreach (var p in paramsEl.EnumerateArray())
                {
                    parameters.Add(new EmevdParameter(
                        RequiredLong(p, "instructionIndex"),
                        RequiredLong(p, "targetStartByte"),
                        RequiredLong(p, "sourceStartByte"),
                        (int)RequiredLong(p, "byteCount"),
                        (int)(p.TryGetProperty("unkId", out var unk) && unk.ValueKind == JsonValueKind.Number ? unk.GetInt64() : 0)));
                }
            }
            return new EmevdPatch(kind, eventId, null, null, null, null, null, null, parameters);
        }

        var eventIdRequired = RequiredLong(item, "eventId");
        var restBehavior = OptionalUInt32(item, "restBehavior");
        long? newEventId = null;
        if (item.TryGetProperty("newEventId", out var newEl) && newEl.ValueKind == JsonValueKind.Number)
            newEventId = newEl.GetInt64();
        return new EmevdPatch(kind, eventIdRequired, restBehavior, newEventId);
    }

    private static void RequireHash(JsonElement options, string field, string actual, string label)
    {
        if (!RequiredString(options, field).Equals(actual, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException($"{label} 不匹配。");
    }

    private static string RequiredString(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.String
            && !string.IsNullOrWhiteSpace(value.GetString())
            ? value.GetString()!
            : throw new InvalidDataException($"options.{field} 是必填字符串。");

    private static long RequiredLong(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.Number
            ? value.GetInt64()
            : throw new InvalidDataException($"options.{field} 是必填整数。");

    private static long? OptionalUInt32(JsonElement options, string field)
    {
        if (!options.TryGetProperty(field, out var value)) return null;
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt64(out var parsed)
            || parsed < uint.MinValue || parsed > uint.MaxValue)
            throw new InvalidDataException($"options.{field} 必须是 uint32 范围内的整数。");
        return parsed;
    }
}
