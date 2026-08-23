using System;
using Havoc.Reflection;

namespace Havoc.Objects;

public class HkOpaque : IHkObject
{
	public HkType Type { get; }

	object IHkObject.Value => null;

	public HkOpaque(HkType type)
	{
		if (type.Format != HkTypeFormat.Opaque)
		{
			throw new ArgumentException("Type must be of an opaque type.", "type");
		}
		Type = type;
	}
}
