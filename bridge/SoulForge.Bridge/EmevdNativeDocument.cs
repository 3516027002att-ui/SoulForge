using System.Buffers.Binary;
using System.Security.Cryptography;

/// <summary>
/// Sekiro EMEVD (EVD\0, format flags 00 FF 01 FF, version 0xCD) native document.
/// Layout matches SoulsFormats Game.Sekiro (64-bit varints).
/// Supports in-place event field edits, equal-length arg writes, and full GC rebuild for event add/delete.
/// </summary>
internal sealed class EmevdNativeDocument
{
    private const int HeaderSize = 0x90;
    private const int EventSize = 0x30;
    private const int InstructionSize = 0x20;
    private const int ParameterSize = 0x20;
    private const int MaxEvents = 200_000;
    private const int MaxInstructions = 2_000_000;
    private const int MaxSourceBytes = 64 * 1024 * 1024;
    private const int MaxArgsBytes = 1 * 1024 * 1024;

    private EmevdNativeDocument(
        byte[] sourceBytes,
        long eventsOffset,
        long instructionsOffset,
        long argumentsOffset,
        long argumentsLength,
        long parametersOffset,
        long linkedFilesOffset,
        long stringsOffset,
        long stringsLength,
        IReadOnlyList<EmevdEvent> events,
        IReadOnlyList<EmevdInstruction> instructions)
    {
        SourceBytes = sourceBytes;
        EventsOffset = eventsOffset;
        InstructionsOffset = instructionsOffset;
        ArgumentsOffset = argumentsOffset;
        ArgumentsLength = argumentsLength;
        ParametersOffset = parametersOffset;
        LinkedFilesOffset = linkedFilesOffset;
        StringsOffset = stringsOffset;
        StringsLength = stringsLength;
        Events = events;
        Instructions = instructions;
    }

