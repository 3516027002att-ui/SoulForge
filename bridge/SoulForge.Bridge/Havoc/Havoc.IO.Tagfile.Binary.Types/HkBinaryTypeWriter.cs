using System.IO;
using System.Linq;
using Havoc.Collections;
using Havoc.Extensions;
using Havoc.IO.Tagfile.Binary.Sections;
using Havoc.Reflection;

namespace Havoc.IO.Tagfile.Binary.Types;

public static class HkBinaryTypeWriter
{
	public static void WriteTypeSection(BinaryWriter writer, HkTypeCompendium typeCompendium, HkSdkVersion sdkVersion)
	{
		OrderedSet<string> orderedSet = new OrderedSet<string>();
		OrderedSet<string> orderedSet2 = new OrderedSet<string>();
		foreach (HkType item in typeCompendium)
		{
			orderedSet.Add(item.Name);
			foreach (HkParameter mParameter in item.mParameters)
			{
				orderedSet.Add(mParameter.Name);
			}
			foreach (HkField mField in item.mFields)
			{
				orderedSet2.Add(mField.Name);
			}
		}
		using (new HkSectionWriter(writer, "TYPE", hasSubSections: true))
		{
			using (new HkSectionWriter(writer, "TPTR", hasSubSections: false))
			{
				for (int i = 0; i < typeCompendium.Count; i++)
				{
					writer.Write(0uL);
				}
			}
			using (new HkSectionWriter(writer, "TSTR", hasSubSections: false))
			{
				foreach (string item2 in orderedSet)
				{
					writer.WriteNullTerminatedString(item2);
				}
			}
			using (new HkSectionWriter(writer, (sdkVersion >= HkSdkVersion.V20160200) ? "TNA1" : "TNAM", hasSubSections: false))
			{
				writer.WritePackedInt(typeCompendium.Count);
				int num = 0;
				foreach (HkType item3 in typeCompendium)
				{
					num++;
					writer.WritePackedInt(orderedSet.IndexMap[item3.Name]);
					writer.WritePackedInt(item3.mParameters.Count);
					foreach (HkParameter mParameter2 in item3.mParameters)
					{
						writer.WritePackedInt(orderedSet.IndexMap[mParameter2.Name]);
						if (mParameter2.IsInt)
						{
							writer.WritePackedInt((long)mParameter2.Value);
						}
						else
						{
							writer.WritePackedInt(GetTypeIndex((HkType)mParameter2.Value));
						}
					}
				}
			}
			using (new HkSectionWriter(writer, "FSTR", hasSubSections: false))
			{
				foreach (string item4 in orderedSet2)
				{
					writer.WriteNullTerminatedString(item4);
				}
			}
			using (new HkSectionWriter(writer, (sdkVersion >= HkSdkVersion.V20160200) ? "TBDY" : "TBOD", hasSubSections: false))
			{
				foreach (HkType item5 in typeCompendium)
				{
					writer.WritePackedInt(GetTypeIndex(item5));
					writer.WritePackedInt(GetTypeIndex(item5.ParentType));
					writer.WritePackedInt((long)item5.Flags);
					if ((item5.Flags & HkTypeFlags.HasFormatInfo) != 0)
					{
						writer.WritePackedInt(item5.mFormatInfo);
					}
					if ((item5.Flags & HkTypeFlags.HasSubType) != 0)
					{
						writer.WritePackedInt(GetTypeIndex(item5.mSubType));
					}
					if ((item5.Flags & HkTypeFlags.HasVersion) != 0)
					{
						writer.WritePackedInt(item5.mVersion);
					}
					if ((item5.Flags & HkTypeFlags.HasByteSize) != 0)
					{
						writer.WritePackedInt(item5.mByteSize);
						writer.WritePackedInt(item5.mAlignment);
					}
					if ((item5.Flags & HkTypeFlags.HasUnknownFlags) != 0)
					{
						writer.WritePackedInt(item5.mUnknownFlags);
					}
					if ((item5.Flags & HkTypeFlags.HasFields) != 0)
					{
						writer.Write((byte)item5.mFields.Count);
						foreach (HkField mField2 in item5.mFields)
						{
							writer.WritePackedInt(orderedSet2.IndexMap[mField2.Name]);
							writer.WritePackedInt((long)mField2.Flags);
							writer.WritePackedInt(mField2.ByteOffset);
							int num2 = GetTypeIndex(mField2.Type);
							writer.WritePackedInt(num2);
							if (!(item5.Name == "hkPropertyId"))
							{
							}
						}
					}
					if ((item5.Flags & HkTypeFlags.HasInterfaces) == 0)
					{
						continue;
					}
					writer.WritePackedInt(item5.mInterfaces.Count);
					foreach (HkInterface mInterface in item5.mInterfaces)
					{
						writer.WritePackedInt(GetTypeIndex(mInterface.Type));
						writer.WritePackedInt(mInterface.Flags);
					}
				}
			}
			using (new HkSectionWriter(writer, "THSH", hasSubSections: false))
			{
				writer.WritePackedInt(typeCompendium.Count((HkType x) => x.Hash != 0));
				foreach (HkType item6 in typeCompendium)
				{
					if (item6.Hash != 0)
					{
						writer.WritePackedInt(GetTypeIndex(item6));
						writer.Write(item6.Hash);
					}
				}
			}
			using (new HkSectionWriter(writer, "TPAD", hasSubSections: false))
			{
			}
		}
		int GetTypeIndex(HkType type)
		{
			int value;
			return (type != null && typeCompendium.IndexMap.TryGetValue(type, out value)) ? (value + 1) : 0;
		}
	}
}
