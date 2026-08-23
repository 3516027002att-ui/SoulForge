using System;
using Havoc.Reflection;

namespace Havoc.Objects;

public class HkSByte : IHkObject
{
	public sbyte Value { get; }

	public HkType Type { get; }

	object IHkObject.Value => Value;

	public HkSByte(HkType type, sbyte value)
	{
		if (type.Format != HkTypeFormat.Int || type.BitCount != 8 || !type.IsSigned)
		{
			throw new ArgumentException("Type must be of an int8 type.", "type");
		}
		Type = type;
		Value = value;
	}
}
