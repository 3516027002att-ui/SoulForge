using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Xml;
using Havoc.Collections;
using Havoc.Extensions;
using Havoc.Objects;
using Havoc.Reflection;

namespace Havoc.IO.Tagfile.Xml.V1;

public class HkXmlObjectWriterV1 : IHkXmlObjectWriter
{
	private readonly OrderedSet<IHkObject> mObjects;

	public IHkXmlTypeWriter TypeWriter { get; }

	public IHkObject RootObject { get; }

	public IReadOnlyList<IHkObject> Objects => mObjects;

	public HkXmlObjectWriterV1(IHkObject rootObject)
	{
		TypeWriter = new HkXmlTypeWriterV1(new HkTypeCompendium(rootObject));
		RootObject = rootObject;
		mObjects = new OrderedSet<IHkObject>();
		AddObjectsRecursively(rootObject);
	}

	public HkXmlObjectWriterV1(List<IHkObject> objs)
	{
		TypeWriter = new HkXmlTypeWriterV1(new HkTypeCompendium(objs));
		RootObject = objs[0];
		mObjects = new OrderedSet<IHkObject>();
		objs.ForEach(AddObjectsRecursively);
	}

	public void WriteObject(XmlWriter writer, IHkObject obj, bool writeObjectDefinition = false)
	{
		WriteObject(writer, obj, null, writeObjectDefinition);
	}

	public void WriteAllObjects(XmlWriter writer)
	{
		foreach (IHkObject mObject in mObjects)
		{
			WriteObject(writer, mObject, writeObjectDefinition: true);
		}
	}

	public string GetObjectIdString(IHkObject obj)
	{
		DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(1, 1);
		defaultInterpolatedStringHandler.AppendLiteral("#");
		defaultInterpolatedStringHandler.AppendFormatted((obj != null && mObjects.IndexMap.TryGetValue(obj, out var value)) ? (value + 1) : 0, "D4");
		return defaultInterpolatedStringHandler.ToStringAndClear();
	}

	private void WriteObject(XmlWriter writer, IHkObject obj, string name, bool writeObjectDefinition = false)
	{
		string formatName = HkXmlTypeWriterV1.GetFormatName(obj.Type);
		if (writeObjectDefinition)
		{
			writer.WriteStartElement("object", ("id", GetObjectIdString(obj)), ("type", TypeWriter.GetTypeIdString(obj.Type)));
		}
		else if (!string.IsNullOrEmpty(name))
		{
			writer.WriteStartElement(formatName, ("name", name));
		}
		else
		{
			writer.WriteStartElement(formatName);
		}
		switch (obj.Type.Format)
		{
		case HkTypeFormat.Bool:
		case HkTypeFormat.Int:
		case HkTypeFormat.FloatingPoint:
			writer.WriteString(GetPrimitiveString(obj));
			break;
		case HkTypeFormat.String:
			writer.WriteString(obj.GetValue<HkString, string>());
			break;
		case HkTypeFormat.Ptr:
			writer.WriteString(GetObjectIdString(obj.GetValue<HkPtr, IHkObject>()));
			break;
		case HkTypeFormat.Class:
		{
			IReadOnlyDictionary<HkField, IHkObject> value2 = obj.GetValue<HkClass, IReadOnlyDictionary<HkField, IHkObject>>();
			if (obj.Type.Name.StartsWith("hkQsTransform"))
			{
				IReadOnlyList<IHkObject> value3 = value2[obj.Type.Fields[0]].GetValue<HkArray, IReadOnlyList<IHkObject>>();
				IReadOnlyList<IHkObject> value4 = value2[obj.Type.Fields[1]].GetValue<HkArray, IReadOnlyList<IHkObject>>();
				IReadOnlyList<IHkObject> value5 = value2[obj.Type.Fields[2]].GetValue<HkArray, IReadOnlyList<IHkObject>>();
				writer.WriteString(string.Join(" ", value3.Concat(value4).Concat(value5).Select(GetPrimitiveString)));
				break;
			}
			foreach (KeyValuePair<HkField, IHkObject> item in value2)
			{
				item.Deconstruct(out var key, out var value6);
				HkField hkField = key;
				IHkObject obj2 = value6;
				if ((hkField.Flags & HkFieldFlags.IsNotSerializable) == 0)
				{
					WriteObject(writer, obj2, hkField.Name);
				}
			}
			break;
		}
		case HkTypeFormat.Array:
		{
			IReadOnlyList<IHkObject> value = obj.GetValue<HkArray, IReadOnlyList<IHkObject>>();
			if (!formatName.StartsWith("vec"))
			{
				DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(0, 1);
				defaultInterpolatedStringHandler.AppendFormatted(value.Count);
				writer.WriteAttributeString("size", defaultInterpolatedStringHandler.ToStringAndClear());
			}
			if (obj.Type.SubType.Format == HkTypeFormat.Bool || obj.Type.SubType.Format == HkTypeFormat.Int || obj.Type.SubType.Format == HkTypeFormat.FloatingPoint)
			{
				writer.WriteString(string.Join(" ", value.Select(GetPrimitiveString)));
				break;
			}
			foreach (IHkObject item2 in value)
			{
				WriteObject(writer, item2);
			}
			break;
		}
		default:
			throw new ArgumentOutOfRangeException();
		case HkTypeFormat.Void:
		case HkTypeFormat.Opaque:
			break;
		}
		writer.WriteEndElement();
	}

