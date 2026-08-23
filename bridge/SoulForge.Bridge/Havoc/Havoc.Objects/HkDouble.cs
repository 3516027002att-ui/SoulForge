using System;
using Havoc.Reflection;

namespace Havoc.Objects;

public class HkDouble : IHkObject
{
	public double Value { get; }

	public HkType Type { get; }

	object IHkObject.Value => Value;

	public HkDouble(HkType type, double value)
	{
		if (!type.IsDouble)
		{
			throw new ArgumentException("Type must be of a double type.", "type");
		}
		Type = type;
		Value = value;
	}
}
