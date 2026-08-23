using System;
using System.Xml;
using Havoc.Reflection;

namespace Havoc.IO.Tagfile.Xml.V1;

public class HkXmlTypeWriterV1 : IHkXmlTypeWriter
{
	public HkTypeCompendium TypeCompendium { get; }

	public HkXmlTypeWriterV1(HkTypeCompendium typeCompendium)
	{
		TypeCompendium = typeCompendium;
	}

	public void WriteType(XmlWriter writer, HkType type)
	{
	}

	public void WriteAllTypes(XmlWriter writer)
	{
	}

	public string GetTypeIdString(HkType type)
	{
		return type.Name;
	}

	public static string GetFormatName(HkType type)
	{
		switch (type.Format)
		{
		case HkTypeFormat.Void:
			return "void";
		case HkTypeFormat.Opaque:
			return "incomplete";
		case HkTypeFormat.Bool:
		case HkTypeFormat.Int:
			return (type.BitCount == 8) ? "byte" : "int";
		case HkTypeFormat.String:
			return "string";
		case HkTypeFormat.FloatingPoint:
			return "real";
		case HkTypeFormat.Ptr:
			return "ref";
		case HkTypeFormat.Class:
			return type.Name.StartsWith("hkQsTransform") ? "vec12" : "struct";
		case HkTypeFormat.Array:
		{
			if (!type.IsFixedSize)
			{
				return "array";
			}
			if (type.SubType.Format != HkTypeFormat.FloatingPoint)
			{
				return "tuple";
			}
			int fixedSize = type.FixedSize;
			if (1 == 0)
			{
			}
			string result = fixedSize switch
			{
				4 => "vec4", 
				12 => "vec12", 
				16 => "vec16", 
				_ => "tuple", 
			};
			if (1 == 0)
			{
			}
			return result;
		}
		default:
			throw new ArgumentOutOfRangeException("Format");
		}
	}
}
