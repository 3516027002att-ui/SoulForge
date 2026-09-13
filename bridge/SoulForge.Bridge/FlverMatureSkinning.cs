using System.Numerics;

/// <summary>
/// FLVER 的成熟查看器兼容层。
///
/// 这是按已验证的原生语义重写的独立模块，不复制第三方实现的源代码：
/// - 顶点权重保持文件中的原始值；GPU/查看器在需要时按权重和处理；
/// - FLVER2 新版本使用全局骨骼索引，旧版本使用 mesh palette；
/// - 零权重顶点回退到首个骨骼索引；没有 BoneIndices 语义时使用 Normal.W；
/// - 参考 FK 使用 FLVER 的 row-vector 顺序；蒙皮矩阵为 inverse(reference FK) * FK；
/// - DirectBoneMap 替换已映射骨骼的 FK，并递归重算未映射后代。
///
/// 解析、索引和参考姿态必须在同一处定义。否则 Bridge、装配器和 renderer
/// 各自“差不多”地实现一遍，就会出现脸、头发和骨骼分别落在不同空间的问题。
/// </summary>
internal static class FlverMatureSkinning
{
    private const int OldPaletteVersion = 0x2000D;
    private const float WeightEpsilon = 1e-5f;

    internal enum VertexMode
    {
        Rigid,
        Weighted,
        Invalid
    }

    /// <summary>
    /// Decode one native vertex into the exact global bone namespace consumed by
    /// the preview. The output weights intentionally are not normalized or
    /// rewritten: mature FLVER shaders divide by the native sum.
    /// </summary>
    internal static VertexMode DecodeVertex(
        int internalVersion,
        int boneCount,
        FlverMeshEntry mesh,
        bool hasBoneIndexSemantic,
        bool hasDecodedWeights,
        ReadOnlySpan<float> rawWeights,
        bool hasDecodedIndices,
        ReadOnlySpan<int> rawIndices,
        bool hasNormalW,
        int normalW,
        Span<float> outputWeights,
        Span<ushort> outputIndices,
        out string? failure)
    {
        if (outputWeights.Length < 4 || outputIndices.Length < 4)
        {
            failure = "FLVER_SKINNING_OUTPUT_TOO_SMALL";
            return VertexMode.Invalid;
        }
        outputWeights[..4].Clear();
        outputIndices[..4].Clear();
        failure = null;

        var sum = 0f;
        if (hasDecodedWeights)
        {
            for (var i = 0; i < 4; i++)
            {
                var value = rawWeights[i];
                if (!float.IsFinite(value))
                {
                    failure = $"FLVER_SKINNING_WEIGHT_NONFINITE:{i}";
                    return VertexMode.Invalid;
                }
                sum += value;
            }
        }

        var hasPalette = internalVersion <= OldPaletteVersion && mesh.BoneIndices.Count > 0;

        bool TryResolve(int rawIndex, out ushort resolved)
        {
            var globalIndex = rawIndex;
            if (hasPalette)
            {
                if (rawIndex < 0 || rawIndex >= mesh.BoneIndices.Count)
                {
                    resolved = 0;
                    return false;
                }
                globalIndex = mesh.BoneIndices[rawIndex];
            }
            if (globalIndex < 0 || globalIndex >= boneCount || globalIndex > ushort.MaxValue)
            {
                resolved = 0;
                return false;
            }
            resolved = (ushort)globalIndex;
            return true;
        }

        // Native layouts with BoneIndices use the four native weights. Keep
        // zero-weight slots intact; only positive slots need a valid bone.
        if (hasBoneIndexSemantic && sum > WeightEpsilon)
        {
            if (!hasDecodedIndices)
            {
                failure = "FLVER_SKINNING_INDICES_UNREADABLE";
                return VertexMode.Invalid;
            }

            var hasPositiveInfluence = false;
            for (var influence = 0; influence < 4; influence++)
            {
                var weight = rawWeights[influence];
                outputWeights[influence] = weight;
                if (weight <= WeightEpsilon) continue;
                if (!TryResolve(rawIndices[influence], out var resolved))
                {
                    // Mature readers discard an invalid influence instead of
                    // shifting the remaining slots to another bone.
                    outputWeights[influence] = 0f;
                    outputIndices[influence] = 0;
                    continue;
                }
                outputIndices[influence] = resolved;
                hasPositiveInfluence = true;
            }
            if (!hasPositiveInfluence)
            {
                failure = "FLVER_SKINNING_NO_VALID_POSITIVE_INFLUENCE";
                return VertexMode.Invalid;
            }
            return VertexMode.Weighted;
        }

        int rigidRawIndex;
        if (hasBoneIndexSemantic)
        {
            // With a BoneIndices member, the first native index is authoritative
            // even when all decoded weights are zero. Normal.W is not a hidden
            // second index channel for this layout.
            if (!hasDecodedIndices)
            {
                failure = "FLVER_SKINNING_INDICES_UNREADABLE";
                return VertexMode.Invalid;
            }
            rigidRawIndex = rawIndices[0];
        }
        else
        {
            // Rigid layouts without BoneIndices store their bone in Normal.W.
            // Mesh.DefaultBoneIndex is only the absent-normal fallback.
            rigidRawIndex = hasNormalW ? normalW : mesh.DefaultBoneIndex;
        }

        if (!TryResolve(rigidRawIndex, out var rigidIndex))
        {
            failure = $"FLVER_SKINNING_BONE_INDEX_INVALID:{rigidRawIndex}";
            return VertexMode.Invalid;
        }

        outputIndices[0] = rigidIndex;
        outputWeights[0] = 1f;
        return VertexMode.Rigid;
    }

