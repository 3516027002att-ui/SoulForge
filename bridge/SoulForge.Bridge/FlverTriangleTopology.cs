/// <summary>
/// FLVER FaceSet topology projection used by renderer preview paths.
///
/// The renderer contract is deliberately simpler than the native format: it only
/// accepts triangle lists. FLVER itself may store a FaceSet as a triangle strip,
/// including degenerate connector faces and 0xFFFF primitive restarts. This helper
/// performs the same strip-to-list projection as SoulsFormats FaceSet.Triangulate
/// so raw strip indices never leak into Three.js as if they were ordinary triples.
/// </summary>
internal static class FlverTriangleTopology
{
    public static uint[] ToTriangleList(
        ReadOnlySpan<uint> sourceIndices,
        bool triangleStrip,
        bool allowPrimitiveRestarts,
        int maxOutputIndices)
    {
        if (maxOutputIndices <= 0 || sourceIndices.Length < 3)
            return Array.Empty<uint>();

        // Renderer indices must always describe complete triangles.
        var outputLimit = maxOutputIndices - (maxOutputIndices % 3);
        if (outputLimit <= 0)
            return Array.Empty<uint>();

        if (!triangleStrip)
        {
            var count = Math.Min(sourceIndices.Length - (sourceIndices.Length % 3), outputLimit);
            return sourceIndices[..count].ToArray();
        }

        var output = new List<uint>(Math.Min(outputLimit, Math.Max(0, (sourceIndices.Length - 2) * 3)));
        var flip = false;
        for (var i = 0; i < sourceIndices.Length - 2; i++)
        {
            var vi1 = sourceIndices[i];
            var vi2 = sourceIndices[i + 1];
            var vi3 = sourceIndices[i + 2];

            // Matches SoulsFormats: a restart marker resets strip winding and does
            // not itself emit a triangle. Sekiro FLVER uses the ushort sentinel
            // when primitive restart is enabled for meshes below ushort.MaxValue.
            if (allowPrimitiveRestarts && (vi1 == 0xFFFF || vi2 == 0xFFFF || vi3 == 0xFFFF))
            {
                flip = false;
                continue;
            }

            // Degenerate strip faces are connectors, not visible triangles.
            if (vi1 != vi2 && vi2 != vi3 && vi3 != vi1)
            {
                if (output.Count + 3 > outputLimit)
                    break;

                if (flip)
                {
                    output.Add(vi3);
                    output.Add(vi2);
                    output.Add(vi1);
                }
                else
                {
                    output.Add(vi1);
                    output.Add(vi2);
                    output.Add(vi3);
                }
            }

            flip = !flip;
        }

        return output.ToArray();
    }
}
