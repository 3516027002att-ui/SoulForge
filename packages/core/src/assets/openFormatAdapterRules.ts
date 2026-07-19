/**
 * Open-format adapter pack rules (backend skeleton).
 *
 * Section 22 requires game adapter packs to declare:
 * - material mapping (fail closed when missing — never invent)
 * - glTF node naming → collision
 * - texture color space / mipmap / compression / size rules
 *
 * This module is a pure backend contract + Sekiro candidate pack.
 * It does NOT write native FLVER/MTD/HKX and never claims native-verified authority.
 */

import type { StructuredDiagnostic } from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';

/** Local game id for adapter packs — shared GameId may not exist yet. */
export type OpenFormatGameId = 'sekiro';

export type OpenFormatAdapterAuthority = 'candidate' | 'partial' | 'unsupported';

export type TextureColorSpace = 'srgb' | 'linear' | 'unknown';
export type TextureCompressionHint =
  | 'uncompressed-bgra8'
  | 'bc7'
  | 'bc1'
  | 'passthrough-dds'
  | 'unknown';

export interface TextureImportRule {
  ruleId: string;
  sourceKinds: Array<'png' | 'tga' | 'dds'>;
  colorSpace: TextureColorSpace;
  generateMipmaps: boolean;
  compression: TextureCompressionHint;
  maxWidth: number;
  maxHeight: number;
  requirePowerOfTwo: boolean;
  notes: string[];
}

export type NameMatch =
  | { type: 'exact'; value: string }
  | { type: 'endsWith'; value: string }
  | { type: 'startsWith'; value: string }
  | { type: 'includes'; value: string };

export interface MaterialMappingRule {
  ruleId: string;
  /** glTF material name pattern (exact / prefix / suffix / includes). */
  match: NameMatch;
  /** Target native material / MTD-ish id (candidate label only). */
  targetMaterialId: string;
  notes: string[];
}

export interface CollisionNodeRule {
  ruleId: string;
  match: NameMatch;
  collisionKind: 'mesh' | 'capsule' | 'box' | 'unknown';
  notes: string[];
}

export interface OpenFormatAdapterPack {
  packId: string;
  gameId: OpenFormatGameId;
  displayName: string;
  authority: OpenFormatAdapterAuthority;
  version: string;
  textureRules: TextureImportRule[];
  materialMappings: MaterialMappingRule[];
  collisionNodeRules: CollisionNodeRule[];
  notes: string[];
}

export interface TextureRuleCheckInput {
  sourceKind: 'png' | 'tga' | 'dds';
  width: number;
  height: number;
}

export interface MaterialMappingCheckInput {
  materialName: string;
}

export interface CollisionNodeCheckInput {
  nodeName: string;
}

export interface AdapterRuleMatchResult {
  ok: boolean;
  authority: OpenFormatAdapterAuthority;
  packId: string;
  matchedRuleId?: string;
  diagnostics: StructuredDiagnostic[];
  mapped: boolean;
}

