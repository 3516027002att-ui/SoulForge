import { setTimeout } from 'node:timers/promises';
import { createOwnedTemporaryDirectory } from './owned-temporary-directory.mjs';

/** Keep Electron's process handles with its test-owned profile through teardown. */
export async function createElectronTestResources(owner, options) {
  const directory = await createOwnedTemporaryDirectory(`e2e-${owner}`, options);
  const applications = new Map();
  return {
    root: directory.root,
    async registerApp(app) {
      const child = app.process();
      applications.set(app, child);
      await directory.trackProcess(child.pid);
    },
    async dispose() {
      for (const [app, child] of applications) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        let closeError;
        try { await app.close(); } catch (error) { closeError = error; }
        const deadline = Date.now() + 5_000;
        while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await setTimeout(50);
        if (closeError && child.exitCode === null && child.signalCode === null) throw closeError;
      }
      // A final removal failure is visible. The marked root remains recoverable
      // by the next run once every registered process has exited.
      await directory.dispose();
    }
  };
}
