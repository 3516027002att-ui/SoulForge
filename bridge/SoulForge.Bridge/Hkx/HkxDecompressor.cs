// MIT License
// Copyright (c) 2026 SoulForge Authors
// Clean-room implementation of checked De Boor B-spline evaluation and HKX
// quaternion decoding. Malformed compressed data is an error; it never turns
// into a zero/identity/default pose.

using System.Buffers.Binary;
using System.Numerics;

namespace SoulForge.Bridge.Hkx;

internal static class HkxDecompressor
{
    public static float EvaluateBSpline(SplineCurve curve, float t)
    {
        ValidateScalarCurve(curve);
        if (curve.ControlPoints.Length == 1)
            return curve.ControlPoints[0];

        int degree = curve.Degree;
        var knots = curve.Knots;
        var cp = curve.ControlPoints;
        int n = cp.Length;
        float parameter = ClampParameter(knots, degree, n, t);
        int span = FindSpan(knots, degree, n, parameter);

        var d = new float[degree + 1];
        for (int j = 0; j <= degree; j++)
        {
            int cpIndex = span - degree + j;
            d[j] = cp[cpIndex];
        }

        for (int r = 1; r <= degree; r++)
        {
            for (int j = degree; j >= r; j--)
            {
                int knotIndex = span - degree + j;
                float left = knots[knotIndex];
                float right = knots[knotIndex + degree - r + 1];
                float alpha = Math.Abs(right - left) > 1e-6f
                    ? (parameter - left) / (right - left)
                    : 0f;
                d[j] = (1f - alpha) * d[j - 1] + alpha * d[j];
            }
        }

        if (!float.IsFinite(d[degree]))
            throw new InvalidDataException("HKX spline evaluation produced a non-finite scalar.");
        return d[degree];
    }

    public static Quaternion EvaluateBSplineQuat(SplineQuatCurve curve, float t)
    {
        ValidateQuaternionCurve(curve);
        if (curve.ControlPoints.Length == 1)
            return NormalizeQuaternion(curve.ControlPoints[0], "HKX quaternion control point");

        int degree = curve.Degree;
        var knots = curve.Knots;
        var cp = curve.ControlPoints;
        int n = cp.Length;
        float parameter = ClampParameter(knots, degree, n, t);
        int span = FindSpan(knots, degree, n, parameter);

        var d = new Quaternion[degree + 1];
        for (int j = 0; j <= degree; j++)
        {
            int cpIndex = span - degree + j;
            d[j] = cp[cpIndex];
        }

        // Havok evaluates quaternion control points as a four-component spline
        // and normalizes the result. Slerp would change the compressed curve.
        for (int r = 1; r <= degree; r++)
        {
            for (int j = degree; j >= r; j--)
            {
                int knotIndex = span - degree + j;
                float left = knots[knotIndex];
                float right = knots[knotIndex + degree - r + 1];
                float alpha = Math.Abs(right - left) > 1e-6f
                    ? (parameter - left) / (right - left)
                    : 0f;

                var q0 = d[j - 1];
                var q1 = d[j];
                if (Quaternion.Dot(q0, q1) < 0f)
                    q1 = -q1;
                d[j] = new Quaternion(
                    q0.X + (q1.X - q0.X) * alpha,
                    q0.Y + (q1.Y - q0.Y) * alpha,
                    q0.Z + (q1.Z - q0.Z) * alpha,
                    q0.W + (q1.W - q0.W) * alpha);
            }
        }

        return NormalizeQuaternion(d[degree], "HKX spline quaternion");
    }

    public static Quaternion UnpackPolar32(uint packed)
    {
        // Havok's polar32 layout: a 10-bit W magnitude, an indexed spherical
        // direction in the low 18 bits, and four sign bits.
        float w = ((packed >> 18) & 0x3FFu) * 0.0009775171f;
        w = 1f - w * w;
        float squareIndex = packed & 0x3FFFFu;
        float root = MathF.Floor(MathF.Sqrt(squareIndex));
        float angle = 0f;
        if (root > 0f)
        {
            angle = MathF.PI / 4f * (squareIndex - root * root) / root;
            root *= 0.0030739654f;
        }

        float radius = MathF.Sqrt(MathF.Max(0f, 1f - w * w));
        var result = new Quaternion(
            MathF.Sin(root) * MathF.Cos(angle) * radius,
            MathF.Sin(root) * MathF.Sin(angle) * radius,
            MathF.Cos(root) * radius,
            w);
        if ((packed & 0x10000000u) != 0) result.X = -result.X;
        if ((packed & 0x20000000u) != 0) result.Y = -result.Y;
        if ((packed & 0x40000000u) != 0) result.Z = -result.Z;
        if ((packed & 0x80000000u) != 0) result.W = -result.W;
        return NormalizeQuaternion(result, "HKX Polar32 quaternion");
    }

