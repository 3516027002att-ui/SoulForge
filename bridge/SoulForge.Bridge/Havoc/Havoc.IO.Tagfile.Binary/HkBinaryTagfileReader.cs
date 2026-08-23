using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text;
using Havoc.Extensions;
using Havoc.IO.Tagfile.Binary.Sections;
using Havoc.IO.Tagfile.Binary.Types;
using Havoc.Objects;
using Havoc.Reflection;

namespace Havoc.IO.Tagfile.Binary;

public class HkBinaryTagfileReader : IDisposable
{
	private class Item
	{
		private readonly HkBinaryTagfileReader mTag;

		private List<IHkObject> mObjects;

		public bool IsArray = false;

		private static Dictionary<string, bool> InfoLogged = new Dictionary<string, bool>();

		private static int objIdx = -1;

		public HkType Type { get; }

		private long Position { get; }

		private int Count { get; }

		public IReadOnlyList<IHkObject> Objects
		{
			get
			{
				if (mObjects == null)
				{
					ReadThisObject();
				}
				return mObjects;
			}
		}

		public Item(HkBinaryTagfileReader tag)
		{
			mTag = tag;
			int num = mTag.mReader.ReadInt32() & 0xFFFFFF;
			Type = ((num == 0) ? null : tag.mTypes[num - 1]);
			Position = mTag.mReader.ReadUInt32() + tag.mDataOffset;
			Count = mTag.mReader.ReadInt32();
		}

		private void ReadThisObject()
		{
			if (mObjects != null)
			{
				return;
			}
			mObjects = new List<IHkObject>(Count);
			if (objIdx >= 40000000 && Count > 1 && Type.ToString() != "char")
			{
				DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(28, 2);
				defaultInterpolatedStringHandler.AppendLiteral("read item objects ");
				defaultInterpolatedStringHandler.AppendFormatted(Type);
				defaultInterpolatedStringHandler.AppendLiteral(", length: ");
				defaultInterpolatedStringHandler.AppendFormatted(Count);
				Debug.ReadProcess(defaultInterpolatedStringHandler.ToStringAndClear());
			}
			for (int i = 0; i < Count; i++)
			{
				long offset = Position + i * Type.ByteSize;
				if (IsArray && (Type.ToString() == "hkStringPtr" || Type.IsPtr))
				{
					offset = Position + i * 4;
				}
				if (objIdx >= 40000000 && Type.ToString() != "char")
				{
					DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(49, 5);
					defaultInterpolatedStringHandler.AppendLiteral("read item obj idx ");
					defaultInterpolatedStringHandler.AppendFormatted(i);
					defaultInterpolatedStringHandler.AppendLiteral(" of type ");
					defaultInterpolatedStringHandler.AppendFormatted(Type);
					defaultInterpolatedStringHandler.AppendLiteral("(");
					defaultInterpolatedStringHandler.AppendFormatted(Type.ByteSize);
					defaultInterpolatedStringHandler.AppendLiteral(") (parent: ");
					defaultInterpolatedStringHandler.AppendFormatted(Type.ParentType);
					defaultInterpolatedStringHandler.AppendLiteral("), isPtr? ");
					defaultInterpolatedStringHandler.AppendFormatted(Type.IsPtr);
					Debug.ReadProcess(defaultInterpolatedStringHandler.ToStringAndClear());
				}
				Debug.ReadProcessIndent++;
				mObjects.Add(ReadObject(Type, offset));
				Debug.ReadProcessIndent--;
			}
		}

