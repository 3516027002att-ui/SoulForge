/**
 * One revision function for every evidence projection.
 *
 * A content hash is authoritative when available.  The mtime/size fallback
 * is intentionally deterministic and is used only when the scanner has not
 * computed a hash yet; callers must not treat it as native-content proof.
 */
export interface SourceRevisionFile {
  sourceUri: string;
  sha256?: string;
  mtimeMs: number;
  size?: number;
}

export function sourceRevisionForFile(file: SourceRevisionFile): string {
  return file.sha256 ?? `${file.mtimeMs}:${file.size ?? ''}`;
}

export function sourceRevisionForFiles(files: readonly SourceRevisionFile[]): string | undefined {
  if (files.length === 0) return undefined;
  return files
    .map((file) => `${file.sourceUri}:${sourceRevisionForFile(file)}`)
    .sort()
    .join('|');
}
