using System;
using System.Runtime.CompilerServices;
using System.Xml;
using Havoc.Extensions;

namespace Havoc.IO.Tagfile.Xml;

public static class HkXmlTypeWriterEx
{
	public static void WriteTypeCompendium(this IHkXmlTypeWriter typeWriter, XmlWriter writer)
	{
		writer.WriteStartDocument();
		DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(23, 1);
		defaultInterpolatedStringHandler.AppendLiteral("Exported from Havoc at ");
		defaultInterpolatedStringHandler.AppendFormatted(DateTime.Now);
		writer.WriteStartElement("hktypecompendium", defaultInterpolatedStringHandler.ToStringAndClear(), ("version", 3));
		typeWriter.WriteAllTypes(writer);
		writer.WriteEndElement();
		writer.WriteEndDocument();
	}

	public static void WriteTypeCompendium(this IHkXmlTypeWriter typeWriter, string destinationFilePath)
	{
		using XmlWriter writer = XmlWriter.Create(destinationFilePath, new XmlWriterSettings
		{
			Indent = true,
			IndentChars = "  "
		});
		typeWriter.WriteTypeCompendium(writer);
	}
}
