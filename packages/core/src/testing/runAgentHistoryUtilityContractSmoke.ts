/**
 * Structural contract: agent history/retention is available on utility + main IPC
 * without preload/renderer exposure of history APIs.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function main(): void {
  const root = resolve("../..");
  const protocol = readFileSync(resolve(root, "apps/desktop/src/main/operationLogUtilityProtocol.ts"), "utf8");
  const client = readFileSync(resolve(root, "apps/desktop/src/main/operationLogUtilityClient.ts"), "utf8");
  const utility = readFileSync(resolve(root, "apps/desktop/src/main/databaseUtility.ts"), "utf8");
  const ipc = readFileSync(resolve(root, "apps/desktop/src/main/ipc.ts"), "utf8");
  const preload = readFileSync(resolve(root, "apps/desktop/src/preload/index.ts"), "utf8");

  const methods = [
    "getAgentRun",
    "listAgentRuns",
    "getAiHistoryRetentionMode",
    "setAiHistoryRetentionMode"
  ];
  for (const method of methods) {
    if (!protocol.includes(method + ":")) throw new Error("protocol missing " + method);
    if (!client.includes(method + "(")) throw new Error("client missing " + method);
    if (!utility.includes("case '" + method + "'")) throw new Error("databaseUtility missing " + method);
  }

  const ipcChannels = [
    "ai.history.getAgentRun",
    "ai.history.listAgentRuns",
    "ai.history.getRetentionMode",
    "ai.history.setRetentionMode"
  ];
  for (const channel of ipcChannels) {
    if (!ipc.includes(`'${channel}'`)) throw new Error("ipc missing " + channel);
    if (preload.includes(channel)) {
      throw new Error("preload must not expose " + channel);
    }
  }
  for (const banned of ["getAgentRun", "listAgentRuns", "getHistoryRetentionMode", "setHistoryRetentionMode"]) {
    if (preload.includes(banned)) throw new Error("preload must not expose " + banned);
  }

  if (preload.includes("invoke('ai.runModel'") === false && preload.includes("ai.runModel") === false) {
    // runModel may remain exposed; history must not.
  }

  console.log(JSON.stringify({
    ok: true,
    message: "agent history utility contract: ok",
    methods,
    ipcChannels,
    preloadHistoryExposed: false
  }, null, 2));
}

main();
