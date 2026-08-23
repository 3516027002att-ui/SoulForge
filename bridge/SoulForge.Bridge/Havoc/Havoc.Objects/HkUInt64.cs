using System;
using Havoc.Reflection;

namespace Havoc.Objects;

public class HkUInt64 : IHkObject
{
	public ulong Value { get; }

	public HkType Type { get; }

	object IHkObject.Value => Value;

	public HkUInt64(HkType type, ulong value)
	{
		if (type.Format != HkTypeFormat.Int || type.BitCount != 64 || type.IsSigned)
		{
			throw new ArgumentException("Type must be of an uint64 type.", "type");
		}
		Type = type;
		Value = value;
	}
}
