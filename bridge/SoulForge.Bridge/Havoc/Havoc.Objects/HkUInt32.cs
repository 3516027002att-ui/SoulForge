using System;
using Havoc.Reflection;

namespace Havoc.Objects;

public class HkUInt32 : IHkObject
{
	public uint Value { get; }

	public HkType Type { get; }

	object IHkObject.Value => Value;

	public HkUInt32(HkType type, uint value)
	{
		if (type.Format != HkTypeFormat.Int || type.BitCount != 32 || type.IsSigned)
		{
			throw new ArgumentException("Type must be of an uint32 type.", "type");
		}
		Type = type;
		Value = value;
	}
}
