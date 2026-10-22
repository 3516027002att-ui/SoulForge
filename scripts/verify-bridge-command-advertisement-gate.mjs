#!/usr/bin/env node
// Source projection consistency only. Real dispatch is verified at daemon
// startup and in SoulForge.Bridge.Tests, including a descriptor-only negative.
import { checkOrWriteBridgeCommands } from './generate-bridge-commands.mjs';
try {
  console.log(JSON.stringify(await checkOrWriteBridgeCommands({ check: true }), null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, status: 'failed', code: 'BRIDGE_COMMAND_ADVERTISEMENT_DRIFT', message: error.message }));
  process.exitCode = 1;
}
