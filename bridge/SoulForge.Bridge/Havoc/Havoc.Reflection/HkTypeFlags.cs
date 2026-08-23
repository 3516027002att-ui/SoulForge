using System;

namespace Havoc.Reflection;

[Flags]
public enum HkTypeFlags
{
	HasFormatInfo = 1,
	HasSubType = 2,
	HasVersion = 4,
	HasByteSize = 8,
	HasUnknownFlags = 0x10,
	HasFields = 0x20,
	HasInterfaces = 0x40,
	HasUnknownData = 0x80
}
