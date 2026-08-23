using System.Runtime.CompilerServices;
using System.Xml;

namespace Havoc.Extensions;

public static class XmlWriterEx
{
	public static void WriteStartElement(this XmlWriter writer, string name, params (string, object)[] attributes)
	{
		writer.WriteStartElement(name);
		for (int i = 0; i < attributes.Length; i++)
		{
			var (localName, obj) = attributes[i];
			writer.WriteAttributeString(localName, obj.ToString());
		}
	}

	public static void WriteStartElement(this XmlWriter writer, string name, object comment, params (string, object)[] attributes)
	{
		DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(0, 1);
		defaultInterpolatedStringHandler.AppendFormatted<object>(comment);
		writer.WriteComment(defaultInterpolatedStringHandler.ToStringAndClear());
		writer.WriteStartElement(name, attributes);
	}

	public static void WriteElement(this XmlWriter writer, string name, params (string, object)[] attributes)
	{
		writer.WriteStartElement(name, attributes);
		writer.WriteEndElement();
	}

	public static void WriteElement(this XmlWriter writer, string name, object comment, params (string, object)[] attributes)
	{
		DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(0, 1);
		defaultInterpolatedStringHandler.AppendFormatted<object>(comment);
		writer.WriteComment(defaultInterpolatedStringHandler.ToStringAndClear());
		writer.WriteElement(name, attributes);
	}
}
