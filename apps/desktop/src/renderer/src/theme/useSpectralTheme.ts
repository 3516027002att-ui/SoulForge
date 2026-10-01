import { useEffect, useMemo, useState } from 'react';
import {
  THEME_STORAGE_KEY, applyThemeMode, manifestForPreferences, readThemePreferences,
  resetThemeBudget, updateThemeIntensity, type SpectralMode
} from './themeConfig.js';
import { syncNativeWindowTheme } from './nativeWindowTheme.js';

export function useSpectralTheme() {
  const [preferences, setPreferences] = useState(readThemePreferences);
  const manifest = useMemo(() => manifestForPreferences(preferences), [preferences]);
  useEffect(() => {
    applyThemeMode(preferences.mode);
    try { window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(preferences)); } catch { /* Storage may be disabled. */ }
  }, [preferences]);
  useEffect(() => { void syncNativeWindowTheme(preferences.mode); }, [preferences.mode]);
  return {
    manifest,
    setMode: (mode: SpectralMode): void => { setPreferences((current) => ({ ...current, mode })); },
    setIntensity: (id: string, value: number): void => {
      setPreferences((current) => updateThemeIntensity(current, current.mode, id, value));
    },
    reset: (): void => { setPreferences(resetThemeBudget); }
  };
}
