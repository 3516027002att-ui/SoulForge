import { appendFileSync } from 'node:fs';

/** Temporary, opt-in startup markers for the owned CI smoke profile. No payloads. */
export function traceDatabaseSmokeStartup(stage: string): void {
  const path = process.env.SOULFORGE_DATABASE_SMOKE_STAGE_FILE;
  if (!path) return;
  try {
    appendFileSync(path, `${JSON.stringify({ pid: process.pid,
      role: process.env.SOULFORGE_DATABASE_ROLE ?? 'main', stage })}\n`);
  } catch { /* Diagnostic output must not change database behavior. */ }
}
