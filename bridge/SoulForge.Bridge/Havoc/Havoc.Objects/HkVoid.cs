using System;
using Havoc.Reflection;

namespace Havoc.Objects;

public class HkVoid : IHkObject
{
	public HkType Type { get; }

	object IHkObject.Value => null;

	public HkVoid(HkType type)
	{
		if (type.Format != 0)
		{
			throw new ArgumentException("Type must be of a void type.", "type");
		}
		Type = type;
	}
}
