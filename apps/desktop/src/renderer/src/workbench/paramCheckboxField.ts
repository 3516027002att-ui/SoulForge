import type { ParamFieldDef } from '@soulforge/shared';

/** bool 整字段，或 1bit 位域：FIELDS 画勾，点一下就写。s32/f32 不要勾。 */
export function isParamCheckboxField(field: Pick<ParamFieldDef, 'type' | 'bitfield'>): boolean {
  return field.type === 'bool' || field.bitfield?.bitWidth === 1;
}

export function isParamCheckboxChecked(display: string): boolean {
  const normalized = display.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}