		private IHkObject ReadObject(HkType type, long offset)
		{
			objIdx++;
			mTag.mStream.Seek(offset, SeekOrigin.Begin);
			if (type.ToString() != "char" && objIdx >= 40000000)
			{
				DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(39, 5);
				defaultInterpolatedStringHandler.AppendLiteral("Read object index ");
				defaultInterpolatedStringHandler.AppendFormatted(objIdx);
				defaultInterpolatedStringHandler.AppendLiteral(" type ");
				defaultInterpolatedStringHandler.AppendFormatted(type);
				defaultInterpolatedStringHandler.AppendLiteral("/");
				defaultInterpolatedStringHandler.AppendFormatted(type.Format);
				defaultInterpolatedStringHandler.AppendLiteral(" offset ");
				defaultInterpolatedStringHandler.AppendFormatted(offset);
				defaultInterpolatedStringHandler.AppendLiteral(", pos ");
				defaultInterpolatedStringHandler.AppendFormatted(mTag.mReader.BaseStream.Position);
				Debug.ReadProcess(defaultInterpolatedStringHandler.ToStringAndClear());
			}
			string text = Convert.ToString(type.FormatInfo, 2).PadLeft(24, '0');
			if (!InfoLogged.ContainsKey(type.Name + text) && type.FormatInfo > 8)
			{
				InfoLogged[type.Name + text] = true;
				if (type.Format != HkTypeFormat.String)
				{
				}
			}
			switch (type.Format)
			{
			case HkTypeFormat.Void:
				return new HkVoid(type);
			case HkTypeFormat.Opaque:
				return new HkOpaque(type);
			case HkTypeFormat.Bool:
			{
				bool value;
				switch (type.BitCount)
				{
				case 8:
					value = mTag.mReader.ReadByte() != 0;
					break;
				case 16:
					value = mTag.mReader.ReadInt16() != 0;
					break;
				case 32:
					value = mTag.mReader.ReadInt32() != 0;
					break;
				case 64:
					value = mTag.mReader.ReadInt64() != 0;
					break;
				default:
				{
					DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(22, 1);
					defaultInterpolatedStringHandler.AppendLiteral("Unexpected bit count: ");
					defaultInterpolatedStringHandler.AppendFormatted(type.BitCount);
					throw new InvalidDataException(defaultInterpolatedStringHandler.ToStringAndClear());
				}
				}
				return new HkBool(type, value);
			}
			case HkTypeFormat.String:
			{
				string value2;
				if (type.IsFixedSize)
				{
					value2 = mTag.mReader.ReadString(type.FixedSize);
				}
				else
				{
					IReadOnlyList<IHkObject> readOnlyList2 = ReadItemIndex();
					if (readOnlyList2 != null && readOnlyList2.Count > 0)
					{
						StringBuilder stringBuilder = new StringBuilder(readOnlyList2.Count - 1);
						for (int j = 0; j < readOnlyList2.Count - 1; j++)
						{
							if (readOnlyList2[j].Value is sbyte)
							{
								stringBuilder.Append((char)(byte)(sbyte)readOnlyList2[j].Value);
							}
							else
							{
								stringBuilder.Append((char)(byte)readOnlyList2[j].Value);
							}
						}
						value2 = stringBuilder.ToString();
						if (objIdx >= 40000000)
						{
							DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(33, 3);
							defaultInterpolatedStringHandler.AppendLiteral("Read object index ");
							defaultInterpolatedStringHandler.AppendFormatted(objIdx);
							defaultInterpolatedStringHandler.AppendLiteral(" string: ");
							defaultInterpolatedStringHandler.AppendFormatted(value2);
							defaultInterpolatedStringHandler.AppendLiteral(", pos ");
							defaultInterpolatedStringHandler.AppendFormatted(mTag.mReader.BaseStream.Position);
							Debug.ReadProcess(defaultInterpolatedStringHandler.ToStringAndClear());
						}
					}
					else
					{
						value2 = null;
						if (objIdx >= 40000000)
						{
							DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(27, 1);
							defaultInterpolatedStringHandler.AppendLiteral("Read object index ");
							defaultInterpolatedStringHandler.AppendFormatted(objIdx);
							defaultInterpolatedStringHandler.AppendLiteral(" but null");
							Debug.ReadProcess(defaultInterpolatedStringHandler.ToStringAndClear());
						}
					}
				}
				return new HkString(type, value2);
			}
			case HkTypeFormat.Int:
				switch (type.BitCount)
				{
				case 8:
				{
					IHkObject result4;
					if (!type.IsSigned)
					{
						IHkObject hkObject = new HkByte(type, mTag.mReader.ReadByte());
						result4 = hkObject;
					}
					else
					{
						IHkObject hkObject = new HkSByte(type, mTag.mReader.ReadSByte());
						result4 = hkObject;
					}
					return result4;
				}
				case 16:
				{
					IHkObject result3;
					if (!type.IsSigned)
					{
						IHkObject hkObject = new HkUInt16(type, mTag.mReader.ReadUInt16());
						result3 = hkObject;
					}
					else
					{
						IHkObject hkObject = new HkInt16(type, mTag.mReader.ReadInt16());
						result3 = hkObject;
					}
					return result3;
				}
				case 32:
				{
					IHkObject result5;
					if (!type.IsSigned)
					{
						IHkObject hkObject = new HkUInt32(type, mTag.mReader.ReadUInt32());
						result5 = hkObject;
					}
					else
					{
						IHkObject hkObject = new HkInt32(type, mTag.mReader.ReadInt32());
						result5 = hkObject;
					}
					return result5;
				}
				case 64:
				{
					IHkObject result2;
					if (!type.IsSigned)
					{
						IHkObject hkObject = new HkUInt64(type, mTag.mReader.ReadUInt64());
						result2 = hkObject;
					}
					else
					{
						IHkObject hkObject = new HkInt64(type, mTag.mReader.ReadInt64());
						result2 = hkObject;
					}
					return result2;
				}
				default:
				{
					DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(22, 1);
					defaultInterpolatedStringHandler.AppendLiteral("Unexpected bit count: ");
					defaultInterpolatedStringHandler.AppendFormatted(type.BitCount);
					throw new InvalidDataException(defaultInterpolatedStringHandler.ToStringAndClear());
				}
				}
			case HkTypeFormat.FloatingPoint:
			{
				IHkObject result;
				if (!type.IsHalf)
				{
					if (!type.IsSingle)
					{
						if (!type.IsDouble)
						{
							throw new InvalidDataException("Unexpected floating point format");
						}
						IHkObject hkObject = new HkDouble(type, mTag.mReader.ReadDouble());
						result = hkObject;
					}
					else
					{
						IHkObject hkObject = new HkSingle(type, mTag.mReader.ReadSingle());
						result = hkObject;
					}
				}
				else
				{
					IHkObject hkObject = new HkHalf(type, mTag.mReader.ReadHalf());
					result = hkObject;
				}
				return result;
			}
			case HkTypeFormat.Ptr:
			{
				IReadOnlyList<IHkObject> readOnlyList = ReadItemIndex();
				if (readOnlyList == null || readOnlyList.Count == 0)
				{
					return new HkPtr(type, null);
				}
				return new HkPtr(type, readOnlyList?[0]);
			}
			case HkTypeFormat.Class:
				return new HkClass(type, type.AllFields.ToDictionary((HkField x) => x, delegate(HkField x)
				{
					long offset2 = offset + x.ByteOffset;
					return ReadObject(x.Type, offset2);
				}));
			case HkTypeFormat.Array:
			{
				if (objIdx >= 40000000)
				{
					DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(27, 1);
					defaultInterpolatedStringHandler.AppendLiteral("read array, is fixed size? ");
					defaultInterpolatedStringHandler.AppendFormatted(type.IsFixedSize);
					Debug.ReadProcess(defaultInterpolatedStringHandler.ToStringAndClear());
				}
				if (!type.IsFixedSize)
				{
					return new HkArray(type, ReadItemIndex(isArray: true));
				}
				IHkObject[] array = new IHkObject[type.FixedSize];
				if (objIdx >= 40000000)
				{
					DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(20, 1);
					defaultInterpolatedStringHandler.AppendLiteral("read array, length: ");
					defaultInterpolatedStringHandler.AppendFormatted(array.Length);
					Debug.ReadProcess(defaultInterpolatedStringHandler.ToStringAndClear());
				}
				for (int i = 0; i < array.Length; i++)
				{
					array[i] = ReadObject(type.SubType, offset + i * type.SubType.ByteSize);
				}
				return new HkArray(type, array);
			}
			default:
				throw new ArgumentOutOfRangeException("Format");
			}
			IReadOnlyList<IHkObject> ReadItemIndex(bool isArray = false)
			{
				int num = mTag.mReader.ReadInt32();
				if (num < 0)
				{
					DefaultInterpolatedStringHandler defaultInterpolatedStringHandler2 = new DefaultInterpolatedStringHandler(19, 1);
					defaultInterpolatedStringHandler2.AppendLiteral("ReadItemIndex: ");
					defaultInterpolatedStringHandler2.AppendFormatted(num);
					defaultInterpolatedStringHandler2.AppendLiteral(" < 0");
					throw new Exception(defaultInterpolatedStringHandler2.ToStringAndClear());
				}
				if (num >= mTag.mItems.Count)
				{
					DefaultInterpolatedStringHandler defaultInterpolatedStringHandler2 = new DefaultInterpolatedStringHandler(18, 2);
					defaultInterpolatedStringHandler2.AppendLiteral("ReadItemIndex: ");
					defaultInterpolatedStringHandler2.AppendFormatted(num);
					defaultInterpolatedStringHandler2.AppendLiteral(" > ");
					defaultInterpolatedStringHandler2.AppendFormatted(mTag.mItems.Count);
					throw new Exception(defaultInterpolatedStringHandler2.ToStringAndClear());
				}
				if (objIdx >= 40000000)
				{
					DefaultInterpolatedStringHandler defaultInterpolatedStringHandler2 = new DefaultInterpolatedStringHandler(15, 1);
					defaultInterpolatedStringHandler2.AppendLiteral("ReadItemIndex: ");
					defaultInterpolatedStringHandler2.AppendFormatted(num);
					Debug.ReadProcess(defaultInterpolatedStringHandler2.ToStringAndClear());
				}
				mTag.mItems[num].IsArray = true;
				return (num == 0) ? null : mTag.mItems[num].Objects;
			}
		}
	}

