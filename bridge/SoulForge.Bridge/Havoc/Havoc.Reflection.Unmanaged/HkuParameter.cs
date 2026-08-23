using System;
using System.Runtime.InteropServices;

namespace Havoc.Reflection.Unmanaged;

public struct HkuParameter
{
	public unsafe readonly void* Value;

	public unsafe readonly byte* Name;

	public unsafe bool IsIntValue => *Name == 118;

	public unsafe bool IsTypeValue => *Name == 116;

	public unsafe static int GetArrayCount(void* array)
	{
		return *(ushort*)array;
	}

	public unsafe static HkuParameter* GetArrayItem(void* array, int index)
	{
		return (HkuParameter*)((byte*)array + (nint)(index * 2 + 1) * (nint)sizeof(void*));
	}

	public unsafe string GetName()
	{
		return Marshal.PtrToStringAnsi((IntPtr)Name);
	}
}
