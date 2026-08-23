using System;
using System.Collections.Generic;

namespace Havoc;

public readonly struct HkSdkVersion : IEquatable<HkSdkVersion>
{
	public static readonly HkSdkVersion V20120200 = new HkSdkVersion(2012, 2, 0);
	public static readonly HkSdkVersion V20150100 = new HkSdkVersion(2015, 1, 0);
	public static readonly HkSdkVersion V20160100 = new HkSdkVersion(2016, 1, 0);
	public static readonly HkSdkVersion V20160200 = new HkSdkVersion(2016, 2, 0);
	public static readonly HkSdkVersion V20180100 = new HkSdkVersion(2018, 1, 0);
	public static readonly HkSdkVersion V20190100 = new HkSdkVersion(2019, 1, 0);

	public static readonly IReadOnlyCollection<HkSdkVersion> SupportedSdkVersions = new[] { V20150100, V20160100, V20160200, V20180100, V20190100 };

	public readonly uint Value;

	public ushort Year => (ushort)(Value >> 16);
	public ushort Major => (byte)((Value >> 8) & 0xFFu);
	public ushort Minor => (byte)(Value & 0xFFu);

	public bool Equals(HkSdkVersion other) => other.Value == Value;
	public override bool Equals(object? obj) => obj is HkSdkVersion other && Equals(other);
	public override int GetHashCode() => Value.GetHashCode();
	public override string ToString() => $"{Year:D4}{Major:D2}{Minor:D2}";

	public static bool operator <(HkSdkVersion left, HkSdkVersion right) => left.Value < right.Value;
	public static bool operator >(HkSdkVersion left, HkSdkVersion right) => left.Value > right.Value;
	public static bool operator >=(HkSdkVersion left, HkSdkVersion right) => left.Value >= right.Value;
	public static bool operator <=(HkSdkVersion left, HkSdkVersion right) => left.Value <= right.Value;
	public static bool operator ==(HkSdkVersion left, HkSdkVersion right) => left.Value == right.Value;
	public static bool operator !=(HkSdkVersion left, HkSdkVersion right) => left.Value != right.Value;

	public HkSdkVersion(ushort year, byte major, byte minor)
	{
		Value = (uint)((year << 16) | (major << 8) | minor);
	}

	public HkSdkVersion(string value)
	{
		if (value.Length != 8)
		{
			throw new ArgumentException("Invalid SDK version string length.", nameof(value));
		}
		ReadOnlySpan<char> span = value.AsSpan();
		Value = (uint)((ushort.Parse(span.Slice(0, 4)) << 16) | (byte.Parse(span.Slice(4, 2)) << 8) | byte.Parse(span.Slice(6, 2)));
	}
}
