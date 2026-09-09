import type { ParamExport, ParamFieldSymbol, ParamRowSymbol } from '@soulforge/shared';

type ClonePrimitive = string | number | boolean | null | undefined | bigint;
type StringKeyedRecord = Record<string, unknown>;

/**
 * PARAM projections are data records. Keep immutable scalar values attached to
 * the original strings/numbers, while sending only mutable unknown values
 * through structuredClone. `Object.keys` intentionally mirrors
 * structuredClone's enumerable-string property boundary (symbol and hidden
 * properties were not part of the old clone contract either).
 */
function isClonePrimitive(value: unknown): value is ClonePrimitive {
  const kind = typeof value;
  return value === null
    || kind === 'string'
    || kind === 'number'
    || kind === 'boolean'
    || kind === 'undefined'
    || kind === 'bigint';
}

function defineEnumerable(target: StringKeyedRecord, key: string, value: unknown): void {
  // Assignment would treat an unknown `__proto__` key as a prototype setter.
  // Defining the data property keeps the no-field-deletion promise exact.
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value
  });
}

interface CloneParts {
  clone: StringKeyedRecord;
  complex: StringKeyedRecord;
  complexKeys: string[];
}

/**
 * Copy one enumerable string property into an ordinary clone.  Ordinary
 * assignment is the fast path; the one legacy prototype setter is handled as
 * a data property explicitly.  This avoids both scalar defineProperty calls
 * and an intermediate scalar snapshot while keeping unknown `__proto__`
 * properties safe.  Object.keys intentionally keeps symbols and hidden
 * properties outside the clone contract.
 */
function assignCloneProperty(target: StringKeyedRecord, key: string, value: unknown): void {
  if (key === '__proto__') {
    defineEnumerable(target, key, value);
    return;
  }
  target[key] = value;
}

function partitionCloneProperties(source: StringKeyedRecord, skipKey?: string): CloneParts {
  const clone: StringKeyedRecord = {};
  const complex = Object.create(null) as StringKeyedRecord;
  const complexKeys: string[] = [];

  for (const key of Object.keys(source)) {
    if (key === skipKey) continue;
    const value = source[key];
    if (isClonePrimitive(value)) {
      assignCloneProperty(clone, key, value);
    } else {
      complex[key] = value;
      complexKeys.push(key);
    }
  }

  return {
    clone,
    complex,
    complexKeys
  };
}

function finishClone(parts: CloneParts): StringKeyedRecord {
  if (parts.complexKeys.length > 0) {
    const clonedComplex = structuredClone(parts.complex) as StringKeyedRecord;
    for (const key of parts.complexKeys) defineEnumerable(parts.clone, key, clonedComplex[key]);
  }
  return parts.clone;
}

/**
 * Clone one plain data object without serializing its scalar properties.
 * Complex properties are grouped into one bounded wrapper so aliases/cycles
 * between future unknown properties in that object remain intact.
 */
function cloneDataObject<T extends object>(source: T): T {
  return finishClone(partitionCloneProperties(source as StringKeyedRecord)) as T;
}

function cloneParamField(field: ParamFieldSymbol): ParamFieldSymbol {
  // Field values and metadata strings are immutable scalar values. Any future
  // complex field extension still gets the old deep-clone behavior.
  return cloneDataObject(field);
}

function cloneParamRow(row: ParamRowSymbol): ParamRowSymbol {
  const sourceRecord = row as unknown as StringKeyedRecord;
  const clone: StringKeyedRecord = {};
  const complex: StringKeyedRecord = Object.create(null) as StringKeyedRecord;
  const complexKeys: string[] = [];

  for (const key of Object.keys(sourceRecord)) {
    const value = sourceRecord[key];
    if (key === 'fields' && Array.isArray(value)) {
      // Always allocate a new array and field object for refresh isolation;
      // field scalar strings/numbers are copied directly.
      assignCloneProperty(clone, key, value.map((field) => cloneParamField(field as ParamFieldSymbol)));
    } else if (isClonePrimitive(value)) {
      assignCloneProperty(clone, key, value);
    } else {
      // This includes raw and unknown row extensions. A single wrapper keeps
      // raw-internal cycles and aliases between unknown properties intact.
      complex[key] = value;
      complexKeys.push(key);
    }
  }

  return finishClone({
    clone,
    complex,
    complexKeys
  }) as unknown as ParamRowSymbol;
}

/**
 * Clone one PARAM export without handing the complete row table to
 * structuredClone at once. Metadata and row scalar properties are copied as
 * data, fields are rebuilt as fresh arrays/objects, and raw/unknown mutable
 * properties retain the previous structured-clone semantics in bounded units.
 */
export function cloneParamExport(value: ParamExport): ParamExport {
  const sourceRecord = value as unknown as StringKeyedRecord;
  const parts = partitionCloneProperties(sourceRecord, 'rows');
  // `rows` is read once after the metadata snapshot.  This preserves the old
  // contract of materializing the required rows property even if a caller
  // supplies it as a non-enumerable accessor.
  const clone = finishClone(parts);
  defineEnumerable(clone, 'rows', value.rows.map(cloneParamRow));
  return clone as unknown as ParamExport;
}

/** Clone PARAM exports with no serializer input proportional to the full table. */
export function cloneParamExports(values: readonly ParamExport[]): ParamExport[] {
  const cloned: ParamExport[] = [];
  for (const value of values) cloned.push(cloneParamExport(value));
  return cloned;
}
