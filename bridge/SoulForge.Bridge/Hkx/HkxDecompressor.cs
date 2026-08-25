// MIT License
// Copyright (c) 2026 SoulForge Authors
// Clean-room implementation of De Boor B-spline evaluation, quaternion unpacking and continuous sampling.
// References: SoulsFormats (MIT) by TKGP/vawser and HKLib (MIT) by The12thAvenger.

using System.Buffers.Binary;
using System.Numerics;

namespace SoulForge.Bridge.Hkx;

internal static class HkxDecompressor
{
    public static float EvaluateBSpline(SplineCurve curve, float t)
    {
        ValidateCurve(curve, t);
        if (curve.ControlPoints.Length == 1) return curve.ControlPoints[0];

        int degree = curve.Degree;
        var knots = curve.Knots;
        var cp = curve.ControlPoints;
        int n = cp.Length;

        // Clamp parameter t within knot range
        float tMin = knots[degree];
        float tMax = knots[n];
        t = Math.Clamp(t, tMin, tMax);

        // Find knot span k such that knots[k] <= t < knots[k+1]
        int k = degree;
        for (int i = degree; i < n; i++)
        {
            if (t >= knots[i] && t < knots[i + 1])
            {
                k = i;
                break;
            }
            if (t >= knots[i + 1])
            {
                k = i;
            }
        }

        // De Boor's algorithm
        var d = new float[degree + 1];
        for (int j = 0; j <= degree; j++)
        {
            int cpIdx = k - degree + j;
            if (cpIdx < 0 || cpIdx >= n)
                throw new InvalidDataException($"B-spline control point index out of range: {cpIdx}.");
            d[j] = cp[cpIdx];
        }

        for (int r = 1; r <= degree; r++)
        {
            for (int j = degree; j >= r; j--)
            {
                int knotIdx = k - degree + j;
                float knotLeft = knots[knotIdx];
                float knotRight = knots[knotIdx + degree - r + 1];
                float alpha = (Math.Abs(knotRight - knotLeft) > 1e-6f)
                    ? (t - knotLeft) / (knotRight - knotLeft)
                    : 0f;
                d[j] = (1f - alpha) * d[j - 1] + alpha * d[j];
            }
        }

        return d[degree];
    }

    public static Quaternion EvaluateBSplineQuat(SplineQuatCurve curve, float t)
    {
        ValidateCurve(curve, t);
        if (curve.ControlPoints.Length == 1) return NormalizeQuaternionOrThrow(curve.ControlPoints[0], "B-spline quaternion");

        int degree = curve.Degree;
        var knots = curve.Knots;
        var cp = curve.ControlPoints;
        int n = cp.Length;

        float tMin = knots[degree];
        float tMax = knots[n];
        t = Math.Clamp(t, tMin, tMax);

        int k = degree;
        for (int i = degree; i < n; i++)
        {
            if (t >= knots[i] && t < knots[i + 1])
            {
                k = i;
                break;
            }
            if (t >= knots[i + 1])
            {
                k = i;
            }
        }

        var d = new Quaternion[degree + 1];
        for (int j = 0; j <= degree; j++)
        {
            int cpIdx = k - degree + j;
            if (cpIdx < 0 || cpIdx >= n)
                throw new InvalidDataException($"B-spline quaternion control point index out of range: {cpIdx}.");
            d[j] = cp[cpIdx];
        }

        for (int r = 1; r <= degree; r++)
        {
            for (int j = degree; j >= r; j--)
            {
                int knotIdx = k - degree + j;
                float knotLeft = knots[knotIdx];
                float knotRight = knots[knotIdx + degree - r + 1];
                float alpha = (Math.Abs(knotRight - knotLeft) > 1e-6f)
                    ? (t - knotLeft) / (knotRight - knotLeft)
                    : 0f;

                // Havok's spline quaternion curve is a component-wise De Boor
                // interpolation followed by normalization. Slerp here looks
                // plausible but produces a different curve from the native
                // runtime (and changes real Sekiro poses at spline boundaries).
                var q0 = d[j - 1];
                var q1 = d[j];
                d[j] = NormalizeQuaternionOrThrow(
                    new Quaternion(
                        (1f - alpha) * q0.X + alpha * q1.X,
                        (1f - alpha) * q0.Y + alpha * q1.Y,
                        (1f - alpha) * q0.Z + alpha * q1.Z,
                        (1f - alpha) * q0.W + alpha * q1.W),
                    "B-spline quaternion interpolation");
            }
        }

        return NormalizeQuaternionOrThrow(d[degree], "B-spline quaternion result");
    }

