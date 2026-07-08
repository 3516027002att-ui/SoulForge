# 本地验证队列

这个文件专门记录“代码已经推进，但当前 CodexPro 运行壳无法稳定验证”的项目。它的作用是防止验证缺口阻塞开发，同时避免把未验证项误标成完成。

## 原则

- 不因为当前壳环境跑不动 dotnet / Rollup optional dependency 就停止推进纯逻辑接线。
- 未验证项不能在里程碑、README、最终汇报里写成“已完全通过”。
- 每一项都必须保留命令、预期 diagnostic / 输出、当前阻塞原因和完成条件。
- 真实游戏资源和用户 Mod 文件不能提交为 fixture；只允许脚本生成 synthetic fixture。

## 2026-07-07 本地验证结果

本轮在 Windows PowerShell 环境完成了队列内验证，旧的 CodexPro / WSL 阻塞没有在当前壳复现。

实际执行命令：

```powershell
npm run typecheck
npm test
npm run test:native-preview
npm run bridge:build
npm run bridge:verify:synthetic
npm run build
```

结果：

- `npm run typecheck` 退出码 0。
- `npm test` 退出码 0；扫描 `D:\Repository\SoulForge\mods` 共 237 个文件，`scanDiagnostics = 0`，`failedPreviews = []`。
- `npm run test:native-preview` 退出码 0；抽样 24 个文件，`nativeInspections = 23`，`failures = []`，`bridgeUnavailable = false`。
- `npm run bridge:build` 退出码 0；`dotnet build` 结果为 0 warning / 0 error。
- `npm run bridge:verify:synthetic` 退出码 0；输出 `synthetic core fixtures: ok`。脚本断言覆盖 MSG、EMEVD、PARAM、MSB、BND child table、DCX payload boundary、DFLT decompressed preview、nested BND child table。
- `npm run build` 退出码 0；shared、core、desktop production build 均完成。

## 队列

### 1. Bridge synthetic core + DCX smoke

状态：已验证（2026-07-07，Windows PowerShell）。

命令：

```powershell
npm run bridge:build
npm run bridge:verify:synthetic
```

预期：

- `MSG_FMG_SYNTHETIC_FIXTURE_CONFIRMED`
- `EMEVD_SYNTHETIC_FIXTURE_CONFIRMED`
- `PARAM_SYNTHETIC_FIXTURE_CONFIRMED`
- `MSB_SYNTHETIC_FIXTURE_CONFIRMED`
- `BND_SYNTHETIC_FIXTURE_CONFIRMED`
- `DCX_PAYLOAD_BOUNDARY_CONFIRMED`
- `DCX_DFLT_DECOMPRESSED_PREVIEW_READY`
- `DCX_DFLT_NESTED_BND_CHILD_TABLE_FOUND`

历史 CodexPro 阻塞：

- WSL 侧没有可用 Linux `dotnet`。
- Windows `dotnet.exe` 从 WSL 入口执行时出现 NuGet / path 环境异常。
- 因此当时不能在 CodexPro 壳里把 Bridge smoke 标成已通过。

本次结果：

- `npm run bridge:build` 已通过，0 warning / 0 error。
- `npm run bridge:verify:synthetic` 已通过，输出 `synthetic core fixtures: ok`。

完成条件（已满足）：

- 在正常 Windows 终端或修复后的 CodexPro/full bash 环境中，上述命令退出码为 0。
- 失败时只修最小编译/fixture 问题，不扩大到 native parser 重写。

### 2. Desktop production build

状态：已验证（2026-07-07，Windows PowerShell）。

命令：

```bash
npm run build
```

历史 CodexPro 阻塞（本次未复现）：

- `npm run build` 在 `electron-vite build` 阶段失败于 Rollup optional dependency 缺失：`@rollup/rollup-linux-x64-gnu`。
- 这通常来自跨平台 / optional dependency 安装状态，不是本轮 TypeScript 类型错误。

本次结果：

- `npm run build` 已通过，shared、core、desktop production build 均完成。

完成条件（已满足）：

- 刷新 `node_modules` / `package-lock.json` 对应安装状态后，`npm run build` 退出码为 0。

### 3. BND synthetic child inventory inspect

状态：已验证（2026-07-07，Windows PowerShell）。

验证命令：

```powershell
npm run bridge:build
npm run bridge:verify:synthetic
```

需要补充 / 确认的预期：

- synthetic BND fixture 通过 `inspect` 返回 `BND_SYNTHETIC_FIXTURE_CONFIRMED`。
- `data.evidence` 包含 `binderChildTable`。
- child inventory 至少包含 `id`、`name`、`resourceKind`、`offset`、`packedSize`、`unpackedSize`。
- visible-string `binderChildCandidate` fallback 不被移除。
- DFLT DCX synthetic fixture 如果 payload 根魔数是 BND3/BND4，并符合 synthetic BND fixture，应返回 `DCX_DFLT_NESTED_BND_CHILD_TABLE_FOUND` 和 `dcxNestedBinderChildTable`。

本次结果：

- `npm run bridge:verify:synthetic` 已覆盖顶层 BND inspect 与 DCX nested BND child table 断言，并退出码为 0。

完成条件（已满足）：

- 本地 Bridge smoke 覆盖 BND synthetic inspect 并退出码为 0。
- 文档可把 BND synthetic child inventory wire-up 标为已验证。

## 当前可继续推进项

- BND synthetic child inventory wire-up：本地 Bridge smoke 已通过；后续可继续 parser plumbing，但仍不能把真实 native BND parser 标成已完成。
- DCX KRAK / EDGE / ZSTD：只允许继续做边界识别和 unsupported diagnostic，不能伪解压。
- PARAM/FMG native 深度读取：必须等待 container boundary、BND child table、fixture-confirmed parser 继续稳住后再推进。
