import { readFile } from 'node:fs/promises';

const files = {
  main: await readFile(new URL('../apps/desktop/src/main/index.ts', import.meta.url), 'utf8'),
  ipc: await readFile(new URL('../apps/desktop/src/main/ipc.ts', import.meta.url), 'utf8'),
  runtimeIpc: await readFile(new URL('../apps/desktop/src/main/runtimeIpc.ts', import.meta.url), 'utf8'),
  runtimeController: await readFile(
    new URL('../apps/desktop/src/main/runtimeController.ts', import.meta.url),
    'utf8'
  ),
  runtimeVerification: await readFile(
    new URL('../packages/core/src/runtime/runtimeVerification.ts', import.meta.url),
    'utf8'
  ),
  runtimeRepositories: await readFile(
    new URL('../packages/core/src/storage/runtimeRepositories.ts', import.meta.url),
    'utf8'
  ),
  preload: await readFile(new URL('../apps/desktop/src/preload/index.ts', import.meta.url), 'utf8'),
  rendererHtml: await readFile(new URL('../apps/desktop/src/renderer/index.html', import.meta.url), 'utf8'),
  rendererDto: await readFile(new URL('../apps/desktop/src/main/rendererDto.ts', import.meta.url), 'utf8'),
  databaseUtility: await readFile(new URL('../apps/desktop/src/main/databaseUtility.ts', import.meta.url), 'utf8'),
  operationLogUtilityClient: await readFile(
    new URL('../apps/desktop/src/main/operationLogUtilityClient.ts', import.meta.url),
    'utf8'
  )
};

const verificationInsert = files.runtimeRepositories.match(
  /INSERT INTO runtime_verification_evidence[\s\S]{0,500}/
)?.[0] ?? '';

