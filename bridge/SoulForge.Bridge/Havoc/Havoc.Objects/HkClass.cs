using System;
using System.Collections.Generic;
using Havoc.Reflection;

namespace Havoc.Objects;

public class HkClass : IHkObject
{
	public IReadOnlyDictionary<HkField, IHkObject> Value { get; }

	public HkType Type { get; }

	object IHkObject.Value => Value;

	public HkClass(HkType type, IReadOnlyDictionary<HkField, IHkObject> value)
	{
		if (type.Format != HkTypeFormat.Class)
		{
			throw new ArgumentException("Type must be of a class type.", "type");
		}
		Type = type;
		Value = value;
	}
}