    public static Quaternion UnpackThreeComp40(ReadOnlySpan<byte> data)
    {
        RequireLength(data, 5, "HKX ThreeComp40 quaternion");
        ulong packed = data[0]
            | ((ulong)data[1] << 8)
            | ((ulong)data[2] << 16)
            | ((ulong)data[3] << 24)
            | ((ulong)data[4] << 32);

        // ThreeComp40 stores three 12-bit components in the low 36 bits.
        // The center is the mature decoder's 2047 (not 2049); bits 36..37
        // select the omitted component and bit 38 stores its sign.
        int c0 = (int)(packed & 0xFFF) - 2047;
        int c1 = (int)((packed >> 12) & 0xFFF) - 2047;
        int c2 = (int)((packed >> 24) & 0xFFF) - 2047;
        int omitted = (int)((packed >> 36) & 0x3);
        var values = new[] { c0 * 0.000345436f, c1 * 0.000345436f, c2 * 0.000345436f };
        bool negative = ((packed >> 38) & 1) != 0;
        return ReconstructSmallestThree(values, omitted, negative, "HKX ThreeComp40 quaternion");
    }

    public static Quaternion UnpackThreeComp48(ReadOnlySpan<byte> data)
    {
        RequireLength(data, 6, "HKX ThreeComp48 quaternion");
        short n1 = BinaryPrimitives.ReadInt16LittleEndian(data.Slice(0, 2));
        short n2 = BinaryPrimitives.ReadInt16LittleEndian(data.Slice(2, 2));
        short n3 = BinaryPrimitives.ReadInt16LittleEndian(data.Slice(4, 2));

        int omitted = ((n2 >> 14) & 2) | ((n1 >> 15) & 1);
        bool negative = (n3 >> 15) != 0;
        var values = new[]
        {
            ((n1 & 0x7FFF) - 16383) * 4.3161E-05f,
            ((n2 & 0x7FFF) - 16383) * 4.3161E-05f,
            ((n3 & 0x7FFF) - 16383) * 4.3161E-05f
        };
        return ReconstructSmallestThree(values, omitted, negative, "HKX ThreeComp48 quaternion");
    }

    public static Quaternion UnpackThreeComp24(ReadOnlySpan<byte> data)
    {
        _ = data;
        throw new NotSupportedException("HKX ThreeComp24 quaternion quantization is not verified for this corpus.");
    }

    public static Quaternion UnpackStraight16(ReadOnlySpan<byte> data)
    {
        _ = data;
        throw new NotSupportedException("HKX Straight16 quaternion quantization is not verified for this corpus.");
    }

    public static Quaternion UnpackUncompressedQuat(ReadOnlySpan<byte> data)
    {
        RequireLength(data, 16, "HKX uncompressed quaternion");
        float x = BinaryPrimitives.ReadSingleLittleEndian(data.Slice(0, 4));
        float y = BinaryPrimitives.ReadSingleLittleEndian(data.Slice(4, 4));
        float z = BinaryPrimitives.ReadSingleLittleEndian(data.Slice(8, 4));
        float w = BinaryPrimitives.ReadSingleLittleEndian(data.Slice(12, 4));
        return NormalizeQuaternion(new Quaternion(x, y, z, w), "HKX uncompressed quaternion");
    }

    private static void ValidateScalarCurve(SplineCurve curve)
    {
        if (curve is null)
            throw new InvalidDataException("HKX scalar spline is null.");
        ValidateCurveShape(curve.Degree, curve.Knots, curve.ControlPoints.Length, "scalar");
        foreach (float value in curve.ControlPoints)
        {
            if (!float.IsFinite(value))
                throw new InvalidDataException("HKX scalar spline contains a non-finite control point.");
        }
    }

