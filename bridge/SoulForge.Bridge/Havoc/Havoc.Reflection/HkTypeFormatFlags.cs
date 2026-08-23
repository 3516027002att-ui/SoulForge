using System;

namespace Havoc.Reflection;

[Flags]
public enum HkTypeFormatFlags
{
	IsFixedSize = 0x20,
	IsSigned = 0x200
}
