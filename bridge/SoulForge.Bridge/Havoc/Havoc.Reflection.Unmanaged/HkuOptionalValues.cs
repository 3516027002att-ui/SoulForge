using System;

namespace Havoc.Reflection.Unmanaged;

[Flags]
public enum HkuOptionalValues
{
	FormatInfoOfType = 1,
	SubTypeOfType = 2,
	NameOfType = 8,
	VersionOfType = 0x10,
	InterfacesOfType = 0x20000,
	ParametersOfType = 0x40000,
	NameOfField = 0x80000,
	ByteOffsetAndFlagsOfField = 0x100000,
	ParentOfField = 0x200000,
	ByteSizeOfType = 0x800000,
	UnknownFlagsOfType = 0x1000000,
	FieldsOfType = 0x4000000
}
