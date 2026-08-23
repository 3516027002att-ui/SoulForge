using System;
using System.Collections.Generic;
using Havoc.Reflection;

namespace Havoc.Objects;

public class HkArray : IHkObject
{
	public IReadOnlyList<IHkObject> Value { get; }

	public HkType Type { get; }

	object IHkObject.Value => Value;

	public HkArray(HkType type, IReadOnlyList<IHkObject> value)
	{
		if (type.Format != HkTypeFormat.Array)
		{
			throw new ArgumentException("Type must be of an array type.", "type");
		}
		if (type.IsFixedSize && value.Count != type.FixedSize)
		{
			throw new ArgumentOutOfRangeException("value", "Array size must be equal to fixed size.");
		}
		Type = type;
		Value = value;
	}
}
