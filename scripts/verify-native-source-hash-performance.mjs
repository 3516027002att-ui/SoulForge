/**
 * Native PARAM/MSB SourceHash 性能回归。
 *
 * 这个回归不启动 Bridge，也不构建或覆盖生产 EXE。运行时把当前 checkout
 * 中的四个最小 Bridge 源文件复制到临时 C# 项目，给 Hash 加测试计数器，
 * 然后用合成的 PARAM/MSB 文档反复模拟语义导出中的「每行/每实体读取
 * SourceHash」。计数器比 wall-clock 阈值更稳定：每个不可变 document 应只
 * 对 SourceBytes 做一次 SHA-256；新 document 必须重新计算并得到新 hash。
 *
 * 用法：
 *   node scripts/verify-native-source-hash-performance.mjs
 *
 * 目标框架自动选择本机 dotnet SDK 支持的最高 netX.0（生产 Bridge 使用的
 * net10 若未安装时可退到本机已有 SDK，例如 net6）；这只验证 C# 源码行为，
 * 不把兼容性退级误报成 production Bridge 构建成功。
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOTNET = process.env.SOULFORGE_DOTNET?.trim() || 'dotnet';
const BUILD_TIMEOUT_MS = 180_000;
const RUN_TIMEOUT_MS = 60_000;

function xmlEscape(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function runChecked(command, args, { timeout, cwd }) {
  let result;
  try {
    result = execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : '';
    const stderr = typeof error.stderr === 'string' ? error.stderr : '';
    const detail = [stdout, stderr, error.message].filter(Boolean).join('\n').trim();
    const wrapped = new Error(`${command} ${args.join(' ')} 失败：${detail}`);
    wrapped.code = error.status ?? error.code ?? 'command-failed';
    throw wrapped;
  }
  return result;
}

function chooseTargetFramework() {
  const listing = runChecked(DOTNET, ['--list-sdks'], {
    timeout: 30_000,
    cwd: REPO_ROOT
  });
  const majors = [...listing.matchAll(/^\s*(\d+)\.\d+\.\d+/gm)]
    .map((match) => Number(match[1]))
    .filter((major) => Number.isInteger(major) && major > 0);
  if (majors.length === 0) {
    throw new Error('DOTNET_SDK_NOT_FOUND：dotnet --list-sdks 没有返回可用 SDK。');
  }
  return {
    framework: `net${Math.max(...majors)}.0`,
    sdkListing: listing.trim()
  };
}

function instrumentSource(source, kind) {
  const getter = kind === 'param'
    ? 'public string SourceHash => sourceHashMemo ??= Hash(SourceBytes);'
    : 'public string SourceHash => sourceHashMemo ??= Hash(SourceBytes);';
  if (!source.includes(getter)) {
    throw new Error(
      `${kind.toUpperCase()}_SOURCE_HASH_SHAPE_CHANGED：未找到带 memo 的 SourceHash getter，拒绝把测试结果解释为当前实现。`
    );
  }

  const hashExpression = kind === 'param'
    ? 'internal static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();'
    : 'private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();';
  if (!source.includes(hashExpression)) {
    throw new Error(
      `${kind.toUpperCase()}_HASH_SHAPE_CHANGED：未找到预期 Hash 实现，拒绝运行不具可比性的回归。`
    );
  }

  const replacement = kind === 'param'
    ? `internal static string Hash(byte[] bytes)
    {
        PerfHashCounter.Record(bytes.Length);
        return Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    }`
    : `private static string Hash(byte[] bytes)
    {
        PerfHashCounter.Record(bytes.Length);
        return Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    }`;
  return source.replace(hashExpression, replacement);
}

function readBridgeSources() {
  const files = [
    ['ParamNativeDocument.cs', 'param'],
    ['ParamMutationPlan.cs', null],
    ['MsbNativeDocument.cs', 'msb'],
    ['MsbReferencePlan.cs', null]
  ];
  return files.map(([name, kind]) => {
    const path = resolve(REPO_ROOT, 'bridge', 'SoulForge.Bridge', name);
    if (!existsSync(path)) throw new Error(`BRIDGE_SOURCE_MISSING：${path}`);
    const source = readFileSync(path, 'utf8');
    return {
      name,
      source: kind ? instrumentSource(source, kind) : source
    };
  });
}

const COUNTER_SOURCE = String.raw`
using System.Threading;

internal static class PerfHashCounter
{
    private static long calls;
    private static long bytes;

    public static long Calls => Interlocked.Read(ref calls);
    public static long Bytes => Interlocked.Read(ref bytes);

    public static void Reset()
    {
        Interlocked.Exchange(ref calls, 0);
        Interlocked.Exchange(ref bytes, 0);
    }

    public static void Record(int length)
    {
        Interlocked.Increment(ref calls);
        Interlocked.Add(ref bytes, length);
    }
}
`;

const PROGRAM_SOURCE = String.raw`
using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

internal static class Program
{
    private const int ParamRowCount = 4096;
    private const int ParamTrailingBytes = 2 * 1024 * 1024;
    private const int MsbModelCount = 1024;
    private const int MsbEntrySize = 0xA0;

    private static int Main()
    {
        try
        {
            var param = VerifyParam(BuildParam(ParamRowCount, ParamTrailingBytes));
            var msb = VerifyMsb(BuildMsb(MsbModelCount));
            var result = new
            {
                ok = true,
                status = "passed",
                test = "native-source-hash-performance",
                sourceMode = "temporary C# project over current Bridge source snapshot",
                param,
                msb
            };
            Console.WriteLine(JsonSerializer.Serialize(result));
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(JsonSerializer.Serialize(new
            {
                ok = false,
                status = "failed",
                test = "native-source-hash-performance",
                error = error.ToString()
            }));
            return 1;
        }
    }

    private static object VerifyParam(byte[] source)
    {
        var document = ParamNativeDocument.Read(source);
        if (document.Rows.Count != ParamRowCount)
            throw new InvalidDataException($"PARAM 行数不符：{document.Rows.Count} != {ParamRowCount}。");

        var expected = IndependentHash(source);
        PerfHashCounter.Reset();
        var firstHash = document.SourceHash;
        if (!string.Equals(firstHash, expected, StringComparison.Ordinal))
            throw new InvalidDataException("PARAM 首次 SourceHash 与独立 SHA-256 不相等。");

        var repeatedReads = Math.Max(256, document.Rows.Count * 2);
        for (var i = 0; i < repeatedReads; i++)
        {
            if (!string.Equals(document.SourceHash, firstHash, StringComparison.Ordinal))
                throw new InvalidDataException($"PARAM 重复 SourceHash 在第 {i} 次发生变化。");
        }

        var sameDocumentCalls = PerfHashCounter.Calls;
        var sameDocumentBytes = PerfHashCounter.Bytes;
        if (sameDocumentCalls != 1 || sameDocumentBytes != source.LongLength)
        {
            throw new InvalidDataException(
                $"PARAM SourceHash 未呈现一次性缓存：calls={sameDocumentCalls}, bytes={sameDocumentBytes}, sourceBytes={source.LongLength}。");
        }

        var changed = source.ToArray();
        changed[^1] ^= 0x5A;
        var changedDocument = ParamNativeDocument.Read(changed);
        PerfHashCounter.Reset();
        var changedHash = changedDocument.SourceHash;
        if (string.Equals(changedHash, firstHash, StringComparison.Ordinal))
            throw new InvalidDataException("PARAM 新 document 的 SourceHash 没有随源字节变化。");
        if (PerfHashCounter.Calls != 1 || PerfHashCounter.Bytes != changed.LongLength)
            throw new InvalidDataException("PARAM 新 document 没有独立计算一次 SourceHash。");

        return new
        {
            sourceBytes = source.LongLength,
            rows = document.Rows.Count,
            repeatedReads,
            sameDocumentHashCalls = sameDocumentCalls,
            sameDocumentBytesHashed = sameDocumentBytes,
            changedDocumentHashCalls = PerfHashCounter.Calls,
            firstHash,
            changedHash
        };
    }

    private static object VerifyMsb(byte[] source)
    {
        var document = MsbNativeDocument.Read(source);
        if (document.Models.Count != MsbModelCount)
            throw new InvalidDataException($"MSB 模型数不符：{document.Models.Count} != {MsbModelCount}。");

        var expected = IndependentHash(source);
        PerfHashCounter.Reset();
        var firstHash = document.SourceHash;
        if (!string.Equals(firstHash, expected, StringComparison.Ordinal))
            throw new InvalidDataException("MSB 首次 SourceHash 与独立 SHA-256 不相等。");

        var repeatedReads = Math.Max(256, document.Models.Count * 2);
        for (var i = 0; i < repeatedReads; i++)
        {
            if (!string.Equals(document.SourceHash, firstHash, StringComparison.Ordinal))
                throw new InvalidDataException($"MSB 重复 SourceHash 在第 {i} 次发生变化。");
        }

        var sameDocumentCalls = PerfHashCounter.Calls;
        var sameDocumentBytes = PerfHashCounter.Bytes;
        if (sameDocumentCalls != 1 || sameDocumentBytes != source.LongLength)
        {
            throw new InvalidDataException(
                $"MSB SourceHash 未呈现一次性缓存：calls={sameDocumentCalls}, bytes={sameDocumentBytes}, sourceBytes={source.LongLength}。");
        }

        var changed = source.ToArray();
        changed[^1] ^= 0x5A;
        var changedDocument = MsbNativeDocument.Read(changed);
        PerfHashCounter.Reset();
        var changedHash = changedDocument.SourceHash;
        if (string.Equals(changedHash, firstHash, StringComparison.Ordinal))
            throw new InvalidDataException("MSB 新 document 的 SourceHash 没有随源字节变化。");
        if (PerfHashCounter.Calls != 1 || PerfHashCounter.Bytes != changed.LongLength)
            throw new InvalidDataException("MSB 新 document 没有独立计算一次 SourceHash。");

        return new
        {
            sourceBytes = source.LongLength,
            models = document.Models.Count,
            repeatedReads,
            sameDocumentHashCalls = sameDocumentCalls,
            sameDocumentBytesHashed = sameDocumentBytes,
            changedDocumentHashCalls = PerfHashCounter.Calls,
            firstHash,
            changedHash
        };
    }

    private static byte[] BuildParam(int rows, int trailingBytes)
    {
        const int headerSize = 0x40;
        const int rowHeaderSize = 0x0C;
        const int rowDataSize = 16;
        const int typeGap = 0x20;
        const string typeName = "SYNTHETIC_PARAM_ST";

        var directoryEnd = headerSize + rows * rowHeaderSize;
        var dataStart = Align16(directoryEnd);
        var dataEnd = checked(dataStart + rows * rowDataSize);
        var typeNameOffset = checked(dataEnd + typeGap);
        var typeBytes = Encoding.ASCII.GetBytes(typeName + "\0");
        var source = new byte[checked(typeNameOffset + typeBytes.Length + trailingBytes)];

        WriteUInt16(source, 4, checked((ushort)dataStart));
        WriteUInt16(source, 6, 0);
        WriteUInt16(source, 8, 1);
        WriteUInt16(source, 10, checked((ushort)rows));
        WriteInt64(source, 0x10, typeNameOffset);
        source[0x2D] = 0x83; // extended 0x40 row directory + offset ParamType name
        source[0x2E] = 0;

        for (var i = 0; i < rows; i++)
        {
            var rowOffset = headerSize + i * rowHeaderSize;
            WriteInt32(source, rowOffset, 100000 + i);
            WriteUInt32(source, rowOffset + 4, checked((uint)(dataStart + i * rowDataSize)));
            WriteUInt32(source, rowOffset + 8, 0);
            for (var b = 0; b < rowDataSize; b++)
                source[dataStart + i * rowDataSize + b] = checked((byte)((i + b) & 0xFF));
        }

        typeBytes.CopyTo(source, typeNameOffset);
        return source;
    }

    private static byte[] BuildMsb(int modelCount)
    {
        var names = new[]
        {
            "MODEL_PARAM_ST",
            "EVENT_PARAM_ST",
            "POINT_PARAM_ST",
            "ROUTE_PARAM_ST",
            "LAYER_PARAM_ST",
            "PARTS_PARAM_ST",
            "MAPSTUDIO_PARTS_POSE_ST",
            "MAPSTUDIO_BONE_NAME_STRING"
        };
        var starts = new int[names.Length];
        var entryCounts = new int[names.Length];
        entryCounts[0] = modelCount;

        var cursor = 0x10;
        for (var i = 0; i < names.Length; i++)
        {
            starts[i] = cursor;
            var offsetCount = entryCounts[i] + 1;
            cursor = checked(cursor + 16 + offsetCount * 8 + entryCounts[i] * MsbEntrySize);
        }

        var stringCursor = Align16(cursor);
        var paramNameOffsets = new int[names.Length];
        for (var i = 0; i < names.Length; i++)
        {
            paramNameOffsets[i] = stringCursor;
            stringCursor = checked(stringCursor + Encoding.Unicode.GetByteCount(names[i] + "\0"));
        }

        var source = new byte[checked(stringCursor + modelCount * 64 + 32)];
        Encoding.ASCII.GetBytes("MSB ").CopyTo(source, 0);
        WriteInt32(source, 4, 1);

        for (var i = 0; i < names.Length; i++)
        {
            var start = starts[i];
            var offsetCount = entryCounts[i] + 1;
            WriteInt32(source, start, 1);
            WriteInt32(source, start + 4, offsetCount);
            WriteInt64(source, start + 8, paramNameOffsets[i]);

            var entryTable = start + 16;
            var entryStart = entryTable + entryCounts[i] * 8 + 8;
            for (var k = 0; k < entryCounts[i]; k++)
                WriteInt64(source, entryTable + k * 8, entryStart + k * MsbEntrySize);
            var nextOffset = i + 1 < names.Length ? starts[i + 1] : 0;
            WriteInt64(source, entryTable + entryCounts[i] * 8, nextOffset);

            if (i != 0) continue;
            for (var k = 0; k < modelCount; k++)
            {
                var entry = checked((int)(entryStart + k * MsbEntrySize));
                WriteInt64(source, entry, 0x30);
                WriteInt32(source, entry + 8, 0);
                WriteInt64(source, entry + 0x10, 0);
                var modelName = Encoding.Unicode.GetBytes($"MODEL_{k}\0");
                modelName.CopyTo(source, entry + 0x30);
            }
        }

        for (var i = 0; i < names.Length; i++)
            Encoding.Unicode.GetBytes(names[i] + "\0").CopyTo(source, paramNameOffsets[i]);
        return source;
    }

    private static string IndependentHash(byte[] bytes) =>
        Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static int Align16(int value) => checked((value + 0x0F) & ~0x0F);
    private static void WriteInt32(byte[] bytes, int offset, int value) =>
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(offset, 4), value);
    private static void WriteInt64(byte[] bytes, int offset, long value) =>
        BinaryPrimitives.WriteInt64LittleEndian(bytes.AsSpan(offset, 8), value);
    private static void WriteUInt16(byte[] bytes, int offset, ushort value) =>
        BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(offset, 2), value);
    private static void WriteUInt32(byte[] bytes, int offset, uint value) =>
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(offset, 4), value);
}
`;

function writeProject(tempRoot, framework, bridgeSources) {
  for (const { name, source } of bridgeSources) {
    writeFileSync(join(tempRoot, name), source, 'utf8');
  }
  writeFileSync(join(tempRoot, 'PerfHashCounter.cs'), COUNTER_SOURCE, 'utf8');
  writeFileSync(join(tempRoot, 'Program.cs'), PROGRAM_SOURCE, 'utf8');

  const project = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>${xmlEscape(framework)}</TargetFramework>
    <LangVersion>preview</LangVersion>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <AssemblyName>source-hash-perf</AssemblyName>
    <RootNamespace>SourceHashPerf</RootNamespace>
  </PropertyGroup>
</Project>
`;
  const projectPath = join(tempRoot, 'source-hash-perf.csproj');
  writeFileSync(projectPath, project, 'utf8');
  return projectPath;
}

function parseRuntimeResult(output) {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const jsonLine = lines.at(-1);
  if (!jsonLine) throw new Error('PERF_OUTPUT_EMPTY：测试程序没有输出结构化结果。');
  try {
    return JSON.parse(jsonLine);
  } catch (error) {
    throw new Error(`PERF_OUTPUT_INVALID：${error.message}\n${output}`);
  }
}

function main() {
  const { framework, sdkListing } = chooseTargetFramework();
  const tempRoot = mkdtempSync(join(tmpdir(), 'soulforge-source-hash-perf-'));
  try {
    const projectPath = writeProject(tempRoot, framework, readBridgeSources());
    runChecked(DOTNET, ['build', projectPath, '--configuration', 'Release', '--nologo'], {
      timeout: BUILD_TIMEOUT_MS,
      cwd: tempRoot
    });
    const dllPath = join(tempRoot, 'bin', 'Release', framework, 'source-hash-perf.dll');
    const output = runChecked(DOTNET, [dllPath], {
      timeout: RUN_TIMEOUT_MS,
      cwd: tempRoot
    });
    const result = parseRuntimeResult(output);
    if (result?.ok !== true || result?.status !== 'passed') {
      throw new Error(`PERF_RESULT_NOT_PASSED：${JSON.stringify(result)}`);
    }
    console.log(JSON.stringify({
      ...result,
      targetFramework: framework,
      dotnet: DOTNET,
      sdkListing
    }));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    status: 'failed',
    test: 'native-source-hash-performance',
    diagnostics: [{
      code: error.code || 'NATIVE_SOURCE_HASH_PERF_FAILED',
      message: error.message
    }]
  }));
  process.exitCode = 1;
}
