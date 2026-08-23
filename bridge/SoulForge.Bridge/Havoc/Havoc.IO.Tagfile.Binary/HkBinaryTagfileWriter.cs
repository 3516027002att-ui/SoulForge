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

public class HkBinaryTagfileWriter : IDisposable
{
	private class Item
	{
		public HkType Type { get; }

		public List<IHkObject> Objects { get; }

		public bool IsPtr { get; }

		public long Position { get; set; }

		public Item(HkType type, IEnumerable<IHkObject> objects)
		{
			Type = type;
			Objects = new List<IHkObject>(objects);
		}

		public Item(HkType type, IHkObject obj)
		{
			Type = type;
			Objects = new List<IHkObject> { obj };
			IsPtr = true;
		}
	}

	private readonly Dictionary<IHkObject, int> mIndexMap;

	private readonly List<Item> mItems;

	private readonly bool mLeaveOpen;

	private readonly Dictionary<HkType, List<long>> mPatches;

	private readonly IHkObject mRootObject;

	private readonly HkSdkVersion mSdkVersion;

	private readonly Stream mStream;

	private readonly HkTypeCompendium mTypeCompendium;

	private readonly BinaryWriter mWriter;

	private long mDataOffset;

	private static int writeIdx = -1;

	private static int itemIdx = -1;

	private static int patchIdx = -1;

	private HkBinaryTagfileWriter(Stream stream, bool leaveOpen, IHkObject rootObject, HkSdkVersion sdkVersion)
	{
		mStream = stream;
		mWriter = new BinaryWriter(mStream, Encoding.UTF8, leaveOpen: true);
		mLeaveOpen = leaveOpen;
		mRootObject = rootObject;
		mTypeCompendium = new HkTypeCompendium(rootObject);
		mSdkVersion = sdkVersion;
		mIndexMap = new Dictionary<IHkObject, int>();
		mItems = new List<Item>();
		mPatches = new Dictionary<HkType, List<long>>();
		AddItemsRecursively(rootObject);
	}

	public void Dispose()
	{
		if (!mLeaveOpen)
		{
			mStream.Dispose();
		}
		mWriter.Dispose();
	}

	private void WriteTagSection()
	{
		using (new HkSectionWriter(mWriter, "TAG0", hasSubSections: true))
		{
			using (new HkSectionWriter(mWriter, "SDKV", hasSubSections: false))
			{
				mWriter.Write(mSdkVersion.ToString(), 8);
			}
			WriteDataSection();
			WriteTypeSection();
			WriteIndexSection();
		}
	}

	private void WriteDataSection()
	{
		using (new HkSectionWriter(mWriter, "DATA", hasSubSections: false))
		{
			mDataOffset = mStream.Position;
			foreach (Item mItem in mItems)
			{
				mWriter.WriteAlignmentPadding(mItem.Type.Alignment);
				mItem.Position = mStream.Position;
				foreach (IHkObject @object in mItem.Objects)
				{
					WriteObject(@object);
				}
			}
		}
	}

	private void WriteTypeSection()
	{
		HkBinaryTypeWriter.WriteTypeSection(mWriter, mTypeCompendium, mSdkVersion);
	}

	private int GetTypeIndex(HkType type)
	{
		int value;
		return (type != null && mTypeCompendium.IndexMap.TryGetValue(type, out value)) ? (value + 1) : 0;
	}

	private int GetItemIndex(IHkObject obj)
	{
		int value;
		return (obj != null && mIndexMap.TryGetValue(obj, out value)) ? (value + 1) : 0;
	}

