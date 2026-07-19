/**
 * Section-28 sandbox rollback dry-run.
 * Reads one real fixture, mutates only inside temp sandbox via PatchIR raw range.
 * Never writes under game root / mods.
 */
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadNativeFixtureRegistry } from "./native-fixture-registry.mjs";
const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/core/dist");
const { createWorkspaceTransaction } = await import(pathToFileURL(join(coreRoot, "transactions/workspaceTransaction.js")).href);
const { createPatchIr, createRawByteRangeOperation } = await import(pathToFileURL(join(coreRoot, "patch-engine/patchIr.js")).href);

function sha256(buf) { return createHash("sha256").update(buf).digest("hex"); }
function isInside(rootPath, candidate) {
  const norm = (value) => {
    let out = resolve(value).toLowerCase();
    while (out.includes("\\")) out = out.split("\\").join("/");
    while (out.endsWith("/")) out = out.slice(0, -1);
    return out;
  };
  const a = norm(rootPath);
  const b = norm(candidate);
  return b === a || b.startsWith(a + "/");
}

async function main() {
  const fixtureRoot = process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim() || "";
  const registryPath = process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim() || "";
  const gameRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim() || fixtureRoot;
  if (!fixtureRoot || !registryPath || !gameRoot) {
    console.log(JSON.stringify({ ok: false, status: "blocked", code: "SECTION28_ENV_REQUIRED", message: "需要 SOULFORGE_SEKIRO_GAME_ROOT + FIXTURE_ROOT + REGISTRY" }));
    process.exitCode = 2; return;
  }
  const registry = await loadNativeFixtureRegistry({ registryPath, fixtureRoot });
  const fixture = registry.roles["emevd-primary"] || registry.fixtures.find((f) => f.format === "EMEVD");
  if (!fixture) throw new Error("missing EMEVD fixture");
  if (!isInside(gameRoot, fixture.absolutePath) && !isInside(fixtureRoot, fixture.absolutePath)) {
    throw new Error("fixture path outside allowed roots");
  }
  const sourceBytes = await readFile(fixture.absolutePath);
  const sourceHash = sha256(sourceBytes);
  const gameBefore = { mtimeNs: (await stat(fixture.absolutePath)).mtimeNs, size: sourceBytes.length, sha256: sourceHash };
  const sandbox = await mkdtemp(join(tmpdir(), "soulforge-section28-sandbox-"));
  const overlay = join(sandbox, "overlay");
  await mkdir(overlay, { recursive: true });
  const rel = "event/common.emevd.dcx";
  const target = join(overlay, ...rel.split("/").filter(Boolean));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, sourceBytes);
  if (sourceBytes.length < 8) throw new Error("fixture too small");
  const replacement = Buffer.from([0x53, 0x46, 0x52, 0x4f]); // SFRO marker
  const op = createRawByteRangeOperation({
    targetUri: "soulforge://sekiro/overlay/" + rel,
    targetPath: target,
    offset: 0,
    length: 4,
    replacement,
    expectedHash: sourceHash,
    resourceKind: "event"
  });
  op.riskLevel = "high";
  op.metadata = { ...(op.metadata || {}), requiresConfirmation: true, section28SandboxDryRun: true };
  const patch = createPatchIr({
    workspaceId: "section28-sandbox",
    title: "section28 sandbox dry-run",
    author: "system",
    operations: [op]
  });
  const tx = createWorkspaceTransaction({ workspaceId: "section28-sandbox", workspaceRoot: overlay, actor: { kind: "system", id: "section28-dryrun" } });
  tx.addPatch(patch);
  const staged = await tx.stage();
  if (!staged.ok) throw new Error("stage failed: " + JSON.stringify(staged.diagnostics));
  const validated = await tx.validate();
  if (!validated.ok) throw new Error("validate failed: " + JSON.stringify(validated.diagnostics));
  const committed = await tx.commit();
  if (!committed.ok) throw new Error("commit failed: " + JSON.stringify(committed.diagnostics));
  const afterCommit = await readFile(target);
  if (afterCommit.subarray(0,4).equals(sourceBytes.subarray(0,4))) throw new Error("commit did not mutate sandbox file");
  const rolled = await tx.rollback();
  if (!rolled.ok) throw new Error("rollback failed: " + JSON.stringify(rolled.diagnostics));
  const afterRollback = await readFile(target);
  if (sha256(afterRollback) !== sourceHash) throw new Error("rollback did not restore sandbox bytes");
  const gameAfter = { mtimeNs: (await stat(fixture.absolutePath)).mtimeNs, size: (await stat(fixture.absolutePath)).size, sha256: sha256(await readFile(fixture.absolutePath)) };
  if (gameAfter.mtimeNs !== gameBefore.mtimeNs || gameAfter.sha256 !== gameBefore.sha256) throw new Error("game fixture was modified");
  if (isInside(gameRoot, sandbox) || isInside(fixtureRoot, sandbox)) throw new Error("sandbox unexpectedly inside game/fixture root");
  await rm(sandbox, { recursive: true, force: true });
  console.log(JSON.stringify({
    ok: true,
    status: "passed",
    message: "section-28 sandbox rollback dry-run passed; game root untouched",
    fixtureId: fixture.fixtureId,
    sourceHash,
    gameRootUntouched: true,
    sandboxCommitMutated: true,
    sandboxRollbackRestored: true,
    writesUnderGameRoot: false
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack || error.message) : String(error));
  process.exitCode = 1;
});
