using System;
using Havoc.Reflection;

namespace Havoc.Objects;

public class HkByte : IHkObject
{
	public byte Value { get; }

	public HkType Type { get; }

	object IHkObject.Value => Value;

	public HkByte(HkType type, byte value)
	{
		if (type.Format != HkTypeFormat.Int || type.BitCount != 8 || type.IsSigned)
		{
			throw new ArgumentException("Type must be of an uint8 type.", "type");
		}
		Type = type;
		Value = value;
	}
}