    public static Quaternion UnpackPolar32(uint packed)
    {
        // 32-bit polar quaternion unpacking
        // Top 2 bits: major component index (0=X, 1=Y, 2=Z, 3=W)
        // 10 bits theta, 10 bits phi, 10 bits psi
        int major = (int)((packed >> 30) & 0x3);
        float x = ((packed & 0x3FF) / 1023.0f) * 2.0f - 1.0f;
        float y = (((packed >> 10) & 0x3FF) / 1023.0f) * 2.0f - 1.0f;
        float z = (((packed >> 20) & 0x3FF) / 1023.0f) * 2.0f - 1.0f;
        float sumSq = x * x + y * y + z * z;
        float w = MathF.Sqrt(Math.Max(0f, 1f - sumSq));

        return NormalizeQuaternionOrThrow(major switch
        {
            0 => Quaternion.Normalize(new Quaternion(w, x, y, z)),
            1 => Quaternion.Normalize(new Quaternion(x, w, y, z)),
            2 => Quaternion.Normalize(new Quaternion(x, y, w, z)),
            _ => Quaternion.Normalize(new Quaternion(x, y, z, w))
        }, "POLAR32");
    }

    public static Quaternion UnpackThreeComp40(ReadOnlySpan<byte> data)
    {
        if (data.Length < 5) throw new InvalidDataException("THREECOMP40 requires 5 bytes.");
        // 40-bit three-component quaternion (5 bytes)
        // byte 0: upper bits indicate omitted component index
        ulong packed = (ulong)data[0] |
                       ((ulong)data[1] << 8) |
                       ((ulong)data[2] << 16) |
                       ((ulong)data[3] << 24) |
                       ((ulong)data[4] << 32);

        int omitted = (int)((packed >> 38) & 0x3);
        const float range = 0.70710678118f; // 1 / sqrt(2)
        float c0 = (((packed & 0xFFF) / 4095.0f) * 2f - 1f) * range;
        float c1 = ((((packed >> 12) & 0xFFF) / 4095.0f) * 2f - 1f) * range;
        float c2 = ((((packed >> 24) & 0xFFF) / 4095.0f) * 2f - 1f) * range;
        float c3 = MathF.Sqrt(Math.Max(0f, 1f - (c0 * c0 + c1 * c1 + c2 * c2)));

        return NormalizeQuaternionOrThrow(omitted switch
        {
            0 => Quaternion.Normalize(new Quaternion(c3, c0, c1, c2)),
            1 => Quaternion.Normalize(new Quaternion(c0, c3, c1, c2)),
            2 => Quaternion.Normalize(new Quaternion(c0, c1, c3, c2)),
            _ => Quaternion.Normalize(new Quaternion(c0, c1, c2, c3))
        }, "THREECOMP40");
    }

    public static Quaternion UnpackThreeComp48(ReadOnlySpan<byte> data)
    {
        if (data.Length < 6) throw new InvalidDataException("THREECOMP48 requires 6 bytes.");
        // 48-bit three-component quaternion (6 bytes = 3 x int16)
        short s0 = BinaryPrimitives.ReadInt16LittleEndian(data.Slice(0, 2));
        short s1 = BinaryPrimitives.ReadInt16LittleEndian(data.Slice(2, 2));
        short s2 = BinaryPrimitives.ReadInt16LittleEndian(data.Slice(4, 2));

        int omitted = (s0 & 0x3);
        s0 = (short)(s0 & ~0x3);

        const float range = 0.70710678118f;
        float c0 = (s0 / 32767.0f) * range;
        float c1 = (s1 / 32767.0f) * range;
        float c2 = (s2 / 32767.0f) * range;
        float c3 = MathF.Sqrt(Math.Max(0f, 1f - (c0 * c0 + c1 * c1 + c2 * c2)));

        return NormalizeQuaternionOrThrow(omitted switch
        {
            0 => Quaternion.Normalize(new Quaternion(c3, c0, c1, c2)),
            1 => Quaternion.Normalize(new Quaternion(c0, c3, c1, c2)),
            2 => Quaternion.Normalize(new Quaternion(c0, c1, c3, c2)),
            _ => Quaternion.Normalize(new Quaternion(c0, c1, c2, c3))
        }, "THREECOMP48");
    }

