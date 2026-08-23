using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Xml;
using Havoc.Extensions;
using Havoc.Objects;

namespace Havoc.IO.Tagfile.Xml.V3;

public class HkXmlTagfileWriterV3 : IHkXmlTagfileWriter
{
	private static HkXmlTagfileWriterV3 sInstance;

	public static HkXmlTagfileWriterV3 Instance => sInstance ?? (sInstance = new HkXmlTagfileWriterV3());

	public void Write(XmlWriter writer, IHkObject rootObject)
	{
		HkXmlObjectWriterV3 hkXmlObjectWriterV = new HkXmlObjectWriterV3(rootObject);
		writer.WriteStartDocument();
		DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(23, 1);
		defaultInterpolatedStringHandler.AppendLiteral("Exported from Havoc at ");
		defaultInterpolatedStringHandler.AppendFormatted(DateTime.Now);
		writer.WriteStartElement("hktagfile", defaultInterpolatedStringHandler.ToStringAndClear(), ("version", 3));
		hkXmlObjectWriterV.TypeWriter.WriteAllTypes(writer);
		hkXmlObjectWriterV.WriteAllObjects(writer);
		writer.WriteEndElement();
		writer.WriteEndDocument();
	}

	public void Write(XmlWriter writer, List<IHkObject> rootObject)
	{
		HkXmlObjectWriterV3 hkXmlObjectWriterV = new HkXmlObjectWriterV3(rootObject);
		writer.WriteStartDocument();
		DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(23, 1);
		defaultInterpolatedStringHandler.AppendLiteral("Exported from Havoc at ");
		defaultInterpolatedStringHandler.AppendFormatted(DateTime.Now);
		writer.WriteStartElement("hktagfile", defaultInterpolatedStringHandler.ToStringAndClear(), ("version", 3));
		hkXmlObjectWriterV.TypeWriter.WriteAllTypes(writer);
		hkXmlObjectWriterV.WriteAllObjects(writer);
		writer.WriteEndElement();
		writer.WriteEndDocument();
	}
}
