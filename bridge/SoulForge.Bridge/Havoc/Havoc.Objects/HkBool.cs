using System;
using Havoc.Reflection;

namespace Havoc.Objects;

public class HkBool : IHkObject
{
	public bool Value { get; }

	public HkType Type { get; }

	object IHkObject.Value => Value;

	public HkBool(HkType type, bool value)
	{
		if (type.Format != HkTypeFormat.Bool)
		{
			throw new ArgumentException("Type must be of a bool type.", "type");
		}
		Type = type;
		Value = value;
	}
}