function matchName(name: string, match: NameMatch): boolean {
  switch (match.type) {
    case 'exact':
      return name === match.value;
    case 'endsWith':
      return name.endsWith(match.value);
    case 'startsWith':
      return name.startsWith(match.value);
    case 'includes':
      return name.includes(match.value);
    default:
      return false;
  }
}

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/** Sekiro candidate pack — fail-closed material/collision; texture size gates real. */
export function createSekiroOpenFormatAdapterPack(): OpenFormatAdapterPack {
  return {
    packId: 'sekiro.open-format.v0',
    gameId: 'sekiro',
    displayName: 'Sekiro open-format adapter (candidate)',
    authority: 'candidate',
    version: '0.1.0-candidate',
    textureRules: [
      {
        ruleId: 'sekiro.tex.png-tga.albedo',
        sourceKinds: ['png', 'tga'],
        colorSpace: 'srgb',
        generateMipmaps: false,
        compression: 'uncompressed-bgra8',
        maxWidth: 4096,
        maxHeight: 4096,
        requirePowerOfTwo: false,
        notes: [
          'candidate albedo path; BC compression not claimed',
          'mipmaps deferred until native texture writer exists'
        ]
      },
      {
        ruleId: 'sekiro.tex.dds.passthrough',
        sourceKinds: ['dds'],
        colorSpace: 'unknown',
        generateMipmaps: false,
        compression: 'passthrough-dds',
        maxWidth: 8192,
        maxHeight: 8192,
        requirePowerOfTwo: false,
        notes: ['DDS passthrough stages source bytes without re-encode']
      }
    ],
    materialMappings: [
      {
        ruleId: 'sekiro.mat.c_body',
        match: { type: 'exact', value: 'c_body' },
        targetMaterialId: 'sekiro.mtd.chr.body',
        notes: ['exact body material sample; fail-closed for unmapped names']
      },
      {
        ruleId: 'sekiro.mat.c_face',
        match: { type: 'exact', value: 'c_face' },
        targetMaterialId: 'sekiro.mtd.chr.face',
        notes: ['exact face material sample']
      },
      {
        ruleId: 'sekiro.mat.c_eye',
        match: { type: 'exact', value: 'c_eye' },
        targetMaterialId: 'sekiro.mtd.chr.eye',
        notes: ['exact eye material sample; still candidate, no MTD writer']
      },
      {
        ruleId: 'sekiro.mat.c_cloak',
        match: { type: 'exact', value: 'c_cloak' },
        targetMaterialId: 'sekiro.mtd.chr.cloak',
        notes: ['exact cloak material sample; still candidate, no MTD writer']
      },
      {
        ruleId: 'sekiro.mat.exact.default',
        match: { type: 'exact', value: 'M_ChrDefault' },
        targetMaterialId: 'sekiro.mtd.chr.default',
        notes: ['exact-name sample; fail-closed for unmapped names']
      },
      // Prefix / suffix / includes MUST stay after exacts so c_eye is not swallowed by c_.
      {
        ruleId: 'sekiro.mat.prefix_c_',
        match: { type: 'startsWith', value: 'c_' },
        targetMaterialId: 'sekiro.mtd.chr.generic',
        notes: ['prefix catch-all after exact c_* samples; still candidate']
      },
      {
        ruleId: 'sekiro.mat.m_dummy',
        match: { type: 'startsWith', value: 'm_' },
        targetMaterialId: 'sekiro.mtd.map.dummy',
        notes: ['candidate label only — no MTD writer']
      },
      {
        ruleId: 'sekiro.mat.endsWith_n',
        match: { type: 'endsWith', value: '_n' },
        targetMaterialId: 'sekiro.mtd.normal.dummy',
        notes: ['normal-map style suffix sample; still candidate, no MTD writer']
      },
      {
        ruleId: 'sekiro.mat.endsWith_s',
        match: { type: 'endsWith', value: '_s' },
        targetMaterialId: 'sekiro.mtd.specular.dummy',
        notes: ['specular-map style suffix sample; still candidate, no MTD writer']
      },
      {
        ruleId: 'sekiro.mat.includes_armor',
        match: { type: 'includes', value: 'armor' },
        targetMaterialId: 'sekiro.mtd.chr.armor',
        notes: ['includes-match sample for armor-like names']
      },
      {
        ruleId: 'sekiro.mat.includes_weapon',
        match: { type: 'includes', value: 'weapon' },
        targetMaterialId: 'sekiro.mtd.wep.generic',
        notes: ['includes-match sample for weapon-like names']
      }
    ],
    collisionNodeRules: [
      {
        ruleId: 'sekiro.col.hkt_',
        match: { type: 'startsWith', value: 'hkt_' },
        collisionKind: 'mesh',
        notes: ['Havok-style collision node prefix sample']
      },
      {
        ruleId: 'sekiro.col.col_',
        match: { type: 'startsWith', value: 'col_' },
        collisionKind: 'mesh',
        notes: ['node-name convention only — no HKX writer']
      },
      {
        ruleId: 'sekiro.col.hk_',
        match: { type: 'startsWith', value: 'hk_' },
        collisionKind: 'mesh',
        notes: ['short Havok-style prefix sample']
      },
      {
        ruleId: 'sekiro.col.n_col_',
        match: { type: 'startsWith', value: 'n_col_' },
        collisionKind: 'mesh',
        notes: ['n_col_ prefix sample used by some export pipelines']
      },
      {
        ruleId: 'sekiro.col.endsWith_col',
        match: { type: 'endsWith', value: '_col' },
        collisionKind: 'mesh',
        notes: ['suffix collision marker sample; still candidate, no HKX writer']
      },
      {
        ruleId: 'sekiro.col.includes_collision',
        match: { type: 'includes', value: 'collision' },
        collisionKind: 'mesh',
        notes: ['includes-match sample for verbose collision node names']
      },
      {
        ruleId: 'sekiro.col.includes_hitbox',
        match: { type: 'includes', value: 'hitbox' },
        collisionKind: 'capsule',
        notes: ['includes-match sample for hitbox-style node names']
      }
    ],
    notes: [
      'candidate skeleton only — not a complete Sekiro material/collision table',
      'fail-closed: unmapped material/collision names never invent mappings',
      'no native FLVER/MTD/HKX writer authority'
    ]
  };
}

export function getOpenFormatAdapterPack(gameId: OpenFormatGameId): OpenFormatAdapterPack | null {
  if (gameId === 'sekiro') return createSekiroOpenFormatAdapterPack();
  return null;
}

