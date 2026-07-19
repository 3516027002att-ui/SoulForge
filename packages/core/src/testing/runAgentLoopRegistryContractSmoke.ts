/**
 * Structural contract: desktop agent loop uses the production ToolRegistry only.
 * - createDefaultToolRegistry is the sole registry constructor in main ipc
 * - tool execution goes through executeToolThroughPolicy
 * - no scaffold registry imports
 * - outbound audit is recorded with retentionMode + outboundContextItems
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function main(): void {
  const root = resolve("../..");
  const ipc = readFileSync(resolve(root, "apps/desktop/src/main/ipc.ts"), "utf8");
  const preload = readFileSync(resolve(root, "apps/desktop/src/preload/index.ts"), "utf8");

  if (!ipc.includes("createDefaultToolRegistry()")) {
    throw new Error("ipc must construct createDefaultToolRegistry()");
  }
  if (ipc.includes("createScaffoldToolRegistry") || ipc.includes("scaffoldToolRegistry")) {
    throw new Error("ipc must not import scaffold tool registry");
  }
  if ((ipc.match(/createDefaultToolRegistry\s*\(/g) || []).length !== 1) {
    throw new Error("expected exactly one createDefaultToolRegistry() construction in ipc");
  }
  if (!ipc.includes("toolRegistry.executeToolThroughPolicy(")) {
    throw new Error("ipc tool execution must use executeToolThroughPolicy");
  }
  if (ipc.includes("toolRegistry.run(")) {
    throw new Error("ipc should not call toolRegistry.run directly");
  }
  if (!ipc.includes("runAgentToolLoop")) {
    throw new Error("ipc must host runAgentToolLoop agent path");
  }
  if (!ipc.includes("recordAgentRun(") || !ipc.includes("outboundContextItems: outbound.outboundContextItems")) {
    throw new Error("ai.runModel must persist outboundContextItems via recordAgentRun");
  }
  if (!ipc.includes("getAiHistoryRetentionMode()") || !ipc.includes("retentionMode,")) {
    throw new Error("ai.runModel must pass retentionMode from app settings into recordAgentRun");
  }
  if (!ipc.includes("buildOutboundContext(")) {
    throw new Error("ai.runModel must build outbound context through Context Broker");
  }
  // Preload may expose runAiTool/runModelService, but must not expose history/retention or credentials.
  for (const banned of ["getAgentRun", "listAgentRuns", "getRetentionMode", "setRetentionMode", "resolveApiKey"]) {
    if (preload.includes(banned)) {
      throw new Error("preload must not expose " + banned);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    message: "agent loop production registry contract: ok",
    checks: [
      "single createDefaultToolRegistry",
      "executeToolThroughPolicy",
      "no scaffold registry",
      "recordAgentRun outbound + retentionMode",
      "preload history/credentials denied"
    ]
  }, null, 2));
}

main();
