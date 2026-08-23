using System.Collections;
using System.Collections.Generic;
using Havoc.Collections;
using Havoc.Objects;

namespace Havoc.Reflection;

public class HkTypeCompendium : IReadOnlyList<HkType>, IEnumerable<HkType>, IEnumerable, IReadOnlyCollection<HkType>
{
	private readonly OrderedSet<HkType> mTypes = new OrderedSet<HkType>();

	public IReadOnlyDictionary<HkType, int> IndexMap => mTypes.IndexMap;

	public int Count => mTypes.Count;

	public HkType this[int index] => mTypes[index];

	public HkTypeCompendium(IHkObject obj)
	{
		AddRecursively(obj);
	}

	public HkTypeCompendium(List<IHkObject> objs)
	{
		objs.ForEach(AddRecursively);
	}

	public HkTypeCompendium(IEnumerable<HkType> types)
	{
		foreach (HkType type in types)
		{
			Add(type);
		}
	}

	public IEnumerator<HkType> GetEnumerator()
	{
		return mTypes.GetEnumerator();
	}

	IEnumerator IEnumerable.GetEnumerator()
	{
		return ((IEnumerable)mTypes).GetEnumerator();
	}

	internal void Add(HkType type)
	{
		if (type == null)
		{
			return;
		}
		AddIfNotNull(type);
		foreach (HkParameter mParameter in type.mParameters)
		{
			AddIfNotNull(mParameter.Value as HkType);
		}
		AddIfNotNull(type.ParentType);
		AddIfNotNull(type.SubType);
		foreach (HkField mField in type.mFields)
		{
			AddIfNotNull(mField.Type);
		}
		foreach (HkInterface mInterface in type.mInterfaces)
		{
			AddIfNotNull(mInterface.Type);
		}
		void AddIfNotNull(HkType t)
		{
			if (t != null && !mTypes.Contains(t))
			{
				mTypes.Add(t);
				Add(t);
			}
		}
	}

	internal void AddRecursively(IHkObject obj)
	{
		while (true)
		{
			Add(obj.Type);
			if (obj.Value == null)
			{
				break;
			}
			switch (obj.Type.Format)
			{
			default:
				return;
			case HkTypeFormat.Ptr:
				break;
			case HkTypeFormat.Class:
			{
				foreach (KeyValuePair<HkField, IHkObject> item in (IReadOnlyDictionary<HkField, IHkObject>)obj.Value)
				{
					AddRecursively(item.Value);
				}
				return;
			}
			case HkTypeFormat.Array:
			{
				foreach (IHkObject item2 in (IEnumerable<IHkObject>)obj.Value)
				{
					AddRecursively(item2);
				}
				return;
			}
			}
			obj = (IHkObject)obj.Value;
		}
	}
}
