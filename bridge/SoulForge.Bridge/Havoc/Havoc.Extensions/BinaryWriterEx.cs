using System;
using System.IO;

namespace Havoc.Extensions;

public static class BinaryWriterEx
{
	public static void WriteAlignmentPadding(this BinaryWriter writer, int alignment)
	{
		int num = alignment - (int)(writer.BaseStream.Position % alignment);
		if (num != alignment)
		{
			for (int i = 0; i < num; i++)
			{
				writer.Write((byte)0);
			}
		}
	}

	public static void Write(this BinaryWriter writer, string value, int length)
	{
		if (value.Length > length)
		{
			throw new ArgumentException("Provided string is longer than fixed length.", "value");
		}
		for (int i = 0; i < value.Length; i++)
		{
			writer.Write(value[i]);
		}
		for (int j = 0; j < length - value.Length; j++)
		{
			writer.Write('\0');
		}
	}

	public static void WriteNullTerminatedString(this BinaryWriter writer, string value)
	{
		for (int i = 0; i < value.Length; i++)
		{
			writer.Write(value[i]);
		}
		writer.Write('\0');
	}

	public static void WritePackedInt(this BinaryWriter writer, long value)
	{
		if (value < 128)
		{
			writer.Write((byte)value);
		}
		else if (value < 16384)
		{
			writer.Write((byte)(((value >> 8) & 0xFF) | 0x80));
			writer.Write((byte)(value & 0xFF));
		}
		else if (value < 2097152)
		{
			writer.Write((byte)(((value >> 16) & 0xFF) | 0xC0));
			writer.Write((byte)((value >> 8) & 0xFF));
			writer.Write((byte)(value & 0xFF));
		}
		else if (value < 134217728)
		{
			writer.Write((byte)(((value >> 24) & 0xFF) | 0xE0));
			writer.Write((byte)((value >> 16) & 0xFF));
			writer.Write((byte)((value >> 8) & 0xFF));
			writer.Write((byte)(value & 0xFF));
		}
		else if (value < 34359738368L)
		{
			writer.Write((byte)(((value >> 32) & 0xFF) | 0xE8));
			writer.Write((byte)((value >> 24) & 0xFF));
			writer.Write((byte)((value >> 16) & 0xFF));
			writer.Write((byte)((value >> 8) & 0xFF));
			writer.Write((byte)(value & 0xFF));
		}
		else if (value < 1099511627776L)
		{
			writer.Write((byte)248);
			writer.Write((byte)((value >> 32) & 0xFF));
			writer.Write((byte)((value >> 24) & 0xFF));
			writer.Write((byte)((value >> 16) & 0xFF));
			writer.Write((byte)((value >> 8) & 0xFF));
			writer.Write((byte)(value & 0xFF));
		}
		else if (value < 576460752303423488L)
		{
			writer.Write((byte)(((value >> 56) & 0xFF) | 0xF0));
			writer.Write((byte)((value >> 48) & 0xFF));
			writer.Write((byte)((value >> 40) & 0xFF));
			writer.Write((byte)((value >> 32) & 0xFF));
			writer.Write((byte)((value >> 24) & 0xFF));
			writer.Write((byte)((value >> 16) & 0xFF));
			writer.Write((byte)((value >> 8) & 0xFF));
			writer.Write((byte)(value & 0xFF));
		}
		else
		{
			writer.Write((byte)249);
			writer.Write((byte)((value >> 56) & 0xFF));
			writer.Write((byte)((value >> 48) & 0xFF));
			writer.Write((byte)((value >> 40) & 0xFF));
			writer.Write((byte)((value >> 32) & 0xFF));
			writer.Write((byte)((value >> 24) & 0xFF));
			writer.Write((byte)((value >> 16) & 0xFF));
			writer.Write((byte)((value >> 8) & 0xFF));
			writer.Write((byte)(value & 0xFF));
		}
	}

	public static void WriteNulls(this BinaryWriter writer, int count)
	{
		for (int i = 0; i < count / 8; i++)
		{
			writer.Write(0uL);
		}
		for (int j = 0; j < count % 8; j++)
		{
			writer.Write((byte)0);
		}
	}
}
