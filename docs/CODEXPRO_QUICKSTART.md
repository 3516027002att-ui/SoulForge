# CodexPro Quickstart

CodexPro connects ChatGPT Developer Mode to this local SoulForge repository through an MCP server.
It is a development bridge only: it helps ChatGPT read, search, edit, and validate repository code, but it is not part of the SoulForge app runtime.

## Start From A New Chat

If another Codex or ChatGPT chat needs to start the bridge, use:

```powershell
cd D:\Repository\SoulForge
npm run codexpro:start
```

Keep the terminal process running. CodexPro prints and copies a ChatGPT Server URL. Paste that exact URL into ChatGPT's Developer Mode connector setup.

## ChatGPT Connector Setup

In ChatGPT:

1. Open `Settings -> Apps & Connectors -> Advanced settings`.
2. Enable Developer Mode.
3. Create a connector.
4. Paste the CodexPro Server URL.
5. Choose `Authentication: No Authentication / None`.

Do not choose OAuth. CodexPro does not implement OAuth discovery; it uses the `codexpro_token` in the generated Server URL.

## Default Permissions

`npm run codexpro:start` starts CodexPro in agent mode:

- ChatGPT can directly edit files in `D:\Repository\SoulForge`.
- Tool mode is `standard`.
- Workspace write mode is enabled.
- Bash mode is `safe`.
- Bash calls must include `session_id: "soulforge"`.

For planning-only mode:

```powershell
npm run codexpro:start:handoff
```

## Suggested First Message In ChatGPT

```text
请先调用 codexpro_self_test，然后 open_current_workspace。你可以直接修改 SoulForge 仓库代码；如需运行 bash，session_id 使用 soulforge。
```

## Safety Notes

- Do not commit CodexPro Server URLs, query tokens, Cloudflare tokens, ngrok tokens, `.env` files, or local runtime logs.
- Quick tunnel URLs usually change after CodexPro restarts.
- ChatGPT may edit SoulForge source code, but product writes into user mod workspaces must still go through the Patch Engine.
- Unsupported binary formats must still return structured diagnostics instead of guessed parses.
