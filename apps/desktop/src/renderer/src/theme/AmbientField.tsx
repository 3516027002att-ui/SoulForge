import { useEffect, useRef, type ReactElement } from 'react';
import { createSpectralField, type SpectralFieldHandle } from './spectralField.js';
import type { SpectralManifest } from './themeConfig.js';

/** The shared opal/obsidian environmental field never owns workbench layout. */
export function AmbientField({ manifest }: { manifest: SpectralManifest }): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fieldRef = useRef<SpectralFieldHandle | null>(null);
  const initialRef = useRef(manifest);
  useEffect(() => {
    if (!canvasRef.current) return;
    const field = createSpectralField(canvasRef.current, initialRef.current);
    fieldRef.current = field;
    return () => { field.dispose(); fieldRef.current = null; };
  }, []);
  useEffect(() => { fieldRef.current?.update(manifest); }, [manifest]);
  return <canvas id="sf-ambient-field" ref={canvasRef} className="sf-ambient-field"
    aria-hidden="true" data-testid="sf-ambient-field" />;
}
