import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const write = (path, content) => writeFile(new URL(path, root), content, 'utf8');

function replaceOnce(content, from, to, label) {
  const count = content.split(from).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  return content.replace(from, to);
}

async function patchAdapter() {
  const path = 'packages/core/src/runtime/me3RuntimeAdapter.ts';
  let text = await read(path);
  text = replaceOnce(
    text,
    "import type { WorkspaceSession } from '../workspace/workspaceSession.js';\n",
    "import type { WorkspaceSession } from '../workspace/workspaceSession.js';\nimport { probeMe3Executable } from './me3ExecutableProbe.js';\nimport { renderSekiroMe3Profile } from './me3Profile.js';\n",
    'adapter imports'
  );
  text = replaceOnce(
    text,
    '  terminateGraceMs?: number;\n  processHost?: RuntimeProcessHost;',
    '  terminateGraceMs?: number;\n  executableProbeTimeoutMs?: number;\n  processHost?: RuntimeProcessHost;',
    'adapter options'
  );
  text = replaceOnce(
    text,
    "const DEFAULT_TERMINATE_GRACE_MS = 5_000;\n",
    "const DEFAULT_TERMINATE_GRACE_MS = 5_000;\nconst DEFAULT_EXECUTABLE_PROBE_TIMEOUT_MS = 5_000;\n",
    'probe constant'
  );
  text = replaceOnce(
    text,
    '  private readonly terminateGraceMs: number;\n  private readonly processHost: RuntimeProcessHost;',
    '  private readonly terminateGraceMs: number;\n  private readonly executableProbeTimeoutMs: number;\n  private readonly processHost: RuntimeProcessHost;',
    'probe property'
  );
  text = replaceOnce(
    text,
    '    this.terminateGraceMs = Math.max(100, options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS);\n    this.processHost = options.processHost ?? createNodeRuntimeProcessHost();',
    '    this.terminateGraceMs = Math.max(100, options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS);\n    this.executableProbeTimeoutMs = Math.max(250, options.executableProbeTimeoutMs ?? DEFAULT_EXECUTABLE_PROBE_TIMEOUT_MS);\n    this.processHost = options.processHost ?? createNodeRuntimeProcessHost();',
    'probe constructor'
  );
  text = replaceOnce(
    text,
    `        const canonicalPath = await realpath(candidate);
        this.detectedExecutablePath = canonicalPath;
        return {
          adapterId: ADAPTER_ID,
          status: 'available',
          executablePath: canonicalPath,
          diagnostics: [{
            severity: 'info',
            code: 'ME3_EXECUTABLE_FOUND_UNVERIFIED',
            message: '已发现 me3 可执行文件；尚未执行真实 Sekiro 启动验证。',
            details: { executablePath: canonicalPath }
          }]
        };`,
    `        const canonicalPath = await realpath(candidate);
        const probe = await probeMe3Executable({
          processHost: this.processHost,
          command: canonicalPath,
          cwd: dirname(canonicalPath),
          env: this.environment,
          timeoutMs: this.executableProbeTimeoutMs,
          maxOutputBytes: Math.min(this.maxOutputBytes, 64 * 1024)
        });
        if (!probe.ok) {
          failures.push({ candidate, reason: probe.reason ?? 'me3 executable probe failed' });
          continue;
        }
        this.detectedExecutablePath = canonicalPath;
        return {
          adapterId: ADAPTER_ID,
          status: 'available',
          executablePath: canonicalPath,
          ...(probe.version ? { version: probe.version } : {}),
          diagnostics: [{
            severity: 'info',
            code: 'ME3_EXECUTABLE_IDENTITY_CONFIRMED',
            message: '已通过 `me3 info` 确认所选文件是可工作的 me3 CLI；尚未执行真实 Sekiro Mod 加载验证。',
            details: {
              executablePath: canonicalPath,
              ...(probe.version ? { version: probe.version } : {})
            }
          }]
        };`,
    'detect probe'
  );
  text = replaceOnce(
    text,
    '    const content = renderSekiroProfile(workspace.layers.overlayRoot, workspace.meta.workspaceId);',
    `    const content = renderSekiroMe3Profile({
      overlayRoot: workspace.layers.overlayRoot,
      packageId: \`soulforge-\${workspace.meta.workspaceId}\`
    });`,
    'profile renderer call'
  );
  text = replaceOnce(
    text,
    `function renderSekiroProfile(overlayRoot: string, workspaceId: string): string {
  const portableOverlayPath = resolve(overlayRoot).replaceAll('\\\\', '/');
  return [
    'profileVersion = "v1"',
    '',
    '[[supports]]',
    'game = "sekiro"',
    '',
    '[[packages]]',
    \`id = \${JSON.stringify(\`soulforge-\${workspaceId}\`)}\`,
    \`path = \${JSON.stringify(portableOverlayPath)}\`,
    ''
  ].join('\\n');
}

`,
    '',
    'remove obsolete profile renderer'
  );
  await write(path, text);
}

