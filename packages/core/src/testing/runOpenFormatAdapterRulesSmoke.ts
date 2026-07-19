/**
 * Open-format adapter pack rules smoke (backend only).
 * Covers Sekiro candidate pack texture/material/collision fail-closed gates.
 */
import {
  checkCollisionNodeMapping,
  checkMaterialMapping,
  checkTextureImportRules,
  createSekiroOpenFormatAdapterPack,
  getOpenFormatAdapterPack
} from '../assets/openFormatAdapterRules.js';

function main(): void {
  const pack = createSekiroOpenFormatAdapterPack();
  if (pack.authority !== 'candidate' || pack.packId !== 'sekiro.open-format.v0') {
    throw new Error(`unexpected pack identity: ${pack.packId}/${pack.authority}`);
  }
  if (getOpenFormatAdapterPack('sekiro')?.packId !== pack.packId) {
    throw new Error('getOpenFormatAdapterPack(sekiro) mismatch');
  }

  const texOk = checkTextureImportRules(pack, {
    sourceKind: 'png',
    width: 512,
    height: 512
  });
  if (!texOk.ok || !texOk.mapped || texOk.matchedRuleId !== 'sekiro.tex.png-tga.albedo') {
    throw new Error(`texture ok path failed: ${JSON.stringify(texOk.diagnostics)}`);
  }

  const texTooBig = checkTextureImportRules(pack, {
    sourceKind: 'png',
    width: 8192,
    height: 8192
  });
  if (texTooBig.ok || !texTooBig.diagnostics.some((d) => d.code === 'OPEN_FORMAT_ADAPTER_TEXTURE_SIZE')) {
    throw new Error(`texture oversized path must fail: ${JSON.stringify(texTooBig.diagnostics)}`);
  }

  // Albedo rule does not require power-of-two — non-POT still maps when within size.
  const texNonPot = checkTextureImportRules(pack, {
    sourceKind: 'png',
    width: 100,
    height: 50
  });
  if (!texNonPot.ok || !texNonPot.mapped) {
    throw new Error(
      `texture non-POT path should still map under albedo rule: ${JSON.stringify(texNonPot.diagnostics)}`
    );
  }

  const matBody = checkMaterialMapping(pack, { materialName: 'c_body' });
  if (!matBody.ok || !matBody.mapped || matBody.matchedRuleId !== 'sekiro.mat.c_body') {
    throw new Error(`material exact body failed: ${JSON.stringify(matBody.diagnostics)}`);
  }

  const matFace = checkMaterialMapping(pack, { materialName: 'c_face' });
  if (!matFace.ok || !matFace.mapped || matFace.matchedRuleId !== 'sekiro.mat.c_face') {
    throw new Error(`material exact face failed: ${JSON.stringify(matFace.diagnostics)}`);
  }

  const matHair = checkMaterialMapping(pack, { materialName: 'c_hair' });
  if (!matHair.ok || !matHair.mapped || matHair.matchedRuleId !== 'sekiro.mat.prefix_c_') {
    throw new Error(`material prefix c_ failed: ${JSON.stringify(matHair.diagnostics)}`);
  }

  const matIncludes = checkMaterialMapping(pack, { materialName: 'player_armor_a' });
  if (!matIncludes.ok || !matIncludes.mapped || matIncludes.matchedRuleId !== 'sekiro.mat.includes_armor') {
    throw new Error(`material includes armor failed: ${JSON.stringify(matIncludes.diagnostics)}`);
  }

  const matEye = checkMaterialMapping(pack, { materialName: 'c_eye' });
  if (!matEye.ok || !matEye.mapped || matEye.matchedRuleId !== 'sekiro.mat.c_eye') {
    throw new Error(`material exact eye failed: ${JSON.stringify(matEye.diagnostics)}`);
  }

  const matCloak = checkMaterialMapping(pack, { materialName: 'c_cloak' });
  if (!matCloak.ok || !matCloak.mapped || matCloak.matchedRuleId !== 'sekiro.mat.c_cloak') {
    throw new Error(`material exact cloak failed: ${JSON.stringify(matCloak.diagnostics)}`);
  }

  const matSpecular = checkMaterialMapping(pack, { materialName: 'metal_s' });
  if (!matSpecular.ok || !matSpecular.mapped || matSpecular.matchedRuleId !== 'sekiro.mat.endsWith_s') {
    throw new Error(`material endsWith _s failed: ${JSON.stringify(matSpecular.diagnostics)}`);
  }

  const matWeapon = checkMaterialMapping(pack, { materialName: 'boss_weapon_blade' });
  if (!matWeapon.ok || !matWeapon.mapped || matWeapon.matchedRuleId !== 'sekiro.mat.includes_weapon') {
    throw new Error(`material includes weapon failed: ${JSON.stringify(matWeapon.diagnostics)}`);
  }

  const matMissing = checkMaterialMapping(pack, { materialName: 'totally_unknown_mat' });
  if (matMissing.ok || matMissing.mapped) {
    throw new Error('unmapped material must fail-closed');
  }
  if (!matMissing.diagnostics.some((d) => d.code === 'OPEN_FORMAT_ADAPTER_MATERIAL_UNMAPPED')) {
    throw new Error(`expected MATERIAL_UNMAPPED: ${JSON.stringify(matMissing.diagnostics)}`);
  }

  const colOk = checkCollisionNodeMapping(pack, { nodeName: 'hkt_body' });
  if (!colOk.ok || !colOk.mapped || colOk.matchedRuleId !== 'sekiro.col.hkt_') {
    throw new Error(`collision ok path failed: ${JSON.stringify(colOk.diagnostics)}`);
  }

  const colCol = checkCollisionNodeMapping(pack, { nodeName: 'col_sword' });
  if (!colCol.ok || !colCol.mapped || colCol.matchedRuleId !== 'sekiro.col.col_') {
    throw new Error(`collision col_ path failed: ${JSON.stringify(colCol.diagnostics)}`);
  }

  const colNCol = checkCollisionNodeMapping(pack, { nodeName: 'n_col_torso' });
  if (!colNCol.ok || !colNCol.mapped || colNCol.matchedRuleId !== 'sekiro.col.n_col_') {
    throw new Error(`collision n_col_ path failed: ${JSON.stringify(colNCol.diagnostics)}`);
  }

  const colEnds = checkCollisionNodeMapping(pack, { nodeName: 'body_col' });
  if (!colEnds.ok || !colEnds.mapped || colEnds.matchedRuleId !== 'sekiro.col.endsWith_col') {
    throw new Error(`collision endsWith _col path failed: ${JSON.stringify(colEnds.diagnostics)}`);
  }

  const colHitbox = checkCollisionNodeMapping(pack, { nodeName: 'enemy_hitbox_01' });
  if (!colHitbox.ok || !colHitbox.mapped || colHitbox.matchedRuleId !== 'sekiro.col.includes_hitbox') {
    throw new Error(`collision includes hitbox path failed: ${JSON.stringify(colHitbox.diagnostics)}`);
  }

  const colMissing = checkCollisionNodeMapping(pack, { nodeName: 'mesh_root' });
  if (colMissing.ok || colMissing.mapped) {
    throw new Error('unmapped collision node must fail-closed');
  }
  if (!colMissing.diagnostics.some((d) => d.code === 'OPEN_FORMAT_ADAPTER_COLLISION_UNMAPPED')) {
    throw new Error(`expected COLLISION_UNMAPPED: ${JSON.stringify(colMissing.diagnostics)}`);
  }

  if (pack.authority !== 'candidate') {
    throw new Error(`adapter pack must stay candidate, got ${pack.authority}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        message: 'open-format adapter pack rules smoke passed',
        packId: pack.packId,
        authority: pack.authority,
        textureRuleMatched: texOk.matchedRuleId,
        materialExactBody: matBody.matchedRuleId,
        materialExactFace: matFace.matchedRuleId,
        materialExactEye: matEye.matchedRuleId,
        materialExactCloak: matCloak.matchedRuleId,
        materialPrefix: matHair.matchedRuleId,
        materialIncludes: matIncludes.matchedRuleId,
        materialSpecular: matSpecular.matchedRuleId,
        materialWeapon: matWeapon.matchedRuleId,
        materialFailClosed: true,
        collisionOk: colOk.matchedRuleId,
        collisionCol: colCol.matchedRuleId,
        collisionNCol: colNCol.matchedRuleId,
        collisionEnds: colEnds.matchedRuleId,
        collisionHitbox: colHitbox.matchedRuleId,
        collisionFailClosed: true,
        noNativeWriterClaim: true
      },
      null,
      2
    )
  );
}

main();
