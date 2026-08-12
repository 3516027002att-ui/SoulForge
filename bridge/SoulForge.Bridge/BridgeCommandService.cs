using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

internal sealed class BridgeCommandService
{
    private const int MaxPrefixBytes = 512 * 1024;

    public async Task<BridgeResult<object>> ExecuteAsync(
        string rawCommand,
        string file,
        CancellationToken cancellationToken,
        string? oodleRuntimeRoot = null,
        JsonElement options = default,
        string? outputPath = null)
    {
        var command = rawCommand.Trim().ToLowerInvariant();

        // options 的默认值是 default(JsonElement)，其 ValueKind 为 Undefined。
        // 对 Undefined 调 TryGetProperty 抛 InvalidOperationException
        // ("Operation is not valid due to the current state of the object.")。
        //
        // 实测踩过：read-param-document 在调用方不传 commandOptions 时必然抛这个，
        // 而本方法的 catch 只捕获 InvalidDataException / NotSupportedException /
        // IOException，于是异常逃到守护进程兜底、被压成无出处的
        // BRIDGE_REQUEST_FAILED。表面症状是「PARAM 读不出来」，真实原因是
        // 「分页参数缺省时没有守卫」——两者相差很远，而原来的错误信息指不出方向。
        //
        // 统一走 OptionInt：它先验 ValueKind，缺省即取默认值。
        // 此前 :221 的 EMEVD 分页有 optionsObject 守卫而 PARAM/FLVER 没有，
        // 同一文件里两种写法并存，正是这类缺陷的温床。
        var optionsIsObject = options.ValueKind == JsonValueKind.Object;

        int OptionInt(string name, int fallback)
        {
            if (!optionsIsObject) return fallback;
            if (!options.TryGetProperty(name, out var element)) return fallback;
            if (element.ValueKind != JsonValueKind.Number) return fallback;
            return element.TryGetInt32(out var parsed) ? parsed : fallback;
        }

        var resourceKind = command switch
        {
            "export-event" => "event",
            "export-map" => "map",
            "export-param" => "param",
            "export-msg" => "msg",
            _ => GuessKindFromPath(file)
        };

        if (command == "probe-oodle")
        {
            var probe = OodleRuntimeLocator.Probe(file, BridgeResult<object>.MakeSourceUri(file));
            return BridgeResult<object>.Partial(file, "unknown", probe.Diagnostics, probe);
        }

        if (command == "probe-document-locator")
        {
            return ProbeDocumentLocator(file, oodleRuntimeRoot, resourceKind);
        }

        if (command == "inventory-asset-resources")
        {
            return InventoryAssetResources(file, options, oodleRuntimeRoot, cancellationToken);
        }

        if (!File.Exists(file))
        {
            return BridgeResult<object>.Failed(file, resourceKind, "FILE_NOT_FOUND", "Input file does not exist.");
        }

        cancellationToken.ThrowIfCancellationRequested();
        if (command is "inspect" or "validate")
        {
            return await InspectEnvelopeAsync(file, command == "validate", cancellationToken, oodleRuntimeRoot);
        }

        if (command == "read-dcx-document")
        {
            try
            {
                var document = DcxNativeDocument.Read(file, oodleRuntimeRoot);
                var roundTrip = document.VerifyRoundTrip();
                var diagnostics = new List<Diagnostic>
                {
                    new Diagnostic(
                        roundTrip.PayloadIdentical ? "info" : "warning",
                        roundTrip.PayloadIdentical ? "DCX_DOCUMENT_ROUNDTRIP_PAYLOAD_VERIFIED" : "DCX_DOCUMENT_ROUNDTRIP_UNVERIFIED",
                        roundTrip.PayloadIdentical
                            ? "DCX 完整 payload 重建、重读和哈希验证通过。"
                            : roundTrip.Note ?? "DCX 完整文档 roundtrip 尚未验证。",
                        BridgeResult<object>.MakeSourceUri(file),
                        roundTrip)
                };
                return BridgeResult<object>.Partial(file, GuessKindFromPath(file), diagnostics, document.ToEnvelope(roundTrip));
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or InvalidOperationException or IOException)
            {
                return BridgeResult<object>.Failed(file, GuessKindFromPath(file), "DCX_DOCUMENT_READ_FAILED", ex.Message);
            }
        }

        if (command == "snapshot-bnd4-child")
        {
            try
            {
                var snapshot = Bnd4NativeWriter.SnapshotChild(file, options, oodleRuntimeRoot);
                return BridgeResult<object>.Partial(file, resourceKind, new[]
                {
                    new Diagnostic("info", "BND4_CHILD_SNAPSHOT_CAPTURED", "BND4 子项快照已捕获，可用于条目级逆操作。", BridgeResult<object>.MakeSourceUri(file), snapshot)
                }, snapshot);
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException or ArgumentOutOfRangeException)
            {
                return BridgeResult<object>.Failed(file, resourceKind, "BND4_CHILD_SNAPSHOT_FAILED", ex.Message);
            }
        }

        if (command == "extract-bnd4-child")
        {
            // outputPath 必须用 daemon 已校验并规范化的那一个，不能让 writer 自己再从
            // options 里取原始字符串：daemon 侧对 writable-root 的判定是针对
            // BridgePathBoundary.Verify 的 CanonicalPath 做的，writer 若绕回原始值，
            // 「..」「符号链接」「大小写差异」这类等价路径就能落在校验之外——校验通过、
            // 落盘却在别处。CLI 直调模式没有 daemon 协商的 writableRoots，此时
            // outputPath 为 null，仍回落到 options（与其他 writer 命令一致）。
            if (string.IsNullOrWhiteSpace(outputPath))
            {
                return BridgeResult<object>.Failed(file, resourceKind, "BND4_CHILD_OUTPUT_REQUIRED",
                    "extract-bnd4-child 需要 options.outputPath，且必须经 writable-root 校验。");
            }
            try
            {
                var result = Bnd4NativeWriter.ExtractChild(file, outputPath, options, oodleRuntimeRoot);
                return BridgeResult<object>.Partial(file, resourceKind, new[]
                {
                    new Diagnostic("info", "BND4_CHILD_EXTRACTED", "BND4 子项已提取到文件。", BridgeResult<object>.MakeSourceUri(file), result)
                }, result);
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException or ArgumentOutOfRangeException)
            {
                return BridgeResult<object>.Failed(file, resourceKind, "BND4_CHILD_EXTRACT_FAILED", ex.Message);
            }
        }

        if (command == "read-fmg-document")
        {
            try
            {
                var document = FmgNativeDocument.ReadFile(file);
                var roundTrip = document.VerifyRoundTrip();
                var diagnostics = new[]
                {
                    new Diagnostic(
                        roundTrip.SemanticIdentical ? "info" : "error",
                        roundTrip.SemanticIdentical ? "FMG_DOCUMENT_ROUNDTRIP_SEMANTIC_VERIFIED" : "FMG_DOCUMENT_ROUNDTRIP_FAILED",
                        roundTrip.SemanticIdentical
                            ? (roundTrip.ByteIdentical
                                ? "FMG 无修改往返字节级一致。"
                                : "FMG 无修改往返语义一致（布局归一化后哈希不同仍可接受）。")
                            : "FMG 无修改往返语义不一致。",
                        BridgeResult<object>.MakeSourceUri(file),
                        roundTrip)
                };
                return BridgeResult<object>.Partial(file, "msg", diagnostics, document.ToEnvelope(roundTrip));
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "msg", "FMG_DOCUMENT_READ_FAILED", ex.Message);
            }
        }