    public byte[] SourceBytes { get; }
    public long EventsOffset { get; }
    public long InstructionsOffset { get; }
    public long ArgumentsOffset { get; }
    public long ArgumentsLength { get; }
    public long ParametersOffset { get; }
    public long LinkedFilesOffset { get; }
    public long StringsOffset { get; }
    public long StringsLength { get; }
    public IReadOnlyList<EmevdEvent> Events { get; }
    public IReadOnlyList<EmevdInstruction> Instructions { get; }
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
            throw new NotSupportedException("EMEVD 含 layer 表时的 GC 重建尚未启用；就地 mutation 仍可用。");
        if (eventsOffset < HeaderSize || eventsOffset + eventCount * EventSize > source.Length)
            throw new InvalidDataException("EMEVD 事件表越界。");
        if (instructionsOffset < eventsOffset
            || instructionsOffset + instructionCount * InstructionSize > source.Length)
            throw new InvalidDataException("EMEVD 指令表越界。");
        if (argumentsOffset < 0 || argumentsLength < 0
            || argumentsOffset + argumentsLength > source.Length)
            throw new InvalidDataException("EMEVD 参数银行越界。");
        if (argumentsLength > MaxArgsBytes)
            throw new InvalidDataException($"EMEVD 参数银行过大：{argumentsLength}。");
        if (parametersOffset < 0 || parametersOffset > source.Length)
            throw new InvalidDataException("EMEVD parametersOffset 越界。");
        if (linkedFilesOffset < 0 || linkedFilesOffset > source.Length)
            throw new InvalidDataException("EMEVD linkedFilesOffset 越界。");
        if (stringsOffset < 0 || stringsLength < 0 || stringsOffset + stringsLength > source.Length)
            throw new InvalidDataException("EMEVD 字符串段越界。");
        if (paramCountHeader < 0 || paramCountHeader > MaxEvents * 64)
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
            if (parameterCount < 0)
                throw new InvalidDataException($"EMEVD 事件 {id} parameterCount 越界。");
            if (parameterCount > 0)
            {
                if (eventParamsOffset < 0
                    || parametersOffset + eventParamsOffset + parameterCount * ParameterSize > source.Length)
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
                if (argsOffset < 0 || argsOffset + argsLength > argumentsLength)
                    throw new InvalidDataException($"EMEVD 指令[{i}] argsOffset 越界。");
                var abs = checked((int)(argumentsOffset + argsOffset));
                args = source.AsSpan(abs, (int)argsLength).ToArray();
            }
            instructions.Add(new EmevdInstruction(bank, id, argsLength, argsOffset, layerOffset, args));
        }

        return new EmevdNativeDocument(
            source, eventsOffset, instructionsOffset, argumentsOffset, argumentsLength,
            parametersOffset, linkedFilesOffset, stringsOffset, stringsLength,
            events, instructions);
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
        return new EmevdRoundTripReport(
            SourceBytes.SequenceEqual(rebuilt),
            eventsEqual && instrEqual,
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
        foreach (var ev in Events)
        {
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
            var parameters = new List<EmevdParameter>();
            if (ev.ParameterCount > 0)
            {
                var baseOff = checked((int)(ParametersOffset + ev.ParametersOffset));
                for (var i = 0; i < ev.ParameterCount; i++)
                {
                    var o = baseOff + i * ParameterSize;
                    parameters.Add(new EmevdParameter(
                        ReadInt64(SourceBytes, o),
                        ReadInt64(SourceBytes, o + 8),
                        ReadInt64(SourceBytes, o + 16),
                        ReadInt32(SourceBytes, o + 24),
                        ReadInt32(SourceBytes, o + 28)));
                }
            }
            builds.Add(new EmevdEventBuild(ev.Id, ev.RestBehavior, instrs, parameters));
        }
        return builds;
    }

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
                    var idx = builds.FindIndex(e => e.Id == patch.EventId);
                    if (idx < 0) throw new InvalidDataException($"EMEVD 事件 ID {patch.EventId} 不存在。");
                    if (patch.RestBehavior is null)
                        throw new InvalidDataException("set_rest_behavior 需要 restBehavior。");
                    var cur = builds[idx];
                    builds[idx] = cur with { RestBehavior = (uint)patch.RestBehavior.Value };
                    break;
                }
                case "update_id":
                {
                    var idx = builds.FindIndex(e => e.Id == patch.EventId);
                    if (idx < 0) throw new InvalidDataException($"EMEVD 事件 ID {patch.EventId} 不存在。");
                    if (patch.NewEventId is null) throw new InvalidDataException("update_id 需要 newEventId。");
                    if (builds.Any(e => e.Id == patch.NewEventId.Value))
                        throw new InvalidDataException($"EMEVD 新事件 ID {patch.NewEventId} 已存在。");
                    var cur = builds[idx];
                    builds[idx] = cur with { Id = patch.NewEventId.Value };
                    break;
                }
                case "set_instruction_args":
                {
                    if (patch.InstructionIndex is null)
                        throw new InvalidDataException("set_instruction_args 需要 instructionIndex。");
                    if (patch.ArgsBase64 is null)
                        throw new InvalidDataException("set_instruction_args 需要 argsBase64。");
                    byte[] args;
                    try { args = Convert.FromBase64String(patch.ArgsBase64); }
                    catch (FormatException ex) { throw new InvalidDataException("argsBase64 非法。", ex); }

                    // Map global instruction index → event/instr
                    var global = checked((int)patch.InstructionIndex.Value);
                    var mapped = MapGlobalInstruction(builds, global);
                    var list = builds[mapped.eventIndex].Instructions;
                    var prev = list[mapped.instrIndex];
                    list[mapped.instrIndex] = prev with { Args = args };
                    // Length change requires full GC rebuild of instruction/arg banks.
                    if (args.Length != prev.Args.Length)
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
                case "delete_event":
                {
                    var idx = builds.FindIndex(e => e.Id == patch.EventId);
                    if (idx < 0) throw new InvalidDataException($"EMEVD 事件 ID {patch.EventId} 不存在。");
                    if (builds.Count <= 1)
                        throw new InvalidDataException("不能删除最后一个事件。");
                    builds.RemoveAt(idx);
                    needsGc = true;
                    break;
                }
                case "duplicate_event":
                {
                    var idx = builds.FindIndex(e => e.Id == patch.EventId);
                    if (idx < 0) throw new InvalidDataException($"EMEVD 事件 ID {patch.EventId} 不存在。");
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

    public object ToEnvelope(EmevdRoundTripReport? report = null)
    {
        report ??= VerifyRoundTrip();
        const int sampleLimit = 256;
        var sample = Instructions.Take(sampleLimit).Select((instr, index) => new
        {
            index,
            instr.Bank,
            instr.Id,
            argsLength = instr.Args.Length,
            argsBase64 = Convert.ToBase64String(instr.Args),
            layerOffset = instr.LayerOffset
        }).ToArray();

        var events = Events.Select(e =>
        {
            var start = e.InstructionCount > 0 ? e.InstructionsOffset / InstructionSize : -1L;
            return new
            {
                id = e.Id,
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
            sourceSize = SourceBytes.Length,
            sourceHash = SourceHash,
            eventCount = Events.Count,
            instructionCount = Instructions.Count,
            eventsOffset = EventsOffset,
            instructionsOffset = InstructionsOffset,
            argumentsOffset = ArgumentsOffset,
            argumentsLength = ArgumentsLength,
            events,
            instructionsSample = sample,
            instructionsSampleTruncated = Instructions.Count > sampleLimit,
            roundTrip = report,
            authority = report is { SemanticIdentical: true, ByteIdentical: true }
                ? "native-verified"
                : "candidate",
            instructionDecode = "raw-args-base64; typed EMEDF optional in TypeScript",
            supportsEventGc = true
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

internal sealed record EmevdPatch(
    string Kind,
    long EventId,
    long? RestBehavior,
    long? NewEventId,
    long? InstructionIndex = null,
    string? ArgsBase64 = null);

internal sealed record EmevdRoundTripReport(
    bool ByteIdentical,
    bool SemanticIdentical,
    string SourceHash,
    string RebuiltHash,
    int EventCount,
    long InstructionCount);
