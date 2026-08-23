using System;
using Havoc.Reflection;

namespace Havoc.Objects;

public class HkInt64 : IHkObject
{
	public long Value { get; }

	public HkType Type { get; }

	object IHkObject.Value => Value;

	public HkInt64(HkType type, long value)
	{
		if (type.Format != HkTypeFormat.Int || type.BitCount != 64 || !type.IsSigned)
		{
			throw new ArgumentException("Type must be of an int64 type.", "type");
		}
		Type = type;
		Value = value;
	}
}
