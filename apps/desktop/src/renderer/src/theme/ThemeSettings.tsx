import { useState, type ReactElement } from 'react';
import type { SpectralManifest, SpectralMode } from './themeConfig.js';

interface ThemeSettingsProps {
  manifest: SpectralManifest;
  onModeChange: (mode: SpectralMode) => void;
  onIntensityChange: (id: string, value: number) => void;
  onReset: () => void;
}

export function ThemeSettings({ manifest, onModeChange, onIntensityChange, onReset }: ThemeSettingsProps): ReactElement {
  const [copyFallback, setCopyFallback] = useState(false);
  const [notice, setNotice] = useState('');
  const serialized = JSON.stringify(manifest, null, 2);

  async function copy(): Promise<void> {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(serialized);
      setCopyFallback(false); setNotice('参数已复制');
    } catch {
      setCopyFallback(true); setNotice('复制不可用，可在下方选中参数后手动复制');
    }
  }

  function exportJson(): void {
    const url = URL.createObjectURL(new Blob([`${serialized}\n`], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = `${manifest.mode}-theme.json`;
    document.body.append(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice('参数已导出');
  }

  return (
    <section className="theme-settings" aria-label="界面主题" data-testid="theme-settings">
      <div className="setting-row">
        <label className="setting-name" htmlFor="spectral-theme-mode">界面主题</label>
        <select id="spectral-theme-mode" value={manifest.mode} onChange={(event) => {
          const mode = event.currentTarget.value;
          if (mode === 'opal' || mode === 'obsidian') onModeChange(mode);
          setNotice(''); setCopyFallback(false);
        }}>
          <option value="opal">流光溢彩白</option>
          <option value="obsidian">五彩斑斓黑</option>
        </select>
      </div>
      <details className="theme-parameters" onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        const details = event.currentTarget;
        details.open = false;
        details.querySelector('summary')?.focus();
      }}>
        <summary>主题参数</summary>
        <div className="theme-parameters__body">
          <label className="theme-slider">
            <span>总体彩色强度 <output>{manifest.overallColorIntensity.toFixed(2)}</output></span>
            <input type="range" aria-label="总体彩色强度" min="0" max="1" step="0.01"
              value={manifest.overallColorIntensity}
              onChange={(event) => onIntensityChange('overall', Number(event.currentTarget.value))} />
          </label>
          {manifest.colors.map((entry) => (
            <label className="theme-slider" key={entry.id}>
              <span>{entry.label} <output>{entry.intensity.toFixed(2)}</output></span>
              <input type="range" aria-label={`${entry.label}强度`} min="0" max="1" step="0.01"
                value={entry.intensity} onChange={(event) => onIntensityChange(entry.id, Number(event.currentTarget.value))} />
            </label>
          ))}
          <div className="theme-parameters__actions">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => {
              onReset(); setNotice('已恢复当前主题预设'); setCopyFallback(false);
            }}>恢复预设</button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={exportJson}>导出 JSON</button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void copy()}>复制参数</button>
          </div>
          <p className="setting-desc" role="status">{notice}</p>
          {copyFallback && <textarea className="theme-parameters__json" aria-label="可手动复制的主题参数"
            value={serialized} readOnly onFocus={(event) => event.currentTarget.select()} />}
        </div>
      </details>
    </section>
  );
}
