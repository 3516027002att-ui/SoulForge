import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const here = dirname(fileURLToPath(import.meta.url));
const includeDatabaseUtilitySmoke = process.env.SOULFORGE_BUILD_DATABASE_UTILITY_SMOKE === '1';
const includeMe3RuntimeGatewaySmoke = process.env.SOULFORGE_BUILD_ME3_GATEWAY_SMOKE === '1';
const includeMe3SekiroSessionSmoke = process.env.SOULFORGE_BUILD_ME3_SEKIRO_SESSION_SMOKE === '1';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(here, 'src/main/index.ts'),
          databaseUtility: resolve(here, 'src/main/databaseUtility.ts'),
          ...(includeDatabaseUtilitySmoke
            ? { databaseUtilitySmoke: resolve(here, 'src/main/databaseUtilitySmoke.ts') }
            : {}),
          ...(includeMe3RuntimeGatewaySmoke
            ? { me3RuntimeGatewaySmoke: resolve(here, 'src/main/me3RuntimeGatewaySmoke.ts') }
            : {}),
          ...(includeMe3SekiroSessionSmoke
            ? { me3SekiroSessionSmoke: resolve(here, 'src/main/me3SekiroSessionSmoke.ts') }
            : {})
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: resolve(here, 'src/renderer'),
    plugins: [react()]
  }
});