	private readonly string CompendiumPath;

	private readonly byte[] CompendiumBytes;

	private List<ulong> mCompendiumIDs;

	private readonly bool mLeaveOpen;

	private readonly BinaryReader mReader;

	private readonly Stream mStream;

	private long mDataOffset;

	private List<Item> mItems;

	private List<HkType> mTypes;

	private Dictionary<HkType, uint[]> mPatches = new Dictionary<HkType, uint[]>();

	private Dictionary<HkType, int> mCurrentPatches = new Dictionary<HkType, int>();

	private HkBinaryTagfileReader(Stream stream, string compendium, bool leaveOpen)
	{
		CompendiumPath = compendium;
		mStream = stream;
		mReader = new BinaryReader(mStream, Encoding.UTF8, leaveOpen: true);
		mLeaveOpen = leaveOpen;
	}

	private HkBinaryTagfileReader(Stream stream, byte[] compendium, bool leaveOpen)
	{
		CompendiumBytes = compendium;
		mStream = stream;
		mReader = new BinaryReader(mStream, Encoding.UTF8, leaveOpen: true);
		mLeaveOpen = leaveOpen;
	}

	public void Dispose()
	{
		if (!mLeaveOpen)
		{
			mStream.Dispose();
		}
		mReader.Dispose();
	}

