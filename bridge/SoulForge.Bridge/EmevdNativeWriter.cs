using System.Text.Json;

internal static class EmevdNativeWriter
{
    public static async Task<object> WriteAsync(
        string sourcePath,
        string outputPath,
        JsonElement options,
        CancellationToken cancellationToken)
    {
        var source = await File.ReadAllBytesAsync(sourcePath, cancellationToken);
        var document = EmevdNativeDocument.Read(source);
        RequireHash(options, "expectedDocumentHash", document.SourceHash, "EMEVD source hash");

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
        if (patches.Count == 0) throw new InvalidDataException("EMEVD writer 需要至少一条 mutation。");
        cancellationToken.ThrowIfCancellationRequested();
        var rebuilt = document.ApplyMutations(patches);
        var directory = Path.GetDirectoryName(outputPath) ?? throw new InvalidDataException("outputPath 没有父目录。");
        Directory.CreateDirectory(directory);
        var temporary = Path.Combine(directory, $".soulforge-{Guid.NewGuid():N}.tmp");
        try
        {
            await File.WriteAllBytesAsync(temporary, rebuilt, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            File.Move(temporary, outputPath, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }

        var reread = EmevdNativeDocument.ReadFile(outputPath);

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
            renameMap[sourceId] = patch.NewEventId.Value;
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
        }

        return new
        {
            mutationCount = patches.Count,
            outputHash = reread.SourceHash,
            eventCount = reread.Events.Count,
            instructionCount = reread.Instructions.Count,
            outputSize = reread.SourceBytes.Length,
            rereadVerified = true
        };
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
