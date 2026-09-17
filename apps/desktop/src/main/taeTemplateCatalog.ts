/**
 * First-party Sekiro TAE registry facade.
 *
 * Names and field layouts come from SoulForge's versioned schema package. The
 * main process never scans an animation editor installation, reads an XML
 * template, or accepts a template path from the environment. The Bridge owns
 * exact native field decoding; this facade is only the renderer-safe catalog
 * and a small compatibility projection for existing callers.
 */
import {
  FIRST_PARTY_TAE_SCHEMA,
  FIRST_PARTY_TAE_SCHEMA_METADATA,
  firstPartyTaeEventVariants,
  type FirstPartyTaeSchemaEvent,
  type FirstPartyTaeSchemaField
} from '@soulforge/core';

export type TaeParamFieldType = 'u8' | 's8' | 'b' | 'u16' | 's16' | 'u32' | 's32' | 's64' | 'f32';

export interface TaeParamFieldDef {
  name: string;
  type: TaeParamFieldType;
  offset: number;
  size: number;
  assert?: number;
  entries?: ReadonlyArray<{ value: number; name: string }>;
}

export interface TaeTemplateEventDef {
  eventTypeId: number;
  bankId: number;
  bankName: string;
  name: string;
  paramSize: number;
  fields: readonly TaeParamFieldDef[];
  variant?: boolean;
  variantOf?: number;
  variantKind?: string;
}

export interface TaeTemplateCatalog {
  origin: 'first-party';
  package: string;
  version: string;
  contentDigest: string;
  events: ReadonlyMap<number, TaeTemplateEventDef>;
  variants: ReadonlyMap<number, readonly TaeTemplateEventDef[]>;
  diagnostics: ReadonlyArray<{ severity: string; code: string; message: string }>;
}

function toEvent(event: FirstPartyTaeSchemaEvent): TaeTemplateEventDef {
  return {
    eventTypeId: event.id,
    bankId: event.bankId,
    bankName: event.bankName,
    name: event.name,
    paramSize: event.paramSize,
    fields: event.fields.map(toField),
    ...(event.variant ? { variant: true } : {}),
    ...(event.variantOf !== undefined ? { variantOf: event.variantOf } : {}),
    ...(event.variantKind ? { variantKind: event.variantKind } : {})
  };
}

function toField(field: FirstPartyTaeSchemaField): TaeParamFieldDef {
  return {
    name: field.name,
    type: field.type as TaeParamFieldType,
    offset: field.offset,
    size: field.size,
    ...(field.assert !== undefined ? { assert: field.assert } : {}),
    ...(field.enum ? { entries: field.enum } : {})
  };
}

let cachedCatalog: TaeTemplateCatalog | null = null;

export function getTaeTemplateCatalog(): TaeTemplateCatalog {
  if (cachedCatalog) return cachedCatalog;
  const variants = new Map<number, readonly TaeTemplateEventDef[]>();
  const events = new Map<number, TaeTemplateEventDef>();
  for (const bank of FIRST_PARTY_TAE_SCHEMA.banks) {
    for (const rawEvent of bank.events) {
      const event = toEvent({ ...rawEvent, bankId: bank.id, bankName: bank.name });
      const current = variants.get(event.eventTypeId) ?? [];
      variants.set(event.eventTypeId, [...current, event]);
      // Characters (bank 14) is the historical default for an unqualified
      // event id. Consumers that have an entry/bank identity use variants.
      const currentDefault = events.get(event.eventTypeId);
      if (!currentDefault
        || (event.bankId === 14 && currentDefault.bankId !== 14)
        || (event.bankId === currentDefault.bankId && event.paramSize > currentDefault.paramSize)) {
        events.set(event.eventTypeId, event);
      }
    }
  }
  cachedCatalog = {
    origin: 'first-party',
    package: FIRST_PARTY_TAE_SCHEMA_METADATA.package,
    version: FIRST_PARTY_TAE_SCHEMA_METADATA.version,
    contentDigest: FIRST_PARTY_TAE_SCHEMA_METADATA.contentDigest,
    events,
    variants,
    diagnostics: []
  };
  return cachedCatalog;
}

export function firstPartyTaeEventCatalog(eventTypeId: number): readonly TaeTemplateEventDef[] {
  return firstPartyTaeEventVariants(eventTypeId).map(toEvent);
}

export function taeEventTypeLabel(catalog: TaeTemplateCatalog, eventTypeId: number): string {
  return catalog.events.get(eventTypeId)?.name ?? '未命名';
}

/** Compatibility helper for non-production validation callers. */
export function decodeTaeParamFields(
  def: TaeTemplateEventDef | undefined,
  paramHex: string
): Array<{ name: string; type: TaeParamFieldType; value: string }> | null {
  if (!def || def.paramSize <= 0) return null;
  const bytes = Buffer.from(paramHex, 'hex');
  const out: Array<{ name: string; type: TaeParamFieldType; value: string }> = [];
  for (const field of def.fields) {
    if (field.offset + field.size > bytes.length) break;
    const raw = bytes.subarray(field.offset, field.offset + field.size);
    const value = readScalar(field.type, raw);
    const entry = field.entries?.find((item) => item.value === value);
    out.push({ name: field.name, type: field.type, value: entry?.name ?? String(value) });
  }
  return out;
}

function readScalar(type: TaeParamFieldType, raw: Buffer): number {
  switch (type) {
    case 'u8': case 'b': return raw[0] ?? 0;
    case 's8': return raw.readInt8(0);
    case 'u16': return raw.readUInt16LE(0);
    case 's16': return raw.readInt16LE(0);
    case 'u32': return raw.readUInt32LE(0);
    case 's32': return raw.readInt32LE(0);
    case 's64': return Number(raw.readBigInt64LE(0));
    case 'f32': return raw.readFloatLE(0);
  }
}