	private void ReadTagSection(HkSection section)
	{
		foreach (HkSection subSection in section.SubSections)
		{
			Debug.ReadProcess("Read section: " + subSection.Signature);
			switch (subSection.Signature)
			{
			case "TCRF":
			{
				mStream.Seek(subSection.Position, SeekOrigin.Begin);
				ulong num = mReader.ReadUInt64();
				if (string.IsNullOrWhiteSpace(CompendiumPath) && CompendiumBytes == null)
				{
					throw new InvalidDataException("TCRF found but Compendium is empty");
				}
				if (!mCompendiumIDs.Contains(num))
				{
					DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(31, 1);
					defaultInterpolatedStringHandler.AppendLiteral("TCRF ref comp id ");
					defaultInterpolatedStringHandler.AppendFormatted(num);
					defaultInterpolatedStringHandler.AppendLiteral(" but not found");
					throw new InvalidDataException(defaultInterpolatedStringHandler.ToStringAndClear());
				}
				break;
			}
			case "SDKV":
			{
				mStream.Seek(subSection.Position, SeekOrigin.Begin);
				string text = mReader.ReadString(8);
				if (!HkSdkVersion.SupportedSdkVersions.Contains(new HkSdkVersion(text)))
				{
					throw new NotSupportedException("Unsupported SDK version: " + text);
				}
				break;
			}
			case "DATA":
				mDataOffset = subSection.Position;
				break;
			case "TYPE":
				ReadTypeSection(subSection);
				break;
			case "INDX":
				ReadIndexSection(subSection);
				break;
			default:
				throw new InvalidDataException("Unexpected signature: " + subSection.Signature);
			}
		}
	}

