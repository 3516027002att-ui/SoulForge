using System;

namespace Havoc.Reflection;

[Flags]
public enum HkTypeFormat
{
	Void = 0,
	Opaque = 1,
	Bool = 2,
	String = 3,
	Int = 4,
	FloatingPoint = 5,
	Ptr = 6,
	Class = 7,
	Array = 8
}