	private void WriteIndexSection()
	{
		using (new HkSectionWriter(mWriter, "INDX", hasSubSections: true))
		{
			DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(18, 2);
			defaultInterpolatedStringHandler.AppendLiteral("Items: ");
			defaultInterpolatedStringHandler.AppendFormatted(mItems.Count);
			defaultInterpolatedStringHandler.AppendLiteral(", Patches: ");
			defaultInterpolatedStringHandler.AppendFormatted(mPatches.Select((KeyValuePair<HkType, List<long>> x) => x.Value.Count).Sum());
			Debug.WriteProcess(defaultInterpolatedStringHandler.ToStringAndClear());
			using (new HkSectionWriter(mWriter, "ITEM", hasSubSections: false))
			{
				mWriter.WriteNulls(12);
				foreach (Item mItem in mItems)
				{
					mWriter.Write(GetTypeIndex(mItem.Type) | (mItem.IsPtr ? 268435456 : 536870912));
					mWriter.Write((uint)(mItem.Position - mDataOffset));
					mWriter.Write(mItem.Objects.Count);
				}
			}
			using (new HkSectionWriter(mWriter, "PTCH", hasSubSections: false))
			{
				foreach (KeyValuePair<HkType, List<long>> item in mPatches.OrderBy((KeyValuePair<HkType, List<long>> x) => GetTypeIndex(x.Key)))
				{
					item.Deconstruct(out var key, out var value);
					HkType hkType = key;
					List<long> list = value;
					mWriter.Write(GetTypeIndex(hkType));
					mWriter.Write(list.Count);
					defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(15, 3);
					defaultInterpolatedStringHandler.AppendLiteral("WritePTCH: ");
					defaultInterpolatedStringHandler.AppendFormatted(GetTypeIndex(hkType));
					defaultInterpolatedStringHandler.AppendLiteral(" ");
					defaultInterpolatedStringHandler.AppendFormatted(hkType.Name);
					defaultInterpolatedStringHandler.AppendLiteral(" (");
					defaultInterpolatedStringHandler.AppendFormatted(list.Count);
					defaultInterpolatedStringHandler.AppendLiteral(")");
					Debug.WriteProcess(defaultInterpolatedStringHandler.ToStringAndClear());
					int num = -1;
					foreach (long item2 in list.OrderBy((long x) => x))
					{
						num++;
						if (num < 10)
						{
							defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(32, 4);
							defaultInterpolatedStringHandler.AppendLiteral("WritePTCH: offset ");
							defaultInterpolatedStringHandler.AppendFormatted(item2 - mDataOffset);
							defaultInterpolatedStringHandler.AppendLiteral("; real: ");
							defaultInterpolatedStringHandler.AppendFormatted(item2);
							defaultInterpolatedStringHandler.AppendLiteral(" = ");
							defaultInterpolatedStringHandler.AppendFormatted(mDataOffset);
							defaultInterpolatedStringHandler.AppendLiteral(" + ");
							defaultInterpolatedStringHandler.AppendFormatted(item2 - mDataOffset);
							Debug.WriteProcess(defaultInterpolatedStringHandler.ToStringAndClear());
						}
						mWriter.Write((uint)(item2 - mDataOffset));
					}
				}
			}
		}
	}

