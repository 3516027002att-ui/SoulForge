using System;
using System.Collections.Generic;

namespace Havoc.Reflection.Unmanaged;

public class HkuTypeConverter
{
	private readonly Dictionary<IntPtr, HkType> mTypeCache;

	public HkuTypeConverter()
	{
		mTypeCache = new Dictionary<IntPtr, HkType>();
	}

	public unsafe HkType Convert(void* type)
	{
		if (type == null)
		{
			return null;
		}
		if (mTypeCache.TryGetValue((IntPtr)type, out var value))
		{
			return value;
		}
		mTypeCache.Add((IntPtr)type, value = new HkType());
		value.Name = HkuType.GetName(type);
		value.ParentType = Convert(HkuType.GetParentType(type));
		if (HkuOptionalStruct.HasOptionalValue(type, 1))
		{
			value.Flags |= HkTypeFlags.HasFormatInfo;
			value.mFormatInfo = HkuType.GetFormatInfo(type);
		}
		if (HkuOptionalStruct.HasOptionalValue(type, 2))
		{
			value.Flags |= HkTypeFlags.HasSubType;
			value.mSubType = Convert(HkuType.GetSubType(type));
		}
		if (HkuOptionalStruct.HasOptionalValue(type, 16))
		{
			value.Flags |= HkTypeFlags.HasVersion;
			value.mVersion = HkuType.GetVersion(type);
		}
		if (HkuOptionalStruct.HasOptionalValue(type, 131072))
		{
			value.Flags |= HkTypeFlags.HasInterfaces;
			void* interfaces = HkuType.GetInterfaces(type);
			if (interfaces != null)
			{
				for (int i = 0; i < HkuInterface.GetArrayCount(interfaces); i++)
				{
					HkuInterface* arrayItem = HkuInterface.GetArrayItem(interfaces, i);
					value.mInterfaces.Add(new HkInterface
					{
						Flags = (int)arrayItem->Flags,
						Type = Convert(arrayItem->Type)
					});
				}
			}
		}
		if (HkuOptionalStruct.HasOptionalValue(type, 262144))
		{
			void* parameters = HkuType.GetParameters(type);
			if (parameters != null)
			{
				for (int j = 0; j < HkuParameter.GetArrayCount(parameters); j++)
				{
					HkuParameter* arrayItem2 = HkuParameter.GetArrayItem(parameters, j);
					value.mParameters.Add(new HkParameter
					{
						Name = arrayItem2->GetName(),
						Value = (arrayItem2->IsIntValue ? ((object)(long)arrayItem2->Value) : Convert(arrayItem2->Value))
					});
				}
			}
		}
		if (HkuOptionalStruct.HasOptionalValue(type, 8388608))
		{
			value.Flags |= HkTypeFlags.HasByteSize;
			value.mByteSize = HkuType.GetByteSize(type);
			value.mAlignment = HkuType.GetAlignment(type);
		}
		if (HkuOptionalStruct.HasOptionalValue(type, 16777216))
		{
			value.Flags |= HkTypeFlags.HasUnknownFlags;
			value.mUnknownFlags = HkuType.GetUnknownFlags(type);
		}
		if (HkuOptionalStruct.HasOptionalValue(type, 67108864))
		{
			value.Flags |= HkTypeFlags.HasFields;
			void* fields = HkuType.GetFields(type);
			if (fields != null)
			{
				for (int k = 0; k < HkuField.GetArrayCount(fields); k++)
				{
					void* arrayItem3 = HkuField.GetArrayItem(fields, k);
					value.mFields.Add(new HkField
					{
						ByteOffset = HkuField.GetByteOffset(arrayItem3),
						Flags = (HkFieldFlags)HkuField.GetFlags(arrayItem3),
						Name = HkuField.GetName(arrayItem3),
						Type = Convert(HkuField.GetType(arrayItem3))
					});
				}
			}
		}
		return value;
	}
}
