using System;
using Havoc.Reflection;

namespace Havoc.Objects;

public class HkSingle : IHkObject
{
	public float Value { get; }

	public HkType Type { get; }

	object IHkObject.Value => Value;

	public HkSingle(HkType type, float value)
	{
		if (!type.IsSingle)
		{
			throw new ArgumentException("Type must be of a float type.", "type");
		}
		Type = type;
		Value = value;
	}
}
