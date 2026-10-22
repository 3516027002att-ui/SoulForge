import opal from './presets/opal.json' with { type: 'json' };
import obsidian from './presets/obsidian.json' with { type: 'json' };

export type SpectralMode = 'opal' | 'obsidian';
export interface OklchColor { l: number; c: number; h: number }
export interface SpectralColor {
  id: string;
  label: string;
  oklch: OklchColor;
  srgbFallback: string;
  intensity: number;
  peakOpacity: number;
  fieldScale: number;
  phase: number[];
  measuredCoverage: number | null;
  effectiveShare: number | null;
}
export interface SpectralManifest {
  schemaVersion: string;
  mode: SpectralMode;
  label: string;
  preset: string;
  seed: number;
  overallColorIntensity: number;
  base: { oklch: OklchColor };
  colors: SpectralColor[];
  field: {
    scale: number; octaves: number; warpStrength: number; motionSpeed: number;
    staticTime: number; ditherStrength: number; luminanceCap?: number;
  };
  output: { colorSpace: string; reducedMotion: string };
}
interface ColorBudget { overall: number; colors: Record<string, number> }
export interface ThemePreferences {
  version: 1;
  mode: SpectralMode;
  budgets: Record<SpectralMode, ColorBudget>;
}

export const THEME_STORAGE_KEY = 'soulforge.ui.spectralTheme.v1';

/** Upstream liuguang-banlan-ui PR #1743, 8117e465; calibrated values stay data-only. */
export function presetForMode(mode: SpectralMode): SpectralManifest {
  return structuredClone((mode === 'obsidian' ? obsidian : opal) as SpectralManifest);
}

function defaultBudget(mode: SpectralMode): ColorBudget {
  const manifest = presetForMode(mode);
  return {
    overall: manifest.overallColorIntensity,
    colors: Object.fromEntries(manifest.colors.map((entry) => [entry.id, entry.intensity]))
  };
}

export function createThemePreferences(): ThemePreferences {
  return { version: 1, mode: 'opal', budgets: { opal: defaultBudget('opal'), obsidian: defaultBudget('obsidian') } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validIntensity(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function restoreThemePreferences(serialized: string | null): ThemePreferences {
  const defaults = createThemePreferences();
  if (serialized === null) return defaults;
  let saved: unknown;
  try { saved = JSON.parse(serialized); } catch { return defaults; }
  if (!isRecord(saved) || saved.version !== 1 || (saved.mode !== 'opal' && saved.mode !== 'obsidian')) return defaults;
  defaults.mode = saved.mode;
  const budgets = saved.budgets;
  if (!isRecord(budgets)) return defaults;
  for (const mode of ['opal', 'obsidian'] as const) {
    const budget = budgets[mode];
    if (!isRecord(budget)) continue;
    if (validIntensity(budget.overall)) defaults.budgets[mode].overall = budget.overall;
    const colors = budget.colors;
    if (!isRecord(colors)) continue;
    for (const id of Object.keys(defaults.budgets[mode].colors)) {
      const value = colors[id];
      if (validIntensity(value)) defaults.budgets[mode].colors[id] = value;
    }
  }
  return defaults;
}

export function manifestForPreferences(preferences: ThemePreferences): SpectralManifest {
  const manifest = presetForMode(preferences.mode);
  const budget = preferences.budgets[preferences.mode];
  manifest.overallColorIntensity = budget.overall;
  for (const entry of manifest.colors) entry.intensity = budget.colors[entry.id] ?? entry.intensity;
  return manifest;
}

export function updateThemeIntensity(preferences: ThemePreferences, mode: SpectralMode, id: string, value: number): ThemePreferences {
  if (!validIntensity(value) || (id !== 'overall' && !(id in preferences.budgets[mode].colors))) return preferences;
  const next = structuredClone(preferences);
  if (id === 'overall') next.budgets[mode].overall = value;
  else next.budgets[mode].colors[id] = value;
  return next;
}

export function resetThemeBudget(preferences: ThemePreferences): ThemePreferences {
  return { ...preferences, budgets: { ...preferences.budgets, [preferences.mode]: defaultBudget(preferences.mode) } };
}

export function readThemePreferences(): ThemePreferences {
  try { return restoreThemePreferences(window.localStorage.getItem(THEME_STORAGE_KEY)); }
  catch { return createThemePreferences(); }
}

export function applyThemeMode(mode: SpectralMode): void {
  document.documentElement.dataset.theme = mode === 'obsidian' ? 'dark' : 'light';
  document.documentElement.dataset.spectralMode = mode;
}
