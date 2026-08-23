using System.Runtime.CompilerServices;
using System.Xml;
using Havoc.Extensions;
using Havoc.Reflection;

namespace Havoc.IO.Tagfile.Xml.V3;

public class HkXmlTypeWriterV3 : IHkXmlTypeWriter
{
	public HkTypeCompendium TypeCompendium { get; }

	public HkXmlTypeWriterV3(HkTypeCompendium typeCompendium)
	{
		TypeCompendium = typeCompendium;
	}

	public void WriteType(XmlWriter writer, HkType type)
	{
		writer.WriteStartElement("type", ("typeid", GetTypeIdString(type)));
		writer.WriteElement("name", ("value", type.Name));
		if (type.ParentType != null)
		{
			writer.WriteElement("parent", type.ParentType, ("id", GetTypeIdString(type.ParentType)));
		}
		if ((type.Flags & HkTypeFlags.HasFormatInfo) != 0)
		{
			writer.WriteElement("format", ("value", type.mFormatInfo));
		}
		if ((type.Flags & HkTypeFlags.HasSubType) != 0)
		{
			writer.WriteElement("subtype", type.mSubType, ("id", GetTypeIdString(type.mSubType)));
		}
		if ((type.Flags & HkTypeFlags.HasVersion) != 0)
		{
			writer.WriteElement("version", ("value", type.mVersion));
		}
		if (type.mParameters.Count != 0)
		{
			writer.WriteStartElement("parameters", ("count", type.mParameters.Count));
			foreach (HkParameter mParameter in type.mParameters)
			{
				if (mParameter.IsType)
				{
					writer.WriteElement("typeparam", mParameter.TypeValue, ("id", GetTypeIdString(mParameter.TypeValue)));
				}
				else
				{
					writer.WriteElement("valueparam", ("value", mParameter.IntValue));
				}
			}
			writer.WriteEndElement();
		}
		if ((type.Flags & HkTypeFlags.HasUnknownFlags) != 0)
		{
			writer.WriteElement("flags", ("value", type.mUnknownFlags));
		}
		if ((type.Flags & HkTypeFlags.HasFields) != 0)
		{
			writer.WriteStartElement("fields", ("count", type.mFields.Count));
			foreach (HkField mField in type.mFields)
			{
				writer.WriteElement("field", mField.Type, ("name", mField.Name), ("typeid", GetTypeIdString(mField.Type)), ("flags", (int)mField.Flags));
			}
			writer.WriteEndElement();
		}
		writer.WriteEndElement();
	}

	public void WriteAllTypes(XmlWriter writer)
	{
		int num = 0;
		Debug.WriteProcess("XML: Write types " + TypeCompendium.Count);
		foreach (HkType item in TypeCompendium)
		{
			DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(17, 1);
			defaultInterpolatedStringHandler.AppendFormatted(num);
			defaultInterpolatedStringHandler.AppendLiteral(" XML: Write type ");
			Debug.WriteProcess(defaultInterpolatedStringHandler.ToStringAndClear() + item?.ToString() + ", name: " + item.Name);
			num++;
			WriteType(writer, item);
		}
	}

	public string GetTypeIdString(HkType type)
	{
		DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(4, 1);
		defaultInterpolatedStringHandler.AppendLiteral("type");
		defaultInterpolatedStringHandler.AppendFormatted((type != null && TypeCompendium.IndexMap.TryGetValue(type, out var value)) ? (value + 1) : 0);
		return defaultInterpolatedStringHandler.ToStringAndClear();
	}
}
