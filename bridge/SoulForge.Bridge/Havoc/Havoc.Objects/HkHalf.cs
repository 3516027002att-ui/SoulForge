using System;
using Havoc.Reflection;

namespace Havoc.Objects;

public class HkHalf : IHkObject
{
	public Half Value { get; }

	public HkType Type { get; }

	object IHkObject.Value => Value;

	public HkHalf(HkType type, Half value)
	{
		if (!type.IsHalf)
		{
			throw new ArgumentException("Type must be of a float16 type.", "type");
		}
		Type = type;
		Value = value;
	}
}