	private void WriteObject(IHkObject obj)
	{
		writeIdx++;
		if (writeIdx < 100)
		{
			DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(24, 2);
			defaultInterpolatedStringHandler.AppendLiteral("Write object type ");
			defaultInterpolatedStringHandler.AppendFormatted(obj.Type);
			defaultInterpolatedStringHandler.AppendLiteral(": pos ");
			defaultInterpolatedStringHandler.AppendFormatted(mStream.Position);
			Debug.WriteProcess(defaultInterpolatedStringHandler.ToStringAndClear());
		}
		switch (obj.Type.Format)
		{
		case HkTypeFormat.Void:
		case HkTypeFormat.Opaque:
			break;
		case HkTypeFormat.Bool:
		{
			int num = (obj.GetValue<HkBool, bool>() ? 1 : 0);
			switch (obj.Type.BitCount)
			{
			case 8:
				mWriter.Write((byte)num);
				break;
			case 16:
				mWriter.Write((short)num);
				break;
			case 32:
				mWriter.Write(num);
				break;
			case 64:
				mWriter.Write((long)num);
				break;
			default:
			{
				DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(22, 1);
				defaultInterpolatedStringHandler.AppendLiteral("Unexpected bit count: ");
				defaultInterpolatedStringHandler.AppendFormatted(obj.Type.BitCount);
				throw new InvalidDataException(defaultInterpolatedStringHandler.ToStringAndClear());
			}
			}
			break;
		}
		case HkTypeFormat.String:
			if (obj.Type.IsFixedSize)
			{
				mWriter.Write(obj.GetValue<HkString, string>(), obj.Type.FixedSize);
			}
			else
			{
				WriteItemIndex(obj);
			}
			break;
		case HkTypeFormat.Int:
			switch (obj.Type.BitCount)
			{
			case 8:
				if (obj.Type.IsSigned)
				{
					mWriter.Write(obj.GetValue<HkSByte, sbyte>());
				}
				else
				{
					mWriter.Write(obj.GetValue<HkByte, byte>());
				}
				break;
			case 16:
				if (obj.Type.IsSigned)
				{
					mWriter.Write(obj.GetValue<HkInt16, short>());
				}
				else
				{
					mWriter.Write(obj.GetValue<HkUInt16, ushort>());
				}
				break;
			case 32:
				if (obj.Type.IsSigned)
				{
					mWriter.Write(obj.GetValue<HkInt32, int>());
				}
				else
				{
					mWriter.Write(obj.GetValue<HkUInt32, uint>());
				}
				break;
			case 64:
				if (obj.Type.IsSigned)
				{
					mWriter.Write(obj.GetValue<HkInt64, long>());
				}
				else
				{
					mWriter.Write(obj.GetValue<HkUInt64, ulong>());
				}
				break;
			default:
			{
				DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(22, 1);
				defaultInterpolatedStringHandler.AppendLiteral("Unexpected bit count: ");
				defaultInterpolatedStringHandler.AppendFormatted(obj.Type.BitCount);
				throw new InvalidDataException(defaultInterpolatedStringHandler.ToStringAndClear());
			}
			}
			break;
		case HkTypeFormat.FloatingPoint:
		{
			if (obj.Type.IsSingle)
			{
				mWriter.Write(obj.GetValue<HkSingle, float>());
				break;
			}
			if (obj.Type.IsDouble)
			{
				mWriter.Write(obj.GetValue<HkDouble, double>());
				break;
			}
			if (obj.Type.IsHalf)
			{
				mWriter.Write(obj.GetValue<HkHalf, Half>());
				break;
			}
			DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(36, 1);
			defaultInterpolatedStringHandler.AppendLiteral("Unexpected floating point format: 0x");
			defaultInterpolatedStringHandler.AppendFormatted(obj.Type.FormatInfo, "X");
			throw new InvalidDataException(defaultInterpolatedStringHandler.ToStringAndClear());
		}
		case HkTypeFormat.Ptr:
			WriteItemIndex(obj);
			break;
		case HkTypeFormat.Class:
		{
			long position = mStream.Position;
			mWriter.WriteNulls(obj.Type.ByteSize);
			foreach (KeyValuePair<HkField, IHkObject> item in obj.GetValue<HkClass, IReadOnlyDictionary<HkField, IHkObject>>())
			{
				item.Deconstruct(out var key, out var value);
				HkField hkField = key;
				IHkObject obj2 = value;
				mStream.Seek(position + hkField.ByteOffset, SeekOrigin.Begin);
				WriteObject(obj2);
			}
			mStream.Seek(position + obj.Type.ByteSize, SeekOrigin.Begin);
			break;
		}
		case HkTypeFormat.Array:
			if (obj.Type.IsFixedSize)
			{
				foreach (IHkObject item2 in obj.GetValue<HkArray, IReadOnlyList<IHkObject>>())
				{
					WriteObject(item2);
				}
				break;
			}
			WriteItemIndex(obj);
			break;
		default:
			throw new ArgumentOutOfRangeException("Format");
		}
	}

	private void WriteItemIndex(IHkObject obj)
	{
		int itemIndex = GetItemIndex(obj);
		if (itemIndex != 0)
		{
			itemIdx++;
			AddPatch(obj.Type, mStream.Position);
		}
		mWriter.Write(itemIndex);
	}

