using System.Buffers.Binary;
using System.Security.Cryptography;

/// <summary>
/// Sekiro EMEVD (EVD\0, format flags 00 FF 01 FF, version 0xCD) native document.
/// Layout matches SoulsFormats Game.Sekiro (64-bit varints).
/// Supports event/instruction edits and full GC rebuild while preserving linked files,
/// strings, parameter substitutions, and opaque instruction arguments.
/// </summary>
internal sealed class EmevdNativeDocument
{
    private const int HeaderSize = 0x90;
    private const int EventSize = 0x30;
    private const int InstructionSize = 0x20;
    private const int ParameterSize = 0x20;
    private const int MaxEvents = 200_000;
    private const int MaxInstructions = 2_000_000;
    private const int MaxParameterSubstitutions = MaxEvents * 64;
    private const int MaxSourceBytes = 64 * 1024 * 1024;
    private const int MaxArgsBytes = 1 * 1024 * 1024;
    private const int MaxEventSnapshotBytes = 256 * 1024;
    private const int MaxEventSnapshotItems = 100_000;
    private const int MaxInstructionSnapshotBytes = 256 * 1024;
    private const int MaxInstructionSnapshotParameters = 10_000;
    private const string SchemaId = "soulforge.emevd.sekiro";
    private const string SchemaVersion = "1.0.0";
    internal const string EventSnapshotFormatId = "soulforge.emevd.event-semantic-v1";
    internal const string EventSnapshotSchemaVersion = "1.0.0";
    internal const string InstructionSnapshotFormatId = "soulforge.emevd.instruction-semantic-v1";
    internal const string InstructionSnapshotSchemaVersion = "1.0.0";
    private static readonly string LayoutFingerprint = Convert.ToHexString(SHA256.HashData(
        System.Text.Encoding.UTF8.GetBytes(
            "EMEVD|Sekiro|0xCD|00FF01FF|little|event:0x30|instruction:0x20|parameter:0x20")))
        .ToLowerInvariant();

    private EmevdNativeDocument(
        byte[] sourceBytes,
        long eventsOffset,
        long instructionsOffset,
        long argumentsOffset,
        long argumentsLength,
        long parametersOffset,
        long layerCount,
        long linkedFilesOffset,
        long stringsOffset,
        long stringsLength,
        IReadOnlyList<EmevdEvent> events,
        IReadOnlyList<EmevdInstruction> instructions,
        IReadOnlyList<IReadOnlyList<EmevdParameter>> eventParameters)
    {
        SourceBytes = sourceBytes;
        EventsOffset = eventsOffset;
        InstructionsOffset = instructionsOffset;
        ArgumentsOffset = argumentsOffset;
        ArgumentsLength = argumentsLength;
        ParametersOffset = parametersOffset;
        LayerCount = layerCount;
        LinkedFilesOffset = linkedFilesOffset;
        StringsOffset = stringsOffset;
        StringsLength = stringsLength;
        Events = events;
        Instructions = instructions;
        EventParameters = eventParameters;
    }

    public byte[] SourceBytes { get; }
    public long EventsOffset { get; }
    public long InstructionsOffset { get; }
    public long ArgumentsOffset { get; }
    public long ArgumentsLength { get; }
    public long ParametersOffset { get; }
    public long LayerCount { get; }
    public long LinkedFilesOffset { get; }
    public long StringsOffset { get; }
    public long StringsLength { get; }
    public IReadOnlyList<EmevdEvent> Events { get; }
    public IReadOnlyList<EmevdInstruction> Instructions { get; }
    public IReadOnlyList<IReadOnlyList<EmevdParameter>> EventParameters { get; }
    public string SourceHash => Hash(SourceBytes);

    public static EmevdNativeDocument Read(byte[] source)
    {
        if (source.Length < HeaderSize || source.Length > MaxSourceBytes)
            throw new InvalidDataException($"EMEVD 大小 {source.Length} 超出安全范围。");
        if (!source.AsSpan(0, 4).SequenceEqual("EVD\0"u8))
            throw new InvalidDataException("输入不是 EMEVD（缺少 EVD\\0）。");
        if (source[4] != 0x00 || source[5] != 0xFF || source[6] != 0x01 || source[7] != 0xFF)
            throw new NotSupportedException("仅支持 Sekiro 风格 EMEVD 格式字节 00 FF 01 FF。");
        var version = ReadInt32(source, 0x08);
        if (version != 0xCD)
            throw new NotSupportedException($"仅支持 EMEVD version 0xCD，收到 0x{version:X}。");
        var declaredSize = ReadInt32(source, 0x0C);
        if (declaredSize != source.Length)
            throw new InvalidDataException($"EMEVD 声明大小 {declaredSize} 与实际 {source.Length} 不一致。");

        var eventCount = ReadInt64(source, 0x10);
        var eventsOffset = ReadInt64(source, 0x18);
        var instructionCount = ReadInt64(source, 0x20);
        var instructionsOffset = ReadInt64(source, 0x28);
        var unkStructCount = ReadInt64(source, 0x30);
        var layerCount = ReadInt64(source, 0x40);
        var paramCountHeader = ReadInt64(source, 0x50);
        var parametersOffset = ReadInt64(source, 0x58);
        var linkedCount = ReadInt64(source, 0x60);
        var linkedFilesOffset = ReadInt64(source, 0x68);
        var argumentsLength = ReadInt64(source, 0x70);
        var argumentsOffset = ReadInt64(source, 0x78);
        var stringsLength = ReadInt64(source, 0x80);
        var stringsOffset = ReadInt64(source, 0x88);

        if (eventCount < 0 || eventCount > MaxEvents)
            throw new InvalidDataException($"EMEVD 事件数 {eventCount} 越界。");
        if (instructionCount < 0 || instructionCount > MaxInstructions)
            throw new InvalidDataException($"EMEVD 指令数 {instructionCount} 越界。");
        if (unkStructCount != 0)
            throw new NotSupportedException($"EMEVD 未知结构计数 {unkStructCount} 非 0，当前未支持。");
        if (layerCount != 0)
            throw new NotSupportedException("EMEVD layer 表尚未解析，当前拒绝读取，不能声明或执行安全写入。");
        if (eventsOffset < HeaderSize || eventsOffset > source.Length
            || eventCount * EventSize > source.Length - eventsOffset)
            throw new InvalidDataException("EMEVD 事件表越界。");
        if (instructionsOffset < eventsOffset || instructionsOffset > source.Length
            || instructionCount * InstructionSize > source.Length - instructionsOffset)
            throw new InvalidDataException("EMEVD 指令表越界。");
        if (argumentsOffset < 0 || argumentsOffset > source.Length || argumentsLength < 0
            || argumentsLength > source.Length - argumentsOffset)
            throw new InvalidDataException("EMEVD 参数银行越界。");
        if (argumentsLength > MaxArgsBytes)
            throw new InvalidDataException($"EMEVD 参数银行过大：{argumentsLength}。");
        if (parametersOffset < 0 || parametersOffset > source.Length)
            throw new InvalidDataException("EMEVD parametersOffset 越界。");
        if (linkedFilesOffset < 0 || linkedFilesOffset > source.Length)
            throw new InvalidDataException("EMEVD linkedFilesOffset 越界。");
        if (stringsOffset < 0 || stringsOffset > source.Length || stringsLength < 0
            || stringsLength > source.Length - stringsOffset)
            throw new InvalidDataException("EMEVD 字符串段越界。");
        if (paramCountHeader < 0 || paramCountHeader > MaxParameterSubstitutions)
            throw new InvalidDataException($"EMEVD 参数条目数 {paramCountHeader} 越界。");
        if (linkedCount < 0 || linkedCount > 1024)
            throw new InvalidDataException($"EMEVD linked 文件数 {linkedCount} 越界。");

        var events = new List<EmevdEvent>((int)eventCount);
        long instrSum = 0;
        long paramSum = 0;
        for (var i = 0; i < eventCount; i++)
        {
            var o = checked((int)(eventsOffset + i * EventSize));
            var id = ReadInt64(source, o);
            var instrCount = ReadInt64(source, o + 8);
            var instrsOffset = ReadInt64(source, o + 16);
            var parameterCount = ReadInt64(source, o + 24);
            var eventParamsOffset = ReadInt64(source, o + 32);
            var restBehavior = ReadUInt32(source, o + 40);
            var pad = ReadInt32(source, o + 44);
            if (pad != 0)
                throw new InvalidDataException($"EMEVD 事件 {id} 填充字段非 0。");
            if (instrCount < 0 || instrCount > MaxInstructions)
                throw new InvalidDataException($"EMEVD 事件 {id} 指令数越界。");
            if (instrCount > 0)
            {
                if (instrsOffset < 0
                    || instrsOffset + instrCount * InstructionSize
                        > instructionCount * InstructionSize)
                    throw new InvalidDataException($"EMEVD 事件 {id} 指令偏移越界。");
            }
            if (parameterCount < 0 || parameterCount > MaxParameterSubstitutions)
                throw new InvalidDataException($"EMEVD 事件 {id} parameterCount 越界。");
            if (parameterCount > 0)
            {
                if (eventParamsOffset < 0
                    || eventParamsOffset > source.Length - parametersOffset
                    || parameterCount * ParameterSize
                        > source.Length - parametersOffset - eventParamsOffset)
                    throw new InvalidDataException($"EMEVD 事件 {id} 参数偏移越界。");
            }
            instrSum += instrCount;
            paramSum += parameterCount;
            events.Add(new EmevdEvent(
                id, instrCount, instrsOffset, parameterCount, eventParamsOffset, restBehavior));
        }
        if (instrSum != instructionCount)
            throw new InvalidDataException(
                $"EMEVD 事件指令合计 {instrSum} 与头指令数 {instructionCount} 不一致。");
        if (paramSum != paramCountHeader)
            throw new InvalidDataException(
                $"EMEVD 事件参数合计 {paramSum} 与头参数数 {paramCountHeader} 不一致。");

        var instructions = new List<EmevdInstruction>((int)instructionCount);
        for (var i = 0; i < instructionCount; i++)
        {
            var o = checked((int)(instructionsOffset + i * InstructionSize));
            var bank = ReadInt32(source, o);
            var id = ReadInt32(source, o + 4);
            var argsLength = ReadInt64(source, o + 8);
            var argsOffset = ReadInt64(source, o + 16);
            var layerOffset = ReadInt64(source, o + 24);
            if (argsLength < 0 || argsLength > MaxArgsBytes)
                throw new InvalidDataException($"EMEVD 指令[{i}] argsLength 越界。");
            byte[] args;
            if (argsLength == 0)
            {
                args = Array.Empty<byte>();
            }
            else
            {
                if (argsOffset < 0 || argsOffset > argumentsLength
                    || argsLength > argumentsLength - argsOffset)
                    throw new InvalidDataException($"EMEVD 指令[{i}] argsOffset 越界。");
                var abs = checked((int)(argumentsOffset + argsOffset));
                args = source.AsSpan(abs, (int)argsLength).ToArray();
            }
            instructions.Add(new EmevdInstruction(bank, id, argsLength, argsOffset, layerOffset, args));
        }

        var eventParameters = new List<IReadOnlyList<EmevdParameter>>(events.Count);
        for (var eventIndex = 0; eventIndex < events.Count; eventIndex++)
        {
            var ev = events[eventIndex];
            var parameters = new List<EmevdParameter>(checked((int)ev.ParameterCount));
            if (ev.ParameterCount > 0)
            {
                var baseOffset = checked((int)(parametersOffset + ev.ParametersOffset));
                var instructionStart = checked((int)(ev.InstructionsOffset / InstructionSize));
                for (var parameterIndex = 0; parameterIndex < ev.ParameterCount; parameterIndex++)
                {
                    var o = checked(baseOffset + (int)parameterIndex * ParameterSize);
                    var parameter = new EmevdParameter(
                        ReadInt64(source, o),
                        ReadInt64(source, o + 8),
                        ReadInt64(source, o + 16),
                        ReadInt32(source, o + 24),
                        ReadInt32(source, o + 28));
                    ValidateParameterTarget(
                        parameter,
                        ev,
                        instructions,
                        instructionStart,
                        eventIndex,
                        checked((int)parameterIndex));
                    parameters.Add(parameter);
                }
            }
            eventParameters.Add(parameters);
        }

        return new EmevdNativeDocument(
            source, eventsOffset, instructionsOffset, argumentsOffset, argumentsLength,
            parametersOffset, layerCount, linkedFilesOffset, stringsOffset, stringsLength,
            events, instructions, eventParameters);
    }

