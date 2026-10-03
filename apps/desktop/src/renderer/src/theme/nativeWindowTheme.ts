import { getBridgeMethod } from '../runtime/rendererRuntime.js';
import type { NativeWindowThemeResult } from '../../../main/ipc/windowTheme.js';
import type { SpectralMode } from './themeConfig.js';

/** The renderer's selected mode is the authority; no second preference store. */
export async function syncNativeWindowTheme(mode: SpectralMode): Promise<NativeWindowThemeResult | null> {
  const setMode = getBridgeMethod('setWindowThemeMode');
  if (!setMode) return null;
  try {
    const result = await setMode(mode);
    if (!result.ok) console.warn('Native window theme unavailable:', result.code);
    return result;
  } catch {
    console.warn('Native window theme unavailable');
    return null;
  }
}