const checks = [
  ['Electron 沙箱已开启', files.main.includes('sandbox: true')],
  ['上下文隔离已开启', files.main.includes('contextIsolation: true')],
  ['Node 集成已关闭', files.main.includes('nodeIntegration: false')],
  ['新窗口被拒绝', files.main.includes("setWindowOpenHandler(() => ({ action: 'deny' }))")],
  ['页面导航被拒绝', files.main.includes("on('will-navigate'")],
  ['生产环境忽略开发渲染地址', files.main.includes('app.isPackaged')
    && files.main.includes('resolveDevelopmentRendererUrl')],
  ['开发渲染地址仅允许回环主机', files.main.includes("url.hostname === 'localhost'")
    && files.main.includes("url.hostname === '127.0.0.1'")
    && files.main.includes("url.hostname === '[::1]'")],
  ['权限请求默认拒绝', files.main.includes('setPermissionRequestHandler')],
  ['CSP 已声明', files.rendererHtml.includes('Content-Security-Policy')],
  ['IPC 统一校验发送方', files.ipc.includes('assertTrustedSender(event, channel)')],
  ['IPC 校验主文档地址', files.ipc.includes('trustedRendererDocuments')
    && files.ipc.includes('actualDocument !== expectedDocument')],
  ['Runtime IPC 独立校验发送方', files.runtimeIpc.includes('assertTrustedSender(event, channel)')
    && files.runtimeIpc.includes('actualDocument !== expectedDocument')],
  ['目录选择使用一次性凭据', files.ipc.includes('consumeDirectorySelection')],
  ['渲染进程不能创建确认凭据', !files.preload.includes('createConfirmation')],
  ['渲染进程不能传入确认凭据', !files.preload.includes('ConfirmationReceipt')],
  ['渲染进程不能传入工作区绝对路径', !files.preload.includes('workspaceRoot')],
  ['me3 路径只能由 main 原生选择器取得', files.runtimeIpc.includes('dialog.showOpenDialog')
    && files.runtimeIpc.includes("'runtime.chooseMe3Executable'")
    && !files.preload.includes('executablePath')],
  ['渲染进程不能传入 runtime profile 路径', !files.preload.includes('profilePath')],
  ['Runtime DTO 删除 executable path', files.rendererDto.includes("'executablePath'")],
  ['Runtime DTO 删除 profile path', files.rendererDto.includes("'profilePath'")],
  ['Runtime 工作区切换先终止活动会话', files.runtimeIpc.includes('terminateActiveForWorkspaceChange')
    && files.runtimeController.includes('activeSessionIds()')],
  ['Runtime 提交验证绑定持久 operation', files.runtimeController.includes('requireCommittedOperation')
    && files.runtimeController.includes("verificationKind: 'post_commit'")],
  ['Runtime 回滚验证校验 inverse relation', files.runtimeController.includes('inverse.inverseOfOpId !== originalOperationId')
    && files.runtimeController.includes("verificationKind: 'post_rollback'")],
  ['Runtime 人工证据 verdict 在 main 校验', files.runtimeIpc.includes('assertRuntimeVerdict(verdict)')
    && files.runtimeIpc.includes('isRuntimeOperatorVerdict')],
  ['Runtime 证据 id 与时间由 main 生成', files.runtimeController.includes('evidenceIdFactory()')
    && files.runtimeController.includes('createdAt: this.now().toISOString()')
    && !files.preload.includes('evidenceId')],
  ['Runtime 人工证据追加写而非覆盖', verificationInsert.includes('VALUES (?, ?, ?, ?, ?, ?, ?)')
    && !verificationInsert.includes('ON CONFLICT')],
  ['Runtime 进程成功不会自动宣称游戏加载', files.runtimeVerification.includes('gameLoadAutomaticallyVerified: false')
    && files.rendererDto.includes('gameLoadAutomaticallyVerified: false')],
  ['渲染进程不能决定 AI 权限模式', !files.preload.includes("ToolContext['mode']")
    && files.ipc.includes("const activeAiMode: ToolContext['mode'] = 'plan'")],
  ['渲染 DTO 删除绝对路径', files.rendererDto.includes("'absolutePath'")],
  ['渲染 DTO 删除源路径', files.rendererDto.includes("'sourcePath'")],
  ['渲染 DTO 脱敏字符串中的绝对路径', files.rendererDto.includes('sanitizeRendererString(item.message)')
    && files.rendererDto.includes('containsWindowsDrivePath')
    && files.rendererDto.includes('containsUncOrDevicePath')],
  ['旧确认 IPC 已删除', !files.ipc.includes("'resource.createConfirmation'")],
  ['main 确认绑定资源与风险', files.ipc.includes('input.sourceUri')
    && files.ipc.includes("'ALL_RISKS'")],
  ['生产操作日志不再打开 JSON store', !files.ipc.includes('openFileOperationLogStore')],
  ['SQLite 运行在 Electron utility process', files.operationLogUtilityClient.includes('utilityProcess.fork')],
  ['app.db 与 workspace.db 由后台进程打开', files.databaseUtility.includes('openAppDatabase')
    && files.databaseUtility.includes('openSqliteOperationLogStore')],
  ['Runtime settings/session 由数据库后台进程持有', files.databaseUtility.includes('RuntimeAdapterSettingsRepository')
    && files.databaseUtility.includes('RuntimeLaunchSessionRepository')],
  ['Runtime verification evidence 由数据库后台进程持有', files.databaseUtility.includes('RuntimeVerificationEvidenceRepository')
    && files.databaseUtility.includes('appendRuntimeVerificationEvidence')],
  ['Runtime 在数据库 utility 关闭前释放', files.main.indexOf('disposeRuntimeIpc()')
    < files.main.indexOf('disposeOperationLogUtility()')]
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length > 0) {
  console.error(JSON.stringify({
    ok: false,
    failed: failed.map(([name]) => name)
  }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    ok: true,
    message: '桌面安全静态门禁通过',
    checks: checks.map(([name]) => name)
  }, null, 2));
}