	private void ReadTypeCompendiumSection(HkSection section)
	{
		foreach (HkSection subSection in section.SubSections)
		{
			string signature = subSection.Signature;
			string text = signature;
			if (!(text == "TCID"))
			{
				if (!(text == "TYPE"))
				{
					throw new InvalidDataException("Unexpected signature: " + subSection.Signature);
				}
				ReadTypeSection(subSection);
			}
			else
			{
				ReadIDsSection(subSection);
			}
		}
	}

	private void ReadIDsSection(HkSection section)
	{
		mCompendiumIDs = new List<ulong>();
		if (section.Length % 8 != 0)
		{
			DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(30, 1);
			defaultInterpolatedStringHandler.AppendLiteral("TCID length ");
			defaultInterpolatedStringHandler.AppendFormatted(section.Length);
			defaultInterpolatedStringHandler.AppendLiteral(" can't be mod by 8");
			throw new InvalidDataException(defaultInterpolatedStringHandler.ToStringAndClear());
		}
		mReader.BaseStream.Seek(section.Position, SeekOrigin.Begin);
		for (int i = 0; i < section.Length / 8; i++)
		{
			mCompendiumIDs.Add(mReader.ReadUInt64());
		}
	}

	private void ReadTypeSection(HkSection section)
	{
		mTypes = HkBinaryTypeReader.ReadTypeSection(mReader, section);
	}

	private void ReadPatchSection(HkSection section)
	{
		mPatches = new Dictionary<HkType, uint[]>();
		mReader.BaseStream.Seek(section.Position, SeekOrigin.Begin);
		while (mReader.BaseStream.Position < section.Position + section.Length)
		{
			int num = mReader.ReadInt32();
			HkType hkType = mTypes[num];
			int num2 = mReader.ReadInt32();
			DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(21, 3);
			defaultInterpolatedStringHandler.AppendLiteral("PTCH: type ");
			defaultInterpolatedStringHandler.AppendFormatted(hkType);
			defaultInterpolatedStringHandler.AppendLiteral("(");
			defaultInterpolatedStringHandler.AppendFormatted(num);
			defaultInterpolatedStringHandler.AppendLiteral("), count ");
			defaultInterpolatedStringHandler.AppendFormatted(num2);
			Debug.ReadProcess(defaultInterpolatedStringHandler.ToStringAndClear());
			mPatches[hkType] = new uint[num2];
			for (int i = 0; i < num2; i++)
			{
				uint num3 = mReader.ReadUInt32();
				if (num2 < 10)
				{
					defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(15, 1);
					defaultInterpolatedStringHandler.AppendLiteral("PTCH:   offset ");
					defaultInterpolatedStringHandler.AppendFormatted(num3);
					Debug.ReadProcess(defaultInterpolatedStringHandler.ToStringAndClear());
				}
				mPatches[hkType][i] = num3;
			}
		}
	}

	private void ReadIndexSection(HkSection section)
	{
		foreach (HkSection subSection in section.SubSections)
		{
			string signature = subSection.Signature;
			string text = signature;
			if (!(text == "ITEM"))
			{
				if (text == "PTCH")
				{
					continue;
				}
				throw new InvalidDataException("Unexpected signature: " + subSection.Signature);
			}
			mStream.Seek(subSection.Position, SeekOrigin.Begin);
			mItems = new List<Item>((int)(subSection.Length / 24));
			while (mStream.Position < subSection.Position + subSection.Length)
			{
				mItems.Add(new Item(this));
			}
		}
	}