    /// <summary>
    /// Build the native FLVER reference FK matrices. Matrix4x4 uses the same
    /// row-vector convention as the mature XNA path:
    /// Scale * Rx * Rz * Ry * Translation, then local * parentFK.
    /// </summary>
    internal static Matrix4x4[] BuildReferenceFkMatrices(IReadOnlyList<FlverBoneEntry> bones)
    {
        var result = new Matrix4x4[bones.Count];
        var resolved = new bool[bones.Count];
        var visiting = new bool[bones.Count];

        Matrix4x4 Resolve(int index)
        {
            if (index < 0 || index >= bones.Count)
                throw new InvalidDataException($"FLVER_BONE_INDEX_INVALID:{index}");
            if (resolved[index]) return result[index];
            if (visiting[index])
                throw new InvalidDataException($"FLVER_BONE_HIERARCHY_CYCLE:{index}");

            visiting[index] = true;
            var bone = bones[index];
            var local = CreateReferenceLocalMatrix(bone);
            var parent = bone.ParentIndex >= 0
                ? Resolve(bone.ParentIndex)
                : Matrix4x4.Identity;
            result[index] = local * parent;
            visiting[index] = false;
            resolved[index] = true;
            return result[index];
        }

        for (var index = 0; index < bones.Count; index++) _ = Resolve(index);
        return result;
    }

    internal static Matrix4x4 CreateReferenceLocalMatrix(FlverBoneEntry bone)
        => Matrix4x4.CreateScale(bone.ScaleX, bone.ScaleY, bone.ScaleZ)
            * Matrix4x4.CreateRotationX(bone.RotationX)
            * Matrix4x4.CreateRotationZ(bone.RotationZ)
            * Matrix4x4.CreateRotationY(bone.RotationY)
            * Matrix4x4.CreateTranslation(bone.TranslationX, bone.TranslationY, bone.TranslationZ);

    /// <summary>
    /// Mature FLVER shader input: inverse(reference FK) * current FK.
    /// </summary>
    internal static Matrix4x4 BuildShaderMatrix(Matrix4x4 referenceFk, Matrix4x4 currentFk)
    {
        if (!Matrix4x4.Invert(referenceFk, out var inverseReference))
            throw new InvalidDataException("FLVER_REFERENCE_FK_SINGULAR");
        return inverseReference * currentFk;
    }