async function patchSmoke() {
  const path = 'packages/core/src/testing/runMe3RuntimeAdapterSmoke.ts';
  let text = await read(path);
  text = replaceOnce(
    text,
    "  environment: NodeJS.ProcessEnv = {};\n",
    "  environment: NodeJS.ProcessEnv = {};\n  identityOutput = 'me3 0.11.0';\n  identityExitCode = 0;\n",
    'fake host identity fields'
  );
  text = replaceOnce(
    text,
    `    this.environment = options.env;
    return handle;`,
    `    this.environment = options.env;
    if (args.length === 1 && args[0] === 'info') {
      queueMicrotask(() => {
        handle.emitStdout(this.identityOutput);
        handle.exit(this.identityExitCode);
      });
    }
    return handle;`,
    'fake info probe'
  );
  text = replaceOnce(
    text,
    "    assert.equal(capability.executablePath, canonicalExecutablePath);\n",
    "    assert.equal(capability.executablePath, canonicalExecutablePath);\n    assert.equal(capability.version, '0.11.0');\n    assert.deepEqual(processHost.args, ['info']);\n",
    'capability version assertion'
  );
  text = replaceOnce(
    text,
    '    assert.match(profileText, /path = /);',
    "    assert.match(profileText, /source = /);\n    assert.doesNotMatch(profileText, /^path = /m);",
    'source field assertion'
  );
  text = replaceOnce(text, '    const firstHandle = processHost.handles[0];', '    const firstHandle = processHost.handles[1];', 'first launch handle');
  text = replaceOnce(text, '    const secondHandle = processHost.handles[1];', '    const secondHandle = processHost.handles[2];', 'second launch handle');
  text = replaceOnce(
    text,
    `    const unsafeApplicationDataRoot = join(overlayRoot, 'unsafe-app-data');`,
    `    const wrongIdentityHost = new FakeProcessHost();
    wrongIdentityHost.identityOutput = 'unrelated executable 1.0.0';
    const wrongIdentityAdapter = new TrustedMe3RuntimeAdapter({
      applicationDataRoot,
      executablePath,
      processHost: wrongIdentityHost
    });
    const wrongIdentityCapability = await wrongIdentityAdapter.detect();
    assert.equal(wrongIdentityCapability.status, 'unavailable');
    assert.equal(
      wrongIdentityCapability.diagnostics.some((item) => item.code === 'ME3_EXECUTABLE_NOT_FOUND'),
      true
    );

    const unsafeApplicationDataRoot = join(overlayRoot, 'unsafe-app-data');`,
    'wrong identity test'
  );
  text = replaceOnce(
    text,
    "      pathDiscovery: 'disabled-at-public-boundary',\n",
    "      pathDiscovery: 'disabled-at-public-boundary',\n      executableIdentity: 'me3-info-confirmed',\n      profilePackageField: 'source',\n",
    'smoke summary'
  );
  await write(path, text);
}

