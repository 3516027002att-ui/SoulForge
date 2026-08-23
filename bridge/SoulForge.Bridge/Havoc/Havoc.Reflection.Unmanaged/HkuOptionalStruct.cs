namespace Havoc.Reflection.Unmanaged;

public static class HkuOptionalStruct
{
	public unsafe static int GetSize(void* ptr)
	{
		return sizeof(void*) * 2 + GetBitCount(*(int*)ptr) * sizeof(void*);
	}

	public unsafe static void* GetAssociatedType(void* ptr)
	{
		return *(void**)((byte*)ptr + sizeof(long*));
	}

	public unsafe static bool HasOptionalValue(void* ptr, int member)
	{
		return (*(int*)ptr & member) != 0;
	}

	public unsafe static long** GetOptionalValue(void* ptr, int member)
	{
		if (!HasOptionalValue(ptr, member))
		{
			return null;
		}
		return (long**)((byte*)ptr + (nint)(GetBitCount(*(int*)ptr & (member - 1)) + 2) * (nint)sizeof(long*));
	}

	private static int GetBitCount(int value)
	{
		value -= (value >> 1) & 0x55555555;
		value = (value & 0x33333333) + ((value >> 2) & 0x33333333);
		return ((value + (value >> 4)) & 0xF0F0F0F) * 16843009 >> 24;
	}
}
