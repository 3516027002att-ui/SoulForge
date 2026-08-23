using System;
using Havoc.Reflection;

namespace Havoc.Objects;

public class HkInt16 : IHkObject
{
	public short Value { get; }

	public HkType Type { get; }

	object IHkObject.Value => Value;

	public HkInt16(HkType type, short value)
	{
		if (type.Format != HkTypeFormat.Int || type.BitCount != 16 || !type.IsSigned)
		{
			throw new ArgumentException("Type must be of an int16 type.", "type");
		}
		Type = type;
		Value = value;
	}
}
