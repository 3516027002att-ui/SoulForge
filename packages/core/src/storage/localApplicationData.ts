import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

/** Persistent per-user data, independent from Electron and the Mod workspace. */
export function localApplicationDataDirectory(input: {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
} = {}): string {
  const platform = input.platform ?? process.platform;
  const home = input.home ?? homedir();
  const env = input.env ?? process.env;
  if (platform === 'win32') return env.LOCALAPPDATA ?? win32.join(home, 'AppData', 'Local');
  if (platform === 'darwin') return posix.join(home, 'Library', 'Application Support');
  // The XDG specification requires absolute paths; relative values are unset.
  return env.XDG_DATA_HOME && posix.isAbsolute(env.XDG_DATA_HOME)
    ? env.XDG_DATA_HOME : posix.join(home, '.local', 'share');
}
