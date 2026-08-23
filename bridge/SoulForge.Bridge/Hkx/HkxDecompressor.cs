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
        if (curve.ControlPoints.Length == 0) return 0f;
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
            d[j] = (cpIdx >= 0 && cpIdx < n) ? cp[cpIdx] : 0f;
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
        if (curve.ControlPoints.Length == 0) return Quaternion.Identity;
        if (curve.ControlPoints.Length == 1) return Quaternion.Normalize(curve.ControlPoints[0]);

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
            d[j] = (cpIdx >= 0 && cpIdx < n) ? cp[cpIdx] : Quaternion.Identity;
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

                // Ensure shortest path for quaternion interpolation
                var q0 = d[j - 1];
                var q1 = d[j];
                if (Quaternion.Dot(q0, q1) < 0f)
                {
                    q1 = -q1;
                }
                d[j] = Quaternion.Normalize(Quaternion.Slerp(q0, q1, alpha));
            }
        }

        return Quaternion.Normalize(d[degree]);
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

        return major switch
        {
            0 => Quaternion.Normalize(new Quaternion(w, x, y, z)),
            1 => Quaternion.Normalize(new Quaternion(x, w, y, z)),
            2 => Quaternion.Normalize(new Quaternion(x, y, w, z)),
            _ => Quaternion.Normalize(new Quaternion(x, y, z, w))
        };
    }

    public static Quaternion UnpackThreeComp40(ReadOnlySpan<byte> data)
    {
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

        return omitted switch
        {
            0 => Quaternion.Normalize(new Quaternion(c3, c0, c1, c2)),
            1 => Quaternion.Normalize(new Quaternion(c0, c3, c1, c2)),
            2 => Quaternion.Normalize(new Quaternion(c0, c1, c3, c2)),
            _ => Quaternion.Normalize(new Quaternion(c0, c1, c2, c3))
        };
    }

    public static Quaternion UnpackThreeComp48(ReadOnlySpan<byte> data)
    {
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

        return omitted switch
        {
            0 => Quaternion.Normalize(new Quaternion(c3, c0, c1, c2)),
            1 => Quaternion.Normalize(new Quaternion(c0, c3, c1, c2)),
            2 => Quaternion.Normalize(new Quaternion(c0, c1, c3, c2)),
            _ => Quaternion.Normalize(new Quaternion(c0, c1, c2, c3))
        };
    }
}
