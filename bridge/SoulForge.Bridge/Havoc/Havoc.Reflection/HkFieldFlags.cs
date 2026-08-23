using System;

namespace Havoc.Reflection;

[Flags]
public enum HkFieldFlags
{
	IsNotSerializable = 1,
	IsProtected = 2,
	IsPrivate = 4,
	UnknownFlag = 0x20
}
