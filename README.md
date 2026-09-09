# SoulForge V0.9.0 源码 tag（Windows x64 预发行）

这是一个精简、可审计的源码快照。内部治理记录、交接材料、测试语料、日志、
凭据和本机游戏文件均未包含。

## 推荐使用完整 Release 源码包

优先下载 GitHub Release 中的 `SoulForge-v0.9.0-win-x64-source.zip`。完整包已
附带编译后的 `apps/desktop/out`、两个 workspace 的 `dist`、Electron SQLite
native binding、自包含 Bridge 和根目录 `SoulForge.exe`。

首次运行：在 Windows x64 安装 Node.js 24 与 npm 11，在根目录执行 `npm ci`，
再运行 `node node_modules/electron/install.js` 下载锁定的 Electron 43 运行时，
然后双击 `SoulForge.exe`。预构建完整包首次启动不需要 .NET SDK。

## GitHub 自动 Source code 归档

GitHub 的自动 Source code ZIP/tar.gz 只包含本 tag 的源码、配置、许可证、构建
脚本和根启动器，不包含完整 Release 源码包中的预编译 `dist`、`out`、SQLite
native binding 或自包含 Bridge。使用自动归档时，需 Node.js 24、npm 11，以及
`global.json` 所要求的 .NET 10 SDK；先运行 `npm ci` 和
`node node_modules/electron/install.js`，再运行 `npm run build` 与
`npm run exe:build`。SQLite 原生绑定重建可能还需要 Windows C++ 构建工具。

## 已知限制、反馈与依赖风险

本预发行版仅支持 Windows x64；后台分析退出协调仍有已知问题；大型 MAP 前台、
跨机器与真实游戏完整验收尚未完成，不作完整通过声明。

主动点击反馈会上传脱敏会话；发送前请先确认会话中没有敏感内容。

生产依赖扫描仍报告 2 项高危节点（`@huggingface/transformers` → `sharp` 依赖链，
对应 GHSA-f88m-g3jw-g9cj 与 GHSA-rgj7-g3m4-5g8c）；本预发行版尚未修复，
请避免处理不可信输入。