	private void AddItemsRecursively(IHkObject obj)
	{
		if (obj == null || mIndexMap.ContainsKey(obj) || obj.Value == null)
		{
			return;
		}
		switch (obj.Type.Format)
		{
		case HkTypeFormat.String:
		{
			if (obj.Type.IsFixedSize)
			{
				break;
			}
			Debug.WriteProcessIndent++;
			HkType charType = mTypeCompendium.FirstOrDefault((HkType x) => x.Name.Equals("char"));
			if (charType == null)
			{
				HkTypeCompendium hkTypeCompendium = mTypeCompendium;
				HkType obj2 = new HkType
				{
					Name = "char",
					Flags = (HkTypeFlags.HasFormatInfo | HkTypeFlags.HasByteSize),
					mFormatInfo = 8196,
					mByteSize = 1,
					mAlignment = 1
				};
				HkType type = obj2;
				charType = obj2;
				hkTypeCompendium.Add(type);
			}
			IEnumerable<HkByte> objects = (from x in Encoding.UTF8.GetBytes(obj.GetValue<HkString, string>())
				select new HkByte(charType, x)).Append(new HkByte(charType, 0));
			AddItem(new Item(charType, objects));
			Debug.WriteProcessIndent--;
			return;
		}
		case HkTypeFormat.Ptr:
		{
			IHkObject value2 = obj.GetValue<HkPtr, IHkObject>();
			AddItem(new Item(value2.Type, value2));
			Debug.WriteProcessIndent++;
			AddItemsRecursively(value2);
			Debug.WriteProcessIndent--;
			return;
		}
		case HkTypeFormat.Class:
			if (obj == mRootObject)
			{
				AddItem(new Item(obj.Type, obj));
			}
			{
				foreach (KeyValuePair<HkField, IHkObject> item in obj.GetValue<HkClass, IReadOnlyDictionary<HkField, IHkObject>>())
				{
					item.Deconstruct(out var key, out var value3);
					HkField hkField = key;
					IHkObject obj3 = value3;
					Debug.WriteProcessIndent++;
					AddItemsRecursively(obj3);
					Debug.WriteProcessIndent--;
				}
				return;
			}
		case HkTypeFormat.Array:
		{
			IReadOnlyList<IHkObject> value = obj.GetValue<HkArray, IReadOnlyList<IHkObject>>();
			if (value.Count == 0)
			{
				return;
			}
			if (!obj.Type.IsFixedSize)
			{
				AddItem(new Item(obj.Type.SubType, value));
			}
			Debug.WriteProcessIndent++;
			if (value.Count > 1000)
			{
				DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(16, 2);
				defaultInterpolatedStringHandler.AppendLiteral("Write Array: ");
				defaultInterpolatedStringHandler.AppendFormatted(obj.Type);
				defaultInterpolatedStringHandler.AppendLiteral(" (");
				defaultInterpolatedStringHandler.AppendFormatted(value.Count);
				defaultInterpolatedStringHandler.AppendLiteral(")");
				Debug.WriteProcess(defaultInterpolatedStringHandler.ToStringAndClear());
			}
			foreach (IHkObject item2 in value)
			{
				AddItemsRecursively(item2);
			}
			Debug.WriteProcessIndent--;
			return;
		}
		}
		AddItem(new Item(obj.Type, obj));
		void AddItem(Item item)
		{
			mIndexMap.Add(obj, mItems.Count);
			mItems.Add(item);
		}
	}

	private void AddPatch(HkType type, long position)
	{
		if (!mPatches.TryGetValue(type, out var value))
		{
			value = (mPatches[type] = new List<long>());
		}
		patchIdx++;
		if (patchIdx < 100)
		{
			DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(20, 2);
			defaultInterpolatedStringHandler.AppendLiteral("AddPatch: ");
			defaultInterpolatedStringHandler.AppendFormatted(type.Name);
			defaultInterpolatedStringHandler.AppendLiteral(" real-pos ");
			defaultInterpolatedStringHandler.AppendFormatted(position);
			Debug.WriteProcess(defaultInterpolatedStringHandler.ToStringAndClear());
		}
		value.Add(position);
	}

	public static void Write(Stream stream, bool leaveOpen, IHkObject rootObject, HkSdkVersion sdkVersion)
	{
		using HkBinaryTagfileWriter hkBinaryTagfileWriter = new HkBinaryTagfileWriter(stream, leaveOpen, rootObject, sdkVersion);
		hkBinaryTagfileWriter.WriteTagSection();
	}

	public static void Write(string filePath, IHkObject rootObject, HkSdkVersion sdkVersion)
	{
		Write(File.Create(filePath), leaveOpen: true, rootObject, sdkVersion);
	}
}
