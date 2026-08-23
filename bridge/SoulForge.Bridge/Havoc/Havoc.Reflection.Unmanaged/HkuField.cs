using System;
using System.Runtime.InteropServices;

namespace Havoc.Reflection.Unmanaged;

public static class HkuField
{
	public unsafe static void* GetType(void* field)
	{
		return HkuOptionalStruct.GetAssociatedType(field);
	}

	public unsafe static int GetByteOffset(void* field)
	{
		long** optionalValue = HkuOptionalStruct.GetOptionalValue(field, 1048576);
		return (optionalValue != null) ? (*(short*)optionalValue) : 0;
	}

	public unsafe static int GetFlags(void* field)
	{
		long** optionalValue = HkuOptionalStruct.GetOptionalValue(field, 1048576);
		return (optionalValue != null) ? (*(short*)((byte*)optionalValue + 2)) : 0;
	}

	public unsafe static string GetName(void* field)
	{
		long** optionalValue = HkuOptionalStruct.GetOptionalValue(field, 524288);
		return (optionalValue != null && *optionalValue != null) ? Marshal.PtrToStringAnsi((IntPtr)(*optionalValue)) : null;
	}

	public unsafe static void* GetParent(void* field)
	{
		long** optionalValue = HkuOptionalStruct.GetOptionalValue(field, 2097152);
		return (optionalValue != null) ? (*optionalValue) : null;
	}

	public unsafe static int GetArrayCount(void* array)
	{
		return *(ushort*)array + *(ushort*)((byte*)array + 2);
	}

	public unsafe static void* GetArrayItem(void* array, int index)
	{
		return *(void**)((byte*)array + (nint)(index + 1) * (nint)sizeof(void*));
	}
}
