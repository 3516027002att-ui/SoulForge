using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.CompilerServices;
using System.Xml;
using Havoc.Collections;
using Havoc.Extensions;
using Havoc.Objects;
using Havoc.Reflection;

namespace Havoc.IO.Tagfile.Xml.V3;

public class HkXmlObjectWriterV3 : IHkXmlObjectWriter
{
	private readonly OrderedSet<IHkObject> mObjects;

	public IHkXmlTypeWriter TypeWriter { get; }

	public IHkObject RootObject { get; }

	public IReadOnlyList<IHkObject> Objects => mObjects;

	public HkXmlObjectWriterV3(IHkObject rootObject)
	{
		TypeWriter = new HkXmlTypeWriterV3(new HkTypeCompendium(rootObject));
		RootObject = rootObject;
		mObjects = new OrderedSet<IHkObject>();
		AddObjectsRecursively(rootObject);
	}

	public HkXmlObjectWriterV3(List<IHkObject> objs)
	{
		TypeWriter = new HkXmlTypeWriterV3(new HkTypeCompendium(objs));
		RootObject = objs[0];
		mObjects = new OrderedSet<IHkObject>();
		objs.ForEach(AddObjectsRecursively);
	}

	public unsafe void WriteObject(XmlWriter writer, IHkObject obj, bool writeObjectDefinition = false)
	{
		if (writeObjectDefinition)
		{
			writer.WriteStartElement("object", obj.Type, ("id", GetObjectIdString(obj)), ("typeid", TypeWriter.GetTypeIdString(obj.Type)));
		}
		switch (obj.Type.Format)
		{
		case HkTypeFormat.Bool:
			writer.WriteElement("bool", ("value", obj.GetValue<HkBool, bool>() ? "true" : "false"));
			break;
		case HkTypeFormat.String:
		{
			string text = ((obj.Value != null) ? obj.GetValue<HkString, string>() : null);
			if (!string.IsNullOrEmpty(text))
			{
				writer.WriteElement("string", ("value", text));
			}
			else
			{
				writer.WriteElement("string");
			}
			break;
		}
		case HkTypeFormat.Int:
			writer.WriteElement("integer", ("value", obj.Value));
			break;
		case HkTypeFormat.FloatingPoint:
		{
			DefaultInterpolatedStringHandler defaultInterpolatedStringHandler;
			if (obj.Type.IsSingle)
			{
				float value2 = obj.GetValue<HkSingle, float>();
				(string, object)[] obj2 = new(string, object)[2]
				{
					("dec", value2.ToString(CultureInfo.InvariantCulture)),
					default((string, object))
				};
				defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(1, 1);
				defaultInterpolatedStringHandler.AppendLiteral("#");
				defaultInterpolatedStringHandler.AppendFormatted(*(uint*)(&value2), "X");
				obj2[1] = ("hex", defaultInterpolatedStringHandler.ToStringAndClear());
				writer.WriteElement("real", obj2);
				break;
			}
			if (obj.Type.IsDouble)
			{
				double value3 = obj.GetValue<HkDouble, double>();
				(string, object)[] obj3 = new(string, object)[2]
				{
					("dec", value3.ToString(CultureInfo.InvariantCulture)),
					default((string, object))
				};
				defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(1, 1);
				defaultInterpolatedStringHandler.AppendLiteral("#");
				defaultInterpolatedStringHandler.AppendFormatted(*(ulong*)(&value3), "X");
				obj3[1] = ("hex", defaultInterpolatedStringHandler.ToStringAndClear());
				writer.WriteElement("real", obj3);
				break;
			}
			if (obj.Type.IsHalf)
			{
				Half value4 = obj.GetValue<HkHalf, Half>();
				(string, object)[] obj4 = new(string, object)[2]
				{
					("dec", value4.ToString(CultureInfo.InvariantCulture)),
					default((string, object))
				};
				defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(1, 1);
				defaultInterpolatedStringHandler.AppendLiteral("#");
				defaultInterpolatedStringHandler.AppendFormatted(*(ulong*)(&value4), "X");
				obj4[1] = ("hex", defaultInterpolatedStringHandler.ToStringAndClear());
				writer.WriteElement("real", obj4);
				break;
			}
			defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(36, 1);
			defaultInterpolatedStringHandler.AppendLiteral("Unexpected floating point format: 0x");
			defaultInterpolatedStringHandler.AppendFormatted(obj.Type.FormatInfo, "X");
			throw new InvalidDataException(defaultInterpolatedStringHandler.ToStringAndClear());
		}
		case HkTypeFormat.Ptr:
			writer.WriteElement("pointer", ("id", GetObjectIdString((obj.Value != null) ? obj.GetValue<HkPtr, IHkObject>() : null)));
			break;
		case HkTypeFormat.Class:
			writer.WriteStartElement("record", obj.Type);
			foreach (KeyValuePair<HkField, IHkObject> item in obj.GetValue<HkClass, IReadOnlyDictionary<HkField, IHkObject>>())
			{
				item.Deconstruct(out var key, out var value);
				HkField hkField = key;
				IHkObject hkObject = value;
				if (obj.Type.Name == "<DEBUG>" && hkField.Name == "<DEBUG>")
				{
					Debug.WriteProcess("Write: " + obj.Type.Name + "." + hkField.Name);
					DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(8, 4);
					defaultInterpolatedStringHandler.AppendLiteral("  ");
					defaultInterpolatedStringHandler.AppendFormatted(hkField.Type.Name);
					defaultInterpolatedStringHandler.AppendLiteral(": ");
					defaultInterpolatedStringHandler.AppendFormatted(hkObject.Type.Name);
					defaultInterpolatedStringHandler.AppendLiteral("(");
					defaultInterpolatedStringHandler.AppendFormatted(hkObject.Type.Format);
					defaultInterpolatedStringHandler.AppendLiteral("): ");
					defaultInterpolatedStringHandler.AppendFormatted((hkObject.Value == null) ? ((object)"null") : ((object)hkObject.Value.GetType()));
					Debug.WriteProcess(defaultInterpolatedStringHandler.ToStringAndClear());
				}
				if ((hkField.Flags & HkFieldFlags.IsNotSerializable) == 0 && hkObject.IsWorthWriting())
				{
					writer.WriteStartElement("field", ("name", hkField.Name));
					WriteObject(writer, hkObject);
					writer.WriteEndElement();
				}
			}
			writer.WriteEndElement();
			break;
		case HkTypeFormat.Array:
		{
			IReadOnlyList<IHkObject> readOnlyList = ((obj.Value != null) ? obj.GetValue<HkArray, IReadOnlyList<IHkObject>>() : null);
			DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(8, 1);
			defaultInterpolatedStringHandler.AppendLiteral("ArrayOf ");
			defaultInterpolatedStringHandler.AppendFormatted(obj.Type.SubType);
			writer.WriteStartElement("array", defaultInterpolatedStringHandler.ToStringAndClear(), ("count", readOnlyList?.Count ?? 0), ("elementtypeid", TypeWriter.GetTypeIdString(obj.Type.SubType)));
			if (readOnlyList != null)
			{
				foreach (IHkObject item2 in readOnlyList)
				{
					WriteObject(writer, item2);
				}
			}
			writer.WriteEndElement();
			break;
		}
		default:
			throw new ArgumentOutOfRangeException("Format");
		case HkTypeFormat.Void:
		case HkTypeFormat.Opaque:
			break;
		}
		if (writeObjectDefinition)
		{
			writer.WriteEndElement();
		}
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
		DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(4, 1);
		defaultInterpolatedStringHandler.AppendLiteral("type");
		defaultInterpolatedStringHandler.AppendFormatted((obj != null && mObjects.IndexMap.TryGetValue(obj, out var value)) ? (value + 1) : 0);
		return defaultInterpolatedStringHandler.ToStringAndClear();
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
			IHkObject value = obj.GetValue<HkPtr, IHkObject>();
			AddObjectsRecursively(value);
			mObjects.Add(value);
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
					item.Deconstruct(out var key, out var value2);
					HkField hkField = key;
					IHkObject obj2 = value2;
					Debug.WriteProcessIndent++;
					AddObjectsRecursively(obj2);
					Debug.WriteProcessIndent--;
				}
				break;
			}
		case HkTypeFormat.Array:
			Debug.WriteProcessIndent++;
			foreach (IHkObject item2 in obj.GetValue<HkArray, IReadOnlyList<IHkObject>>())
			{
				AddObjectsRecursively(item2);
			}
			Debug.WriteProcessIndent--;
			break;
		default:
			mObjects.Add(obj);
			break;
		}
	}
}