async function patchExportsAndScripts() {
  const runtimeIndex = 'packages/core/src/runtime/index.ts';
  let text = await read(runtimeIndex);
  text = replaceOnce(
    text,
    "export * from './runtimeSessionManager.js';\n",
    "export * from './runtimeSessionManager.js';\nexport * from './me3Profile.js';\n",
    'runtime profile export'
  );
  await write(runtimeIndex, text);

  const corePackage = 'packages/core/package.json';
  text = await read(corePackage);
  text = replaceOnce(
    text,
    '    "test:runtime-session-manager": "tsc -b ../shared . && node dist/testing/runRuntimeSessionManagerSmoke.js",',
    '    "test:runtime-session-manager": "tsc -b ../shared . && node dist/testing/runRuntimeSessionManagerSmoke.js",\n    "test:private-me3-sekiro-gate": "tsc -b ../shared . && node dist/testing/runPrivateMe3SekiroRuntimeGate.js",',
    'core private gate script'
  );
  await write(corePackage, text);

  const rootPackage = 'package.json';
  text = await read(rootPackage);
  text = replaceOnce(
    text,
    '    "test:runtime-session-manager": "npm run test:runtime-session-manager -w @soulforge/core",',
    '    "test:runtime-session-manager": "npm run test:runtime-session-manager -w @soulforge/core",\n    "test:private-me3-sekiro-gate": "npm run test:private-me3-sekiro-gate -w @soulforge/core",',
    'root private gate script'
  );
  await write(rootPackage, text);
}

async function patchHandoff() {
  const path = 'docs/V0_5_IMPLEMENTATION_HANDOFF.md';
  let text = await read(path);
  text = replaceOnce(
    text,
    '- 公开 `TrustedMe3RuntimeAdapter`，强制由 Electron main 提供用户原生确认过的 me3 可执行路径，PATH 不参与启动 authority；',
    '- 公开 `TrustedMe3RuntimeAdapter`，强制由 Electron main 提供用户原生确认过的 me3 可执行路径，PATH 不参与启动 authority；所选文件还必须通过限时 `me3 info` 身份探测，普通 exe 不再能冒充 me3；',
    'handoff identity bullet'
  );
  text = replaceOnce(
    text,
    '- `.me3` profile 只写应用数据目录，按 workspace 稳定命名并支持重复更新；',
    '- `.me3` profile 只写应用数据目录，按 workspace 稳定命名并支持重复更新；package override 使用 me3 v1 schema 的 `source` 字段，不再误用 native DLL 的 `path` 字段；',
    'handoff profile bullet'
  );
  text = replaceOnce(
    text,
    '- 真实 me3 可执行文件与真实 Sekiro 启动证据；',
    '- 真实 me3 可执行文件与真实 Sekiro 启动证据；仓库已提供显式 opt-in 的 `test:private-me3-sekiro-gate`，但当前环境未执行；',
    'handoff private gate bullet'
  );
  text = replaceOnce(
    text,
    'npm run test:runtime-session-manager\n',
    'npm run test:runtime-session-manager\n# 仅在合法本地 me3 + Sekiro 环境显式运行：\n# $env:SOULFORGE_PRIVATE_RUNTIME_GATE="1"; npm run test:private-me3-sekiro-gate\n',
    'handoff commands'
  );
  text = replaceOnce(
    text,
    '### 2026-07-24：me3 desktop runtime、持久会话与 operation-linked 编排',
    `### 2026-07-24：me3 profile / executable authority 加固与私有真实运行门

- 路线：H-me3 / H-发行
- 状态变化：维持 \`partial / runtime unverified\`；修复会阻断真实加载的 profile schema 错误，并收紧 executable authority。
- 已实现：me3 v1 Sekiro profile 使用 \`[[packages]].source\`；新增独立 profile contract；所选 executable 必须通过限时 \`me3 info\` 身份探测并提取版本；新增显式 opt-in 私有 Sekiro runtime gate，观察后受控终止并只输出 process evidence。
- 已验证：公开 fake process smoke 覆盖 me3 0.11.0 identity、错误 executable 拒绝、profile source 字段、启动/终止和路径边界；最终 Windows CI 结果待本次候选更新。
- 未验证：本地仍无真实 me3 / Sekiro，因此私有 gate 未运行，游戏内资源 override 与崩溃证据仍为空。
- 非声明：\`me3 info\` 成功只证明 CLI identity；私有 gate 的零退出或运行态只属于 process evidence，不能自动证明 Mod 加载。

### 2026-07-24：me3 desktop runtime、持久会话与 operation-linked 编排`,
    'handoff evidence record'
  );
  await write(path, text);
}

await patchAdapter();
await patchSmoke();
await patchExportsAndScripts();
await patchHandoff();
console.log('me3 authority hardening migration applied');
