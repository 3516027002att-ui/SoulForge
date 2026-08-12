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
    plugins: [externalizeDepsPlugin({ exclude: ['@soulforge/shared'] })],
    // @soulforge/shared 必须打进 bundle 而不是 external：
    // DOCSTORE-04 起 preload 运行时引用 EDITOR_DOCUMENT_IPC_CHANNELS（§14.4
    // 契约的通道权威），external 化后产物是 require('@soulforge/shared')，
    // 而 sandbox: true 的 preload 没有 node_modules 解析能力，报
    // "module not found: @soulforge/shared"，window.soulforge 完全不注入
    // （production-main e2e 实测抓到）。rollup 会把 shared 的 ESM 转成 CJS。
    // @soulforge/core 在 preload 里只有 type import，保持 external。
    //
    // preload 必须产出 CommonJS（.js），不能跟随本包的 "type": "module" 产出 ESM。
    //
    // 原因：生产窗口用 sandbox: true（这是被 verify-desktop-security-runtime.mjs:113
    // 运行期断言的安全要求，不能为了打包方便改掉），而 Electron 的 sandboxed
    // preload **不支持 ESM** —— 加载 .mjs 会报
    // "SyntaxError: Cannot use import statement outside a module"，
    // 于是 contextBridge 完全不执行，window.soulforge 不存在，所有 IPC 功能失效。
    //
    // 这个组合此前没被任何验证覆盖：e2e 的 fixture-main.mjs:313 用 sandbox: false
    // 且指向 index.mjs，两处都与生产不同，所以 16/16 全绿而真实启动是坏的。
    // 扩展名必须是 .cjs 而不是 .js：本包 package.json 声明 "type": "module"，
    // 因此 .js 会被 Node/Electron 当作 ESM 解析，CJS 内容会报
    // "require is not defined in ES module scope"。.cjs 显式脱离该声明。
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    root: resolve(here, 'src/renderer'),
    plugins: [react()]
  }
});
