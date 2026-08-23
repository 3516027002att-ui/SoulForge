using System;
using Havoc.Reflection;

namespace Havoc.Objects;

public class HkInt32 : IHkObject
{
	public int Value { get; }

	public HkType Type { get; }

	object IHkObject.Value => Value;

	public HkInt32(HkType type, int value)
	{
		if (type.Format != HkTypeFormat.Int || type.BitCount != 32 || !type.IsSigned)
		{
			throw new ArgumentException("Type must be of an int32 type.", "type");
		}
		Type = type;
		Value = value;
	}
}