	private void ReadCompendium()
	{
		if (!string.IsNullOrWhiteSpace(CompendiumPath))
		{
			HkBinaryTagfileReader hkBinaryTagfileReader = ReadCompendiums(CompendiumPath);
			mTypes = hkBinaryTagfileReader.mTypes;
			mCompendiumIDs = hkBinaryTagfileReader.mCompendiumIDs;
		}
		else if (CompendiumBytes != null)
		{
			HkBinaryTagfileReader hkBinaryTagfileReader2 = ReadCompendiums(CompendiumBytes);
			mTypes = hkBinaryTagfileReader2.mTypes;
			mCompendiumIDs = hkBinaryTagfileReader2.mCompendiumIDs;
		}
	}

	private void ReadRootSection()
	{
		HkSection hkSection = new HkSection(mReader);
		string signature = hkSection.Signature;
		string text = signature;
		if (!(text == "TAG0"))
		{
			if (!(text == "TCM0"))
			{
				throw new InvalidDataException("Unexpected signature: " + hkSection.Signature);
			}
			ReadTypeCompendiumSection(hkSection);
		}
		else
		{
			ReadTagSection(hkSection);
		}
	}

	public static List<IHkObject> ReadAllObjects(Stream source, string compendium = "", bool leaveOpen = false)
	{
		using HkBinaryTagfileReader hkBinaryTagfileReader = new HkBinaryTagfileReader(source, compendium, leaveOpen);
		hkBinaryTagfileReader.ReadCompendium();
		hkBinaryTagfileReader.ReadRootSection();
		DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(8, 2);
		defaultInterpolatedStringHandler.AppendLiteral("items: ");
		defaultInterpolatedStringHandler.AppendFormatted(hkBinaryTagfileReader.mItems.Count);
		defaultInterpolatedStringHandler.AppendLiteral(" ");
		defaultInterpolatedStringHandler.AppendFormatted(hkBinaryTagfileReader.mItems.Sum((Item x) => x.Objects.Count));
		Debug.Temporary(defaultInterpolatedStringHandler.ToStringAndClear());
		defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(7, 1);
		defaultInterpolatedStringHandler.AppendLiteral("items: ");
		defaultInterpolatedStringHandler.AppendFormatted(hkBinaryTagfileReader.mItems[1].Objects.Count);
		Debug.Temporary(defaultInterpolatedStringHandler.ToStringAndClear());
		return hkBinaryTagfileReader.mItems.SelectMany((Item x) => x.Objects).ToList();
	}

	public static List<IHkObject> ReadAllObjects(string filePath, string compendium = "")
	{
		using FileStream source = File.OpenRead(filePath);
		return ReadAllObjects(source, compendium);
	}

	public static IHkObject Read(Stream source, byte[] compendium, bool leaveOpen = false)
	{
		using HkBinaryTagfileReader hkBinaryTagfileReader = new HkBinaryTagfileReader(source, compendium, leaveOpen);
		hkBinaryTagfileReader.ReadCompendium();
		hkBinaryTagfileReader.ReadRootSection();
		return hkBinaryTagfileReader.mItems[1].Objects[0];
	}

	public static IHkObject Read(byte[] file, byte[] compendium = null)
	{
		using MemoryStream source = new MemoryStream(file);
		return Read(source, compendium);
	}