    private static void ValidateQuaternionCurve(SplineQuatCurve curve)
    {
        if (curve is null)
            throw new InvalidDataException("HKX quaternion spline is null.");
        ValidateCurveShape(curve.Degree, curve.Knots, curve.ControlPoints.Length, "quaternion");
        foreach (var value in curve.ControlPoints)
        {
            _ = NormalizeQuaternion(value, "HKX quaternion spline control point");
        }
    }

    private static void ValidateCurveShape(int degree, IReadOnlyList<float> knots, int controlPointCount, string kind)
    {
        if (controlPointCount <= 0)
            throw new InvalidDataException($"HKX {kind} spline has no control points.");
        if (degree < 0 || degree > 3)
            throw new InvalidDataException($"HKX {kind} spline degree {degree} is outside the supported range 0..3.");
        int expectedKnotCount = checked(controlPointCount + degree + 1);
        if (knots.Count != expectedKnotCount)
            throw new InvalidDataException(
                $"HKX {kind} spline knot count mismatch: expected={expectedKnotCount}, actual={knots.Count}.");
        for (int i = 0; i < knots.Count; i++)
        {
            if (!float.IsFinite(knots[i]))
                throw new InvalidDataException($"HKX {kind} spline has a non-finite knot at {i}.");
            if (i > 0 && knots[i] < knots[i - 1])
                throw new InvalidDataException($"HKX {kind} spline knots are not monotonic at {i}.");
        }
        if (knots[degree] > knots[controlPointCount])
            throw new InvalidDataException($"HKX {kind} spline has an empty parameter range.");
    }

    private static float ClampParameter(IReadOnlyList<float> knots, int degree, int controlPointCount, float t)
    {
        if (!float.IsFinite(t))
            throw new InvalidDataException("HKX spline sample time is non-finite.");
        return Math.Clamp(t, knots[degree], knots[controlPointCount]);
    }

    private static int FindSpan(IReadOnlyList<float> knots, int degree, int controlPointCount, float t)
    {
        if (t >= knots[controlPointCount])
            return controlPointCount - 1;

        int low = degree;
        int high = controlPointCount;
        int mid = (low + high) / 2;
        while (t < knots[mid] || t >= knots[mid + 1])
        {
            if (t < knots[mid]) high = mid;
            else low = mid;
            mid = (low + high) / 2;
            if (low >= high - 1) break;
        }
        return Math.Clamp(mid, degree, controlPointCount - 1);
    }

    private static Quaternion ReconstructSmallestThree(
        IReadOnlyList<float> values,
        int omitted,
        bool negative,
        string label)
    {
        if (omitted < 0 || omitted > 3)
            throw new InvalidDataException($"{label} has invalid omitted component {omitted}.");
        float sum = values[0] * values[0] + values[1] * values[1] + values[2] * values[2];
        float remaining = 1f - sum;
        if (!float.IsFinite(remaining) || remaining < -1e-4f)
            throw new InvalidDataException($"{label} has components outside the unit quaternion domain.");
        float omittedValue = MathF.Sqrt(MathF.Max(0f, remaining));
        if (negative) omittedValue = -omittedValue;

        var result = new float[4];
        for (int i = 0, source = 0; i < result.Length; i++)
        {
            result[i] = i == omitted ? omittedValue : values[source++];
        }
        return NormalizeQuaternion(new Quaternion(result[0], result[1], result[2], result[3]), label);
    }

    private static Quaternion NormalizeQuaternion(Quaternion value, string label)
    {
        if (!float.IsFinite(value.X) || !float.IsFinite(value.Y)
            || !float.IsFinite(value.Z) || !float.IsFinite(value.W))
            throw new InvalidDataException($"{label} contains a non-finite value.");
        float lengthSquared = value.LengthSquared();
        if (!float.IsFinite(lengthSquared) || lengthSquared <= 1e-12f)
            throw new InvalidDataException($"{label} is zero length.");
        return Quaternion.Normalize(value);
    }

    private static void RequireLength(ReadOnlySpan<byte> data, int required, string label)
    {
        if (data.Length < required)
            throw new InvalidDataException($"{label} is truncated: required={required}, actual={data.Length}.");
    }
}
