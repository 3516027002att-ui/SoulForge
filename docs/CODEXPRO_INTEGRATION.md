# CodexPro 接入说明

CodexPro 在 SoulForge 中作为开发期 MCP 桥接工具使用，用来让 ChatGPT
Developer Mode 读取本地仓库、写入 handoff 计划、导出上下文，必要时辅助完成
小范围代码改动。它不是 SoulForge Electron 运行时的一部分，也不是模型代理或额度绕过工具。

## 当前接入

- 依赖：根目录 `devDependencies` 中的 `codexpro@0.28.5`。
- 上游核对：已检查 `rebel0789/codexpro` 的 GitHub `main`
  `f3558dc595d9b9c51d0ab73266fecbc9f837a9dd`。
- 版本说明：GitHub `main` 的 `package.json` 显示 `0.28.6`，但 npm 在接入时最新可安装版是
  `0.28.5`，因此项目锁定 npm 已发布版本。
- 上下文目录：`.ai-bridge/`。

## 常用命令

```powershell
npm run codexpro:doctor
npm run codexpro:setup
npm run codexpro:start
npm run codexpro:start:agent
npm run codexpro:start:handoff
npm run codexpro:pro-bundle
```

如果是在另一个聊天中只需要快速启动和连接步骤，优先看：

```text
docs/CODEXPRO_QUICKSTART.md
```

默认推荐：

```powershell
npm run codexpro:start
```

当前默认允许 ChatGPT 直接编辑 SoulForge 仓库代码。该模式允许 workspace 写入，
并启用 safe bash，但要求工具调用带上 session id：
`soulforge`。

如果某次任务只希望 ChatGPT 写计划、不直接改代码，使用：

```powershell
npm run codexpro:start:handoff
```

## ChatGPT Connector 设置

1. 启动 `npm run codexpro:start`。
2. 复制 CodexPro 输出的 ChatGPT Server URL。
3. 在 ChatGPT 中打开 `Settings -> Apps & Connectors -> Advanced settings`。
4. 开启 Developer Mode，然后创建 connector。
5. 粘贴 Server URL。
6. Authentication 选择 `No Authentication / None`。

Server URL 已包含 CodexPro token。不要把 token、Cloudflare token、ngrok token 或任何
`.env` 内容写入仓库。

## 安全边界

- 不在仓库内提交真实游戏资源、用户 mod 文件、token 或 tunnel 凭据。
- CodexPro 只负责开发期仓库桥接；它可以改 SoulForge 源码，但不绕过产品内
  Patch Engine 对用户 mod workspace 的写入设计。
- 对用户 mod workspace 的真实写入仍必须走 Patch Engine。
- 对不支持的二进制格式仍返回结构化 diagnostics，不能为了展示效果猜测解析结果。
- ChatGPT 生成的计划、diff、执行日志、pro-context 默认忽略，不作为稳定项目文档提交。

## 稳定 URL

默认 quick tunnel 每次重启 URL 都会变化，适合临时验证。如果需要长期复用同一个
ChatGPT App URL，在本机 CodexPro settings 中配置 ngrok dev domain 或 Cloudflare named tunnel。
这些设置属于本地机器状态，不提交到仓库。

## 已验证

- `npm view codexpro version versions --json`：确认 npm 最新可安装版本为 `0.28.5`。
- `npm install --save-dev codexpro@0.28.5`：安装成功，npm audit 报告 0 vulnerabilities。
- `npm exec -- codexpro --help`：CLI 可用。
- `npm run codexpro:doctor`：通过；当前仅提示未保存 workspace profile、未安装
  `cloudflared`，不影响后续由 `codexpro start` 自动安装或改用稳定 tunnel。
- `npm run typecheck`：通过。
- `npm run build`：通过。
- `npm run test`：通过；当前 workspace 没有实际 test 脚本输出。
