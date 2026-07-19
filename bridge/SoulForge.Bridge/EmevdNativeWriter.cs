using System.Text.Json;

internal static class EmevdNativeWriter
{
    public static async Task<object> WriteAsync(
        string sourcePath,
        string outputPath,
        JsonElement options,
        CancellationToken cancellationToken,
        string? oodleRuntimeRoot)
    {
        var source = EmevdNativeSource.Read(sourcePath, oodleRuntimeRoot);
        var document = source.Document;
        RequireSourceHash(options, source.SourceHash);

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
        var rebuiltDocument = document.ApplyMutations(patches);
        var rebuiltSource = source.RebuildSource(rebuiltDocument);
        var directory = Path.GetDirectoryName(outputPath) ?? throw new InvalidDataException("outputPath 没有父目录。");
        Directory.CreateDirectory(directory);
        var temporary = Path.Combine(directory, $".soulforge-{Guid.NewGuid():N}.tmp");
        try
        {
            await File.WriteAllBytesAsync(temporary, rebuiltSource, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            File.Move(temporary, outputPath, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }

        var rereadSource = EmevdNativeSource.Read(outputPath, oodleRuntimeRoot);
        var reread = rereadSource.Document;
        if (!rereadSource.SourceBytes.AsSpan().SequenceEqual(rebuiltSource))
            throw new InvalidDataException("EMEVD 暂存区重读字节与重建结果不一致。");
        if (!reread.SourceBytes.AsSpan().SequenceEqual(rebuiltDocument))
            throw new InvalidDataException("EMEVD 暂存区重读 document payload 与重建结果不一致。");
        var roundTrip = reread.VerifyRoundTrip();
        if (!roundTrip.ByteIdentical || !roundTrip.SemanticIdentical)
            throw new InvalidDataException("EMEVD 暂存区重读后 roundtrip 验证失败。");

        return new
        {
            mutationCount = patches.Count,
            outputHash = rereadSource.SourceHash,
            documentHash = reread.SourceHash,
            containerKind = rereadSource.ContainerKind,
            compressionFormat = rereadSource.CompressionFormat,
            eventCount = reread.Events.Count,
            instructionCount = reread.Instructions.Count,
            outputSize = rereadSource.SourceBytes.Length,
            documentSize = reread.SourceBytes.Length,
            rereadVerified = true,
            byteRoundTripVerified = roundTrip.ByteIdentical,
            semanticRoundTripVerified = roundTrip.SemanticIdentical
        };
    }

    private static EmevdPatch ParsePatch(JsonElement item)
    {
        var kind = RequiredString(item, item.TryGetProperty("kind", out _) ? "kind" : "mutation")
            .ToLowerInvariant();
        if (kind == "set_instruction_args")
        {
            var argsBase64 = RequiredString(item, "argsBase64");
            long eventId = 0;
            if (item.TryGetProperty("eventId", out var eid) && eid.ValueKind == JsonValueKind.Number)
                eventId = eid.GetInt64();
            long? globalInstructionIndex = null;
            if (item.TryGetProperty("instructionIndex", out var gii) && gii.ValueKind == JsonValueKind.Number
                && !(item.TryGetProperty("eventIndex", out var hasEventIndex)
                    && hasEventIndex.ValueKind == JsonValueKind.Number
                    && item.TryGetProperty("instructionLocalIndex", out var hasLocal)
                    && hasLocal.ValueKind == JsonValueKind.Number))
            {
                // Global index mode (legacy): instructionIndex is absolute.
                globalInstructionIndex = gii.GetInt64();
            }
            int? eventIndex = null;
            int? instructionLocalIndex = null;
            int? expectedBank = null;
            int? expectedInstructionId = null;
            if (item.TryGetProperty("eventIndex", out var eix) && eix.ValueKind == JsonValueKind.Number)
                eventIndex = eix.GetInt32();
            if (item.TryGetProperty("instructionLocalIndex", out var ili)
                && ili.ValueKind == JsonValueKind.Number)
                instructionLocalIndex = ili.GetInt32();
            // Also accept "instructionIndex" as local when eventIndex is present.
            if (instructionLocalIndex is null
                && eventIndex is not null
                && item.TryGetProperty("instructionIndex", out var localAsIndex)
                && localAsIndex.ValueKind == JsonValueKind.Number)
                instructionLocalIndex = localAsIndex.GetInt32();
            if (item.TryGetProperty("expectedBank", out var eb) && eb.ValueKind == JsonValueKind.Number)
                expectedBank = eb.GetInt32();
            if (item.TryGetProperty("expectedInstructionId", out var ei)
                && ei.ValueKind == JsonValueKind.Number)
                expectedInstructionId = ei.GetInt32();
            return new EmevdPatch(
                kind,
                eventId,
                null,
                null,
                InstructionIndex: globalInstructionIndex,
                ArgsBase64: argsBase64,
                EventIndex: eventIndex,
                InstructionLocalIndex: instructionLocalIndex,
                ExpectedBank: expectedBank,
                ExpectedInstructionId: expectedInstructionId);
        }

        if (kind == "add_instruction")
        {
            return new EmevdPatch(
                kind,
                RequiredLong(item, "eventId"),
                null,
                null,
                ArgsBase64: RequiredString(item, "argsBase64"),
                EventIndex: RequiredInt(item, "eventIndex"),
                InstructionLocalIndex: RequiredInt(item, "instructionIndex"),
                NewBank: RequiredInt(item, "bank"),
                NewInstructionId: RequiredInt(item, "id"));
        }

        if (kind == "insert_instruction_snapshot")
        {
            return new EmevdPatch(
                kind,
                RequiredLong(item, "eventId"),
                null,
                null,
                EventIndex: RequiredInt(item, "eventIndex"),
                InstructionLocalIndex: RequiredInt(item, "insertInstructionIndex"),
                InstructionSnapshotBase64: RequiredString(item, "snapshotBase64"),
                InstructionSnapshotSha256: RequiredString(item, "snapshotSha256"),
                ExpectedInstructionHash: RequiredString(item, "expectedInstructionHash"),
                InstructionSnapshotFormatId: RequiredString(item, "snapshotFormatId"),
                InstructionSnapshotSchemaVersion: RequiredString(item, "snapshotSchemaVersion"));
        }

        if (kind is "delete_instruction" or "duplicate_instruction")
        {
            return new EmevdPatch(
                kind,
                RequiredLong(item, "eventId"),
                null,
                null,
                EventIndex: RequiredInt(item, "eventIndex"),
                InstructionLocalIndex: RequiredInt(item, "instructionIndex"),
                ExpectedBank: RequiredInt(item, "expectedBank"),
                ExpectedInstructionId: RequiredInt(item, "expectedInstructionId"));
        }

        if (kind == "reorder_instruction")
        {
            var hasBeforeIndex = item.TryGetProperty("beforeInstructionIndex", out var beforeIndex)
                && beforeIndex.ValueKind == JsonValueKind.Number;
            var hasBeforeBank = item.TryGetProperty("beforeExpectedBank", out var beforeBank)
                && beforeBank.ValueKind == JsonValueKind.Number;
            var hasBeforeId = item.TryGetProperty("beforeExpectedInstructionId", out var beforeId)
                && beforeId.ValueKind == JsonValueKind.Number;
            if (hasBeforeIndex != hasBeforeBank || hasBeforeIndex != hasBeforeId)
                throw new InvalidDataException(
                    "reorder_instruction 的 beforeInstruction identity 必须完整提供或全部省略。");
            return new EmevdPatch(
                kind,
                RequiredLong(item, "eventId"),
                null,
                null,
                EventIndex: RequiredInt(item, "eventIndex"),
                InstructionLocalIndex: RequiredInt(item, "instructionIndex"),
                ExpectedBank: RequiredInt(item, "expectedBank"),
                ExpectedInstructionId: RequiredInt(item, "expectedInstructionId"),
                BeforeInstructionIndex: hasBeforeIndex ? beforeIndex.GetInt32() : null,
                BeforeExpectedBank: hasBeforeBank ? beforeBank.GetInt32() : null,
                BeforeExpectedInstructionId: hasBeforeId ? beforeId.GetInt32() : null);
        }

        if (kind is "add_event")
        {
            var newId = RequiredLong(item, "newEventId");
            long? rest = null;
            if (item.TryGetProperty("restBehavior", out var restEl) && restEl.ValueKind == JsonValueKind.Number)
                rest = restEl.GetInt64();
            return new EmevdPatch(kind, 0, rest, newId);
        }

        if (kind is "insert_event_snapshot")
        {
            return new EmevdPatch(
                kind,
                RequiredLong(item, "eventId"),
                null,
                null,
                InsertEventIndex: RequiredInt(item, "insertEventIndex"),
                EventSnapshotBase64: RequiredString(item, "snapshotBase64"),
                EventSnapshotSha256: RequiredString(item, "snapshotSha256"),
                ExpectedEventHash: RequiredString(item, "expectedEventHash"),
                EventSnapshotFormatId: RequiredString(item, "snapshotFormatId"),
                EventSnapshotSchemaVersion: RequiredString(item, "snapshotSchemaVersion"));
        }

        if (kind is "duplicate_event")
        {
            var eventId = RequiredLong(item, "eventId");
            var newId = RequiredLong(item, "newEventId");
            return new EmevdPatch(kind, eventId, null, newId, EventIndex: OptionalInt(item, "eventIndex"));
        }

        if (kind is "delete_event")
        {
            var eventId = RequiredLong(item, "eventId");
            return new EmevdPatch(kind, eventId, null, null, EventIndex: OptionalInt(item, "eventIndex"));
        }

        if (kind is "reorder_event")
        {
            var eventId = RequiredLong(item, "eventId");
            var eventIndex = RequiredInt(item, "eventIndex");
            var beforeEventId = OptionalLong(item, "beforeEventId");
            var beforeEventIndex = OptionalInt(item, "beforeEventIndex");
            if ((beforeEventId is null) != (beforeEventIndex is null))
                throw new InvalidDataException(
                    "reorder_event 的 beforeEventId 与 beforeEventIndex 必须同时提供或同时省略。");
            return new EmevdPatch(
                kind,
                eventId,
                null,
                null,
                BeforeEventId: beforeEventId,
                EventIndex: eventIndex,
                BeforeEventIndex: beforeEventIndex);
        }

        var eventIdRequired = RequiredLong(item, "eventId");
        long? restBehavior = null;
        if (item.TryGetProperty("restBehavior", out var rb) && rb.ValueKind == JsonValueKind.Number)
            restBehavior = rb.GetInt64();
        long? newEventId = null;
        if (item.TryGetProperty("newEventId", out var newEl) && newEl.ValueKind == JsonValueKind.Number)
            newEventId = newEl.GetInt64();
        return new EmevdPatch(
            kind,
            eventIdRequired,
            restBehavior,
            newEventId,
            EventIndex: OptionalInt(item, "eventIndex"));
    }

    private static void RequireSourceHash(JsonElement options, string actual)
    {
        var expectedSourceHash = OptionalString(options, "expectedSourceHash");
        var legacyDocumentHash = OptionalString(options, "expectedDocumentHash");
        if (expectedSourceHash is null && legacyDocumentHash is null)
            throw new InvalidDataException("options.expectedSourceHash 是必填字符串；旧调用可暂用 expectedDocumentHash。");
        if (expectedSourceHash is not null && legacyDocumentHash is not null
            && !expectedSourceHash.Equals(legacyDocumentHash, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("expectedSourceHash 与兼容字段 expectedDocumentHash 冲突。");
        var expected = expectedSourceHash ?? legacyDocumentHash!;
        if (!expected.Equals(actual, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("EMEVD source hash 不匹配。");
    }

    private static string RequiredString(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.String
            && !string.IsNullOrWhiteSpace(value.GetString())
            ? value.GetString()!
            : throw new InvalidDataException($"options.{field} 是必填字符串。");

    private static string? OptionalString(JsonElement options, string field)
    {
        if (!options.TryGetProperty(field, out var value)) return null;
        if (value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString()))
            return value.GetString();
        throw new InvalidDataException($"options.{field} 必须是非空字符串。");
    }

    private static long RequiredLong(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.Number
            ? value.GetInt64()
            : throw new InvalidDataException($"options.{field} 是必填整数。");

    private static int RequiredInt(JsonElement options, string field)
        => options.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.Number
            && value.TryGetInt32(out var parsed)
            ? parsed
            : throw new InvalidDataException($"options.{field} 是必填 Int32。");

    private static int? OptionalInt(JsonElement options, string field)
        => options.TryGetProperty(field, out var value)
            ? value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var parsed)
                ? parsed
                : throw new InvalidDataException($"options.{field} 必须是 Int32。")
            : null;

    private static long? OptionalLong(JsonElement options, string field)
        => options.TryGetProperty(field, out var value)
            ? value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var parsed)
                ? parsed
                : throw new InvalidDataException($"options.{field} 必须是 Int64。")
            : null;
}
