using System;
using Havoc.Reflection;

namespace Havoc.Objects;

public class HkUInt16 : IHkObject
{
	public ushort Value { get; }

	public HkType Type { get; }

	object IHkObject.Value => Value;

	public HkUInt16(HkType type, ushort value)
	{
		if (type.Format != HkTypeFormat.Int || type.BitCount != 16 || type.IsSigned)
		{
			throw new ArgumentException("Type must be of an uint16 type.", "type");
		}
		Type = type;
		Value = value;
	}
}