    /// <summary>
    /// The second matrix array used by Dynamic==0/reference-pose meshes.
    /// </summary>
    internal static Matrix4x4 BuildReferencePoseShaderMatrix(Matrix4x4 referenceFk, Matrix4x4 currentFk)
        => referenceFk * BuildShaderMatrix(referenceFk, currentFk);

    /// <summary>
    /// Build the row-vector normal matrix for a reference-pose transform.
    /// Positions use <c>p * referenceFk</c>; normals must use the inverse
    /// transpose of the linear part so a non-uniform native scale does not
    /// shear or incorrectly scale the normal. <see cref="Vector3.TransformNormal"/>
    /// ignores the translation components of this affine matrix.
    /// </summary>
    internal static Matrix4x4 BuildReferenceNormalMatrix(Matrix4x4 referenceFk)
    {
        if (!Matrix4x4.Invert(referenceFk, out var inverse))
            throw new InvalidDataException("FLVER_REFERENCE_FK_SINGULAR");
        return Matrix4x4.Transpose(inverse);
    }

    internal static Matrix4x4[] BuildReferenceNormalMatrices(IReadOnlyList<Matrix4x4> referenceFk)
    {
        var result = new Matrix4x4[referenceFk.Count];
        for (var index = 0; index < referenceFk.Count; index++)
            result[index] = BuildReferenceNormalMatrix(referenceFk[index]);
        return result;
    }

    /// <summary>
    /// DirectBoneMap traversal used by character parts. Mapped bones receive
    /// the leader FK; follower-only descendants retain their native local
    /// transform and are recomputed below the already-synchronized parent.
    /// </summary>
    internal static Matrix4x4[] ApplyDirectBoneMap(
        IReadOnlyList<FlverBoneEntry> followerBones,
        IReadOnlyList<Matrix4x4> leaderFk,
        IReadOnlyList<int> followerToLeader)
    {
        if (followerToLeader.Count != followerBones.Count)
            throw new InvalidDataException("FLVER_DIRECT_BONE_MAP_LENGTH_MISMATCH");

        var result = new Matrix4x4[followerBones.Count];
        var resolved = new bool[followerBones.Count];
        var visiting = new bool[followerBones.Count];

        Matrix4x4 Resolve(int index)
        {
            if (index < 0 || index >= followerBones.Count)
                throw new InvalidDataException($"FLVER_BONE_INDEX_INVALID:{index}");
            if (resolved[index]) return result[index];
            if (visiting[index])
                throw new InvalidDataException($"FLVER_BONE_HIERARCHY_CYCLE:{index}");
            visiting[index] = true;

            var mapped = followerToLeader[index];
            if (mapped >= 0)
            {
                if (mapped >= leaderFk.Count)
                    throw new InvalidDataException($"FLVER_DIRECT_BONE_MAP_TARGET_INVALID:{mapped}");
                result[index] = leaderFk[mapped];
            }
            else
            {
                var parent = followerBones[index].ParentIndex >= 0
                    ? Resolve(followerBones[index].ParentIndex)
                    : Matrix4x4.Identity;
                result[index] = CreateReferenceLocalMatrix(followerBones[index]) * parent;
            }

            visiting[index] = false;
            resolved[index] = true;
            return result[index];
        }

        for (var index = 0; index < followerBones.Count; index++) _ = Resolve(index);
        return result;
    }

    /// <summary>
    /// Row-major System.Numerics values are the transpose of Three's column
    /// vector transform. Passing this array to Matrix4.fromArray therefore
    /// reconstructs the native FLVER transform without Euler round-tripping.
    /// </summary>
    internal static float[] ToThreeMatrixArray(Matrix4x4 matrix)
        => new[]
        {
            matrix.M11, matrix.M12, matrix.M13, matrix.M14,
            matrix.M21, matrix.M22, matrix.M23, matrix.M24,
            matrix.M31, matrix.M32, matrix.M33, matrix.M34,
            matrix.M41, matrix.M42, matrix.M43, matrix.M44
        };
}
