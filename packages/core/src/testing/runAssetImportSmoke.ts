/**
 * Asset import staging smoke — drives real stageAssetImport on synthetic open-format bytes.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planAssetImport, stageAssetImport } from '../assets/assetImport.js';

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-asset-import-'));
  const stagingRoot = join(root, 'staging');
  const sourceDir = join(root, 'source');
  await mkdir(sourceDir, { recursive: true });
  await mkdir(stagingRoot, { recursive: true });

  // Minimal PNG: 1x1 IHDR-only is complex; use signature + padding for magic gate.
  // Real decode is out of scope; magic + staging path is the shipped contract under test.
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 1)
  ]);
  const pngPath = join(sourceDir, 'pixel.png');
  await writeFile(pngPath, png);

  const glb = Buffer.concat([
    Buffer.from('glTF', 'ascii'),
    Buffer.from([2, 0, 0, 0]),
    Buffer.alloc(32, 0)
  ]);
  const glbPath = join(sourceDir, 'mesh.glb');
  await writeFile(glbPath, glb);

  // Unsupported format blocked
  const badPlan = planAssetImport({
    sourcePath: join(sourceDir, 'mesh.fbx'),
    targetAssetUri: 'file://chr/c0000.flver',
    conversionRuleId: 'sekiro.flver.from-gltf',
    stagingRoot
  });
  if (badPlan.ok || !badPlan.diagnostics.some((d) => d.code === 'ASSET_IMPORT_FORMAT_UNSUPPORTED')) {
    throw new Error('FBX must be rejected');
  }

  const pngStaged = await stageAssetImport({
    sourcePath: pngPath,
    targetAssetUri: 'file://parts/tex/pixel.dds',
    conversionRuleId: 'sekiro.dds.from-png',
    stagingRoot
  });
  if (!pngStaged.ok) throw new Error(`PNG stage failed: ${JSON.stringify(pngStaged.diagnostics)}`);
  const stagedPng = await readFile(pngStaged.stagingPath);
  if (!stagedPng.equals(png)) throw new Error('staged PNG bytes mismatch');
  if (pngStaged.contentHash !== createHash('sha256').update(png).digest('hex')) {
    throw new Error('PNG contentHash mismatch');
  }
  const manifest = JSON.parse(await readFile(`${pngStaged.stagingPath}.manifest.json`, 'utf8')) as {
    format: string;
    contentHash: string;
  };
  if (manifest.format !== 'png' || manifest.contentHash !== pngStaged.contentHash) {
    throw new Error('manifest mismatch');
  }

  const glbStaged = await stageAssetImport({
    sourcePath: glbPath,
    targetAssetUri: 'file://chr/c0000.flver',
    conversionRuleId: 'sekiro.flver.from-gltf',
    stagingRoot
  });
  if (!glbStaged.ok) throw new Error(`GLB stage failed: ${JSON.stringify(glbStaged.diagnostics)}`);

  // Magic mismatch
  const wrong = await stageAssetImport({
    sourcePath: join(sourceDir, 'fake.png'),
    sourceBytes: Buffer.from('not-a-png-file-content'),
    targetAssetUri: 'file://parts/tex/x.dds',
    conversionRuleId: 'sekiro.dds.from-png',
    stagingRoot
  });
  if (wrong.ok || !wrong.diagnostics.some((d) => d.code === 'ASSET_IMPORT_MAGIC_MISMATCH')) {
    throw new Error('PNG magic mismatch must fail');
  }

  console.log(JSON.stringify({
    ok: true,
    message: '资产导入暂存主干验证通过',
    png: {
      hash: pngStaged.contentHash,
      stagingRelative: pngStaged.plan.stagingRelativePath,
      format: pngStaged.plan.format
    },
    glb: {
      hash: glbStaged.contentHash,
      format: glbStaged.plan.format
    },
    rejectedFbx: true,
    rejectedBadMagic: true,
    notes: pngStaged.plan.notes
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