	public static IHkObject Read(Stream source, string compendium = "", bool leaveOpen = false)
	{
		using HkBinaryTagfileReader hkBinaryTagfileReader = new HkBinaryTagfileReader(source, compendium, leaveOpen);
		hkBinaryTagfileReader.ReadCompendium();
		hkBinaryTagfileReader.ReadRootSection();
		DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(8, 2);
		defaultInterpolatedStringHandler.AppendLiteral("items: ");
		defaultInterpolatedStringHandler.AppendFormatted(hkBinaryTagfileReader.mItems.Count);
		defaultInterpolatedStringHandler.AppendLiteral(" ");
		defaultInterpolatedStringHandler.AppendFormatted(hkBinaryTagfileReader.mItems.Sum((Item x) => x.Objects.Count));
		Debug.Temporary(defaultInterpolatedStringHandler.ToStringAndClear());
		defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(7, 1);
		defaultInterpolatedStringHandler.AppendLiteral("items: ");
		defaultInterpolatedStringHandler.AppendFormatted(hkBinaryTagfileReader.mItems[1].Objects.Count);
		Debug.Temporary(defaultInterpolatedStringHandler.ToStringAndClear());
		return hkBinaryTagfileReader.mItems[1].Objects[0];
	}

	public static IHkObject Read(string filePath, string compendium = "")
	{
		using FileStream source = File.OpenRead(filePath);
		return Read(source, compendium);
	}

	public static HkBinaryTagfileReader ReadCompendiums(Stream source, bool leaveOpen = false)
	{
		using HkBinaryTagfileReader hkBinaryTagfileReader = new HkBinaryTagfileReader(source, "", leaveOpen);
		hkBinaryTagfileReader.ReadRootSection();
		return hkBinaryTagfileReader;
	}

	public static HkBinaryTagfileReader ReadCompendiums(byte[] source, bool leaveOpen = false)
	{
		using MemoryStream stream = new MemoryStream(source);
		using HkBinaryTagfileReader hkBinaryTagfileReader = new HkBinaryTagfileReader(stream, "", leaveOpen);
		hkBinaryTagfileReader.ReadRootSection();
		return hkBinaryTagfileReader;
	}

	public static HkBinaryTagfileReader ReadCompendiums(string compendium)
	{
		using FileStream source = File.OpenRead(compendium);
		return ReadCompendiums(source);
	}

	public void BackportTypesTo2012()
	{
		foreach (HkType mType in mTypes)
		{
			string[] toRemoveTypes = new string[6] { "hkDefaultPropertyBag", "hkHash", "hkTuple", "hkPropertyId", "hkPtrAndInt", "hkPropertyDesc" };
			mTypes.RemoveAll((HkType x) => toRemoveTypes.Contains(x.Name));
			if (mType.Name == "hkReferencedObject")
			{
				LimitVersion(mType, 0);
				mType.mFields.RemoveAll((HkField x) => x.Name == "propertyBag");
				mType.mFields.ForEach(delegate(HkField x)
				{
					if (x.Name == "refCount")
					{
						x.Name = "referenceCount";
					}
				});
			}
			if (mType.Name == "hkxMeshSection")
			{
				LimitVersion(mType, 4);
				mType.mFields.RemoveAll((HkField x) => x.Name == "boneMatrixMap");
			}
			if (mType.Name == "hkxVertexBuffer::VertexData")
			{
				LimitVersion(mType, 0);
			}
			if (mType.Name == "hkxVertexDescription::ElementDecl")
			{
				LimitVersion(mType, 3);
				mType.mFields.RemoveAll((HkField x) => x.Name == "channelID");
			}
			if (mType.Name == "hkxMaterial")
			{
				LimitVersion(mType, 4);
				mType.mFields.RemoveAll((HkField x) => x.Name == "userData");
			}
			if (mType.Name == "hkaSkeleton")
			{
				LimitVersion(mType, 5);
			}
			if (mType.Name == "hkcdStaticMeshTreeBase")
			{
				LimitVersion(mType, 0);
				mType.mFields.RemoveAll((HkField x) => x.Name == "primitiveStoresIsFlatConvex");
			}
			if (mType.Name == "hkaInterleavedUncompressedAnimation")
			{
				LimitVersion(mType, 0);
			}
			if (mType.Name == "hkpStaticCompoundShape")
			{
			}
			if (mType.Name == "hkpStaticCompoundShape::Instance")
			{
				LimitVersion(mType, 0);
			}
		}
		static void LimitVersion(HkType type, int maxVer)
		{
			if (type != null && type.Version > maxVer)
			{
				type.mVersion = maxVer;
			}
		}
	}
}
