/**
 * SoulForge Hotpath Forensics — minimal runtime trace helper (V1).
 *
 * 纯诊断：不改变业务结果，不做架构重构，不引入大型 logging framework。
 * 每条事件为单行 JSON，schema 与 mission2.9 规定的 SOULFORGE_HOTPATH_FORENSICS_V1 一致。
 * 复用已有 diagnostics/telemetry/correlationId 基础设施，仅增加轻量计数与计时。
 */

export type ForensicsFlow = 'param' | 'map' | 'action' | 'rollback';
export type ForensicsLayer = 'renderer' | 'preload' | 'main' | 'bridge' | 'native' | 'authority' | 'ui';
export type ForensicsResult = 'ok' | 'empty' | 'error' | 'fallback';

export interface ForensicsEvent {
  schema: 'SOULFORGE_HOTPATH_FORENSICS_V1';
  traceId: string;
  flow: ForensicsFlow;
  layer: ForensicsLayer;
  stage: string;
  op: string;
  resource: string;
  ts: number;
  durationMs: number;
  metrics: Record<string, number | string | boolean | null>;
  result: ForensicsResult;
  errorCode: string | null;
}

const counters = new Map<string, number>();
const events: ForensicsEvent[] = [];

export function forensicsTraceId(flow: ForensicsFlow): string {
  return `${flow}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function forensicsEmit(event: ForensicsEvent): void {
  events.push(event);
  const key = `${event.flow}:${event.layer}:${event.stage}:${event.op}`;
  counters.set(key, (counters.get(key) ?? 0) + 1);
  if (typeof process !== 'undefined' && process.env.SOULFORGE_FORENSICS_LOG === '1') {
    try { console.log(JSON.stringify(event)); } catch { /* ignore */ }
  }
}

export function forensicsCount(key: string): number {
  return counters.get(key) ?? 0;
}

export function forensicsSnapshot(): { counters: Record<string, number>; events: ForensicsEvent[] } {
  return { counters: Object.fromEntries(counters), events: [...events] };
}

export function forensicsReset(): void {
  counters.clear();
  events.length = 0;
}

export function forensicsCounterInc(key: string, delta = 1): number {
  const next = (counters.get(key) ?? 0) + delta;
  counters.set(key, next);
  return next;
}