        if (command == "write-fmg")
        {
            if (string.IsNullOrWhiteSpace(outputPath))
                return BridgeResult<object>.Failed(file, "msg", "BRIDGE_OUTPUT_PATH_REQUIRED", "FMG writer requires a validated staging output path.");
            try
            {
                var written = await FmgNativeWriter.WriteAsync(file, outputPath, options, cancellationToken);
                return BridgeResult<object>.Partial(file, "msg", new[]
                {
                    new Diagnostic("info", "FMG_STAGING_WRITE_VERIFIED", "FMG 已写入暂存区并重读验证。", BridgeResult<object>.MakeSourceUri(file), written)
                }, written);
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "msg", "FMG_STAGING_WRITE_FAILED", ex.Message);
            }
        }

        if (command == "read-param-document")
        {
            try
            {
                var document = ParamNativeDocument.ReadFile(file);
                var roundTrip = document.VerifyRoundTrip();
                var diagnostics = new[]
                {
                    new Diagnostic(
                        roundTrip.SemanticIdentical ? "info" : "error",
                        roundTrip.SemanticIdentical ? "PARAM_DOCUMENT_ROUNDTRIP_SEMANTIC_VERIFIED" : "PARAM_DOCUMENT_ROUNDTRIP_FAILED",
                        roundTrip.SemanticIdentical
                            ? (roundTrip.ByteIdentical
                                ? "PARAM 无修改往返字节级一致。"
                                : "PARAM 无修改往返语义一致。")
                            : "PARAM 无修改往返语义不一致。",
                        BridgeResult<object>.MakeSourceUri(file),
                        roundTrip)
                };
                // Pagination parameters from the request options.
                var rowPage = OptionInt("rowPage", 0);
                var rowPageSize = OptionInt("rowPageSize", 0);
                // Detect legacy header-embedded type-name layout and fail closed with a clear code.
                return BridgeResult<object>.Partial(file, "param", diagnostics, document.ToEnvelope(roundTrip, rowPageSize: rowPageSize, rowPage: rowPage));
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                var code = ex.Message.Contains("首行数据偏移", StringComparison.Ordinal)
                    ? "PARAM_LAYOUT_UNSUPPORTED"
                    : "PARAM_DOCUMENT_READ_FAILED";
                return BridgeResult<object>.Failed(file, "param", code, ex.Message);
            }
        }

        if (command == "write-param")
        {
            if (string.IsNullOrWhiteSpace(outputPath))
                return BridgeResult<object>.Failed(file, "param", "BRIDGE_OUTPUT_PATH_REQUIRED", "PARAM writer requires a validated staging output path.");
            try
            {
                var written = await ParamNativeWriter.WriteAsync(file, outputPath, options, cancellationToken);
                return BridgeResult<object>.Partial(file, "param", new[]
                {
                    new Diagnostic("info", "PARAM_STAGING_WRITE_VERIFIED", "PARAM 已写入暂存区并重读验证。", BridgeResult<object>.MakeSourceUri(file), written)
                }, written);
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException or FormatException)
            {
                return BridgeResult<object>.Failed(file, "param", "PARAM_STAGING_WRITE_FAILED", ex.Message);
            }
        }

        if (command == "read-emevd-document")
        {
            try
            {
                // Accept raw EMEVD or DFLT-wrapped DCX payload path: caller must pass decompressed EVD bytes file.
                var document = EmevdNativeDocument.ReadFile(file);
                var roundTrip = document.VerifyRoundTrip();
                var optionsObject = options.ValueKind == JsonValueKind.Object;
                var page = optionsObject && options.TryGetProperty("instructionPage", out var pageEl)
                    && pageEl.ValueKind == JsonValueKind.Number && pageEl.TryGetInt32(out var parsedPage)
                    && parsedPage >= 0
                    ? parsedPage
                    : 0;
                var pageSize = optionsObject && options.TryGetProperty("instructionPageSize", out var sizeEl)
                    && sizeEl.ValueKind == JsonValueKind.Number && sizeEl.TryGetInt32(out var parsedSize)
                    && parsedSize >= 1 && parsedSize <= 4096
                    ? parsedSize
                    : 256;
                var diagnostics = new[]
                {
                    new Diagnostic(
                        roundTrip.SemanticIdentical ? "info" : "error",
                        roundTrip.SemanticIdentical ? "EMEVD_DOCUMENT_ROUNDTRIP_SEMANTIC_VERIFIED" : "EMEVD_DOCUMENT_ROUNDTRIP_FAILED",
                        roundTrip.SemanticIdentical
                            ? (roundTrip.ByteIdentical
                                ? "EMEVD 无修改往返字节级一致。"
                                : "EMEVD 事件表语义往返一致。")
                            : "EMEVD 无修改往返语义不一致。",
                        BridgeResult<object>.MakeSourceUri(file),
                        roundTrip)
                };
                return BridgeResult<object>.Partial(file, "event", diagnostics, document.ToEnvelope(roundTrip, page, pageSize));
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "event", "EMEVD_DOCUMENT_READ_FAILED", ex.Message);
            }
        }

        if (command == "write-emevd")
        {
            if (string.IsNullOrWhiteSpace(outputPath))
                return BridgeResult<object>.Failed(file, "event", "BRIDGE_OUTPUT_PATH_REQUIRED", "EMEVD writer requires a validated staging output path.");
            try
            {
                var written = await EmevdNativeWriter.WriteAsync(file, outputPath, options, cancellationToken);
                return BridgeResult<object>.Partial(file, "event", new[]
                {
                    new Diagnostic("info", "EMEVD_STAGING_WRITE_VERIFIED", "EMEVD 已写入暂存区并重读验证。", BridgeResult<object>.MakeSourceUri(file), written)
                }, written);
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "event", "EMEVD_STAGING_WRITE_FAILED", ex.Message);
            }
        }

        if (command == "read-msb-document")
        {
            try
            {
                var document = MsbNativeDocument.ReadFile(file);
                var roundTrip = document.VerifyRoundTrip();
                var diagnostics = new[]
                {
                    new Diagnostic(
                        roundTrip.SemanticIdentical ? "info" : "error",
                        roundTrip.SemanticIdentical ? "MSB_DOCUMENT_ROUNDTRIP_SEMANTIC_VERIFIED" : "MSB_DOCUMENT_ROUNDTRIP_FAILED",
                        roundTrip.SemanticIdentical
                            ? $"MSB 已解析 models={document.Models.Count}, parts={document.Parts.Count}；part transform 可写。"
                            : "MSB 语义往返失败。",
                        BridgeResult<object>.MakeSourceUri(file),
                        roundTrip)
                };
                return BridgeResult<object>.Partial(file, "map", diagnostics, document.ToEnvelope(roundTrip));
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "map", "MSB_DOCUMENT_READ_FAILED", ex.Message);
            }
        }

        if (command == "read-tpf-document")
        {
            try
            {
                var document = TpfNativeDocument.ReadFile(file);
                var roundTrip = document.VerifyRoundTrip();
                var diagnostics = new[]
                {
                    new Diagnostic(
                        roundTrip.ByteIdentical ? "info" : "error",
                        roundTrip.ByteIdentical ? "TPF_DOCUMENT_ROUNDTRIP_BYTE_VERIFIED" : "TPF_DOCUMENT_ROUNDTRIP_FAILED",
                        roundTrip.ByteIdentical
                            ? "TPF 无修改往返字节级一致。"
                            : "TPF 无修改往返字节不一致。",
                        BridgeResult<object>.MakeSourceUri(file),
                        roundTrip)
                };
                return BridgeResult<object>.Partial(file, "texture", diagnostics, document.ToEnvelope(roundTrip));
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "texture", "TPF_DOCUMENT_READ_FAILED", ex.Message);
            }
        }

        if (command == "export-tpf-texture")
        {
            if (string.IsNullOrWhiteSpace(outputPath))
            {
                return BridgeResult<object>.Failed(file, "texture", "TPF_EXPORT_OUTPUT_REQUIRED", "export-tpf-texture 需要 options.outputPath。");
            }
            int textureIndex = 0;
            if (options.ValueKind == JsonValueKind.Object
                && options.TryGetProperty("textureIndex", out var indexElement)
                && indexElement.ValueKind == JsonValueKind.Number)
            {
                textureIndex = indexElement.GetInt32();
            }
            string format = "dds";
            if (options.ValueKind == JsonValueKind.Object
                && options.TryGetProperty("format", out var formatElement)
                && formatElement.ValueKind == JsonValueKind.String)
            {
                format = formatElement.GetString() ?? "dds";
            }
            try
            {
                var document = TpfNativeDocument.ReadFile(file);
                var dds = document.GetTextureData(textureIndex);
                byte[] outputBytes;
                string code;
                string? pngColorSpace = null;
                if (format.Equals("png", StringComparison.OrdinalIgnoreCase))
                {
                    // 必须用带色彩空间的重载：DXGI 的 *_UNORM 与 *_UNORM_SRGB 解出的
                    // 像素值完全相同，区分只存在于头部声明里。丢掉它不会让任何断言
                    // 变红，只会让色彩管理的查看器按自己的假设解释亮度。
                    var (width, height, rgba, colorSpace) = DdsCodec.DecodeDdsWithColorSpace(dds);
                    outputBytes = DdsCodec.EncodePng(width, height, rgba, colorSpace);
                    pngColorSpace = colorSpace switch
                    {
                        DdsCodec.DdsColorSpace.Srgb => "srgb",
                        DdsCodec.DdsColorSpace.Linear => "linear",
                        _ => "unknown"
                    };
                    code = $"PNG {width}x{height}";
                }
                else
                {
                    outputBytes = dds;
                    code = "DDS";
                }
                // temp + Move(overwrite)，与五个 native writer 一致：直接写目标文件时
                // 中途失败（取消、磁盘满）会留下截断的图片，而它看起来像导出成功。
                var exportDirectory = Path.GetDirectoryName(outputPath);
                if (string.IsNullOrEmpty(exportDirectory))
                {
                    return BridgeResult<object>.Failed(file, "texture", "TPF_EXPORT_OUTPUT_INVALID", "outputPath 没有父目录。");
                }
                Directory.CreateDirectory(exportDirectory);
                var exportTemporary = Path.Combine(exportDirectory, $".soulforge-tpf-{Guid.NewGuid():N}.tmp");
                try
                {
                    await File.WriteAllBytesAsync(exportTemporary, outputBytes, cancellationToken);
                    File.Move(exportTemporary, outputPath, overwrite: true);
                }
                finally
                {
                    if (File.Exists(exportTemporary)) File.Delete(exportTemporary);
                }
                var entry = document.Textures[textureIndex];
                var exportDiagnostics = new List<Diagnostic>
                {
                    new Diagnostic("info", "TPF_TEXTURE_EXPORTED",
                        $"TPF 纹理 {textureIndex} 已导出为 {code}（{outputBytes.Length} 字节）。",
                        BridgeResult<object>.MakeSourceUri(file))
                };
                // 色彩空间未声明必须可见：不写诊断的话，「DDS 头没给信息」与「已确认线性」
                // 在产物上完全一样（都没有 sRGB chunk），下游无从区分（硬约束 7/8）。
                if (pngColorSpace == "unknown")
                {
                    exportDiagnostics.Add(new Diagnostic("warn", "TPF_TEXTURE_COLOR_SPACE_UNDECLARED",
                        "DDS 头未声明色彩空间（非 DX10 的 fourCC 形态不携带该信息），"
                        + "PNG 因此不写 sRGB/gAMA/cHRM chunk。这是「未声明」而非「已确认线性」；"
                        + "色彩管理的查看器会按自身默认假设解释，亮度可能与游戏内不一致。",
                        BridgeResult<object>.MakeSourceUri(file)));
                }
                return BridgeResult<object>.Partial(file, "texture", exportDiagnostics.ToArray(), new
                {
                    textureIndex,
                    name = entry.Name,
                    format,
                    outputPath,
                    byteLength = outputBytes.Length,
                    // 只在 PNG 路径有意义；DDS 直传不解码也不重写头，故为 null。
                    colorSpace = pngColorSpace
                });
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException or ArgumentOutOfRangeException)
            {
                return BridgeResult<object>.Failed(file, "texture", "TPF_TEXTURE_EXPORT_FAILED", ex.Message);
            }
        }

        if (command == "read-tae-document")
        {
            try
            {
                var document = TaeNativeDocument.ReadFile(file);
                var roundTrip = document.VerifyRoundTrip();
                var diagnostics = new[]
                {
                    new Diagnostic(
                        roundTrip.SemanticIdentical ? "info" : "error",
                        roundTrip.SemanticIdentical ? "TAE_DOCUMENT_ROUNDTRIP_VERIFIED" : "TAE_DOCUMENT_ROUNDTRIP_FAILED",
                        roundTrip.SemanticIdentical
                            ? $"TAE 只读往返验证通过；animations={document.Animations.Count}, events={document.TotalEventCount}, groups={document.TotalGroupCount}。"
                            : "TAE 只读往返语义不一致。",
                        BridgeResult<object>.MakeSourceUri(file),
                        roundTrip)
                };
                return BridgeResult<object>.Partial(file, "action", diagnostics, document.ToEnvelope(roundTrip));
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "action", "TAE_DOCUMENT_READ_FAILED", ex.Message);
            }
        }

        if (command == "read-flver-document")
        {
            try
            {
                var document = FlverNativeDocument.ReadFile(file);
                var roundTrip = document.VerifyRoundTrip();
                // 措辞与判据对齐：FLVER 无 writer，能验证的只是「同一输入两次解析
                // 得到相同结论」，不是「重建后逐字节一致」。旧码 *_ROUNDTRIP_BYTE_VERIFIED
                // 对一个只读解析器是过强表述，会被读成无损可写的证据。
                var diagnostics = new[]
                {
                    new Diagnostic(
                        roundTrip.ByteIdentical ? "info" : "error",
                        roundTrip.ByteIdentical ? "FLVER_DOCUMENT_REPARSE_DETERMINISTIC" : "FLVER_DOCUMENT_REPARSE_NONDETERMINISTIC",
                        roundTrip.ByteIdentical
                            ? $"FLVER 重解析确定（只读，无 writer；不构成无损可写声明）；materials={document.MaterialCount}, bones={document.BoneCount}, meshes={document.MeshCount}。"
                            : "FLVER 重解析结果不确定：同一输入两次解析结论不同。",
                        BridgeResult<object>.MakeSourceUri(file),
                        roundTrip)
                };
                return BridgeResult<object>.Partial(file, "chr", diagnostics, document.ToEnvelope(roundTrip));
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "chr", "FLVER_DOCUMENT_READ_FAILED", ex.Message);
            }
        }

        if (command == "read-flver-mesh")
        {
            try
            {
                var document = FlverNativeDocument.ReadFile(file);
                // 同 PARAM：不传 commandOptions 时裸 TryGetProperty 会抛。
                var meshIndex = OptionInt("meshIndex", 0);
                var maxVertices = OptionInt("maxVertices", 10_000);
                var maxIndices = OptionInt("maxIndices", 30_000);
                var positions = document.GetMeshPositionsBase64(meshIndex, maxVertices);
                var indices = document.GetMeshIndicesBase64(meshIndex, maxIndices);
                var uvs = document.GetMeshUVsBase64(meshIndex, maxVertices);
                var normals = document.GetMeshNormalsBase64(meshIndex, maxVertices);
                var boneWeights = document.GetMeshBoneWeightsBase64(meshIndex, maxVertices);
                var boneIndices = document.GetMeshBoneIndicesBase64(meshIndex, maxVertices);
                if (positions == null)
                    return BridgeResult<object>.Failed(file, "chr", "FLVER_MESH_NOT_FOUND", $"网格索引 {meshIndex} 超出范围或数据不可用。");
                var mesh = document.Meshes[meshIndex];
                return BridgeResult<object>.Partial(file, "chr", new[]
                {
                    new Diagnostic("info", "FLVER_MESH_DATA_EXTRACTED",
                        $"FLVER 网格 {meshIndex} 顶点/索引/UV/法线/骨骼权重/骨骼索引数据已提取；vertexCount={mesh.VertexCount}。",
                        BridgeResult<object>.MakeSourceUri(file))
                }, new
                {
                    meshIndex,
                    vertexCount = mesh.VertexCount,
                    vertexStride = mesh.VertexStride,
                    bufferLayoutIndex = mesh.BufferLayoutIndex,
                    materialIndex = mesh.MaterialIndex,
                    indexFormat = mesh.IndexFormat,
                    positionsBase64 = positions,
                    indicesBase64 = indices,
                    uvsBase64 = uvs,
                    normalsBase64 = normals,
                    boneWeightsBase64 = boneWeights,
                    boneIndicesBase64 = boneIndices
                });
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "chr", "FLVER_MESH_READ_FAILED", ex.Message);
            }
        }

        if (command == "read-flver-skeleton")
        {
            try
            {
                var document = FlverNativeDocument.ReadFile(file);
                var bones = document.Bones.Select(b => new
                {
                    index = b.Index,
                    name = b.Name,
                    parentIndex = b.ParentIndex,
                    nextSiblingIndex = b.NextSiblingIndex,
                    translation = new[] { b.TranslationX, b.TranslationY, b.TranslationZ },
                    rotation = new[] { b.RotationX, b.RotationY, b.RotationZ }
                }).ToArray();
                return BridgeResult<object>.Partial(file, "chr", new[]
                {
                    new Diagnostic("info", "FLVER_SKELETON_EXTRACTED",
                        $"FLVER 骨骼层级已提取；boneCount={document.BoneCount}。",
                        BridgeResult<object>.MakeSourceUri(file))
                }, new
                {
                    boneCount = document.BoneCount,
                    bones
                });
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "chr", "FLVER_SKELETON_READ_FAILED", ex.Message);
            }
        }

        if (command == "read-flver-texture-slots")
        {
            try
            {
                var document = FlverNativeDocument.ReadFile(file);
                var slots = document.GetTextureSlots();
                var textures = slots.Select(t => new
                {
                    index = t.Index,
                    type = t.Type,
                    path = t.Path,
                    materialIndex = t.MaterialIndex
                }).ToArray();
                return BridgeResult<object>.Partial(file, "chr", new[]
                {
                    new Diagnostic("info", "FLVER_TEXTURE_SLOTS_EXTRACTED",
                        $"FLVER 纹理槽位已提取；textureCount={slots.Count}。",
                        BridgeResult<object>.MakeSourceUri(file))
                }, new
                {
                    textureCount = slots.Count,
                    textures
                });
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "chr", "FLVER_TEXTURE_SLOTS_READ_FAILED", ex.Message);
            }
        }

        if (command == "read-flver-dummies")
        {
            try
            {
                var document = FlverNativeDocument.ReadFile(file);
                var dummies = document.GetDummies();
                var entries = dummies.Select(d => new
                {
                    index = d.Index,
                    position = new[] { d.PositionX, d.PositionY, d.PositionZ },
                    referenceId = d.ReferenceId,
                    parentBoneIndex = d.ParentBoneIndex,
                    attachBoneIndex = d.AttachBoneIndex
                }).ToArray();
                return BridgeResult<object>.Partial(file, "chr", new[]
                {
                    new Diagnostic("info", "FLVER_DUMMIES_EXTRACTED",
                        $"FLVER Dummy 挂点已提取；dummyCount={dummies.Count}。",
                        BridgeResult<object>.MakeSourceUri(file))
                }, new
                {
                    dummyCount = dummies.Count,
                    dummies = entries
                });
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "chr", "FLVER_DUMMIES_READ_FAILED", ex.Message);
            }
        }

        // read-mtd-document 已从 dispatch 撤下（落到尾部 UNKNOWN_COMMAND）。
        //
        // 为什么撤下而不是补进 TS：MTD 是 user-approved 的 V0.6 延期项
        // （scope.json 的 SCOPE-ASSET-MTD 与 SCOPE-ASSETS，authorityAtRuling=unverified），
        // 把它接进 TS union 等于在没有 parser/writer/validator/authority 门槛的前提下
        // 扩大 V0.5 的可调用面。而留在「C# 已实现、TS 不可达」这个中间状态更糟：
        // 254 行的 MtdNativeDocument 既不可达也无人验证，却会被能力盘点读成已交付。
        //
        // MtdNativeDocument 与 MTD_DOCUMENT_* 诊断码**保留不动**：撤下的是入口，
        // 不是实现。V0.6 承接时按 scope.json 的 resumeRequires 走通用流程
        // （用户裁定改回 supported → 同步 gates/slices → 补齐门槛 → 重新封存），
        // 届时同时恢复本分支、AdvertisedCommands 与两侧 TS union 三处。
        // test:bridge-command-advertisement 会在任一处漏掉时失败关闭。

        if (command == "read-esd-document")
        {
            try
            {
                var document = EsdNativeDocument.ReadFile(file);
                var roundTrip = document.VerifyRoundTrip();
                var diagnostics = new List<Diagnostic>
                {
                    new Diagnostic(
                        roundTrip.SemanticIdentical ? "info" : "error",
                        roundTrip.SemanticIdentical ? "ESD_DOCUMENT_ROUNDTRIP_VERIFIED" : "ESD_DOCUMENT_ROUNDTRIP_FAILED",
                        roundTrip.SemanticIdentical
                            ? $"ESD 只读重解析确定性通过；stateGroups={document.StateGroups.Count}, states={document.ParsedStateCount}, conditions={document.ParsedConditionCount}。本项只证明同一份字节解析两遍一致，不构成解析完整性声明。"
                            : "ESD 只读往返语义不一致。",
                        BridgeResult<object>.MakeSourceUri(file),
                        roundTrip)
                };
                // 覆盖率残缺必须单列诊断，不能只靠 authority 降级：消费方常只读
                // authority，而「哪几项没解析全」才是排查入口（硬约束 8 要求
                // partial 返回结构化诊断）。
                if (!document.CoverageComplete)
                {
                    diagnostics.Add(new Diagnostic(
                        "warning",
                        "ESD_DECLARED_PARSED_DIVERGED",
                        $"ESD 声明量与实解析量不一致：{string.Join("; ", document.CoverageShortfalls())}。authority 已降为 partial。",
                        BridgeResult<object>.MakeSourceUri(file),
                        new { coverageShortfalls = document.CoverageShortfalls() }));
                }
                // 本版刻意未解析的字段区间**单列诊断码**，不并进上面那条。
                // 两者都会压 authority，但处置方向相反：DIVERGED 指向「去查 parser
                // 为什么少读了」，而这一条指向「本版范围如此，要做得先走 V0.6 承接」。
                // 混成一条会让下一个人去修一个不存在的 bug（ESD 哨兵那次就是这么
                // 被误判的），也会让真实的解析缺口被结构性缺口的噪音盖住。
                var esdUnparsedGaps = document.UnparsedGaps();
                if (esdUnparsedGaps.Length > 0)
                {
                    diagnostics.Add(new Diagnostic(
                        "warning",
                        "ESD_STRUCTURE_NOT_PARSED_IN_SCOPE",
                        $"ESD 刻意不解码以下区间：{string.Join("; ", esdUnparsedGaps)}。"
                        + "RPN 字节码按不透明 (offset,length) 上报——scope.json 的 "
                        + "SCOPE-BEHAVIOR-ESD 把「未知表达式或命令不得重编码」列为永久禁令，"
                        + "不解码是刻意的，不是解析缺陷；但 authority 因此不得停留在 candidate，"
                        + "已降为 partial。",
                        BridgeResult<object>.MakeSourceUri(file),
                        new { unparsedGaps = esdUnparsedGaps }));
                }
                // 跳转图不闭合必须单列：悬空目标意味着写入会破坏状态机可达性
                // （scope.json 的 resumeRequires 明写这一条）。与「刻意不解码」分开，
                // 因为处置完全不同——那个是范围，这个是数据有问题。
                if (!document.TransitionGraphClosed)
                {
                    diagnostics.Add(new Diagnostic(
                        "error",
                        "ESD_TRANSITION_GRAPH_NOT_CLOSED",
                        $"ESD 跳转图不闭合：悬空目标 {document.DanglingEdges.Count} 条、"
                        + $"指向尾随哨兵槽 {document.SentinelTargetEdges.Count} 条。"
                        + "悬空目标指向的偏移不落在任何语义 state 记录起点上；"
                        + "指向哨兵说明哨兵被当成可跳转状态。两者都会让状态机的可达性判断失效，"
                        + "写入前必须先解决（真实语料实测 192/192 文件闭合，出现此诊断说明遇到了"
                        + "未登记形态）。",
                        BridgeResult<object>.MakeSourceUri(file),
                        new
                        {
                            dangling = document.DanglingEdges.Count,
                            sentinelTargets = document.SentinelTargetEdges.Count
                        }));
                }
                return BridgeResult<object>.Partial(file, "script", diagnostics.ToArray(), document.ToEnvelope(roundTrip));
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "script", "ESD_DOCUMENT_READ_FAILED", ex.Message);
            }
        }

        if (command == "write-msb")
        {
            if (string.IsNullOrWhiteSpace(outputPath))
                return BridgeResult<object>.Failed(file, "map", "BRIDGE_OUTPUT_PATH_REQUIRED", "MSB writer requires a validated staging output path.");
            try
            {
                var written = await MsbNativeWriter.WriteAsync(file, outputPath, options, cancellationToken);
                return BridgeResult<object>.Partial(file, "map", new[]
                {
                    new Diagnostic("info", "MSB_STAGING_WRITE_VERIFIED", "MSB 已写入暂存区并重读验证。", BridgeResult<object>.MakeSourceUri(file), written)
                }, written);
            }
            catch (MsbUnregisteredEntityException ex)
            {
                return BridgeResult<object>.Failed(file, "map", "MSB_UNREGISTERED_ENTITY_TYPE", ex.Message);
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, "map", "MSB_STAGING_WRITE_FAILED", ex.Message);
            }
        }

        if (command == "write-bnd4")
        {
            if (string.IsNullOrWhiteSpace(outputPath))
                return BridgeResult<object>.Failed(file, resourceKind, "BRIDGE_OUTPUT_PATH_REQUIRED", "BND4 writer requires a validated staging output path.");
            try
            {
                var written = await Bnd4NativeWriter.WriteAsync(file, outputPath, options, cancellationToken, oodleRuntimeRoot);
                return BridgeResult<object>.Partial(file, resourceKind, new[]
                {
                    new Diagnostic("info", "BND4_STAGING_WRITE_VERIFIED", "BND4 已写入暂存区并重读验证。", BridgeResult<object>.MakeSourceUri(file), written)
                }, written);
            }
            catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException)
            {
                return BridgeResult<object>.Failed(file, resourceKind, "BND4_STAGING_WRITE_FAILED", ex.Message);
            }
        }

        cancellationToken.ThrowIfCancellationRequested();
        return command switch
        {
            "export-event" => ExportSemanticCandidate(file, "event", "Semantic EMEVD export is not implemented yet; inspect returns the audit envelope first."),
            "export-map" => ExportSemanticCandidate(file, "map", "Semantic MSB export is not implemented yet; inspect returns the audit envelope first."),
            "export-param" => ExportSemanticCandidate(file, "param", "Semantic PARAM export is not implemented yet; inspect returns the audit envelope first."),
            "export-msg" => MsgTextExport.Export(file),
            _ => BridgeResult<object>.Failed(file, resourceKind, "UNKNOWN_COMMAND", $"Unknown bridge command: {command}")
        };
    }

    public static string GuessKindFromPath(string file)
    {
        var normalized = file.Replace('\\', '/').ToLowerInvariant();
        foreach (var kind in new[] { "event", "map", "param", "msg", "menu", "script", "action", "ai", "sfx" })
        {
            if (normalized.Contains($"/{kind}/")) return kind;
        }

        var name = Path.GetFileName(file).ToLowerInvariant();
        if (name.Contains("emevd")) return "event";
        if (name.Contains("msb")) return "map";
        if (name.Contains("param")) return "param";
        if (name.Contains("msg") || name.EndsWith(".fmg")) return "msg";
        if (name.EndsWith(".tae")) return "action";
        if (name.EndsWith(".flver")) return "chr";
        if (name.EndsWith(".esd")) return "script";
        return "unknown";
    }

    private static BridgeResult<object> ExportSemanticCandidate(
        string file,
        string resourceKind,
        string unsupportedMessage)
    {
        return SemanticCandidateExports.TryExport(file, resourceKind)
            ?? BridgeResult<object>.Unsupported(file, resourceKind, unsupportedMessage);
    }

    /// <summary>
    /// NATIVE-03: Bridge-confirmed document locator probe。
    ///
    /// 只对「真实读取外层后确认的 magic」产生 `confirmedBy: "bridge"` 层；
    /// suffix/path hint 永远不能构造层。KRAK 且无可用 Oodle runtime 时返回
    /// LOCATOR_RUNTIME_BLOCKED（可重试），不是格式失败。同名 child 出现两个
    /// 不兼容 confirmed leaf 时返回 probeStatus=conflict 且不静默单选。
    /// 响应只携带脱敏标识符与哈希，不含主机路径。
    /// </summary>
    private static BridgeResult<object> ProbeDocumentLocator(
        string file,
        string? oodleRuntimeRoot,
        string resourceKind)
    {
        var sourceUri = BridgeResult<object>.MakeSourceUri(file);
        try
        {
            var source = File.ReadAllBytes(file);
            var outerHash = HashHex(source);
            var layers = new List<BridgeDocumentLocatorLayerDto>();
            var confirmedStackIds = new List<string>();
            byte[] payload = source;
            var layerIndex = 0;

            if (source.AsSpan(0, 4).SequenceEqual("DCX\0"u8))
            {
                DcxNativeDocument dcx;
                try
                {
                    dcx = DcxNativeDocument.Read(file, oodleRuntimeRoot);
                }
                catch (Exception ex) when (ex is InvalidOperationException or NotSupportedException or InvalidDataException)
                {
                    // KRAK 且 Oodle runtime 未挂载/版本不匹配 → 运行时缺失，
                    // 按「可重试的 blocked」返回，不伪装成格式失败。
                    return BridgeResult<object>.Failed(file, resourceKind, "LOCATOR_RUNTIME_BLOCKED",
                        $"无法解压外层 DCX：{ex.Message}",
                        new { compressionRuntime = "oodle-unavailable", retryable = true });
                }
                var dcxFormatId = dcx.CompressionFormat == "KRAK" ? "dcx-krak" : "dcx-dflt";
                layers.Add(new BridgeDocumentLocatorLayerDto(layerIndex++, dcxFormatId, "bridge", null, null));
                payload = dcx.Payload;
            }

            if (payload.AsSpan(0, 4).SequenceEqual("BND4"u8))
            {
                var binder = Bnd4NativeDocument.Read(payload);
                var containerRole = GuessContainerRole(binder, file);
                // 冲突判定按「原始 entry 名」分组：同名 child（含 DuplicateOrdinal
                // 重复名）只要出现两个不兼容 confirmed leaf 即 conflict，禁止静默单选。
                var leafByName = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                var stackIdByName = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                var conflicts = new List<string>();
                var childLayers = new List<BridgeDocumentLocatorLayerDto>();

                for (var index = 0; index < binder.Entries.Count; index++)
                {
                    var entry = binder.Entries[index];
                    var entryBytes = binder.GetStoredBytes(index);
                    var leaf = DetectLeafFormat(entryBytes);
                    var stableEntryId = BuildStableEntryId(index, entry.Name);
                    var stackId = $"locator:{outerHash[..12]}:bnd4:{stableEntryId}";
                    if (leaf != "unknown")
                    {
                        if (leafByName.TryGetValue(entry.Name, out var existing) && existing != leaf)
                        {
                            // 同一 child 两个不兼容 confirmed leaf → conflict，禁止静默单选。
                            if (conflicts.Count == 0 && stackIdByName.TryGetValue(entry.Name, out var firstStackId))
                            {
                                confirmedStackIds.Add(firstStackId);
                            }
                            conflicts.Add(stackId);
                            confirmedStackIds.Add(stackId);
                            continue;
                        }
                        leafByName[entry.Name] = leaf;
                        stackIdByName[entry.Name] = stackId;
                        confirmedStackIds.Add(stackId);
                        childLayers.Add(new BridgeDocumentLocatorLayerDto(
                            layerIndex++,
                            leaf,
                            "bridge",
                            stableEntryId,
                            new BridgeDocumentLocatorEntryDto(
                                stableEntryId,
                                index,
                                entry.Name,
                                entry.ContentHash)));
                    }
                    else
                    {
                        // suffix-only 或未知 magic：只作为容器 child 存在，不构成 confirmed leaf。
                        childLayers.Add(new BridgeDocumentLocatorLayerDto(
                            layerIndex++,
                            "unknown",
                            "bridge",
                            stableEntryId,
                            new BridgeDocumentLocatorEntryDto(
                                stableEntryId,
                                index,
                                entry.Name,
                                entry.ContentHash)));
                    }
                }

                layers.Add(new BridgeDocumentLocatorLayerDto(layerIndex++, "bnd4", "bridge", null, null));
                layers.AddRange(childLayers);

                var leafFormatId = childLayers.Count > 0
                    ? (conflicts.Count > 0 ? "bnd4" : MostSpecificLeaf(leafByName.Values))
                    : "bnd4";
                var probeStatus = conflicts.Count > 0 ? "conflict" : "confirmed";
                var value = new
                {
                    outerResourceId = $"resource:{outerHash[..16]}",
                    outerByteLength = source.Length,
                    outerHash,
                    containerRole,
                    layers,
                    leafFormatId,
                    probeStatus,
                    reasonCode = conflicts.Count > 0 ? "conflicting-confirmed-leaf" : (string?)null,
                    confirmedStackIds
                };
                var diagnostics = new[]
                {
                    new Diagnostic(
                        conflicts.Count > 0 ? "error" : "info",
                        conflicts.Count > 0 ? "LOCATOR_CONFLICTING_LEAF" : "LOCATOR_STACK_CONFIRMED",
                        conflicts.Count > 0
                            ? $"外层容器内同名 child 出现不兼容的 confirmed leaf（{string.Join("; ", conflicts)}），禁止静默单选。"
                            : $"Bridge 已确认格式栈：dcx-dflt/bnd4 + {confirmedStackIds.Count} 个 confirmed child。",
                        sourceUri,
                        value)
                };
                return BridgeResult<object>.Partial(file, resourceKind, diagnostics, value);
            }

            // Loose (non-container) resource：只按 payload magic 确认一层。
            var looseLeaf = DetectLeafFormat(payload);
            if (looseLeaf == "unknown")
            {
                return BridgeResult<object>.Failed(file, resourceKind, "LOCATOR_FORMAT_UNCONFIRMED",
                    "输入内容没有可确认的 native magic；suffix/path 只构成 candidate，不构成 confirmed stack。");
            }
            layers.Add(new BridgeDocumentLocatorLayerDto(0, looseLeaf, "bridge", null, null));
            var looseStackId = $"locator:{outerHash[..12]}:loose";
            var looseValue = new
            {
                outerResourceId = $"resource:{outerHash[..16]}",
                outerByteLength = source.Length,
                outerHash,
                containerRole = "none",
                layers,
                leafFormatId = looseLeaf,
                probeStatus = "confirmed",
                reasonCode = (string?)null,
                confirmedStackIds = new[] { looseStackId }
            };
            return BridgeResult<object>.Partial(file, resourceKind, new[]
            {
                new Diagnostic("info", "LOCATOR_STACK_CONFIRMED",
                    $"Bridge 已确认 loose 格式栈：{looseLeaf}。",
                    sourceUri, looseValue)
            }, looseValue);
        }
        catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException or ArgumentOutOfRangeException)
        {
            return BridgeResult<object>.Failed(file, resourceKind, "LOCATOR_PROBE_FAILED", ex.Message);
        }
    }

    private static string DetectLeafFormat(byte[] payload)
    {
        if (payload.Length < 4) return "unknown";
        if (payload.AsSpan(0, 4).SequenceEqual("PARA"u8)) return "param";
        if (payload.AsSpan(0, 4).SequenceEqual("FMG\0"u8)) return "fmg";
        if (payload.AsSpan(0, 4).SequenceEqual("EVD\0"u8)) return "emevd";
        if (payload.AsSpan(0, 4).SequenceEqual("MSB\0"u8)) return "msb";
        if (payload.AsSpan(0, 4).SequenceEqual("BND4"u8)) return "bnd4";
        return "unknown";
    }

    /// <summary>
    /// probe-document-locator 的层 DTO。全局序列化配置是 WhenWritingNull，
    /// 但 TS 侧契约要求容器层必须出现显式 `entry: null`（缺键会被 TS 运行时
    /// 读成 undefined，与 `null | {...}` 契约不符）——所以这里属性级强制
    /// JsonIgnoreCondition.Never，绕过全局省略。
    /// </summary>
    private sealed record BridgeDocumentLocatorLayerDto(
        int LayerIndex,
        string FormatId,
        string ConfirmedBy,
        string? ChildStableId,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)]
        BridgeDocumentLocatorEntryDto? Entry);

    private sealed record BridgeDocumentLocatorEntryDto(
        string StableEntryId,
        int EntryIndex,
        string EntryName,
        string ExpectedEntryHash);

    /// <summary>
    /// container role 与 byte format 分开：角色是语义分类（gameparam 参数集、
    /// msg 文本集、script 脚本集……），format 是字节 magic。判定优先看 entry
    /// 名（Sekiro 的 parambnd 内是 ItemParam/SpEffectParam 这类真名），fallback
    /// 到外层文件名（gameparam.parambnd.dcx、msg_*.dcx 这类惯例名）。
    /// </summary>
    private static string GuessContainerRole(Bnd4NativeDocument binder, string file)
    {
        var names = binder.Entries.Select(entry => entry.Name.ToLowerInvariant()).ToList();
        var fileName = System.IO.Path.GetFileName(file).ToLowerInvariant();

        if (names.Any(name => name.Contains("gameparam")) || fileName.Contains("gameparam")) return "gameparam-binder";
        if (names.Any(name => name.Contains("drawparam")) || fileName.Contains("drawparam")) return "drawparam-binder";
        if (names.Any(name => name.EndsWith(".fmg") || name.Contains(".msg")) || fileName.Contains("msg")) return "msg-binder";
        if (names.Any(name => name.EndsWith(".lua") || name.Contains("script")) || fileName.Contains("script")) return "script-binder";
        if (names.Any(name => name.Contains("behavior") || name.Contains("_ai_")) || fileName.Contains("behavior")) return "behavior-binder";
        if (names.Any(name => name.EndsWith(".anibnd") || name.Contains("anibnd") || name.Contains("_anim")) || fileName.Contains("anibnd")) return "animation-binder";
        if (names.Any(name => name.Contains("texture") || name.EndsWith(".texbnd")) || fileName.Contains("texbnd")) return "texture-binder";
        if (names.Any(name => name.Contains("vfx") || name.Contains("fx")) || fileName.Contains("vfx")) return "vfx-binder";
        return "generic-binder";
    }

    private static string BuildStableEntryId(int index, string name)
    {
        var digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(name))).ToLowerInvariant();
        return $"bnd4:{index}:{digest[..12]}";
    }

    private static string MostSpecificLeaf(IEnumerable<string> leaves)
    {
        var distinct = leaves.Distinct().ToArray();
        return distinct.Length == 1 ? distinct[0] : "bnd4";
    }

    private static string HashHex(byte[] bytes) =>
        Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    /// <summary>
    /// Container-level asset inventory (candidate): unpack outer DCX, enumerate BND4
    /// entries and classify by extension/magic without decoding child semantics.
    /// Output is limited to logical entry names, counts and category aggregates —
    /// never host paths, payload content or full child dumps.
    /// </summary>
    private static BridgeResult<object> InventoryAssetResources(
        string file,
        JsonElement options,
        string? oodleRuntimeRoot,
        CancellationToken cancellationToken)
    {
        const int maxEntries = 1_000_000;
        const int sampleLimit = 64;
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            var source = File.ReadAllBytes(file);
            byte[] payload = source;
            string? outerCompression = null;
            if (source.AsSpan(0, 4).SequenceEqual("DCX\0"u8))
            {
                var dcx = DcxNativeDocument.Read(file, oodleRuntimeRoot);
                payload = dcx.Payload;
                outerCompression = dcx.CompressionFormat;
            }

            if (payload.AsSpan(0, 4).SequenceEqual("BND3"u8))
                throw new NotSupportedException("BND3 容器尚不支持 inventory 枚举。");

            if (!payload.AsSpan(0, 4).SequenceEqual("BND4"u8))
            {
                // Non-container resource: classify the payload itself as a single entry.
                var kind = ClassifyAssetKind(payload);
                var envelope = new
                {
                    format = outerCompression is null ? "raw" : $"DCX-{outerCompression}",
                    containerType = "none",
                    entryCount = 1,
                    resourceKinds = new Dictionary<string, int> { [kind] = 1 },
                    extensions = new Dictionary<string, int> { [GuessExtension(payload)] = 1 },
                    sampleEntries = new[] { new { name = Path.GetFileName(file), id = 0 } },
                    authority = "candidate"
                };
                return BridgeResult<object>.Partial(file, GuessKindFromPath(file), new[]
                {
                    new Diagnostic("info", "ASSET_INVENTORY_SINGLE_RESOURCE",
                        "输入不是容器；按单资源分类。", BridgeResult<object>.MakeSourceUri(file), envelope)
                }, envelope);
            }

            var binder = Bnd4NativeDocument.Read(payload);
            if (binder.Entries.Count > maxEntries)
                throw new InvalidDataException($"BND4 条目数 {binder.Entries.Count} 超出安全上限。");
            cancellationToken.ThrowIfCancellationRequested();

            var kindCounts = new Dictionary<string, int>(StringComparer.Ordinal);
            var extCounts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            var samples = new List<object>(sampleLimit);
            for (var index = 0; index < binder.Entries.Count; index++)
            {
                var entry = binder.Entries[index];
                var ext = GetExtension(entry.Name);
                extCounts[ext] = extCounts.GetValueOrDefault(ext) + 1;
                var kind = ClassifyAssetKind(entry.Name);
                kindCounts[kind] = kindCounts.GetValueOrDefault(kind) + 1;
                if (samples.Count < sampleLimit)
                {
                    samples.Add(new { name = entry.Name, id = entry.Id });
                }
            }

            var bnd4Envelope = new
            {
                format = outerCompression is null ? "BND4" : $"DCX-{outerCompression}->BND4",
                containerType = "bnd4",
                entryCount = binder.Entries.Count,
                resourceKinds = kindCounts.OrderByDescending(pair => pair.Value).ToDictionary(pair => pair.Key, pair => pair.Value),
                extensions = extCounts.OrderByDescending(pair => pair.Value).ToDictionary(pair => pair.Key, pair => pair.Value),
                sampleEntries = samples,
                authority = "candidate"
            };
            return BridgeResult<object>.Partial(file, GuessKindFromPath(file), new[]
            {
                new Diagnostic("info", "ASSET_INVENTORY_ENUMERATED",
                    $"BND4 容器条目已枚举：{binder.Entries.Count} 条，类别分布见 details。",
                    BridgeResult<object>.MakeSourceUri(file), bnd4Envelope)
            }, bnd4Envelope);
        }
        catch (Exception ex) when (ex is InvalidDataException or NotSupportedException or IOException or ArgumentOutOfRangeException)
        {
            return BridgeResult<object>.Failed(file, GuessKindFromPath(file), "ASSET_INVENTORY_FAILED", ex.Message);
        }
    }

    private static string ClassifyAssetKind(string name)
    {
        var lower = name.ToLowerInvariant();
        if (lower.Contains("event") || lower.EndsWith(".emevd")) return "event";
        if (lower.EndsWith(".msb")) return "map";
        if (lower.Contains("param") || lower.EndsWith(".param")) return "param";
        if (lower.Contains("msg") || lower.EndsWith(".fmg") || lower.EndsWith(".msgbnd")) return "msg";
        if (lower.EndsWith(".luagnl") || lower.EndsWith(".luainfo") || lower.EndsWith(".lua")
            || lower.EndsWith(".esd") || lower.EndsWith(".talkesdbnd")) return "script";
        if (lower.EndsWith(".tae") || lower.EndsWith(".hkx") || lower.EndsWith(".hks")
            || lower.EndsWith(".hkt") || lower.EndsWith(".anibnd") || lower.EndsWith(".behbnd")) return "action";
        if (lower.EndsWith(".flver") || lower.EndsWith(".tpf") || lower.EndsWith(".dds")
            || lower.EndsWith(".mtd") || lower.EndsWith(".matbin") || lower.EndsWith(".texbnd")
            || lower.EndsWith(".objbnd") || lower.EndsWith(".partsbnd") || lower.EndsWith(".mapbnd")
            || lower.EndsWith(".chrbnd")) return "chr";
        return "other";
    }

    private static string ClassifyAssetKind(byte[] sample)
    {
        if (sample.AsSpan(0, 4).SequenceEqual("EVD\0"u8)) return "event";
        if (sample.AsSpan(0, 4).SequenceEqual("FMG\0"u8)) return "msg";
        if (sample.AsSpan(0, 4).SequenceEqual("PARA"u8)) return "param";
        if (sample.AsSpan(0, 4).SequenceEqual("MSB\0"u8)) return "map";
        if (sample.AsSpan(0, 4).SequenceEqual("FLVE"u8)) return "chr";
        return "other";
    }

    private static string GuessExtension(byte[] sample)
    {
        if (sample.AsSpan(0, 4).SequenceEqual("EVD\0"u8)) return ".emevd";
        if (sample.AsSpan(0, 4).SequenceEqual("FMG\0"u8)) return ".fmg";
        if (sample.AsSpan(0, 4).SequenceEqual("PARA"u8)) return ".param";
        if (sample.AsSpan(0, 4).SequenceEqual("MSB\0"u8)) return ".msb";
        return "(unknown)";
    }

    private static string GetExtension(string name)
    {
        var fileName = name.Replace('\\', '/').Split('/').LastOrDefault() ?? name;
        var dot = fileName.LastIndexOf('.');
        return dot >= 0 && dot < fileName.Length - 1 ? fileName[dot..].ToLowerInvariant() : "(none)";
    }

    private static async Task<BridgeResult<object>> InspectEnvelopeAsync(
        string file,
        bool includeReadableValidation,
        CancellationToken cancellationToken,
        string? oodleRuntimeRoot)
    {
        var fileInfo = new FileInfo(file);
        var sample = await ReadBoundedPrefixAsync(file, MaxPrefixBytes, cancellationToken);
        var inspection = EnvelopeInspection.Inspect(
            file,
            sample,
            fileInfo.Length,
            MaxPrefixBytes,
            oodleRuntimeRoot);
        var diagnostics = includeReadableValidation
            ? inspection.Diagnostics.Prepend(new Diagnostic(
                "info",
                "VALIDATION_READABLE",
                "File exists and its bounded prefix can be opened for read validation. No unpacking, decompression, or semantic parsing was attempted.",
                BridgeResult<object>.MakeSourceUri(file))).ToArray()
            : inspection.Diagnostics;

        return BridgeResult<object>.Partial(file, inspection.ResourceKind, diagnostics, inspection);
    }

    private static async Task<byte[]> ReadBoundedPrefixAsync(
        string file,
        int maxBytes,
        CancellationToken cancellationToken)
    {
        if (maxBytes < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(maxBytes), "Maximum prefix size must be non-negative.");
        }

        var fileInfo = new FileInfo(file);
        if (!fileInfo.Exists) throw new FileNotFoundException("Input file does not exist.", file);

        var bytesToRead = (int)Math.Min(fileInfo.Length, maxBytes);
        if (bytesToRead == 0) return Array.Empty<byte>();

        var buffer = new byte[bytesToRead];
        await using var stream = new FileStream(
            file,
            FileMode.Open,
            FileAccess.Read,
            FileShare.ReadWrite,
            bufferSize: 64 * 1024,
            options: FileOptions.Asynchronous | FileOptions.SequentialScan);

        var totalRead = 0;
        while (totalRead < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(totalRead), cancellationToken);
            if (read == 0) break;
            totalRead += read;
        }

        if (totalRead == buffer.Length) return buffer;
        Array.Resize(ref buffer, totalRead);
        return buffer;
    }
}
