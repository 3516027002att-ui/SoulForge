using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.CompilerServices;
using Havoc.Reflection;

namespace Havoc.Objects;

public static class HkObjectEx
{
	public static TValueType GetValue<TObjectType, TValueType>(this IHkObject obj)
	{
		if (obj is TObjectType)
		{
			object value = obj.Value;
			TValueType result = default(TValueType);
			int num;
			if (value is TValueType)
			{
				result = (TValueType)value;
				num = 1;
			}
			else
			{
				num = 0;
			}
			if (num != 0)
			{
				return result;
			}
		}
		throw new InvalidDataException("Expected HK object to be of " + typeof(TObjectType).Name + " type.");
	}

	public static TValueType GetValueOrDefault<TObjectType, TValueType>(this IHkObject obj) where TValueType : class
	{
		if (obj == null || obj.Value == null)
		{
			return null;
		}
		if (!(obj is TObjectType))
		{
			throw new InvalidDataException("Expected HK object to be of " + typeof(TObjectType).Name + " type.");
		}
		if (obj.Value.Equals(null))
		{
			return null;
		}
		if (!(obj.Value is TValueType result))
		{
			throw new InvalidDataException("Expected value to be of " + typeof(TValueType).Name + " type.");
		}
		return result;
	}

	public static bool IsWorthWriting(this IHkObject obj)
	{
		switch (obj.Type.Format)
		{
		case HkTypeFormat.Void:
		case HkTypeFormat.Opaque:
			return false;
		case HkTypeFormat.Bool:
			return obj.GetValue<HkBool, bool>();
		case HkTypeFormat.String:
			return !string.IsNullOrEmpty(obj.GetValueOrDefault<HkString, string>());
		case HkTypeFormat.Int:
			return Convert.ToDecimal(obj.Value) != 0m;
		case HkTypeFormat.FloatingPoint:
		{
			if (obj.Type.IsHalf)
			{
				return (Half)obj.Value != (Half)0f;
			}
			if ((obj.Type.IsSingle && (float)obj.Value >= 4.2865787E+09f) || float.IsNaN((float)obj.Value))
			{
				return true;
			}
			decimal num = default(decimal);
			try
			{
				num = Convert.ToDecimal(obj.Value);
			}
			catch (Exception value)
			{
				DefaultInterpolatedStringHandler defaultInterpolatedStringHandler = new DefaultInterpolatedStringHandler(17, 3);
				defaultInterpolatedStringHandler.AppendLiteral("value: ");
				defaultInterpolatedStringHandler.AppendFormatted(obj.GetType());
				defaultInterpolatedStringHandler.AppendLiteral(" ");
				defaultInterpolatedStringHandler.AppendFormatted<object>(obj.Value);
				defaultInterpolatedStringHandler.AppendLiteral(", error: ");
				defaultInterpolatedStringHandler.AppendFormatted(value);
				Console.WriteLine(defaultInterpolatedStringHandler.ToStringAndClear());
				return true;
			}
			return num != 0m;
		}
		case HkTypeFormat.Ptr:
			return obj.Value != null;
		case HkTypeFormat.Array:
			if (obj.Type.IsFixedSize)
			{
				break;
			}
			return obj.Value != null && obj.GetValue<HkArray, IReadOnlyList<IHkObject>>().Count != 0;
		}
		return true;
	}
}
