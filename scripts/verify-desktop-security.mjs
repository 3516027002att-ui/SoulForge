import { readFile } from 'node:fs/promises';

const files = {
  main: await readFile(new URL('../apps/desktop/src/main/index.ts', import.meta.url), 'utf8'),
  ipc: await readFile(new URL('../apps/desktop/src/main/ipc.ts', import.meta.url), 'utf8'),
  preload: await readFile(new URL('../apps/desktop/src/preload/index.ts', import.meta.url), 'utf8'),
  rendererHtml: await readFile(new URL('../apps/desktop/src/renderer/index.html', import.meta.url), 'utf8'),
  rendererDto: await readFile(new URL('../apps/desktop/src/main/rendererDto.ts', import.meta.url), 'utf8'),
  databaseUtility: await readFile(new URL('../apps/desktop/src/main/databaseUtility.ts', import.meta.url), 'utf8'),
  operationLogUtilityClient: await readFile(
    new URL('../apps/desktop/src/main/operationLogUtilityClient.ts', import.meta.url),
    'utf8'
  )
};

const runModelServiceContract = files.preload.match(
  /runModelService:\s*\(input:\s*\{([^}]*)\}\)\s*:[^\r\n]+=>/
)?.[1] ?? '';

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
  ['目录选择使用一次性凭据', files.ipc.includes('consumeDirectorySelection')],
  ['渲染进程不能创建确认凭据', !files.preload.includes('createConfirmation')],
  ['渲染进程不能传入确认凭据', !files.preload.includes('ConfirmationReceipt')],
  ['渲染进程不能传入工作区绝对路径', !files.preload.includes('workspaceRoot')],
  ['渲染进程不能决定 AI 权限模式', runModelServiceContract.length > 0
    && !runModelServiceContract.includes('permissionMode')
    && files.ipc.includes('resolveAiModeForService')
    && files.ipc.includes('mode: activeMode')],
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
  ['AI 权限模式由 main 从 grant 解析', files.ipc.includes('resolveAiModeForService')
    && /handle\(\s*['"]permissionGrant\.replace['"]/.test(files.ipc)
    && files.ipc.includes('requestMainNativeConfirmation')],
  ['preload 暴露 grant 生命周期但不暴露 resolveApiKey', files.preload.includes('replacePermissionGrant')
    && files.preload.includes('getResolvedPermissionMode')
    && files.preload.includes('revokePermissionGrant')
    && !files.preload.includes('resolveApiKey')]
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
