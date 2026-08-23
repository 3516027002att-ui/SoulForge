using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Xml;
using Havoc.Extensions;
using Havoc.Objects;

namespace Havoc.IO.Tagfile.Xml.V1;

public class HkXmlTagfileWriterV1 : IHkXmlTagfileWriter
{
	private static HkXmlTagfileWriterV1 sInstance;

	public static HkXmlTagfileWriterV1 Instance => sInstance ?? (sInstance = new HkXmlTagfileWriterV1());

	public void Write(XmlWriter writer, IHkObject rootObject)
	{
		HkXmlObjectWriterV1 hkXmlObjectWriterV = new HkXmlObjectWriterV1(rootObject);
		writer.WriteStartDocument();
		DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(23, 1);
		defaultInterpolatedStringHandler.AppendLiteral("Exported from Havoc at ");
		defaultInterpolatedStringHandler.AppendFormatted(DateTime.Now);
		writer.WriteStartElement("hktagfile", defaultInterpolatedStringHandler.ToStringAndClear(), ("version", 1));
		hkXmlObjectWriterV.TypeWriter.WriteAllTypes(writer);
		hkXmlObjectWriterV.WriteAllObjects(writer);
		writer.WriteEndElement();
		writer.WriteEndDocument();
	}

	public void Write(XmlWriter writer, List<IHkObject> rootObject)
	{
		HkXmlObjectWriterV1 hkXmlObjectWriterV = new HkXmlObjectWriterV1(rootObject);
		writer.WriteStartDocument();
		DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(23, 1);
		defaultInterpolatedStringHandler.AppendLiteral("Exported from Havoc at ");
		defaultInterpolatedStringHandler.AppendFormatted(DateTime.Now);
		writer.WriteStartElement("hktagfile", defaultInterpolatedStringHandler.ToStringAndClear(), ("version", 1));
		hkXmlObjectWriterV.TypeWriter.WriteAllTypes(writer);
		hkXmlObjectWriterV.WriteAllObjects(writer);
		writer.WriteEndElement();
		writer.WriteEndDocument();
	}
}
