namespace Havoc.Reflection.Unmanaged;

public struct HkuInterface
{
	public unsafe readonly void* Type;

	public readonly long Flags;

	public unsafe static int GetArrayCount(void* array)
	{
		return *(ushort*)array;
	}

	public unsafe static HkuInterface* GetArrayItem(void* array, int index)
	{
		return (HkuInterface*)((byte*)array + (nint)(index * 2 + 1) * (nint)sizeof(void*));
	}
}
