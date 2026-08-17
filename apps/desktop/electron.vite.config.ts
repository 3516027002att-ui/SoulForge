import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const here = dirname(fileURLToPath(import.meta.url));
const includeDatabaseUtilitySmoke = process.env.SOULFORGE_BUILD_DATABASE_UTILITY_SMOKE === '1';
const includeMe3RuntimeGatewaySmoke = process.env.SOULFORGE_BUILD_ME3_GATEWAY_SMOKE === '1';
const includeMe3SekiroSessionSmoke = process.env.SOULFORGE_BUILD_ME3_SEKIRO_SESSION_SMOKE === '1';

/**
 * workspace 包解析固定到本仓库的 packages（相对路径，git worktree 与主仓库
 * checkout 都成立）：node_modules 里的 @soulforge/* 链接可能指向另一个
 * checkout 的 dist，新导出会被旧 dist 挡住（worktree 实测）。
 */
const workspacePackageAlias = {
  '@soulforge/shared': resolve(here, '../../packages/shared'),
  '@soulforge/core': resolve(here, '../../packages/core')
};

export default defineConfig({
  main: {
    // @soulforge/shared/core 打进 bundle（排除 external）：external 化后运行期
    // require 解析到 node_modules 链接的 dist（worktree 下可能是别的 checkout），
    // alias + exclude 让构建与运行都走本仓库 packages。
    plugins: [externalizeDepsPlugin({ exclude: ['@soulforge/shared', '@soulforge/core'] })],
    resolve: { alias: workspacePackageAlias },
    build: {
      // core 打进 bundle 后其 sqlite 绑定是运行期动态 require（.native 路径），
      // 让 commonjs 插件原样保留而不是试图解析目标。
      commonjsOptions: { ignoreDynamicRequires: true },
      rollupOptions: {
        input: {
          index: resolve(here, 'src/main/index.ts'),
          emevdDarkScriptWorker: resolve(here, 'src/main/emevdDarkScriptWorker.ts'),
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
    resolve: { alias: workspacePackageAlias },
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
    resolve: {
      alias: {
        ...workspacePackageAlias,
        // core 的 EMEVD DSL 模块顶层 import node:crypto（浏览器没有）；renderer
        // 只调用其中的纯解析（parseDarkScriptCall），见 runtime/nodeCryptoShim.ts。
        'node:crypto': resolve(here, 'src/renderer/src/runtime/nodeCryptoShim.ts')
      }
    },
    plugins: [react()]
  }
});
