export interface OwnedTemporaryDirectory {
  root: string;
  trackProcess(pid: number, options?: { processGroup?: boolean; uncertainTree?: boolean }): Promise<{ root: string; token: string }>;
  trackProcessGroup(group: number): Promise<{ root: string; token: string }>;
  dispose(): Promise<void>;
}
export function createOwnedTemporaryDirectory(owner: string, options?: { parent?: string }): Promise<OwnedTemporaryDirectory>;
export function initializeOwnedTemporaryDirectory(owner: string, root: string, options?: { ownerPid?: number; token?: string }): Promise<OwnedTemporaryDirectory>;
export function attachOwnedTemporaryDirectory(root: string): Promise<OwnedTemporaryDirectory>;
export function ownedTemporaryDirectoryIsIdle(root: string, owner: string, token?: string): Promise<boolean>;
export function ownedTemporaryDirectoryObserver(): string | null;
export function observeOwnedProcessGroup(pid: number): number | null;
export function recordOwnedProcess(ticket: { root: string; token: string }, pid: number, options?: { finished?: boolean }): void;
export function prepareOwnedWindowsJob(ticket: { root: string; token: string }, pid: number, id: string): void;
