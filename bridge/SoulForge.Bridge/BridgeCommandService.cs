using System.Text.Json;
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
                var diagnostics = new[]
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
            try
            {
                var result = Bnd4NativeWriter.ExtractChild(file, options, oodleRuntimeRoot);
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
                var rowPage = options.TryGetProperty("rowPage", out var rp) && rp.TryGetInt32(out var rpv) ? rpv : 0;
                var rowPageSize = options.TryGetProperty("rowPageSize", out var rps) && rps.TryGetInt32(out var rpsv) ? rpsv : 0;
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
                if (format.Equals("png", StringComparison.OrdinalIgnoreCase))
                {
                    var (width, height, rgba) = DdsCodec.DecodeDds(dds);
                    outputBytes = DdsCodec.EncodePng(width, height, rgba);
                    code = $"PNG {width}x{height}";
                }
                else
                {
                    outputBytes = dds;
                    code = "DDS";
                }
                await File.WriteAllBytesAsync(outputPath, outputBytes, cancellationToken);
                var entry = document.Textures[textureIndex];
                return BridgeResult<object>.Partial(file, "texture", new[]
                {
                    new Diagnostic("info", "TPF_TEXTURE_EXPORTED",
                        $"TPF 纹理 {textureIndex} 已导出为 {code}（{outputBytes.Length} 字节）。",
                        BridgeResult<object>.MakeSourceUri(file))
                }, new
                {
                    textureIndex,
                    name = entry.Name,
                    format,
                    outputPath,
                    byteLength = outputBytes.Length
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
                var diagnostics = new[]
                {
                    new Diagnostic(
                        roundTrip.ByteIdentical ? "info" : "error",
                        roundTrip.ByteIdentical ? "FLVER_DOCUMENT_ROUNDTRIP_BYTE_VERIFIED" : "FLVER_DOCUMENT_ROUNDTRIP_FAILED",
                        roundTrip.ByteIdentical
                            ? $"FLVER 只读往返字节级一致；materials={document.MaterialCount}, bones={document.BoneCount}, meshes={document.MeshCount}。"
                            : "FLVER 只读往返字节不一致。",
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
                var meshIndex = options.TryGetProperty("meshIndex", out var mi) && mi.TryGetInt32(out var idx) ? idx : 0;
                var positions = document.GetMeshPositionsBase64(meshIndex);
                var indices = document.GetMeshIndicesBase64(meshIndex);
                var uvs = document.GetMeshUVsBase64(meshIndex);
                var normals = document.GetMeshNormalsBase64(meshIndex);
                var boneWeights = document.GetMeshBoneWeightsBase64(meshIndex);
                var boneIndices = document.GetMeshBoneIndicesBase64(meshIndex);
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

        if (command == "read-mtd-document")
        {
            try
            {
                var document = MtdNativeDocument.ReadFile(file);
                var verification = document.VerifyStructure();
                var diagnostics = document.Diagnostics.Append(new Diagnostic(
                    verification.Consistent ? "info" : "error",
                    verification.Consistent ? "MTD_DOCUMENT_STRUCTURE_VERIFIED" : "MTD_DOCUMENT_STRUCTURE_INCONSISTENT",
                    verification.Consistent
                        ? $"MTD 结构投影一致；root={document.RootElement}, params={document.Params.Count}, textureRefs={document.Textures.Count}。"
                        : (verification.Note ?? "MTD 重复解析的结构投影不一致。"),
                    BridgeResult<object>.MakeSourceUri(file),
                    verification)).ToArray();
                return BridgeResult<object>.Partial(file, "mtd", diagnostics, document.ToEnvelope(verification));
            }
            catch (NotSupportedException ex)
            {
                return BridgeResult<object>.Unsupported(file, "mtd", ex.Message);
            }
            catch (Exception ex) when (ex is InvalidDataException or IOException)
            {
                return BridgeResult<object>.Failed(file, "mtd", "MTD_DOCUMENT_READ_FAILED", ex.Message);
            }
        }

        if (command == "read-esd-document")
        {
            try
            {
                var document = EsdNativeDocument.ReadFile(file);
                var roundTrip = document.VerifyRoundTrip();
                var diagnostics = new[]
                {
                    new Diagnostic(
                        roundTrip.SemanticIdentical ? "info" : "error",
                        roundTrip.SemanticIdentical ? "ESD_DOCUMENT_ROUNDTRIP_VERIFIED" : "ESD_DOCUMENT_ROUNDTRIP_FAILED",
                        roundTrip.SemanticIdentical
                            ? $"ESD 只读往返验证通过；stateGroups={document.StateGroups.Count}, states={document.ParsedStateCount}, conditions={document.ParsedConditionCount}。"
                            : "ESD 只读往返语义不一致。",
                        BridgeResult<object>.MakeSourceUri(file),
                        roundTrip)
                };
                return BridgeResult<object>.Partial(file, "script", diagnostics, document.ToEnvelope(roundTrip));
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