	private void AddObjectsRecursively(IHkObject obj)
	{
		if (obj == null || mObjects.Contains(obj) || obj.Value == null)
		{
			return;
		}
		switch (obj.Type.Format)
		{
		case HkTypeFormat.Ptr:
		{
			IHkObject value2 = obj.GetValue<HkPtr, IHkObject>();
			AddObjectsRecursively(value2);
			mObjects.Add(value2);
			break;
		}
		case HkTypeFormat.Class:
			if (obj == RootObject)
			{
				mObjects.Add(obj);
			}
			{
				foreach (KeyValuePair<HkField, IHkObject> item in obj.GetValue<HkClass, IReadOnlyDictionary<HkField, IHkObject>>())
				{
					item.Deconstruct(out var _, out var value);
					IHkObject obj2 = value;
					AddObjectsRecursively(obj2);
				}
				break;
			}
		case HkTypeFormat.Array:
		{
			foreach (IHkObject item2 in obj.GetValue<HkArray, IReadOnlyList<IHkObject>>())
			{
				AddObjectsRecursively(item2);
			}
			break;
		}
		}
	}

	private unsafe static string GetPrimitiveString(IHkObject obj)
	{
		switch (obj.Type.Format)
		{
		case HkTypeFormat.Bool:
			return obj.GetValue<HkBool, bool>() ? "1" : "0";
		case HkTypeFormat.Int:
		{
			DefaultInterpolatedStringHandler defaultInterpolatedStringHandler;
			if (obj.Type.BitCount != 64 || obj.Type.IsSigned)
			{
				defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(0, 1);
				defaultInterpolatedStringHandler.AppendFormatted<object>(obj.Value);
				return defaultInterpolatedStringHandler.ToStringAndClear();
			}
			ulong value3 = obj.GetValue<HkUInt64, ulong>();
			defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(0, 1);
			defaultInterpolatedStringHandler.AppendFormatted((long)value3);
			return defaultInterpolatedStringHandler.ToStringAndClear();
		}
		case HkTypeFormat.FloatingPoint:
		{
			DefaultInterpolatedStringHandler defaultInterpolatedStringHandler;
			if (obj.Type.IsSingle)
			{
				float value = obj.GetValue<HkSingle, float>();
				defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(1, 1);
				defaultInterpolatedStringHandler.AppendLiteral("x");
				defaultInterpolatedStringHandler.AppendFormatted(*(uint*)(&value), "X8");
				return defaultInterpolatedStringHandler.ToStringAndClear();
			}
			if (obj.Type.IsDouble)
			{
				double value2 = obj.GetValue<HkDouble, double>();
				defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(1, 1);
				defaultInterpolatedStringHandler.AppendLiteral("x");
				defaultInterpolatedStringHandler.AppendFormatted(*(ulong*)(&value2), "X16");
				return defaultInterpolatedStringHandler.ToStringAndClear();
			}
			defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(36, 1);
			defaultInterpolatedStringHandler.AppendLiteral("Unexpected floating point format: 0x");
			defaultInterpolatedStringHandler.AppendFormatted(obj.Type.FormatInfo, "X");
			throw new InvalidDataException(defaultInterpolatedStringHandler.ToStringAndClear());
		}
		default:
			throw new ArgumentException("Expected an object of bool, int or floating point type.", "obj");
		}
	}
}