export function checkTextureImportRules(
  pack: OpenFormatAdapterPack,
  input: TextureRuleCheckInput
): AdapterRuleMatchResult {
  const diagnostics: StructuredDiagnostic[] = [];
  const rule = pack.textureRules.find((r) => r.sourceKinds.includes(input.sourceKind));
  if (!rule) {
    diagnostics.push(
      createDiagnostic({
        severity: 'error',
        code: 'OPEN_FORMAT_ADAPTER_TEXTURE_RULE_MISSING',
        message: `adapter pack ${pack.packId} has no texture rule for ${input.sourceKind}`,
        details: { packId: pack.packId, sourceKind: input.sourceKind }
      })
    );
    return {
      ok: false,
      authority: pack.authority,
      packId: pack.packId,
      diagnostics,
      mapped: false
    };
  }

  let ok = true;
  if (input.width <= 0 || input.height <= 0) {
    ok = false;
    diagnostics.push(
      createDiagnostic({
        severity: 'error',
        code: 'OPEN_FORMAT_ADAPTER_TEXTURE_SIZE',
        message: `texture dimensions invalid: ${input.width}x${input.height}`,
        details: { width: input.width, height: input.height, ruleId: rule.ruleId }
      })
    );
  }
  if (input.width > rule.maxWidth || input.height > rule.maxHeight) {
    ok = false;
    diagnostics.push(
      createDiagnostic({
        severity: 'error',
        code: 'OPEN_FORMAT_ADAPTER_TEXTURE_SIZE',
        message: `texture ${input.width}x${input.height} exceeds adapter max ${rule.maxWidth}x${rule.maxHeight}`,
        details: {
          width: input.width,
          height: input.height,
          maxWidth: rule.maxWidth,
          maxHeight: rule.maxHeight,
          ruleId: rule.ruleId
        }
      })
    );
  }
  if (rule.requirePowerOfTwo && (!isPowerOfTwo(input.width) || !isPowerOfTwo(input.height))) {
    ok = false;
    diagnostics.push(
      createDiagnostic({
        severity: 'error',
        code: 'OPEN_FORMAT_ADAPTER_TEXTURE_POT',
        message: `texture ${input.width}x${input.height} is not power-of-two (required by ${rule.ruleId})`,
        details: { width: input.width, height: input.height, ruleId: rule.ruleId }
      })
    );
  }

  if (ok) {
    diagnostics.push(
      createDiagnostic({
        severity: 'info',
        code: 'OPEN_FORMAT_ADAPTER_TEXTURE_RULE_MATCHED',
        message: `texture accepted by ${rule.ruleId}`,
        details: {
          ruleId: rule.ruleId,
          colorSpace: rule.colorSpace,
          compression: rule.compression,
          generateMipmaps: rule.generateMipmaps
        }
      })
    );
  }

  return {
    ok,
    authority: pack.authority,
    packId: pack.packId,
    matchedRuleId: rule.ruleId,
    diagnostics,
    mapped: ok
  };
}

export function checkMaterialMapping(
  pack: OpenFormatAdapterPack,
  input: MaterialMappingCheckInput
): AdapterRuleMatchResult {
  const name = input.materialName.trim();
  const rule = pack.materialMappings.find((r) => matchName(name, r.match));
  if (!rule) {
    return {
      ok: false,
      authority: pack.authority,
      packId: pack.packId,
      diagnostics: [
        createDiagnostic({
          severity: 'error',
          code: 'OPEN_FORMAT_ADAPTER_MATERIAL_UNMAPPED',
          message: `material "${name}" has no adapter mapping — fail-closed (no auto-guess)`,
          details: { materialName: name, packId: pack.packId }
        })
      ],
      mapped: false
    };
  }
  return {
    ok: true,
    authority: pack.authority,
    packId: pack.packId,
    matchedRuleId: rule.ruleId,
    mapped: true,
    diagnostics: [
      createDiagnostic({
        severity: 'info',
        code: 'OPEN_FORMAT_ADAPTER_MATERIAL_MAPPED',
        message: `material "${name}" → ${rule.targetMaterialId}`,
        details: {
          materialName: name,
          targetMaterialId: rule.targetMaterialId,
          ruleId: rule.ruleId,
          nativeWriter: false
        }
      })
    ]
  };
}

export function checkCollisionNodeMapping(
  pack: OpenFormatAdapterPack,
  input: CollisionNodeCheckInput
): AdapterRuleMatchResult {
  const name = input.nodeName.trim();
  const rule = pack.collisionNodeRules.find((r) => matchName(name, r.match));
  if (!rule) {
    return {
      ok: false,
      authority: pack.authority,
      packId: pack.packId,
      diagnostics: [
        createDiagnostic({
          severity: 'error',
          code: 'OPEN_FORMAT_ADAPTER_COLLISION_UNMAPPED',
          message: `collision node "${name}" has no adapter mapping — fail-closed (no auto-guess)`,
          details: { nodeName: name, packId: pack.packId }
        })
      ],
      mapped: false
    };
  }
  return {
    ok: true,
    authority: pack.authority,
    packId: pack.packId,
    matchedRuleId: rule.ruleId,
    mapped: true,
    diagnostics: [
      createDiagnostic({
        severity: 'info',
        code: 'OPEN_FORMAT_ADAPTER_COLLISION_MAPPED',
        message: `collision node "${name}" → ${rule.collisionKind}`,
        details: {
          nodeName: name,
          collisionKind: rule.collisionKind,
          ruleId: rule.ruleId,
          nativeWriter: false
        }
      })
    ]
  };
}
