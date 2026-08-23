using System;
using System.Collections.Generic;
using System.Linq;

namespace Havoc.Reflection;

public class HkType
{
	internal readonly List<HkField> mFields;

	internal readonly List<HkInterface> mInterfaces;

	internal readonly List<HkParameter> mParameters;

	internal int mAlignment;

	internal int mByteSize;

	internal int mFormatInfo;

	internal HkType mSubType;

	internal int mUnknownFlags;

	internal int mVersion;

	public string Name { get; internal set; }

	public IReadOnlyList<HkParameter> Parameters => mParameters;

	public HkType ParentType { get; internal set; }

	public HkTypeFlags Flags { get; internal set; }

	public int FormatInfo => ((Flags & HkTypeFlags.HasFormatInfo) != 0) ? mFormatInfo : (ParentType?.FormatInfo ?? 0);

	public HkTypeFormat Format => (HkTypeFormat)(FormatInfo & 0xF);

	public bool IsPtr => Format == HkTypeFormat.Ptr;

	public bool IsSigned => (Format == HkTypeFormat.Bool || Format == HkTypeFormat.Int) && (FormatInfo & 0x200) != 0;

	public int BitCount => (Format == HkTypeFormat.Bool || Format == HkTypeFormat.Int) ? (FormatInfo >> 10) : 0;

	public bool IsFixedSize => (Format == HkTypeFormat.String || Format == HkTypeFormat.Array) && (FormatInfo & 0x20) != 0;

	public int FixedSize => IsFixedSize ? ((Format == HkTypeFormat.String) ? (FormatInfo >> 16) : (FormatInfo >> 8)) : 0;

	public bool IsHalf => Format == HkTypeFormat.FloatingPoint && FormatInfo >> 8 == 1862;

	public bool IsSingle => Format == HkTypeFormat.FloatingPoint && FormatInfo >> 8 == 5958;

	public bool IsDouble => Format == HkTypeFormat.FloatingPoint && FormatInfo >> 8 == 13406;

	public HkType SubType
	{
		get
		{
			if ((Flags & HkTypeFlags.HasSubType) != 0)
			{
				return mSubType;
			}
			if (ParentType == null)
			{
				return null;
			}
			if (ParentType == this)
			{
				Console.WriteLine("parent " + ParentType.ToString() + " same as this " + ToString());
				return ParentType;
			}
			return ParentType.SubType;
		}
	}

	public int Version => ((Flags & HkTypeFlags.HasVersion) != 0) ? mVersion : (ParentType?.Version ?? 0);

	public int ByteSize => ((Flags & HkTypeFlags.HasByteSize) != 0) ? mByteSize : (ParentType?.ByteSize ?? 0);

	public int Alignment => ((Flags & HkTypeFlags.HasByteSize) != 0) ? mAlignment : (ParentType?.Alignment ?? 0);

	public int UnknownFlags => ((Flags & HkTypeFlags.HasUnknownFlags) != 0) ? mUnknownFlags : (ParentType?.UnknownFlags ?? 0);

	public IReadOnlyList<HkField> Fields
	{
		get
		{
			object result;
			if ((Flags & HkTypeFlags.HasFields) == 0)
			{
				result = ParentType?.Fields;
			}
			else
			{
				IReadOnlyList<HkField> readOnlyList = mFields;
				result = readOnlyList;
			}
			return (IReadOnlyList<HkField>)result;
		}
	}

	public IEnumerable<HkField> AllFields
	{
		get
		{
			IEnumerable<HkField> result;
			if (ParentType == null)
			{
				IEnumerable<HkField> enumerable = mFields;
				result = enumerable;
			}
			else
			{
				result = ParentType.AllFields.Concat(mFields);
			}
			return result;
		}
	}

	public IReadOnlyList<HkInterface> Interfaces
	{
		get
		{
			object result;
			if ((Flags & HkTypeFlags.HasInterfaces) == 0)
			{
				result = ParentType?.Interfaces;
			}
			else
			{
				IReadOnlyList<HkInterface> readOnlyList = mInterfaces;
				result = readOnlyList;
			}
			return (IReadOnlyList<HkInterface>)result;
		}
	}

	public int Hash { get; internal set; }

	internal HkType()
	{
		mParameters = new List<HkParameter>();
		mFields = new List<HkField>();
		mInterfaces = new List<HkInterface>();
	}

	public override string ToString()
	{
		return (mParameters.Count > 0) ? (Name + "<" + string.Join(", ", mParameters.Select((HkParameter x) => x.Value)) + ">") : Name;
	}
}