    public static Quaternion UnpackThreeComp24(ReadOnlySpan<byte> data)
    {
        if (data.Length < 3) throw new InvalidDataException("THREECOMP24 requires 3 bytes.");
        uint packed = (uint)data[0] | ((uint)data[1] << 8) | ((uint)data[2] << 16);
        int omitted = (int)((packed >> 22) & 0x3);
        const float range = 0.70710678118f;
        float c0 = (((packed & 0x7F) / 127.0f) * 2f - 1f) * range;
        float c1 = ((((packed >> 7) & 0x7F) / 127.0f) * 2f - 1f) * range;
        float c2 = ((((packed >> 14) & 0xFF) / 255.0f) * 2f - 1f) * range;
        float sumSq = c0 * c0 + c1 * c1 + c2 * c2;
        float c3 = MathF.Sqrt(Math.Max(0f, 1f - sumSq));

        return NormalizeQuaternionOrThrow(omitted switch
        {
            0 => Quaternion.Normalize(new Quaternion(c3, c0, c1, c2)),
            1 => Quaternion.Normalize(new Quaternion(c0, c3, c1, c2)),
            2 => Quaternion.Normalize(new Quaternion(c0, c1, c3, c2)),
            _ => Quaternion.Normalize(new Quaternion(c0, c1, c2, c3))
        }, "THREECOMP24");
    }

    public static Quaternion UnpackStraight16(ReadOnlySpan<byte> data)
    {
        if (data.Length < 2) throw new InvalidDataException("STRAIGHT16 requires 2 bytes.");
        short s = BinaryPrimitives.ReadInt16LittleEndian(data.Slice(0, 2));
        float x = (((s & 0xF) / 15.0f) * 2f - 1f);
        float y = ((((s >> 4) & 0xF) / 15.0f) * 2f - 1f);
        float z = ((((s >> 8) & 0xF) / 15.0f) * 2f - 1f);
        float w = ((((s >> 12) & 0xF) / 15.0f) * 2f - 1f);
        var q = new Quaternion(x, y, z, w);
        return NormalizeQuaternionOrThrow(q, "STRAIGHT16");
    }

    public static Quaternion UnpackUncompressedQuat(ReadOnlySpan<byte> data)
    {
        if (data.Length < 16) throw new InvalidDataException("Uncompressed quaternion requires 16 bytes.");
        float x = BinaryPrimitives.ReadSingleLittleEndian(data.Slice(0, 4));
        float y = BinaryPrimitives.ReadSingleLittleEndian(data.Slice(4, 4));
        float z = BinaryPrimitives.ReadSingleLittleEndian(data.Slice(8, 4));
        float w = BinaryPrimitives.ReadSingleLittleEndian(data.Slice(12, 4));
        if (!float.IsFinite(x) || !float.IsFinite(y) || !float.IsFinite(z) || !float.IsFinite(w))
            throw new InvalidDataException("Uncompressed quaternion contains a non-finite component.");
        var q = new Quaternion(x, y, z, w);
        return NormalizeQuaternionOrThrow(q, "uncompressed quaternion");
    }

    private static void ValidateCurve(SplineCurve curve, float t)
    {
        ArgumentNullException.ThrowIfNull(curve);
        if (!float.IsFinite(t) || curve.Degree < 0 || curve.Degree > 4 || curve.ControlPoints.Length == 0 ||
            curve.Knots.Length != curve.ControlPoints.Length + curve.Degree + 1)
            throw new InvalidDataException("Invalid scalar B-spline degree, knot vector, or control point count.");
        for (var i = 0; i < curve.Knots.Length; i++)
        {
            if (!float.IsFinite(curve.Knots[i]) || (i > 0 && curve.Knots[i] < curve.Knots[i - 1]))
                throw new InvalidDataException("Scalar B-spline knot vector is non-finite or unordered.");
        }
        if (curve.ControlPoints.Any(value => !float.IsFinite(value)))
            throw new InvalidDataException("Scalar B-spline control points contain a non-finite value.");
    }

    private static void ValidateCurve(SplineQuatCurve curve, float t)
    {
        ArgumentNullException.ThrowIfNull(curve);
        if (!float.IsFinite(t) || curve.Degree < 0 || curve.Degree > 4 || curve.ControlPoints.Length == 0 ||
            curve.Knots.Length != curve.ControlPoints.Length + curve.Degree + 1)
            throw new InvalidDataException("Invalid quaternion B-spline degree, knot vector, or control point count.");
        for (var i = 0; i < curve.Knots.Length; i++)
        {
            if (!float.IsFinite(curve.Knots[i]) || (i > 0 && curve.Knots[i] < curve.Knots[i - 1]))
                throw new InvalidDataException("Quaternion B-spline knot vector is non-finite or unordered.");
        }
        foreach (var value in curve.ControlPoints)
            _ = NormalizeQuaternionOrThrow(value, "quaternion B-spline control point");
    }

    private static Quaternion NormalizeQuaternionOrThrow(Quaternion value, string description)
    {
        if (!float.IsFinite(value.X) || !float.IsFinite(value.Y) || !float.IsFinite(value.Z) || !float.IsFinite(value.W) || value.LengthSquared() <= 1e-8f)
            throw new InvalidDataException($"{description} is non-finite or has zero length.");
        return Quaternion.Normalize(value);
    }
}
