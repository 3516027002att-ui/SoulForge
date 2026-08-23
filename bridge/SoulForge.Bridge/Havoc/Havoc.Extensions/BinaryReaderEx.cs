using System.IO;
using System.Text;

namespace Havoc.Extensions;

public static class BinaryReaderEx
{
	public static string ReadNullTerminatedString(this BinaryReader reader)
	{
		StringBuilder stringBuilder = new StringBuilder();
		char value;
		while ((value = reader.ReadChar()) != 0)
		{
			stringBuilder.Append(value);
		}
		return stringBuilder.ToString();
	}

	public static string ReadString(this BinaryReader reader, int length)
	{
		StringBuilder stringBuilder = new StringBuilder(length);
		for (int i = 0; i < length; i++)
		{
			char c = reader.ReadChar();
			if (c != 0)
			{
				stringBuilder.Append(c);
			}
		}
		return stringBuilder.ToString();
	}

	public static long ReadPackedInt(this BinaryReader reader)
	{
		byte b = reader.ReadByte();
		if ((b & 0x80) == 0)
		{
			return b;
		}
		switch (b >> 3)
		{
		case 16:
		case 17:
		case 18:
		case 19:
		case 20:
		case 21:
		case 22:
		case 23:
			return ((b << 8) | reader.ReadByte()) & 0x3FFF;
		case 24:
		case 25:
		case 26:
		case 27:
			return ((b << 16) | (reader.ReadByte() << 8) | reader.ReadByte()) & 0x1FFFFF;
		case 28:
			return ((b << 24) | (reader.ReadByte() << 16) | (reader.ReadByte() << 8) | reader.ReadByte()) & 0x7FFFFFF;
		case 29:
			return (b | (reader.ReadByte() << 24) | (reader.ReadByte() << 16) | (reader.ReadByte() << 8) | reader.ReadByte()) & 0x7FFFFFFFFFFFFFFL;
		case 30:
			return ((b << 24) | (reader.ReadByte() << 16) | (reader.ReadByte() << 8) | reader.ReadByte() | (reader.ReadByte() << 24) | (reader.ReadByte() << 16) | (reader.ReadByte() << 8) | reader.ReadByte()) & 0x7FFFFFFFFFFFFFFL;
		case 31:
			return ((b & 7) == 0) ? (((b << 8) | reader.ReadByte() | (reader.ReadByte() << 24) | (reader.ReadByte() << 16) | (reader.ReadByte() << 8) | reader.ReadByte()) & 0xFFFFFFFFFFL) : (((b & 7) == 1) ? ((reader.ReadByte() << 24) | (reader.ReadByte() << 16) | (reader.ReadByte() << 8) | reader.ReadByte() | (reader.ReadByte() << 24) | (reader.ReadByte() << 16) | (reader.ReadByte() << 8) | reader.ReadByte()) : 0);
		default:
			return 0L;
		}
	}
}
