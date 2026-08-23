using System;
using System.Runtime.InteropServices;

namespace Havoc.Reflection.Unmanaged;

public static class HkuType
{
	public unsafe static void* GetParentType(void* type)
	{
		return HkuOptionalStruct.GetAssociatedType(type);
	}

	public unsafe static int GetFormatInfo(void* type)
	{
		long** optionalValue = HkuOptionalStruct.GetOptionalValue(type, 1);
		return (int)((optionalValue != null) ? (*optionalValue) : null);
	}

	public unsafe static void* GetSubType(void* type)
	{
		long** optionalValue = HkuOptionalStruct.GetOptionalValue(type, 2);
		return (optionalValue != null) ? (*optionalValue) : null;
	}

	public unsafe static string GetName(void* type)
	{
		long** optionalValue = HkuOptionalStruct.GetOptionalValue(type, 8);
		return (optionalValue != null && *optionalValue != null) ? Marshal.PtrToStringAnsi((IntPtr)(*optionalValue)) : null;
	}

	public unsafe static int GetVersion(void* type)
	{
		long** optionalValue = HkuOptionalStruct.GetOptionalValue(type, 16);
		return (int)((optionalValue != null) ? (*optionalValue) : null);
	}

	public unsafe static void* GetInterfaces(void* type)
	{
		long** optionalValue = HkuOptionalStruct.GetOptionalValue(type, 131072);
		return (optionalValue != null) ? (*optionalValue) : null;
	}

	public unsafe static void* GetParameters(void* type)
	{
		long** optionalValue = HkuOptionalStruct.GetOptionalValue(type, 262144);
		if (optionalValue == null || *optionalValue == null)
		{
			return null;
		}
		long* ptr = *optionalValue;
		if ((*ptr & -65536) != 0)
		{
			return ptr + 1;
		}
		return ptr;
	}

	public unsafe static int GetByteSize(void* field)
	{
		long** optionalValue = HkuOptionalStruct.GetOptionalValue(field, 8388608);
		return (optionalValue != null) ? (*(short*)optionalValue) : 0;
	}

	public unsafe static int GetAlignment(void* field)
	{
		long** optionalValue = HkuOptionalStruct.GetOptionalValue(field, 8388608);
		return (optionalValue != null) ? (*(short*)((byte*)optionalValue + 2)) : 0;
	}

	public unsafe static int GetUnknownFlags(void* type)
	{
		long** optionalValue = HkuOptionalStruct.GetOptionalValue(type, 16777216);
		return (int)((optionalValue != null) ? (*optionalValue) : null);
	}

	public unsafe static void* GetFields(void* type)
	{
		long** optionalValue = HkuOptionalStruct.GetOptionalValue(type, 67108864);
		return (optionalValue != null) ? (*optionalValue) : null;
	}
}
