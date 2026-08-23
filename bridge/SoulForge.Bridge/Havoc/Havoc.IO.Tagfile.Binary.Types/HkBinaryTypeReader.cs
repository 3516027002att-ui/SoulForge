using System.Collections.Generic;
using System.IO;
using System.Runtime.CompilerServices;
using Havoc.Extensions;
using Havoc.IO.Tagfile.Binary.Sections;
using Havoc.Reflection;

namespace Havoc.IO.Tagfile.Binary.Types;

public static class HkBinaryTypeReader
{
	public static List<HkType> ReadTypeSection(BinaryReader reader, HkSection section)
	{
		List<HkType> types = new List<HkType>();
		List<string> list = new List<string>();
		List<string> list2 = new List<string>();
		foreach (HkSection subSection in section.SubSections)
		{
			reader.BaseStream.Seek(subSection.Position, SeekOrigin.Begin);
			Debug.ReadProcess("  Read Type section: " + subSection.Signature);
			switch (subSection.Signature)
			{
			case "TSTR":
			case "TST1":
				while (reader.BaseStream.Position < subSection.Position + subSection.Length)
				{
					list.Add(reader.ReadNullTerminatedString());
				}
				break;
			case "TNAM":
			case "TNA1":
			{
				int num6 = (int)reader.ReadPackedInt();
				DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(16, 1);
				defaultInterpolatedStringHandler.AppendLiteral("Typedef: count: ");
				defaultInterpolatedStringHandler.AppendFormatted(num6);
				Debug.TypeDef(defaultInterpolatedStringHandler.ToStringAndClear());
				types = new List<HkType>(num6);
				for (int l = 0; l < num6; l++)
				{
					types.Add(new HkType());
				}
				int num7 = 0;
				foreach (HkType item2 in types)
				{
					num7++;
					item2.Name = list[(int)reader.ReadPackedInt()];
					defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(19, 3);
					defaultInterpolatedStringHandler.AppendFormatted(num7);
					defaultInterpolatedStringHandler.AppendLiteral(" Read type ");
					defaultInterpolatedStringHandler.AppendFormatted(item2);
					defaultInterpolatedStringHandler.AppendLiteral(", name: ");
					defaultInterpolatedStringHandler.AppendFormatted(item2.Name);
					Debug.TypeDef(defaultInterpolatedStringHandler.ToStringAndClear());
					int num8 = (int)reader.ReadPackedInt();
					if (num8 >= 64)
					{
						num8 &= 0x3F;
					}
					defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(22, 2);
					defaultInterpolatedStringHandler.AppendFormatted(num7);
					defaultInterpolatedStringHandler.AppendLiteral(" Read type parameters ");
					defaultInterpolatedStringHandler.AppendFormatted(num8);
					Debug.TypeDef(defaultInterpolatedStringHandler.ToStringAndClear());
					item2.mParameters.Capacity = num8;
					for (int m = 0; m < num8; m++)
					{
						HkParameter hkParameter = new HkParameter
						{
							Name = list[(int)reader.ReadPackedInt()]
						};
						defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(23, 3);
						defaultInterpolatedStringHandler.AppendFormatted(num7);
						defaultInterpolatedStringHandler.AppendLiteral("-");
						defaultInterpolatedStringHandler.AppendFormatted(m);
						defaultInterpolatedStringHandler.AppendLiteral(" Read type parameters ");
						defaultInterpolatedStringHandler.AppendFormatted(hkParameter.Name);
						Debug.TypeDef(defaultInterpolatedStringHandler.ToStringAndClear());
						if (hkParameter.Name[0] == 't')
						{
							hkParameter.Value = ReadTypeIndex(-1L);
						}
						else
						{
							hkParameter.Value = reader.ReadPackedInt();
						}
						item2.mParameters.Add(hkParameter);
					}
					defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(25, 1);
					defaultInterpolatedStringHandler.AppendFormatted(num7);
					defaultInterpolatedStringHandler.AppendLiteral(" Read type parameters end");
					Debug.TypeDef(defaultInterpolatedStringHandler.ToStringAndClear());
				}
				break;
			}
			case "FSTR":
			case "FST1":
				while (reader.BaseStream.Position < subSection.Position + subSection.Length)
				{
					string text = reader.ReadNullTerminatedString();
					list2.Add(text);
					Debug.TypeDef("field str: " + text);
				}
				break;
			case "TBOD":
			case "TBDY":
				while (reader.BaseStream.Position < subSection.Position + subSection.Length)
				{
					HkType hkType = ReadTypeIndex(-1L);
					if (hkType == null)
					{
						continue;
					}
					hkType.ParentType = ReadTypeIndex(-1L);
					hkType.Flags = (HkTypeFlags)reader.ReadPackedInt();
					if ((hkType.Flags & HkTypeFlags.HasFormatInfo) != 0)
					{
						hkType.mFormatInfo = (int)reader.ReadPackedInt();
					}
					if ((hkType.Flags & HkTypeFlags.HasSubType) != 0)
					{
						hkType.mSubType = ReadTypeIndex(-1L);
						if (hkType.SubType != null)
						{
							Debug.TypeDef("Type Read: SubType " + hkType.mSubType.Name);
						}
					}
					if ((hkType.Flags & HkTypeFlags.HasVersion) != 0)
					{
						hkType.mVersion = (int)reader.ReadPackedInt();
					}
					if ((hkType.Flags & HkTypeFlags.HasByteSize) != 0)
					{
						hkType.mByteSize = (int)reader.ReadPackedInt();
						DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(20, 1);
						defaultInterpolatedStringHandler.AppendLiteral("Type Read: ByteSize ");
						defaultInterpolatedStringHandler.AppendFormatted(hkType.mByteSize);
						Debug.TypeDef(defaultInterpolatedStringHandler.ToStringAndClear());
						hkType.mAlignment = (int)reader.ReadPackedInt();
					}
					if ((hkType.Flags & HkTypeFlags.HasUnknownFlags) != 0)
					{
						hkType.mUnknownFlags = (int)reader.ReadPackedInt();
					}
					if ((hkType.Flags & HkTypeFlags.HasFields) != 0)
					{
						int num2 = reader.ReadByte();
						if (num2 >= 64)
						{
							Debug.TypeDef("Type Read: fieldCount > 0x40");
						}
						if (num2 == 195)
						{
							Debug.TypeDef("Type Read: C3 in fieldCount");
							num2 = reader.ReadByte();
							if (num2 == 0)
							{
								num2 = (int)reader.ReadPackedInt();
							}
						}
						int num3 = num2 & 0x3F;
						DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(11, 2);
						defaultInterpolatedStringHandler.AppendLiteral("Typedef ");
						defaultInterpolatedStringHandler.AppendFormatted(hkType.Name);
						defaultInterpolatedStringHandler.AppendLiteral(" (");
						defaultInterpolatedStringHandler.AppendFormatted(num3);
						defaultInterpolatedStringHandler.AppendLiteral(")");
						Debug.TypeDef(defaultInterpolatedStringHandler.ToStringAndClear());
						hkType.mFields.Capacity = num3;
						for (int j = 0; j < num3; j++)
						{
							int index2 = (int)reader.ReadPackedInt();
							HkFieldFlags flags = (HkFieldFlags)reader.ReadPackedInt();
							HkField hkField = new HkField
							{
								Name = list2[index2],
								Flags = flags,
								ByteOffset = (int)reader.ReadPackedInt()
							};
							long num4 = reader.ReadPackedInt();
							hkField.Type = ReadTypeIndex(num4);
							hkType.mFields.Add(hkField);
							defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(39, 5);
							defaultInterpolatedStringHandler.AppendLiteral("    ");
							defaultInterpolatedStringHandler.AppendFormatted(hkField.Name);
							defaultInterpolatedStringHandler.AppendLiteral(": ");
							defaultInterpolatedStringHandler.AppendFormatted(hkField.Type?.Name);
							defaultInterpolatedStringHandler.AppendLiteral(", Flags: (");
							defaultInterpolatedStringHandler.AppendFormatted((int)hkField.Flags);
							defaultInterpolatedStringHandler.AppendLiteral(") (offset ");
							defaultInterpolatedStringHandler.AppendFormatted(hkField.ByteOffset);
							defaultInterpolatedStringHandler.AppendLiteral(") (typeidx: ");
							defaultInterpolatedStringHandler.AppendFormatted(num4);
							defaultInterpolatedStringHandler.AppendLiteral(")");
							Debug.TypeDef(defaultInterpolatedStringHandler.ToStringAndClear());
							if (j == 0 && hkField.ByteOffset != 0 && hkField.ByteOffset % 8 != 0)
							{
								Debug.TypeDef("WARNING: Type first field offset % 8 != 0");
							}
						}
					}
					if ((hkType.Flags & HkTypeFlags.HasInterfaces) != 0)
					{
						int num5 = (int)reader.ReadPackedInt();
						hkType.mInterfaces.Capacity = num5;
						for (int k = 0; k < num5; k++)
						{
							HkInterface item = new HkInterface
							{
								Type = ReadTypeIndex(-1L),
								Flags = (int)reader.ReadPackedInt()
							};
							hkType.mInterfaces.Add(item);
						}
					}
				}
				break;
			case "THSH":
			{
				int num = (int)reader.ReadPackedInt();
				for (int i = 0; i < num; i++)
				{
					ReadTypeIndex(-1L).Hash = reader.ReadInt32();
				}
				break;
			}
			default:
				throw new InvalidDataException("Unexpected signature: " + subSection.Signature);
			case "TPTR":
			case "TPAD":
				break;
			}
		}
		return types;
		HkType ReadTypeIndex(long index = -1L)
		{
			if (index == -1)
			{
				index = reader.ReadPackedInt();
			}
			if (index == 0)
			{
				return null;
			}
			return types[(int)index - 1];
		}
	}
}