    public static EmevdNativeDocument ReadFile(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists) throw new FileNotFoundException("EMEVD 文件不存在。", path);
        if (info.Length <= 0 || info.Length > MaxSourceBytes)
            throw new InvalidDataException($"EMEVD 文件大小 {info.Length} 超出安全读取范围。");
        return Read(File.ReadAllBytes(path));
    }

    public EmevdRoundTripReport VerifyRoundTrip()
    {
        // Prefer structural rebuild identity when event count unchanged.
        var rebuilt = Events.Count == 0
            ? SourceBytes
            : RebuildEvents(Events);
        var reparsed = Read(rebuilt);
        var eventsEqual = reparsed.Events.Count == Events.Count
            && reparsed.Events.Zip(Events).All(pair => pair.First == pair.Second);
        var instrEqual = reparsed.Instructions.Count == Instructions.Count
            && reparsed.Instructions.Zip(Instructions).All(pair =>
                pair.First.Bank == pair.Second.Bank
                && pair.First.Id == pair.Second.Id
                && pair.First.Args.AsSpan().SequenceEqual(pair.Second.Args));
        var parametersEqual = reparsed.EventParameters.Count == EventParameters.Count
            && reparsed.EventParameters.Zip(EventParameters).All(pair =>
                pair.First.Count == pair.Second.Count
                && pair.First.Zip(pair.Second).All(parameter => parameter.First == parameter.Second));
        return new EmevdRoundTripReport(
            SourceBytes.SequenceEqual(rebuilt),
            eventsEqual && instrEqual && parametersEqual,
            SourceHash,
            Hash(rebuilt),
            Events.Count,
            Instructions.Count);
    }

    public byte[] RebuildEvents(IReadOnlyList<EmevdEvent> nextEvents)
    {
        if (nextEvents.Count != Events.Count)
            throw new NotSupportedException("等数量事件表重写请使用 RebuildEvents；增删请用 GC 重建。");
        var rebuilt = SourceBytes.ToArray();
        for (var i = 0; i < nextEvents.Count; i++)
        {
            var o = checked((int)(EventsOffset + i * EventSize));
            var e = nextEvents[i];
            WriteInt64(rebuilt, o, e.Id);
            WriteInt64(rebuilt, o + 8, e.InstructionCount);
            WriteInt64(rebuilt, o + 16, e.InstructionsOffset);
            WriteInt64(rebuilt, o + 24, e.ParameterCount);
            WriteInt64(rebuilt, o + 32, e.ParametersOffset);
            WriteUInt32(rebuilt, o + 40, e.RestBehavior);
            WriteInt32(rebuilt, o + 44, 0);
        }
        return rebuilt;
    }

    public byte[] RebuildInstructionArgs(int instructionIndex, byte[] nextArgs)
    {
        if (instructionIndex < 0 || instructionIndex >= Instructions.Count)
            throw new InvalidDataException($"EMEVD 指令索引 {instructionIndex} 越界。");
        var current = Instructions[instructionIndex];
        if (nextArgs.Length != current.Args.Length)
            throw new NotSupportedException(
                "等长 args 替换失败；变长请使用完整 GC（尚未对单指令开放）。");
        if (current.ArgsLength == 0)
            throw new InvalidDataException("目标指令无 args 可写。");
        var rebuilt = SourceBytes.ToArray();
        var abs = checked((int)(ArgumentsOffset + current.ArgsOffset));
        nextArgs.CopyTo(rebuilt, abs);
        return rebuilt;
    }

    public List<EmevdEventBuild> CaptureEventBuilds()
    {
        var builds = new List<EmevdEventBuild>(Events.Count);
        for (var eventIndex = 0; eventIndex < Events.Count; eventIndex++)
        {
            var ev = Events[eventIndex];
            var instrs = new List<EmevdInstructionBuild>();
            if (ev.InstructionCount > 0)
            {
                var start = checked((int)(ev.InstructionsOffset / InstructionSize));
                for (var i = 0; i < ev.InstructionCount; i++)
                {
                    var instr = Instructions[start + i];
                    instrs.Add(new EmevdInstructionBuild(instr.Bank, instr.Id, instr.LayerOffset, instr.Args.ToArray()));
                }
            }
            var parameters = EventParameters[eventIndex].ToList();
            builds.Add(new EmevdEventBuild(ev.Id, ev.RestBehavior, instrs, parameters));
        }
        return builds;
    }

    internal static byte[] EncodeEventSnapshot(EmevdEventBuild build)
    {
        using var stream = new MemoryStream();
        using (var writer = new BinaryWriter(stream, System.Text.Encoding.UTF8, leaveOpen: true))
        {
            writer.Write(build.Id);
            writer.Write(build.RestBehavior);
            writer.Write(build.Instructions.Count);
            foreach (var instruction in build.Instructions)
            {
                writer.Write(instruction.Bank);
                writer.Write(instruction.Id);
                writer.Write(instruction.LayerOffset);
                writer.Write(instruction.Args.Length);
                writer.Write(instruction.Args);
            }
            writer.Write(build.Parameters.Count);
            foreach (var parameter in build.Parameters)
            {
                writer.Write(parameter.InstructionIndex);
                writer.Write(parameter.TargetStartByte);
                writer.Write(parameter.SourceStartByte);
                writer.Write(parameter.ByteCount);
                writer.Write(parameter.UnkId);
            }
        }
        var bytes = stream.ToArray();
        if (bytes.Length > MaxEventSnapshotBytes)
            throw new InvalidDataException("EMEVD 单事件 snapshot 超过安全上限。");
        return bytes;
    }

    internal static EmevdEventBuild DecodeEventSnapshot(
        string snapshotBase64,
        string snapshotSha256,
        string expectedEventHash,
        string formatId,
        string snapshotSchemaVersion)
    {
        if (!formatId.Equals(EventSnapshotFormatId, StringComparison.Ordinal)
            || !snapshotSchemaVersion.Equals(EventSnapshotSchemaVersion, StringComparison.Ordinal))
            throw new InvalidDataException("EMEVD event snapshot format/schema 不受支持。");
        if (snapshotBase64.Any(char.IsWhiteSpace))
            throw new InvalidDataException("EMEVD event snapshot 必须使用无空白规范 Base64。");
        byte[] bytes;
        try { bytes = Convert.FromBase64String(snapshotBase64); }
        catch (FormatException ex) { throw new InvalidDataException("EMEVD event snapshot Base64 非法。", ex); }
        if (!Convert.ToBase64String(bytes).Equals(snapshotBase64, StringComparison.Ordinal))
            throw new InvalidDataException("EMEVD event snapshot 必须使用规范标准 Base64 编码。");
        if (bytes.Length < 20 || bytes.Length > MaxEventSnapshotBytes)
            throw new InvalidDataException("EMEVD event snapshot 大小超出安全边界。");
        var actualHash = Hash(bytes);
        if (!actualHash.Equals(snapshotSha256, StringComparison.OrdinalIgnoreCase)
            || !actualHash.Equals(expectedEventHash, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("EMEVD event snapshot hash/eventHash 不匹配。");

        using var stream = new MemoryStream(bytes, writable: false);
        using var reader = new BinaryReader(stream, System.Text.Encoding.UTF8, leaveOpen: true);
        var id = reader.ReadInt64();
        var restBehavior = reader.ReadUInt32();
        var instructionCount = reader.ReadInt32();
        if (instructionCount < 0 || instructionCount > MaxEventSnapshotItems)
            throw new InvalidDataException("EMEVD event snapshot instructionCount 超出安全上限。");
        var instructions = new List<EmevdInstructionBuild>(instructionCount);
        for (var index = 0; index < instructionCount; index++)
        {
            var bank = reader.ReadInt32();
            var instructionId = reader.ReadInt32();
            var layerOffset = reader.ReadInt64();
            var argsLength = reader.ReadInt32();
            if (argsLength < 0
                || argsLength > MaxArgsBytes
                || argsLength > stream.Length - stream.Position)
                throw new InvalidDataException("EMEVD event snapshot instruction args 长度无效。");
            instructions.Add(new EmevdInstructionBuild(
                bank,
                instructionId,
                layerOffset,
                reader.ReadBytes(argsLength)));
        }
        var parameterCount = reader.ReadInt32();
        if (parameterCount < 0 || parameterCount > MaxEventSnapshotItems)
            throw new InvalidDataException("EMEVD event snapshot parameterCount 超出安全上限。");
        var parameters = new List<EmevdParameter>(parameterCount);
        for (var index = 0; index < parameterCount; index++)
        {
            parameters.Add(new EmevdParameter(
                reader.ReadInt64(),
                reader.ReadInt64(),
                reader.ReadInt64(),
                reader.ReadInt32(),
                reader.ReadInt32()));
        }
        if (stream.Position != stream.Length)
            throw new InvalidDataException("EMEVD event snapshot 含未声明尾部字节。");
        var build = new EmevdEventBuild(id, restBehavior, instructions, parameters);
        ValidateEventBuilds(new[] { build });
        if (!HashEventBuild(build).Equals(expectedEventHash, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("EMEVD event snapshot 解码后的语义 hash 不匹配。");
        return build;
    }

    internal static byte[] EncodeInstructionSnapshot(
        EmevdInstructionBuild instruction,
        IReadOnlyList<EmevdParameter> parameters)
    {
        using var stream = new MemoryStream();
        using (var writer = new BinaryWriter(stream, System.Text.Encoding.UTF8, leaveOpen: true))
        {
            writer.Write(instruction.Bank);
            writer.Write(instruction.Id);
            writer.Write(instruction.LayerOffset);
            writer.Write(instruction.Args.Length);
            writer.Write(instruction.Args);
            writer.Write(parameters.Count);
            foreach (var parameter in parameters)
            {
                writer.Write(parameter.TargetStartByte);
                writer.Write(parameter.SourceStartByte);
                writer.Write(parameter.ByteCount);
                writer.Write(parameter.UnkId);
            }
        }
        var bytes = stream.ToArray();
        if (bytes.Length > MaxInstructionSnapshotBytes)
            throw new InvalidDataException("EMEVD instruction snapshot 超过 256 KiB inline 安全上限。");
        return bytes;
    }

    internal static EmevdInstructionSnapshotBuild DecodeInstructionSnapshot(
        string snapshotBase64,
        string snapshotSha256,
        string expectedInstructionHash,
        string formatId,
        string snapshotSchemaVersion)
    {
        if (!formatId.Equals(InstructionSnapshotFormatId, StringComparison.Ordinal)
            || !snapshotSchemaVersion.Equals(InstructionSnapshotSchemaVersion, StringComparison.Ordinal))
            throw new InvalidDataException("EMEVD instruction snapshot format/schema 不受支持。");
        if (snapshotBase64.Any(char.IsWhiteSpace))
            throw new InvalidDataException("EMEVD instruction snapshot 必须使用无空白规范 Base64。");
        byte[] bytes;
        try { bytes = Convert.FromBase64String(snapshotBase64); }
        catch (FormatException ex) { throw new InvalidDataException("EMEVD instruction snapshot Base64 非法。", ex); }
        if (!Convert.ToBase64String(bytes).Equals(snapshotBase64, StringComparison.Ordinal))
            throw new InvalidDataException("EMEVD instruction snapshot 必须使用规范标准 Base64 编码。");
        if (bytes.Length < 24 || bytes.Length > MaxInstructionSnapshotBytes)
            throw new InvalidDataException("EMEVD instruction snapshot 大小超出安全边界。");
        var actualHash = Hash(bytes);
        if (!actualHash.Equals(snapshotSha256, StringComparison.OrdinalIgnoreCase)
            || !actualHash.Equals(expectedInstructionHash, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("EMEVD instruction snapshot hash/instructionHash 不匹配。");

        using var stream = new MemoryStream(bytes, writable: false);
        using var reader = new BinaryReader(stream, System.Text.Encoding.UTF8, leaveOpen: true);
        var bank = reader.ReadInt32();
        var instructionId = reader.ReadInt32();
        var layerOffset = reader.ReadInt64();
        var argsLength = reader.ReadInt32();
        if (argsLength < 0
            || argsLength > MaxArgsBytes
            || argsLength > stream.Length - stream.Position)
            throw new InvalidDataException("EMEVD instruction snapshot args 长度无效。");
        var instruction = new EmevdInstructionBuild(
            bank,
            instructionId,
            layerOffset,
            reader.ReadBytes(argsLength));
        var parameterCount = reader.ReadInt32();
        if (parameterCount < 0 || parameterCount > MaxInstructionSnapshotParameters)
            throw new InvalidDataException("EMEVD instruction snapshot parameterCount 超出安全上限。");
        var parameters = new List<EmevdParameter>(parameterCount);
        for (var parameterIndex = 0; parameterIndex < parameterCount; parameterIndex++)
        {
            var parameter = new EmevdParameter(
                0,
                reader.ReadInt64(),
                reader.ReadInt64(),
                reader.ReadInt32(),
                reader.ReadInt32());
            ValidateParameterByteRange(parameter, instruction.Args.Length, 0, parameterIndex);
            parameters.Add(parameter);
        }
        if (stream.Position != stream.Length)
            throw new InvalidDataException("EMEVD instruction snapshot 含未声明尾部字节。");
        var snapshot = new EmevdInstructionSnapshotBuild(instruction, parameters);
        if (!Hash(EncodeInstructionSnapshot(snapshot.Instruction, snapshot.Parameters))
            .Equals(expectedInstructionHash, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("EMEVD instruction snapshot 解码后的语义 hash 不匹配。");
        return snapshot;
    }

    private static string HashInstructionBuild(
        EmevdInstructionBuild instruction,
        IReadOnlyList<EmevdParameter> parameters) =>
        Hash(EncodeInstructionSnapshot(instruction, parameters));

    /// <summary>
    /// Full document GC rebuild: events + instructions + args + parameters; preserves linked/strings.
    /// Layer bank must be empty (layerCount==0).
    /// </summary>
    public byte[] RebuildWithEventBuilds(IReadOnlyList<EmevdEventBuild> builds)
    {
        if (builds.Count > MaxEvents)
            throw new InvalidDataException($"事件数 {builds.Count} 超过上限。");
        var totalInstr = builds.Sum(b => b.Instructions.Count);
        if (totalInstr > MaxInstructions)
            throw new InvalidDataException($"指令数 {totalInstr} 超过上限。");
        var totalParams = builds.Sum(b => b.Parameters.Count);
        if (totalParams > MaxParameterSubstitutions)
            throw new InvalidDataException($"参数替换数 {totalParams} 超过上限。");
        long paddedArgsLength = 0;
        foreach (var instruction in builds.SelectMany(build => build.Instructions))
        {
            if (instruction.Args.Length > MaxArgsBytes)
                throw new InvalidDataException("单条 EMEVD 指令参数超过安全上限。");
            paddedArgsLength = checked(paddedArgsLength + ((instruction.Args.Length + 3L) / 4L) * 4L);
        }
        if (paddedArgsLength > MaxArgsBytes)
            throw new InvalidDataException($"EMEVD 参数银行重建大小 {paddedArgsLength} 超过上限。");
        ValidateEventBuilds(builds);

        // Linked files + strings from original
        var linkedCount = ReadInt64(SourceBytes, 0x60);
        var linkedBytes = SourceBytes.AsSpan(
            checked((int)LinkedFilesOffset),
            checked((int)(StringsOffset - LinkedFilesOffset))).ToArray();
        var stringBytes = SourceBytes.AsSpan(
            checked((int)StringsOffset),
            checked((int)StringsLength)).ToArray();

        using var ms = new MemoryStream();
        using var bw = new BinaryWriter(ms);

        // Header placeholder
        bw.Write("EVD\0"u8);
        bw.Write((byte)0x00);
        bw.Write((byte)0xFF);
        bw.Write((byte)0x01);
        bw.Write((byte)0xFF);
        bw.Write(0xCD); // version
        bw.Write(0); // filesize later
        // varints from 0x10
        WriteInt64(bw, builds.Count);
        WriteInt64(bw, 0); // events offset later
        WriteInt64(bw, totalInstr);
        WriteInt64(bw, 0); // instructions offset later
        WriteInt64(bw, 0); // unk count
        WriteInt64(bw, 0); // unk offset later
        WriteInt64(bw, 0); // layer count
        WriteInt64(bw, 0); // layers offset later
        WriteInt64(bw, totalParams);
        WriteInt64(bw, 0); // parameters offset later
        WriteInt64(bw, linkedCount);
        WriteInt64(bw, 0); // linked offset later
        WriteInt64(bw, 0); // args length later
        WriteInt64(bw, 0); // args offset later
        WriteInt64(bw, stringBytes.Length);
        WriteInt64(bw, 0); // strings offset later

        // Events
        var eventsPos = ms.Position;
        var eventInstrOffsets = new long[builds.Count];
        var eventParamOffsets = new long[builds.Count];
        long instrCursor = 0;
        long paramCursor = 0;
        for (var i = 0; i < builds.Count; i++)
        {
            var b = builds[i];
            eventInstrOffsets[i] = b.Instructions.Count > 0 ? instrCursor * InstructionSize : -1;
            eventParamOffsets[i] = b.Parameters.Count > 0 ? paramCursor * ParameterSize : -1;
            WriteInt64(bw, b.Id);
            WriteInt64(bw, b.Instructions.Count);
            WriteInt64(bw, eventInstrOffsets[i]);
            WriteInt64(bw, b.Parameters.Count);
            WriteInt64(bw, eventParamOffsets[i]);
            bw.Write(b.RestBehavior);
            bw.Write(0);
            instrCursor += b.Instructions.Count;
            paramCursor += b.Parameters.Count;
        }

        // Instructions (args offsets filled after args bank written — write placeholders)
        var instructionsPos = ms.Position;
        var argOffsetPlaceholders = new List<(long position, int eventIndex, int instrIndex)>();
        for (var ei = 0; ei < builds.Count; ei++)
        {
            var b = builds[ei];
            for (var ii = 0; ii < b.Instructions.Count; ii++)
            {
                var instr = b.Instructions[ii];
                bw.Write(instr.Bank);
                bw.Write(instr.Id);
                WriteInt64(bw, instr.Args.Length);
                argOffsetPlaceholders.Add((ms.Position, ei, ii));
                WriteInt64(bw, 0); // args offset placeholder
                WriteInt64(bw, instr.LayerOffset);
            }
        }

        var unkPos = ms.Position; // offset3

        // Layers empty — layers offset = current
        var layersPos = ms.Position;

        // Arguments
        var argsPos = ms.Position;
        var argsOffsets = new Dictionary<(int, int), long>();
        for (var ei = 0; ei < builds.Count; ei++)
        {
            var b = builds[ei];
            for (var ii = 0; ii < b.Instructions.Count; ii++)
            {
                var args = b.Instructions[ii].Args;
                if (args.Length == 0)
                {
                    argsOffsets[(ei, ii)] = -1;
                    continue;
                }
                argsOffsets[(ei, ii)] = ms.Position - argsPos;
                bw.Write(args);
                var pad = (4 - (args.Length % 4)) % 4;
                if (pad > 0) bw.Write(new byte[pad]);
            }
        }
        // pad args bank to 0x10
        var argsLen = ms.Position - argsPos;
        var argsPad = (0x10 - (argsLen % 0x10)) % 0x10;
        if (argsPad > 0) bw.Write(new byte[argsPad]);
        var argsLenFinal = ms.Position - argsPos;

        // Fill instruction arg offsets
        var afterArgs = ms.Position;
        foreach (var (position, ei, ii) in argOffsetPlaceholders)
        {
            ms.Position = position;
            WriteInt64(bw, argsOffsets[(ei, ii)]);
        }
        ms.Position = afterArgs;

        // Parameters
        var paramsPos = ms.Position;
        foreach (var b in builds)
        {
            foreach (var p in b.Parameters)
            {
                WriteInt64(bw, p.InstructionIndex);
                WriteInt64(bw, p.TargetStartByte);
                WriteInt64(bw, p.SourceStartByte);
                bw.Write(p.ByteCount);
                bw.Write(p.UnkId);
            }
        }

        // Linked + strings
        var linkedPos = ms.Position;
        bw.Write(linkedBytes);
        var stringsPos = ms.Position;
        bw.Write(stringBytes);

        var fileSize = checked((int)ms.Position);

        // Patch header offsets
        ms.Position = 0x0C;
        bw.Write(fileSize);
        ms.Position = 0x18;
        WriteInt64(bw, eventsPos);
        ms.Position = 0x28;
        WriteInt64(bw, instructionsPos);
        ms.Position = 0x38;
        WriteInt64(bw, unkPos);
        ms.Position = 0x48;
        WriteInt64(bw, layersPos);
        ms.Position = 0x58;
        WriteInt64(bw, paramsPos);
        ms.Position = 0x68;
        WriteInt64(bw, linkedPos);
        ms.Position = 0x70;
        WriteInt64(bw, argsLenFinal);
        ms.Position = 0x78;
        WriteInt64(bw, argsPos);
        ms.Position = 0x88;
        WriteInt64(bw, stringsPos);

        var bytes = ms.ToArray();
        // Validate by reparse
        _ = Read(bytes);
        return bytes;
    }

    public byte[] ApplyMutations(IReadOnlyList<EmevdPatch> patches)
    {
        var builds = CaptureEventBuilds();
        var needsGc = false;
        byte[]? workingInPlace = null;

        foreach (var patch in patches)
        {
            switch (patch.Kind)
            {
                case "set_rest_behavior":
                {
                    var idx = ResolveEventIndex(builds, patch.EventId, patch.EventIndex, "event");
                    if (patch.RestBehavior is null)
                        throw new InvalidDataException("set_rest_behavior 需要 restBehavior。");
                    var cur = builds[idx];
                    builds[idx] = cur with { RestBehavior = (uint)patch.RestBehavior.Value };
                    break;
                }
                case "update_id":
                {
                    var idx = ResolveEventIndex(builds, patch.EventId, patch.EventIndex, "event");
                    if (patch.NewEventId is null) throw new InvalidDataException("update_id 需要 newEventId。");
                    if (builds.Any(e => e.Id == patch.NewEventId.Value))
                        throw new InvalidDataException($"EMEVD 新事件 ID {patch.NewEventId} 已存在。");
                    var cur = builds[idx];
                    builds[idx] = cur with { Id = patch.NewEventId.Value };
                    break;
                }
                case "set_instruction_args":
                {
                    if (patch.ArgsBase64 is null)
                        throw new InvalidDataException("set_instruction_args 需要 argsBase64。");
                    var args = DecodeArgsBase64(patch.ArgsBase64);

                    int eventIndex;
                    int instrIndex;
                    // Prefer event-local identity binding when provided.
                    if (patch.EventIndex is not null && patch.InstructionLocalIndex is not null)
                    {
                        eventIndex = ResolveEventIndex(builds, patch.EventId, patch.EventIndex, "event");
                        instrIndex = ResolveInstructionIndex(
                            builds[eventIndex],
                            patch.InstructionLocalIndex,
                            patch.ExpectedBank,
                            patch.ExpectedInstructionId,
                            "instruction");
                    }
                    else
                    {
                        if (patch.InstructionIndex is null)
                            throw new InvalidDataException(
                                "set_instruction_args 需要 instructionIndex，或 eventIndex+instructionLocalIndex。");
                        // Map global instruction index → event/instr
                        var global = checked((int)patch.InstructionIndex.Value);
                        var mapped = MapGlobalInstruction(builds, global);
                        eventIndex = mapped.eventIndex;
                        instrIndex = mapped.instrIndex;
                        if (patch.ExpectedBank is not null || patch.ExpectedInstructionId is not null)
                        {
                            var check = builds[eventIndex].Instructions[instrIndex];
                            if (patch.ExpectedBank is not null && check.Bank != patch.ExpectedBank.Value)
                                throw new InvalidDataException("set_instruction_args expectedBank 不匹配。");
                            if (patch.ExpectedInstructionId is not null
                                && check.Id != patch.ExpectedInstructionId.Value)
                                throw new InvalidDataException("set_instruction_args expectedInstructionId 不匹配。");
                        }
                    }

                    var list = builds[eventIndex].Instructions;
                    var prev = list[instrIndex];
                    list[instrIndex] = prev with { Args = args };
                    // Length change requires full GC rebuild of instruction/arg banks.
                    if (args.Length != prev.Args.Length)
                        needsGc = true;
                    break;
                }
                case "add_instruction":
                {
                    var eventIndex = ResolveEventIndex(builds, patch.EventId, patch.EventIndex, "event");
                    if (patch.InstructionLocalIndex is null || patch.NewBank is null
                        || patch.NewInstructionId is null || patch.ArgsBase64 is null)
                        throw new InvalidDataException(
                            "add_instruction 需要 instructionIndex、bank、id 和 argsBase64。");
                    var ev = builds[eventIndex];
                    var insertionIndex = patch.InstructionLocalIndex.Value;
                    if (insertionIndex < 0 || insertionIndex > ev.Instructions.Count)
                        throw new InvalidDataException($"EMEVD instructionIndex {insertionIndex} 越界。");
                    var args = DecodeArgsBase64(patch.ArgsBase64);
                    ShiftParametersForInsert(ev, insertionIndex);
                    ev.Instructions.Insert(insertionIndex, new EmevdInstructionBuild(
                        patch.NewBank.Value,
                        patch.NewInstructionId.Value,
                        -1,
                        args));
                    needsGc = true;
                    break;
                }
                case "insert_instruction_snapshot":
                {
                    var eventIndex = ResolveEventIndex(builds, patch.EventId, patch.EventIndex, "event");
                    if (patch.InstructionLocalIndex is null
                        || patch.InstructionSnapshotBase64 is null
                        || patch.InstructionSnapshotSha256 is null
                        || patch.ExpectedInstructionHash is null
                        || patch.InstructionSnapshotFormatId is null
                        || patch.InstructionSnapshotSchemaVersion is null)
                        throw new InvalidDataException(
                            "insert_instruction_snapshot 缺少完整 snapshot 字段。");
                    var ev = builds[eventIndex];
                    var insertionIndex = patch.InstructionLocalIndex.Value;
                    if (insertionIndex < 0 || insertionIndex > ev.Instructions.Count)
                        throw new InvalidDataException("insert_instruction_snapshot 的插入索引越界。");
                    var restored = DecodeInstructionSnapshot(
                        patch.InstructionSnapshotBase64,
                        patch.InstructionSnapshotSha256,
                        patch.ExpectedInstructionHash,
                        patch.InstructionSnapshotFormatId,
                        patch.InstructionSnapshotSchemaVersion);
                    ShiftParametersForInsert(ev, insertionIndex);
                    ev.Instructions.Insert(insertionIndex, restored.Instruction);
                    InsertInstructionParameters(
                        ev,
                        insertionIndex,
                        restored.Parameters);
                    needsGc = true;
                    break;
                }
                case "delete_instruction":
                {
                    var eventIndex = ResolveEventIndex(builds, patch.EventId, patch.EventIndex, "event");
                    var ev = builds[eventIndex];
                    var instructionIndex = ResolveInstructionIndex(
                        ev,
                        patch.InstructionLocalIndex,
                        patch.ExpectedBank,
                        patch.ExpectedInstructionId,
                        "instruction");
                    if (ev.Instructions.Count <= 1)
                        throw new InvalidDataException("不能删除事件中的最后一条指令。");
                    RemoveInstruction(ev, instructionIndex);
                    needsGc = true;
                    break;
                }
                case "duplicate_instruction":
                {
                    var eventIndex = ResolveEventIndex(builds, patch.EventId, patch.EventIndex, "event");
                    var ev = builds[eventIndex];
                    var instructionIndex = ResolveInstructionIndex(
                        ev,
                        patch.InstructionLocalIndex,
                        patch.ExpectedBank,
                        patch.ExpectedInstructionId,
                        "instruction");
                    var insertionIndex = instructionIndex + 1;
                    var source = ev.Instructions[instructionIndex];
                    var clonedParameters = ev.Parameters
                        .Where(parameter => parameter.InstructionIndex == instructionIndex)
                        .Select(parameter => parameter with { InstructionIndex = insertionIndex })
                        .ToList();
                    ShiftParametersForInsert(ev, insertionIndex);
                    ev.Instructions.Insert(insertionIndex, source with { Args = source.Args.ToArray() });
                    InsertInstructionParameters(ev, insertionIndex, clonedParameters);
                    needsGc = true;
                    break;
                }
                case "reorder_instruction":
                {
                    var eventIndex = ResolveEventIndex(builds, patch.EventId, patch.EventIndex, "event");
                    var ev = builds[eventIndex];
                    var instructionIndex = ResolveInstructionIndex(
                        ev,
                        patch.InstructionLocalIndex,
                        patch.ExpectedBank,
                        patch.ExpectedInstructionId,
                        "instruction");
                    int? beforeIndex = null;
                    if (patch.BeforeInstructionIndex is not null
                        || patch.BeforeExpectedBank is not null
                        || patch.BeforeExpectedInstructionId is not null)
                    {
                        if (patch.BeforeInstructionIndex is null
                            || patch.BeforeExpectedBank is null
                            || patch.BeforeExpectedInstructionId is null)
                            throw new InvalidDataException(
                                "reorder_instruction 的 beforeInstruction identity 必须完整提供或全部省略。");
                        beforeIndex = ResolveInstructionIndex(
                            ev,
                            patch.BeforeInstructionIndex,
                            patch.BeforeExpectedBank,
                            patch.BeforeExpectedInstructionId,
                            "beforeInstruction");
                    }
                    MoveInstructionBefore(ev, instructionIndex, beforeIndex);
                    needsGc = true;
                    break;
                }
                case "add_event":
                {
                    if (patch.NewEventId is null)
                        throw new InvalidDataException("add_event 需要 newEventId。");
                    if (builds.Any(e => e.Id == patch.NewEventId.Value))
                        throw new InvalidDataException($"EMEVD 事件 ID {patch.NewEventId} 已存在。");
                    var rest = patch.RestBehavior is null ? 0u : (uint)patch.RestBehavior.Value;
                    builds.Add(new EmevdEventBuild(
                        patch.NewEventId.Value,
                        rest,
                        new List<EmevdInstructionBuild>(),
                        new List<EmevdParameter>()));
                    needsGc = true;
                    break;
                }
                case "insert_event_snapshot":
                {
                    if (patch.InsertEventIndex is null
                        || patch.EventSnapshotBase64 is null
                        || patch.EventSnapshotSha256 is null
                        || patch.ExpectedEventHash is null
                        || patch.EventSnapshotFormatId is null
                        || patch.EventSnapshotSchemaVersion is null)
                        throw new InvalidDataException("insert_event_snapshot 缺少完整 snapshot 字段。");
                    if (patch.InsertEventIndex.Value < 0 || patch.InsertEventIndex.Value > builds.Count)
                        throw new InvalidDataException("insert_event_snapshot 的插入索引越界。");
                    var restored = DecodeEventSnapshot(
                        patch.EventSnapshotBase64,
                        patch.EventSnapshotSha256,
                        patch.ExpectedEventHash,
                        patch.EventSnapshotFormatId,
                        patch.EventSnapshotSchemaVersion);
                    if (restored.Id != patch.EventId)
                        throw new InvalidDataException("insert_event_snapshot 的 eventId 与 snapshot 不一致。");
                    builds.Insert(patch.InsertEventIndex.Value, restored);
                    needsGc = true;
                    break;
                }
                case "delete_event":
                {
                    var idx = ResolveEventIndex(builds, patch.EventId, patch.EventIndex, "event");
                    if (builds.Count <= 1)
                        throw new InvalidDataException("不能删除最后一个事件。");
                    builds.RemoveAt(idx);
                    needsGc = true;
                    break;
                }
                case "duplicate_event":
                {
                    var idx = ResolveEventIndex(builds, patch.EventId, patch.EventIndex, "event");
                    if (patch.NewEventId is null)
                        throw new InvalidDataException("duplicate_event 需要 newEventId。");
                    if (builds.Any(e => e.Id == patch.NewEventId.Value))
                        throw new InvalidDataException($"EMEVD 新事件 ID {patch.NewEventId} 已存在。");
                    var src = builds[idx];
                    var copyInstr = src.Instructions
                        .Select(i => i with { Args = i.Args.ToArray() })
                        .ToList();
                    var copyParams = src.Parameters.ToList();
                    builds.Add(new EmevdEventBuild(patch.NewEventId.Value, src.RestBehavior, copyInstr, copyParams));
                    needsGc = true;
                    break;
                }
                case "reorder_event":
                {
                    var idx = ResolveEventIndex(builds, patch.EventId, patch.EventIndex, "event");
                    if ((patch.BeforeEventId is null) != (patch.BeforeEventIndex is null))
                        throw new InvalidDataException(
                            "reorder_event 的 beforeEventId 与 beforeEventIndex 必须同时提供或同时省略。");
                    int insertionIndex;
                    if (patch.BeforeEventId is long beforeEventId
                        && patch.BeforeEventIndex is int beforeEventIndex)
                    {
                        var beforeIndex = ResolveEventIndex(
                            builds,
                            beforeEventId,
                            beforeEventIndex,
                            "beforeEvent");
                        if (idx == beforeIndex)
                            throw new InvalidDataException("reorder_event 的 event 与 beforeEvent 不能是同一项。");
                        insertionIndex = idx < beforeIndex ? beforeIndex - 1 : beforeIndex;
                    }
                    else
                    {
                        insertionIndex = builds.Count - 1;
                    }
                    if (insertionIndex == idx)
                        throw new InvalidDataException("reorder_event 不允许不改变顺序的空操作。");
                    var moved = builds[idx];
                    builds.RemoveAt(idx);
                    builds.Insert(insertionIndex, moved);
                    needsGc = true;
                    break;
                }
                default:
                    throw new InvalidDataException($"未知或尚未支持的 EMEVD mutation：{patch.Kind}。");
            }
        }

        if (needsGc)
            return RebuildWithEventBuilds(builds);

        // In-place path when event count unchanged: rewrite event table + optional args
        // First apply event field changes
        var nextEvents = Events.ToList();
        for (var i = 0; i < builds.Count; i++)
        {
            var b = builds[i];
            var prev = nextEvents[i];
            nextEvents[i] = prev with { Id = b.Id, RestBehavior = b.RestBehavior };
        }
        workingInPlace = RebuildEvents(nextEvents);
        var mid = Read(workingInPlace);
        // Apply any instruction arg changes from builds
        for (var ei = 0; ei < builds.Count; ei++)
        {
            var b = builds[ei];
            var ev = mid.Events[ei];
            if (ev.InstructionCount == 0) continue;
            var start = checked((int)(ev.InstructionsOffset / InstructionSize));
            for (var ii = 0; ii < b.Instructions.Count; ii++)
            {
                var want = b.Instructions[ii].Args;
                var have = mid.Instructions[start + ii].Args;
                if (!want.AsSpan().SequenceEqual(have))
                {
                    workingInPlace = mid.RebuildInstructionArgs(start + ii, want);
                    mid = Read(workingInPlace);
                }
            }
        }
        return workingInPlace;
    }

    private static (int eventIndex, int instrIndex) MapGlobalInstruction(
        IReadOnlyList<EmevdEventBuild> builds, int globalIndex)
    {
        var cursor = 0;
        for (var ei = 0; ei < builds.Count; ei++)
        {
            var count = builds[ei].Instructions.Count;
            if (globalIndex < cursor + count)
                return (ei, globalIndex - cursor);
            cursor += count;
        }
        throw new InvalidDataException($"EMEVD 指令索引 {globalIndex} 越界。");
    }

    private static int ResolveEventIndex(
        IReadOnlyList<EmevdEventBuild> builds,
        long eventId,
        int? eventIndex,
        string label)
    {
        if (eventIndex is not null)
        {
            if (eventIndex.Value < 0 || eventIndex.Value >= builds.Count)
                throw new InvalidDataException($"EMEVD {label}Index {eventIndex} 越界。");
            if (builds[eventIndex.Value].Id != eventId)
                throw new InvalidDataException($"EMEVD {label}Index 与 expected {label}Id 不匹配。");
            return eventIndex.Value;
        }

        var matches = builds
            .Select((build, index) => (build.Id, index))
            .Where(item => item.Id == eventId)
            .Select(item => item.index)
            .Take(2)
            .ToArray();
        if (matches.Length == 0)
            throw new InvalidDataException($"EMEVD {label} ID {eventId} 不存在。");
        if (matches.Length > 1)
            throw new InvalidDataException($"EMEVD {label} ID {eventId} 重复，mutation 必须提供 {label}Index。");
        return matches[0];
    }

    private static int ResolveInstructionIndex(
        EmevdEventBuild ev,
        int? instructionIndex,
        int? expectedBank,
        int? expectedInstructionId,
        string label)
    {
        if (instructionIndex is null || expectedBank is null || expectedInstructionId is null)
            throw new InvalidDataException(
                $"EMEVD {label} 需要 instructionIndex、expectedBank 和 expectedInstructionId。");
        if (instructionIndex.Value < 0 || instructionIndex.Value >= ev.Instructions.Count)
            throw new InvalidDataException($"EMEVD {label}Index {instructionIndex} 越界。");
        var instruction = ev.Instructions[instructionIndex.Value];
        if (instruction.Bank != expectedBank.Value || instruction.Id != expectedInstructionId.Value)
            throw new InvalidDataException(
                $"EMEVD {label}Index 与 expected bank/id 不匹配。");
        return instructionIndex.Value;
    }

    private static void ShiftParametersForInsert(EmevdEventBuild ev, int insertionIndex)
    {
        for (var i = 0; i < ev.Parameters.Count; i++)
        {
            var parameter = ev.Parameters[i];
            if (parameter.InstructionIndex >= insertionIndex)
                ev.Parameters[i] = parameter with { InstructionIndex = parameter.InstructionIndex + 1 };
        }
    }

    private static void RemoveInstruction(EmevdEventBuild ev, int instructionIndex)
    {
        ev.Instructions.RemoveAt(instructionIndex);
        for (var i = ev.Parameters.Count - 1; i >= 0; i--)
        {
            var parameter = ev.Parameters[i];
            if (parameter.InstructionIndex == instructionIndex)
            {
                ev.Parameters.RemoveAt(i);
            }
            else if (parameter.InstructionIndex > instructionIndex)
            {
                ev.Parameters[i] = parameter with { InstructionIndex = parameter.InstructionIndex - 1 };
            }
        }
    }

    private static void MoveInstructionBefore(
        EmevdEventBuild ev,
        int instructionIndex,
        int? beforeInstructionIndex)
    {
        if (instructionIndex == beforeInstructionIndex)
            throw new InvalidDataException(
                "reorder_instruction 的 instruction 与 beforeInstruction 不能是同一项。");
        var oldOrder = Enumerable.Range(0, ev.Instructions.Count).ToList();
        var movedInstruction = ev.Instructions[instructionIndex];
        var movedOldIndex = oldOrder[instructionIndex];
        ev.Instructions.RemoveAt(instructionIndex);
        oldOrder.RemoveAt(instructionIndex);
        var insertionIndex = beforeInstructionIndex is null
            ? ev.Instructions.Count
            : instructionIndex < beforeInstructionIndex.Value
                ? beforeInstructionIndex.Value - 1
                : beforeInstructionIndex.Value;
        if (insertionIndex == instructionIndex)
            throw new InvalidDataException("reorder_instruction 不允许不改变顺序的空操作。");
        ev.Instructions.Insert(insertionIndex, movedInstruction);
        oldOrder.Insert(insertionIndex, movedOldIndex);

        var oldToNew = new int[oldOrder.Count];
        for (var newIndex = 0; newIndex < oldOrder.Count; newIndex++)
            oldToNew[oldOrder[newIndex]] = newIndex;
        for (var i = 0; i < ev.Parameters.Count; i++)
        {
            var parameter = ev.Parameters[i];
            ev.Parameters[i] = parameter with
            {
                InstructionIndex = oldToNew[checked((int)parameter.InstructionIndex)]
            };
        }
    }

    private static void InsertInstructionParameters(
        EmevdEventBuild ev,
        int instructionIndex,
        IReadOnlyList<EmevdParameter> parameters)
    {
        if (parameters.Count == 0) return;
        var restored = parameters.Select(parameter =>
            parameter with { InstructionIndex = instructionIndex }).ToList();
        var parameterInsertionIndex = ev.Parameters.FindIndex(parameter =>
            parameter.InstructionIndex > instructionIndex);
        if (parameterInsertionIndex < 0) parameterInsertionIndex = ev.Parameters.Count;
        ev.Parameters.InsertRange(parameterInsertionIndex, restored);
    }

    private static byte[] DecodeArgsBase64(string value)
    {
        if (value.Any(char.IsWhiteSpace))
            throw new InvalidDataException("argsBase64 必须是无空白的标准 Base64。");
        byte[] args;
        try { args = Convert.FromBase64String(value); }
        catch (FormatException ex) { throw new InvalidDataException("argsBase64 非法。", ex); }
        if (!Convert.ToBase64String(args).Equals(value, StringComparison.Ordinal))
            throw new InvalidDataException("argsBase64 必须使用规范标准 Base64 编码。");
        if (args.Length > MaxArgsBytes)
            throw new InvalidDataException("单条 EMEVD 指令参数超过安全上限。");
        return args;
    }

    private static void ValidateEventBuilds(IReadOnlyList<EmevdEventBuild> builds)
    {
        for (var eventIndex = 0; eventIndex < builds.Count; eventIndex++)
        {
            var ev = builds[eventIndex];
            for (var parameterIndex = 0; parameterIndex < ev.Parameters.Count; parameterIndex++)
            {
                var parameter = ev.Parameters[parameterIndex];
                if (parameter.InstructionIndex < 0
                    || parameter.InstructionIndex >= ev.Instructions.Count)
                    throw new InvalidDataException(
                        $"EMEVD 事件[{eventIndex}] parameter[{parameterIndex}] 指令索引越界。");
                ValidateParameterByteRange(
                    parameter,
                    ev.Instructions[checked((int)parameter.InstructionIndex)].Args.Length,
                    eventIndex,
                    parameterIndex);
            }
        }
    }

    private static void ValidateParameterTarget(
        EmevdParameter parameter,
        EmevdEvent ev,
        IReadOnlyList<EmevdInstruction> instructions,
        int instructionStart,
        int eventIndex,
        int parameterIndex)
    {
        if (parameter.InstructionIndex < 0 || parameter.InstructionIndex >= ev.InstructionCount)
            throw new InvalidDataException(
                $"EMEVD 事件[{eventIndex}] parameter[{parameterIndex}] 指令索引越界。");
        var instruction = instructions[checked(instructionStart + (int)parameter.InstructionIndex)];
        ValidateParameterByteRange(
            parameter,
            instruction.Args.Length,
            eventIndex,
            parameterIndex);
    }

    private static void ValidateParameterByteRange(
        EmevdParameter parameter,
        int argsLength,
        int eventIndex,
        int parameterIndex)
    {
        if (parameter.TargetStartByte < 0 || parameter.SourceStartByte < 0
            || parameter.ByteCount <= 0
            || parameter.TargetStartByte > argsLength
            || parameter.ByteCount > argsLength - parameter.TargetStartByte)
            throw new InvalidDataException(
                $"EMEVD 事件[{eventIndex}] parameter[{parameterIndex}] 字节范围无效。");
    }

    public object ToEnvelope(
        EmevdRoundTripReport? report = null,
        EmevdSourceInfo? source = null,
        int? focusEventIndex = null,
        int? focusInstructionLocalIndex = null,
        int? snapshotEventIndex = null,
        long? snapshotEventIdOverride = null,
        int? snapshotInstructionEventIndex = null,
        int? snapshotInstructionLocalIndex = null,
        int? instructionOrderEventIndex = null,
        EmevdInstructionAuthoringRequest? instructionAuthoringRequest = null)
    {
        report ??= VerifyRoundTrip();
        const int sampleLimit = 256;
        const int parameterSampleLimit = 256;
        var eventBuilds = CaptureEventBuilds();
        var sample = Instructions.Take(sampleLimit).Select((instr, index) => new
        {
            index,
            instr.Bank,
            instr.Id,
            argsLength = instr.Args.Length,
            argsBase64 = Convert.ToBase64String(instr.Args),
            layerOffset = instr.LayerOffset
        }).ToArray();
        object? focusedInstruction = null;
        if (focusEventIndex is not null && focusInstructionLocalIndex is not null)
        {
            if (focusEventIndex.Value < 0 || focusEventIndex.Value >= Events.Count)
                throw new InvalidDataException($"EMEVD focusEventIndex {focusEventIndex} 越界。");
            var focusEvent = Events[focusEventIndex.Value];
            if (focusInstructionLocalIndex.Value < 0
                || focusInstructionLocalIndex.Value >= focusEvent.InstructionCount)
                throw new InvalidDataException(
                    $"EMEVD focusInstructionLocalIndex {focusInstructionLocalIndex} 越界。");
            var globalStart = checked((int)(focusEvent.InstructionsOffset / InstructionSize));
            var globalIndex = globalStart + focusInstructionLocalIndex.Value;
            var instr = Instructions[globalIndex];
            var instructionBuild = eventBuilds[focusEventIndex.Value]
                .Instructions[focusInstructionLocalIndex.Value];
            var instructionParameters = eventBuilds[focusEventIndex.Value].Parameters
                .Where(parameter => parameter.InstructionIndex == focusInstructionLocalIndex.Value)
                .ToList();
            focusedInstruction = new
            {
                eventId = focusEvent.Id,
                eventIndex = focusEventIndex.Value,
                instructionIndex = focusInstructionLocalIndex.Value,
                globalInstructionIndex = globalIndex,
                bank = instr.Bank,
                id = instr.Id,
                argsLength = instr.Args.Length,
                argsBase64 = Convert.ToBase64String(instr.Args),
                layerOffset = instr.LayerOffset,
                parameterCount = instructionParameters.Count,
                instructionHash = HashInstructionBuild(instructionBuild, instructionParameters)
            };
        }
        var parameterSubstitutionCount = EventParameters.Sum(parameters => parameters.Count);
        var parameterSubstitutionSample = EventParameters
            .SelectMany((parameters, eventIndex) => parameters.Select((parameter, parameterIndex) => new
            {
                eventIndex,
                parameterIndex,
                instructionIndex = parameter.InstructionIndex,
                targetStartByte = parameter.TargetStartByte,
                sourceStartByte = parameter.SourceStartByte,
                byteCount = parameter.ByteCount,
                unkId = parameter.UnkId
            }))
            .Take(parameterSampleLimit)
            .ToArray();

        object? focusedEventSnapshot = null;
        if (snapshotEventIndex is not null)
        {
            if (snapshotEventIndex.Value < 0 || snapshotEventIndex.Value >= eventBuilds.Count)
                throw new InvalidDataException($"EMEVD snapshotEventIndex {snapshotEventIndex} 越界。");
            var sourceBuild = eventBuilds[snapshotEventIndex.Value];
            if (snapshotEventIdOverride is not null
                && eventBuilds.Any(candidate => candidate.Id == snapshotEventIdOverride.Value))
                throw new InvalidDataException("EMEVD snapshotEventIdOverride 必须是当前文档中不存在的新事件 ID。");
            var build = snapshotEventIdOverride is null
                ? sourceBuild
                : sourceBuild with { Id = snapshotEventIdOverride.Value };
            var snapshotBytes = EncodeEventSnapshot(build);
            var snapshotHash = Hash(snapshotBytes);
            focusedEventSnapshot = new
            {
                eventId = build.Id,
                eventIndex = snapshotEventIdOverride is null
                    ? snapshotEventIndex.Value
                    : eventBuilds.Count,
                eventHash = snapshotHash,
                restBehavior = build.RestBehavior,
                instructionCount = build.Instructions.Count,
                parameterCount = build.Parameters.Count,
                sourceEventId = sourceBuild.Id,
                sourceEventIndex = snapshotEventIndex.Value,
                sourceEventHash = HashEventBuild(sourceBuild),
                snapshotFormatId = EventSnapshotFormatId,
                snapshotSchemaVersion = EventSnapshotSchemaVersion,
                snapshotBase64 = Convert.ToBase64String(snapshotBytes),
                snapshotSha256 = snapshotHash,
                snapshotSize = snapshotBytes.Length
            };
        }
        object? focusedInstructionSnapshot = null;
        if ((snapshotInstructionEventIndex is null) != (snapshotInstructionLocalIndex is null))
            throw new InvalidDataException(
                "EMEVD instruction snapshot 的 event/local index 必须同时提供。");
        if (snapshotInstructionEventIndex is not null
            && snapshotInstructionLocalIndex is not null)
        {
            if (snapshotInstructionEventIndex.Value < 0
                || snapshotInstructionEventIndex.Value >= eventBuilds.Count)
                throw new InvalidDataException(
                    $"EMEVD snapshotInstructionEventIndex {snapshotInstructionEventIndex} 越界。");
            var eventBuild = eventBuilds[snapshotInstructionEventIndex.Value];
            ValidateInstructionSnapshotParameterOrder(eventBuild);
            if (snapshotInstructionLocalIndex.Value < 0
                || snapshotInstructionLocalIndex.Value >= eventBuild.Instructions.Count)
                throw new InvalidDataException(
                    $"EMEVD snapshotInstructionLocalIndex {snapshotInstructionLocalIndex} 越界。");
            var instruction = eventBuild.Instructions[snapshotInstructionLocalIndex.Value];
            var parameters = eventBuild.Parameters
                .Where(parameter => parameter.InstructionIndex == snapshotInstructionLocalIndex.Value)
                .ToList();
            var snapshotBytes = EncodeInstructionSnapshot(instruction, parameters);
            var snapshotHash = Hash(snapshotBytes);
            focusedInstructionSnapshot = new
            {
                eventId = eventBuild.Id,
                eventIndex = snapshotInstructionEventIndex.Value,
                eventHash = HashEventBuild(eventBuild),
                instructionIndex = snapshotInstructionLocalIndex.Value,
                bank = instruction.Bank,
                id = instruction.Id,
                layerOffset = instruction.LayerOffset,
                argsLength = instruction.Args.Length,
                argsBase64 = Convert.ToBase64String(instruction.Args),
                parameterCount = parameters.Count,
                instructionHash = snapshotHash,
                snapshotFormatId = InstructionSnapshotFormatId,
                snapshotSchemaVersion = InstructionSnapshotSchemaVersion,
                snapshotBase64 = Convert.ToBase64String(snapshotBytes),
                snapshotSha256 = snapshotHash,
                snapshotSize = snapshotBytes.Length
            };
        }
        object? focusedEventInstructionOrder = null;
        if (instructionOrderEventIndex is not null)
        {
            if (instructionOrderEventIndex.Value < 0
                || instructionOrderEventIndex.Value >= eventBuilds.Count)
                throw new InvalidDataException(
                    $"EMEVD instructionOrderEventIndex {instructionOrderEventIndex} 越界。");
            var eventBuild = eventBuilds[instructionOrderEventIndex.Value];
            ValidateInstructionSnapshotParameterOrder(eventBuild);
            // The order projection is an all-or-nothing semantic guard. Reuse the
            // bounded event snapshot encoder so a very large event fails closed
            // instead of returning an unbounded eager payload.
            _ = EncodeEventSnapshot(eventBuild);
            var instructions = eventBuild.Instructions.Select((instruction, instructionIndex) =>
            {
                var parameters = eventBuild.Parameters
                    .Where(parameter => parameter.InstructionIndex == instructionIndex)
                    .ToList();
                return new
                {
                    instructionIndex,
                    bank = instruction.Bank,
                    id = instruction.Id,
                    instructionHash = HashInstructionBuild(instruction, parameters),
                    parameterCount = parameters.Count
                };
            }).ToArray();
            focusedEventInstructionOrder = new
            {
                eventId = eventBuild.Id,
                eventIndex = instructionOrderEventIndex.Value,
                eventHash = HashEventBuild(eventBuild),
                instructionCount = eventBuild.Instructions.Count,
                parameterCount = eventBuild.Parameters.Count,
                instructions
            };
        }
        object? authoredInstructionSnapshot = null;
        if (instructionAuthoringRequest is not null)
        {
            var request = instructionAuthoringRequest;
            if (request.EventIndex < 0 || request.EventIndex >= eventBuilds.Count)
                throw new InvalidDataException(
                    $"EMEVD authorInstructionEventIndex {request.EventIndex} 越界。");
            var eventBuild = eventBuilds[request.EventIndex];
            ValidateInstructionSnapshotParameterOrder(eventBuild);
            if (request.InstructionIndex < 0
                || request.InstructionIndex > eventBuild.Instructions.Count)
                throw new InvalidDataException(
                    $"EMEVD authorInstructionIndex {request.InstructionIndex} 越界。");
            var args = DecodeArgsBase64(request.ArgsBase64);
            var instruction = new EmevdInstructionBuild(
                request.Bank,
                request.InstructionId,
                -1,
                args);
            var snapshotBytes = EncodeInstructionSnapshot(
                instruction,
                Array.Empty<EmevdParameter>());
            var snapshotHash = Hash(snapshotBytes);
            authoredInstructionSnapshot = new
            {
                eventId = eventBuild.Id,
                eventIndex = request.EventIndex,
                eventHash = HashEventBuild(eventBuild),
                instructionIndex = request.InstructionIndex,
                bank = instruction.Bank,
                id = instruction.Id,
                layerOffset = instruction.LayerOffset,
                argsLength = instruction.Args.Length,
                argsBase64 = Convert.ToBase64String(instruction.Args),
                parameterCount = 0,
                instructionHash = snapshotHash,
                snapshotFormatId = InstructionSnapshotFormatId,
                snapshotSchemaVersion = InstructionSnapshotSchemaVersion,
                snapshotBase64 = Convert.ToBase64String(snapshotBytes),
                snapshotSha256 = snapshotHash,
                snapshotSize = snapshotBytes.Length
            };
        }
        var events = Events.Select((e, index) =>
        {
            var start = e.InstructionCount > 0 ? e.InstructionsOffset / InstructionSize : -1L;
            return new
            {
                id = e.Id,
                eventIndex = index,
                eventHash = HashEventBuild(eventBuilds[index]),
                instructionCount = e.InstructionCount,
                instructionsOffset = e.InstructionsOffset,
                instructionStartIndex = start,
                parameterCount = e.ParameterCount,
                parametersOffset = e.ParametersOffset,
                restBehavior = e.RestBehavior
            };
        }).ToArray();

        return new
        {
            format = "EMEVD",
            version = "0xCD",
            versionBytes = "00FF01FF",
            sourceSize = source?.SourceSize ?? SourceBytes.Length,
            sourceHash = source?.SourceHash ?? SourceHash,
            documentSize = SourceBytes.Length,
            documentHash = SourceHash,
            documentRevision = source?.SourceHash ?? SourceHash,
            schemaId = SchemaId,
            schemaVersion = SchemaVersion,
            layoutFingerprint = LayoutFingerprint,
            containerKind = source?.ContainerKind ?? "raw",
            compressionFormat = source?.CompressionFormat,
            containerRoundTrip = source?.ContainerRoundTrip,
            writeSupported = source?.WriteSupported ?? true,
            eventCount = Events.Count,
            instructionCount = Instructions.Count,
            parameterSubstitutionCount,
            eventsOffset = EventsOffset,
            instructionsOffset = InstructionsOffset,
            argumentsOffset = ArgumentsOffset,
            argumentsLength = ArgumentsLength,
            layerCount = LayerCount,
            events,
            instructionsSample = sample,
            instructionsSampleTruncated = Instructions.Count > sampleLimit,
            focusedInstruction,
            focusedEventSnapshot,
            focusedInstructionSnapshot,
            focusedEventInstructionOrder,
            authoredInstructionSnapshot,
            parameterSubstitutionSample,
            parameterSubstitutionSampleTruncated = parameterSubstitutionCount > parameterSampleLimit,
            roundTrip = report,
            authority = report is { SemanticIdentical: true, ByteIdentical: true }
                ? "native-verified"
                : "candidate",
            instructionDecode = "raw-args-base64; typed EMEDF optional in TypeScript",
            parameterTargetValidation = "event-local-instruction-and-argument-range-verified",
            supportsEventGc = true,
            supportsInstructionGc = true
        };
    }

    private static void WriteInt64(BinaryWriter bw, long value)
    {
        Span<byte> buf = stackalloc byte[8];
        BinaryPrimitives.WriteInt64LittleEndian(buf, value);
        bw.Write(buf);
    }

    private static int ReadInt32(byte[] source, int offset) =>
        BinaryPrimitives.ReadInt32LittleEndian(source.AsSpan(offset, 4));
    private static uint ReadUInt32(byte[] source, int offset) =>
        BinaryPrimitives.ReadUInt32LittleEndian(source.AsSpan(offset, 4));
    private static long ReadInt64(byte[] source, int offset) =>
        BinaryPrimitives.ReadInt64LittleEndian(source.AsSpan(offset, 8));
    private static void WriteInt32(byte[] target, int offset, int value) =>
        BinaryPrimitives.WriteInt32LittleEndian(target.AsSpan(offset, 4), value);
    private static void WriteUInt32(byte[] target, int offset, uint value) =>
        BinaryPrimitives.WriteUInt32LittleEndian(target.AsSpan(offset, 4), value);
    private static void WriteInt64(byte[] target, int offset, long value) =>
        BinaryPrimitives.WriteInt64LittleEndian(target.AsSpan(offset, 8), value);
    private static string Hash(byte[] bytes) =>
        Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static string HashEventBuild(EmevdEventBuild build)
        => Hash(EncodeEventSnapshot(build));

    private static void ValidateInstructionSnapshotParameterOrder(EmevdEventBuild build)
    {
        for (var index = 1; index < build.Parameters.Count; index++)
        {
            if (build.Parameters[index - 1].InstructionIndex
                > build.Parameters[index].InstructionIndex)
                throw new InvalidDataException(
                    "EMEVD parameter substitution 表未按 instructionIndex 分组；instruction typed snapshot/order 暂不支持该布局。");
        }
    }
}

internal sealed record EmevdEvent(
    long Id,
    long InstructionCount,
    long InstructionsOffset,
    long ParameterCount,
    long ParametersOffset,
    uint RestBehavior);

internal sealed record EmevdInstruction(
    int Bank,
    int Id,
    long ArgsLength,
    long ArgsOffset,
    long LayerOffset,
    byte[] Args);

internal sealed record EmevdParameter(
    long InstructionIndex,
    long TargetStartByte,
    long SourceStartByte,
    int ByteCount,
    int UnkId);

internal sealed record EmevdInstructionBuild(
    int Bank,
    int Id,
    long LayerOffset,
    byte[] Args);

internal sealed record EmevdEventBuild(
    long Id,
    uint RestBehavior,
    List<EmevdInstructionBuild> Instructions,
    List<EmevdParameter> Parameters);

internal sealed record EmevdInstructionSnapshotBuild(
    EmevdInstructionBuild Instruction,
    List<EmevdParameter> Parameters);

internal sealed record EmevdInstructionAuthoringRequest(
    int EventIndex,
    int InstructionIndex,
    int Bank,
    int InstructionId,
    string ArgsBase64);

internal sealed record EmevdPatch(
    string Kind,
    long EventId,
    long? RestBehavior,
    long? NewEventId,
    long? InstructionIndex = null,
    string? ArgsBase64 = null,
    long? BeforeEventId = null,
    int? EventIndex = null,
    int? BeforeEventIndex = null,
    int? InstructionLocalIndex = null,
    int? ExpectedBank = null,
    int? ExpectedInstructionId = null,
    int? BeforeInstructionIndex = null,
    int? BeforeExpectedBank = null,
    int? BeforeExpectedInstructionId = null,
    int? NewBank = null,
    int? NewInstructionId = null,
    int? InsertEventIndex = null,
    string? EventSnapshotBase64 = null,
    string? EventSnapshotSha256 = null,
    string? ExpectedEventHash = null,
    string? EventSnapshotFormatId = null,
    string? EventSnapshotSchemaVersion = null,
    string? InstructionSnapshotBase64 = null,
    string? InstructionSnapshotSha256 = null,
    string? ExpectedInstructionHash = null,
    string? InstructionSnapshotFormatId = null,
    string? InstructionSnapshotSchemaVersion = null);

internal sealed record EmevdRoundTripReport(
    bool ByteIdentical,
    bool SemanticIdentical,
    string SourceHash,
    string RebuiltHash,
    int EventCount,
    long InstructionCount);
