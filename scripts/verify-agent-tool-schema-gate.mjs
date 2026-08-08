#!/usr/bin/env node
/**
 * 生产 AI 工具 schema 暴露门禁。
 *
 * 守的问题:`createAgentToolBridge` 把生产 ToolRegistry 投影成 agent loop 的
 * ToolDefinition 时,必须把每个工具**真实的字段名与类型**告诉模型。
 *
 * 为什么需要机器校验:
 *
 * 修复前 `agentToolBridge.ts:37` 写的是 `parametersJsonSchema: { type: 'object' }`
 * —— 一个不带 properties 的空壳。它编译通过、类型正确、所有测试照绿,但模型收到的
 * 是「这个工具接受一个对象」,字段名一个都没有。模型只能猜:`q` 还是 `query`、
 * `id` 还是 `textId`。猜错回来一条 INVALID_INPUT,而错误信息里没有正确字段名,
 * 模型无法从失败中恢复。这就是工具调用不可靠的根因。
 *
 * 空壳 schema 的危险在于它**不会以任何形式失败**:没有编译错误,没有测试红,
 * 运行期也只表现为「模型好像不太会用工具」。所以必须有一道判据钉住
 * 「声明了字段的工具,其暴露 schema 里必须真的有那些字段」。
 *
 * 判据(全部在运行期观测真实 bridge 输出,不做静态字符串匹配):
 *   ① 生产注册表经 bridge 投影后,工具数必须与注册数一致(投影不得丢工具);
 *   ② 每个在 registry 里声明了 inputSchema 的工具,其 parametersJsonSchema
 *      必须逐字段包含同名 properties,且类型与声明一致;
 *   ③ 非可选字段(声明串不以 '?' 结尾)必须出现在 required 里;可选字段必须不在;
 *   ④ 零参数工具允许空 properties,但仍必须是合法 object schema;
 *   ⑤ 投影不得凭空造出 registry 未声明的字段(那会让模型传入被运行期忽略的参数);
 *   ⑥ 与运行期强制器同源:对每个声明字段构造一个「只缺这一个必填字段」的输入,
 *      registry.run 必须以 INVALID_INPUT 拒绝 —— 证明 schema 宣告的 required
 *      与 validateToolInput 实际强制的是同一套,而不是两份会漂移的副本;
 *   ⑦ `enum:a|b|c` 声明的取值必须逐个到达模型,且运行期必须真的拒绝集合外的值,
 *      拒绝信息里要列全合法取值;
 *   ⑧ 声明的每个枚举取值,handler 侧归一化函数必须真的接受(不能静默回落);
 *   ⑨ 整个 input 即某个已知类型的工具(validate_patch / build_patch_graph 的
 *      input 就是 PatchProposal),其必填字段必须与该类型的必填成员一致 ——
 *      第二源是 packages/shared/src/types.ts 的接口定义,不是重述声明。
 *
 * 判据⑥是本门禁与「读一遍源码看看有没有 properties」的区别所在:光比对 schema
 * 自身无法发现「schema 写对了但运行期不认」或反之。判据⑦⑧⑨补的是同一类盲区的
 * 另外三个方向 —— ⑦⑧防「声明说得比 handler 宽」,⑨防「声明与投影一致地漏字段」。
 * ⑦和⑨都是先实测报绿、确认存在盲区之后才补的,不是预防性堆判据。
 *
 * 不做的事:不判断字段名起得好不好,不校验 description 文案,不跨工具比较语义。
 *
 * ── 负向证明(2026-08-08 实测十一条,每条退化后 `tsc -b --force` 重建再跑本门禁)──
 *   D1  parametersJsonSchema 写回空壳 { type: 'object' }  → SCHEMA_FIELD_NOT_EXPOSED
 *   D2  list() 不再透出 inputSchema(bridge 拿不到声明)   → NO_DECLARED_FIELDS
 *   D3  投影时把 query 改名成 q                            → FIELD_NOT_EXPOSED + INVENTED_FIELDS
 *   D4  number 投影成 string                               → SCHEMA_FIELD_TYPE_MISMATCH
 *   D5  required 恒为空                                     → SCHEMA_REQUIRED_FIELD_NOT_MARKED
 *   D6  '?' 判定失效,可选字段进 required                   → SCHEMA_OPTIONAL_MARKED_REQUIRED
 *   D7  零参数工具被投出 ghostField                        → SCHEMA_INVENTED_FIELDS
 *   D8  未识别类型串被宣告成 type=string                   → SCHEMA_UNCHECKED_TYPE_CLAIMED
 *   D9  validateToolInput 不再强制必填                     → REQUIRED_FIELD_NOT_ENFORCED
 *   D10 拒绝信息去掉字段名                                  → REJECTION_OMITS_FIELD_NAME
 *   D11 list() 返回空数组                                   → NO_TOOLS_REGISTERED(失败关闭)
 *
 * D2 与 D11 证明的是失败关闭那道保险:声明消失时判据②③⑤⑥会零样本恒真,
 * 此时必须红而不是绿。D4/D6/D7/D8/D11 的锚点最初写成跨行字面量匹配不上
 * (源码 CRLF),假报「锚点未命中」;改单行锚点后成立。
 *
 * ── 判据⑦⑧⑨ 的负向证明(同日实测九条)──
 *   E1  四个枚举字段全退回裸 string                → NO_ENUM_FIELDS(失败关闭)
 *   E2  声明多列一个 handler 不认的取值 sideways    → ENUM_VALUE_NOT_ACCEPTED
 *   E3  enum 投影丢掉 enum 列表                     → SCHEMA_ENUM_NOT_EXPOSED
 *   E4  validateToolInput 不再强制枚举              → ENUM_NOT_ENFORCED
 *   E5  枚举拒绝信息不列合法取值                    → ENUM_REJECTION_OMITS_VALUES
 *   E6  validate_patch 退回只声明 changes           → WHOLE_INPUT_REQUIRED_FIELD_UNDECLARED
 *   E7  opId 降级为可选(无实测豁免)               → WHOLE_INPUT_REQUIRED_FIELD_OPTIONAL
 *   E8  声明收紧后豁免清单残留                      → STALE_OPTIONAL_EXEMPTION
 *   E9  ENUM_FIELD_NORMALIZERS 不再导出             → NO_ENUM_NORMALIZERS(失败关闭)
 *
 * E2 与 E6 第一版都报绿,正是它们暴露了判据⑧⑨要守的盲区:E2 里声明与投影
 * 一致地变宽,E6 里声明与投影一致地变窄,两侧比对都发现不了。E4 最初退化成
 * `if (false)` 导致 tsc 报 TS18047(类型收窄失效)而非跑出判据结果,
 * 改成保留类型使用的恒假条件后成立。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const LABEL = 'agent-tool-schema';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function report(payload, exitCode) {
  (exitCode === 0 ? console.log : console.error)(JSON.stringify(payload, null, 2));
  process.exit(exitCode);
}

// 观测编译产物而不是源码:门禁要证明的是「模型实际收到什么」,那取决于运行期
// 投影结果。读源码只能证明源码长什么样。
const DIST = join(root, 'packages', 'core', 'dist', 'ai');
const REGISTRY_JS = join(DIST, 'toolRegistry.js');
const BRIDGE_JS = join(DIST, 'agentToolBridge.js');

for (const [name, path] of [['toolRegistry', REGISTRY_JS], ['agentToolBridge', BRIDGE_JS]]) {
  if (!existsSync(path)) {
    report({
      ok: false, gate: LABEL, status: 'failed', code: 'DIST_MISSING',
      message: `缺少编译产物 ${name}:${path}。先跑 npm run build -w @soulforge/core。`
        + ' 本门禁必须观测运行期投影结果,不能退化成读源码字符串。'
    }, 1);
  }
}

const {
  createDefaultToolRegistry,
  validateToolInput,
  ENUM_FIELD_NORMALIZERS
} = await import(pathToFileURL(REGISTRY_JS).href);
const { createAgentToolBridge } = await import(pathToFileURL(BRIDGE_JS).href);

// 判据⑧读的是生产侧真实归一化函数,不是门禁自己重述一遍取值集合。
// 重述等于第二份副本,会漂移。
const ENUM_NORMALIZERS = ENUM_FIELD_NORMALIZERS ?? {};
let enumAcceptanceProbes = 0;
const exemptionsApplied = [];

const registry = createDefaultToolRegistry();
const descriptors = registry.list();
const bridge = createAgentToolBridge({
  registry,
  // workspaceIndex 只在 run 体内被用到;本门禁只观测 tools 投影与输入校验拒绝,
  // 不触达索引,故传占位。任何走到索引的判据都会抛异常而不是静默通过。
  context: { workspaceIndex: {}, mode: 'fullPermission' }
});

const findings = [];

/** 构造探针输入用的合法占位值。 */
const PLACEHOLDER = {
  string: 'x',
  number: 1,
  boolean: true,
  array: [],
  object: {}
};

// 判据①:投影不得丢工具。
if (bridge.tools.length !== descriptors.length) {
  findings.push({
    code: 'TOOL_COUNT_MISMATCH',
    registered: descriptors.length,
    projected: bridge.tools.length,
    message: `注册 ${descriptors.length} 个工具,投影出 ${bridge.tools.length} 个。`
      + ' 投影丢工具意味着模型看不到部分能力。'
  });
}

const projected = new Map(bridge.tools.map((tool) => [tool.name, tool]));
const declaredCounts = { withSchema: 0, zeroArg: 0, fields: 0, enumFields: 0 };

for (const descriptor of descriptors) {
  const tool = projected.get(descriptor.name);
  if (!tool) {
    findings.push({
      code: 'TOOL_NOT_PROJECTED',
      tool: descriptor.name,
      message: `工具 ${descriptor.name} 在注册表里存在,但没有出现在 bridge.tools 中。`
    });
    continue;
  }

  const schema = tool.parametersJsonSchema;
  if (!schema || typeof schema !== 'object' || schema.type !== 'object') {
    findings.push({
      code: 'SCHEMA_NOT_OBJECT',
      tool: descriptor.name,
      schema,
      message: `工具 ${descriptor.name} 的 parametersJsonSchema 不是合法 object schema。`
    });
    continue;
  }

  const shape = descriptor.inputSchema;
  const properties = schema.properties ?? {};
  const required = Array.isArray(schema.required) ? schema.required : [];

  // 判据④:零参数工具。
  if (!shape || Object.keys(shape).length === 0) {
    declaredCounts.zeroArg += 1;
    if (Object.keys(properties).length > 0) {
      findings.push({
        code: 'SCHEMA_INVENTED_FIELDS',
        tool: descriptor.name,
        invented: Object.keys(properties),
        message: `工具 ${descriptor.name} 在 registry 里没有声明 inputSchema,`
          + ` 但投影出了字段 ${Object.keys(properties).join(', ')}。`
          + ' 模型会传入运行期直接忽略的参数。'
      });
    }
    continue;
  }

  declaredCounts.withSchema += 1;

  // `enum:a|b|c` 是运行期强制的枚举(validateToolInput 会按取值集合拒绝),
  // 故它必须投影成 type=string 且带 enum 列表 —— 与「未识别类型串」不同,
  // 后者运行期一律放过,投影就不能宣告任何类型。
  const enumValuesOf = (bare) => {
    if (!bare.startsWith('enum:')) return null;
    const values = bare.slice('enum:'.length).split('|').filter((value) => value.length > 0);
    return values.length > 0 ? values : null;
  };
  const expectedTypeFor = (declared) => {
    const bare = declared.endsWith('?') ? declared.slice(0, -1) : declared;
    if (enumValuesOf(bare) !== null) return 'string';
    return ['string', 'number', 'boolean', 'array', 'object'].includes(bare) ? bare : null;
  };

  for (const [field, declared] of Object.entries(shape)) {
    declaredCounts.fields += 1;
    const optional = declared.endsWith('?');
    const bare = optional ? declared.slice(0, -1) : declared;
    const declaredEnum = enumValuesOf(bare);
    const expectedType = expectedTypeFor(declared);

    // 判据②:字段必须存在。
    if (!Object.prototype.hasOwnProperty.call(properties, field)) {
      findings.push({
        code: 'SCHEMA_FIELD_NOT_EXPOSED',
        tool: descriptor.name,
        field,
        declared,
        exposedFields: Object.keys(properties),
        message: `工具 ${descriptor.name} 声明了字段 ${field}(${declared}),`
          + ' 但投影出的 parametersJsonSchema.properties 里没有它。'
          + ' 模型无法得知这个字段名,只能猜。'
      });
      continue;
    }

    // 判据②:类型必须一致。
    const exposedType = properties[field]?.type;
    if (expectedType !== null && exposedType !== expectedType) {
      findings.push({
        code: 'SCHEMA_FIELD_TYPE_MISMATCH',
        tool: descriptor.name,
        field,
        declared,
        expectedType,
        exposedType: exposedType ?? null,
        message: `工具 ${descriptor.name} 字段 ${field} 声明为 ${expectedType},`
          + ` 投影出的类型是 ${exposedType ?? '(无)'}。`
      });
    }
    // 声明了运行期不校验的类型名时,投影必须留空而不是编一个类型出来。
    if (expectedType === null && exposedType !== undefined) {
      findings.push({
        code: 'SCHEMA_UNCHECKED_TYPE_CLAIMED',
        tool: descriptor.name,
        field,
        declared,
        exposedType,
        message: `工具 ${descriptor.name} 字段 ${field} 的声明类型 ${declared} 不在`
          + ' validateToolInput 的强制清单里(该处未识别的类型串一律放过),'
          + ` 但投影却宣告了 type=${exposedType}。宣告比实际更严会让模型`
          + '拒绝本可接受的输入。'
      });
    }

    // 判据⑦:枚举取值必须逐个到达模型。裸 'string' 声明会让模型不知道
    // 只有三个合法值,而传错值不报错、静默回落默认值(实测 direction
    // 传 'sideways' 回落 'both',mode 传 'destroy' 回落会话模式),
    // 于是模型基于一个它没要求的结果继续推理。
    if (declaredEnum !== null) {
      declaredCounts.enumFields += 1;
      const exposedEnum = properties[field]?.enum;
      if (!Array.isArray(exposedEnum)) {
        findings.push({
          code: 'SCHEMA_ENUM_NOT_EXPOSED',
          tool: descriptor.name,
          field,
          declared,
          declaredEnum,
          message: `工具 ${descriptor.name} 字段 ${field} 声明为枚举`
            + `(${declaredEnum.join(' | ')}),但投影出的 schema 没有 enum 列表。`
            + ' 模型不知道合法取值集合。'
        });
      } else {
        const missing = declaredEnum.filter((value) => !exposedEnum.includes(value));
        const extra = exposedEnum.filter((value) => !declaredEnum.includes(value));
        if (missing.length > 0 || extra.length > 0) {
          findings.push({
            code: 'SCHEMA_ENUM_MISMATCH',
            tool: descriptor.name,
            field,
            declaredEnum,
            exposedEnum,
            ...(missing.length > 0 ? { missing } : {}),
            ...(extra.length > 0 ? { extra } : {}),
            message: `工具 ${descriptor.name} 字段 ${field} 的枚举取值与声明不符。`
          });
        }
      }
      // 运行期必须真的拒绝集合外的值,否则 enum 只是装饰。
      const probeInput = {};
      for (const [otherField, otherDeclared] of Object.entries(shape)) {
        if (otherField === field) continue;
        if (otherDeclared.endsWith('?')) continue;
        const otherBare = otherDeclared.slice(0);
        probeInput[otherField] = PLACEHOLDER[otherBare] ?? 'x';
      }
      probeInput[field] = '__not_a_valid_enum_value__';
      const enumVerdict = validateToolInput(shape, probeInput);
      if (enumVerdict.ok) {
        findings.push({
          code: 'ENUM_NOT_ENFORCED',
          tool: descriptor.name,
          field,
          declaredEnum,
          message: `工具 ${descriptor.name} 字段 ${field} 声明了枚举并投影给模型,`
            + ' 但 validateToolInput 放过了集合外的取值。'
            + ' 宣告的约束必须与运行期强制的一致。'
        });
      } else if (!declaredEnum.every((value) => enumVerdict.message.includes(value))) {
        findings.push({
          code: 'ENUM_REJECTION_OMITS_VALUES',
          tool: descriptor.name,
          field,
          declaredEnum,
          rejection: enumVerdict.message,
          message: `工具 ${descriptor.name} 字段 ${field} 取值非法时的拒绝信息没有`
            + `列全合法取值(实际:${enumVerdict.message})。模型无法自我纠正。`
        });
      }

      // 判据⑧:声明的每个取值,handler 侧必须真的接受。
      //
      // 判据⑦只比对「声明 ↔ 投影」两侧是否一致,声明本身变宽时两侧会一致地
      // 变宽 —— 实测把 direction 声明成 enum:from|to|both|sideways 时判据⑦
      // 全绿,而 asReferenceDirection 只认三个值,sideways 会被静默回落成
      // both。模型照 schema 传了一个「合法」值,拿回的却是它没要求的方向。
      // 故必须拿 handler 的归一化函数做反向对钉。
      const normalizer = ENUM_NORMALIZERS[`${descriptor.name}.${field}`];
      if (normalizer) {
        enumAcceptanceProbes += 1;
        for (const value of declaredEnum) {
          const accepted = normalizer(value);
          if (accepted !== value) {
            findings.push({
              code: 'ENUM_VALUE_NOT_ACCEPTED',
              tool: descriptor.name,
              field,
              value,
              normalizedTo: accepted,
              message: `工具 ${descriptor.name} 字段 ${field} 声明取值 ${value} 合法,`
                + ` 但 handler 的归一化把它变成了 ${JSON.stringify(accepted)}。`
                + ' 模型会以为自己传的值生效了。'
            });
          }
        }
      } else {
        findings.push({
          code: 'ENUM_NORMALIZER_UNREGISTERED',
          tool: descriptor.name,
          field,
          message: `工具 ${descriptor.name} 字段 ${field} 声明了枚举,但本门禁的`
            + ' ENUM_NORMALIZERS 里没有对应的 handler 归一化函数。'
            + ' 无法证明声明的取值 handler 真的接受 —— 缺判据必须失败关闭,'
            + '否则新增枚举字段会绕过判据⑧。'
        });
      }
    }

    // 判据③:required 与可选性一致。
    const inRequired = required.includes(field);
    if (optional && inRequired) {
      findings.push({
        code: 'SCHEMA_OPTIONAL_MARKED_REQUIRED',
        tool: descriptor.name,
        field,
        declared,
        message: `工具 ${descriptor.name} 字段 ${field} 声明为可选(${declared}),`
          + ' 但投影把它放进了 required。'
      });
    }
    if (!optional && !inRequired) {
      findings.push({
        code: 'SCHEMA_REQUIRED_FIELD_NOT_MARKED',
        tool: descriptor.name,
        field,
        declared,
        required,
        message: `工具 ${descriptor.name} 字段 ${field} 是必填(${declared}),`
          + ' 但投影的 required 列表里没有它。模型会以为可以省略。'
      });
    }
  }

  // 判据⑤:不得凭空造字段。
  for (const field of Object.keys(properties)) {
    if (!Object.prototype.hasOwnProperty.call(shape, field)) {
      findings.push({
        code: 'SCHEMA_INVENTED_FIELDS',
        tool: descriptor.name,
        field,
        declaredFields: Object.keys(shape),
        message: `工具 ${descriptor.name} 投影出了未声明的字段 ${field}。`
          + ' 运行期 validateToolInput 不认识它,模型的输入会被静默忽略。'
      });
    }
  }
}

// 判据⑨:整个 input 即某个已知类型的工具,其必填字段必须与该类型的必填
// 字段一致。
//
// 判据②③只比对「声明 ↔ 投影」,声明本身漏字段时两侧一致地漏,门禁全绿
// ——实测把 validate_patch 退回 `{ changes: 'array' }` 时判据①-⑧全过。
// 而那正是本轮修掉的原始缺陷:模型照 schema 只传 changes,
// build_patch_graph 返回 ok:true 却带着 "op:undefined" 的污染图,
// validate_patch 返回 ok:true 内层却是 PATCH_IR_MISSING_WORKSPACE。
// 外层 ok:true 会被 agent loop 当成调用成功。
//
// 判据需要独立第二源,不能重述声明。PatchProposal 的必填字段以
// packages/shared/src/types.ts 的接口定义为准(非 `?:` 的成员)。
const WHOLE_INPUT_TYPES = Object.freeze({
  validate_patch: 'PatchProposal',
  build_patch_graph: 'PatchProposal'
});

/**
 * 类型定义标为必填、但实测省略后运行期结果完全相同的成员,允许声明成可选。
 *
 * 2026-08-08 实测:对 PatchProposal 只传 opId + workspaceId + changes,
 * dryRunPatchProposal 得到 ok=true 零诊断,buildGraphPatchFromProposal 的
 * summary 与传全字段逐字符相同("op=op1 files=1 resources=0 edges=1");
 * 逐个补 title / author / mode / createdAt 均无任何差异。
 *
 * 让模型必须编造一个对结果无影响的 createdAt 只是增加出错面。但这份豁免
 * 必须逐字段列举而不是整类放宽 —— 新增成员默认仍按必填校验,漏声明会红。
 * 这里放的每一个都对应一次实测,不是「看起来不重要」。
 */
const WHOLE_INPUT_OPTIONAL_EXEMPTIONS = Object.freeze({
  'PatchProposal.title': '实测省略后 dryRun 零诊断、graph summary 逐字符相同',
  'PatchProposal.author': '同上;author 只影响审计标注,不影响校验结果',
  'PatchProposal.mode': '同上;工具按 context.mode 兜底,已另有 enum 约束',
  'PatchProposal.createdAt': '同上;时间戳由引擎侧记录,模型编造无意义'
});

/** 从 shared 的接口定义里提取必填成员名(非 `?:`)。 */
function requiredMembersOfInterface(interfaceName) {
  const typesPath = join(root, 'packages', 'shared', 'src', 'types.ts');
  if (!existsSync(typesPath)) return null;
  const text = readFileSync(typesPath, 'utf8');
  const start = text.indexOf(`export interface ${interfaceName} {`);
  if (start < 0) return null;
  const open = text.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return null;
  const body = text.slice(open + 1, end);
  const members = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
    const match = /^([A-Za-z_$][\w$]*)(\??)\s*:/.exec(line);
    if (!match) continue;
    if (match[2] === '?') continue;
    members.push(match[1]);
  }
  return members.length > 0 ? members : null;
}

for (const [toolName, interfaceName] of Object.entries(WHOLE_INPUT_TYPES)) {
  const descriptor = descriptors.find((entry) => entry.name === toolName);
  if (!descriptor) continue;
  const requiredMembers = requiredMembersOfInterface(interfaceName);
  if (requiredMembers === null) {
    report({
      ok: false, gate: LABEL, status: 'failed', code: 'WHOLE_INPUT_TYPE_UNREADABLE',
      message: `无法从 packages/shared/src/types.ts 提取 ${interfaceName} 的必填成员;`
        + '判据⑨的第二源不可读必须失败关闭,否则该判据会退化成必然通过。'
    }, 1);
  }
  const declaredFields = new Set(Object.keys(descriptor.inputSchema ?? {}));
  const declaredRequired = new Set(
    Object.entries(descriptor.inputSchema ?? {})
      .filter(([, declared]) => !declared.endsWith('?'))
      .map(([field]) => field)
  );
  for (const member of requiredMembers) {
    if (!declaredFields.has(member)) {
      findings.push({
        code: 'WHOLE_INPUT_REQUIRED_FIELD_UNDECLARED',
        tool: toolName,
        interfaceName,
        field: member,
        declaredFields: [...declaredFields],
        message: `工具 ${toolName} 的整个 input 就是 ${interfaceName},`
          + ` 而 ${interfaceName}.${member} 是必填成员,但 inputSchema 没有声明它。`
          + ' 模型会以为不用传,拿回一个外层 ok:true 内层失败或含 undefined 的结果。'
      });
      continue;
    }
    if (!declaredRequired.has(member)) {
      const exemption = WHOLE_INPUT_OPTIONAL_EXEMPTIONS[`${interfaceName}.${member}`];
      if (exemption) {
        exemptionsApplied.push({ field: `${interfaceName}.${member}`, evidence: exemption });
        continue;
      }
      findings.push({
        code: 'WHOLE_INPUT_REQUIRED_FIELD_OPTIONAL',
        tool: toolName,
        interfaceName,
        field: member,
        message: `工具 ${toolName} 把 ${interfaceName}.${member} 声明成可选,`
          + ' 但该成员在类型定义里是必填,且不在实测豁免清单里。'
          + ' 要么声明成必填,要么先实测省略它不改变运行期结果再加豁免。'
      });
    }
  }
}

// 豁免清单不得腐烂:每条豁免必须真的对应一个「类型必填、声明可选」的字段。
// 字段改名或类型定义变化后,残留豁免会悄悄放宽判据⑨。
for (const key of Object.keys(WHOLE_INPUT_OPTIONAL_EXEMPTIONS)) {
  if (!exemptionsApplied.some((entry) => entry.field === key)) {
    findings.push({
      code: 'STALE_OPTIONAL_EXEMPTION',
      field: key,
      message: `豁免清单里的 ${key} 本轮没有被用到 —— 说明该成员已不是`
        + '「类型必填但声明可选」的情形(改名、类型定义变了、或声明已收紧)。'
        + ' 残留豁免会在下次漏声明时静默放宽判据⑨。'
    });
  }
}

// 判据⑥:与运行期强制器同源。逐个必填字段构造「只缺这一个」的输入,
// validateToolInput 必须拒绝且拒绝信息里含该字段名。这一条把 schema 与
// 运行期强制钉在一起。
let enforcementProbes = 0;
for (const descriptor of descriptors) {
  const shape = descriptor.inputSchema;
  if (!shape) continue;
  const requiredFields = Object.entries(shape)
    .filter(([, declared]) => !declared.endsWith('?'))
    .map(([field]) => field);
  if (requiredFields.length === 0) continue;

  for (const omitted of requiredFields) {
    const input = {};
    for (const [field, declared] of Object.entries(shape)) {
      if (field === omitted) continue;
      if (declared.endsWith('?')) continue;
      const bare = declared.endsWith('?') ? declared.slice(0, -1) : declared;
      // 枚举字段必须填一个合法取值,否则拒绝原因会是「取值非法」而不是
      // 「缺少必填字段」,判据⑥就测不到它想测的东西。
      if (bare.startsWith('enum:')) {
        input[field] = bare.slice('enum:'.length).split('|')[0];
        continue;
      }
      input[field] = PLACEHOLDER[bare] ?? 'x';
    }
    enforcementProbes += 1;
    // 直接调 validateToolInput 而不是 registry.run:run 会进入 handler,
    // 那需要真实 workspaceIndex。要证明的是「required 声明被强制」这一层。
    const verdict = validateToolInput(shape, input);
    if (verdict.ok) {
      findings.push({
        code: 'REQUIRED_FIELD_NOT_ENFORCED',
        tool: descriptor.name,
        field: omitted,
        input,
        message: `工具 ${descriptor.name} 的字段 ${omitted} 被声明为必填并投影进`
          + ' required,但 validateToolInput 在它缺失时仍然放过。'
          + ' schema 宣告的契约与运行期强制的契约不是同一套。'
      });
    } else if (!verdict.message.includes(omitted)) {
      findings.push({
        code: 'REJECTION_OMITS_FIELD_NAME',
        tool: descriptor.name,
        field: omitted,
        rejection: verdict.message,
        message: `工具 ${descriptor.name} 缺少 ${omitted} 时的拒绝信息里没有该字段名`
          + `(实际:${verdict.message})。模型无法从失败中恢复。`
      });
    }
  }
}

// 提取失败必须失败关闭,否则判据会退化成必然通过。
if (descriptors.length === 0) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'NO_TOOLS_REGISTERED',
    message: '生产注册表返回零个工具;提取失败必须失败关闭,否则本门禁全部判据空转。'
  }, 1);
}
if (declaredCounts.fields === 0) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'NO_DECLARED_FIELDS',
    message: '17 个工具里没有任何一个声明了 inputSchema 字段;'
      + '零样本会让判据②③⑤⑥全部恒真。'
  }, 1);
}
if (enforcementProbes === 0) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'NO_ENFORCEMENT_PROBES',
    message: '没有构造出任何必填字段探针;判据⑥空转。'
  }, 1);
}
if (Object.keys(ENUM_NORMALIZERS).length === 0) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'NO_ENUM_NORMALIZERS',
    message: '生产侧未导出 ENUM_FIELD_NORMALIZERS;判据⑧无从对钉,'
      + '声明的枚举取值 handler 是否真的接受将无人校验。'
  }, 1);
}
if (declaredCounts.enumFields === 0) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'NO_ENUM_FIELDS',
    message: '没有任何 enum: 声明字段;判据⑦零样本恒真。'
      + ' 已知至少 4 个字段是枚举语义(find_references.direction、'
      + 'propose_text_patch.mode、assess_edit_risk 的 parseStatus 与 changeKind)'
      + ',它们退回裸 string 会让非法取值静默回落默认值。'
  }, 1);
}

if (findings.length > 0) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'AGENT_TOOL_SCHEMA_VIOLATION',
    message: '生产 AI 工具向模型暴露的 parametersJsonSchema 与 registry 声明不一致。',
    toolCount: descriptors.length,
    declaredCounts,
    enforcementProbes,
    enumAcceptanceProbes,
    findings
  }, 1);
}

report({
  ok: true,
  gate: LABEL,
  status: 'passed',
  message: `${descriptors.length} 个生产工具的 parametersJsonSchema 与 registry 声明逐字段一致。`,
  toolCount: descriptors.length,
  declaredCounts,
  enforcementProbes,
  enumAcceptanceProbes,
  wholeInputTypesChecked: Object.keys(WHOLE_INPUT_TYPES),
  optionalExemptionsApplied: exemptionsApplied,
  sample: bridge.tools
    .filter((tool) => Object.keys(tool.parametersJsonSchema.properties ?? {}).length > 0)
    .slice(0, 3)
    .map((tool) => ({ name: tool.name, schema: tool.parametersJsonSchema })),
  nonClaim: '本门禁证明四件事:registry 声明的字段名与类型确实到达模型;'
    + 'required 声明与 validateToolInput 同源;枚举取值逐个到达且 handler 真的接受;'
    + '整个 input 即已知类型的两个工具,其必填字段与 shared 的接口定义一致。'
    + ' 不证明的:字段名起得是否合理;'
    + '「整个 input 即某类型」以外的工具其 run 体是否真的读取了声明字段'
    + '(WHOLE_INPUT_TYPES 只覆盖 validate_patch / build_patch_graph);'
    + 'assess_edit_risk.file 的内层必填字段(ToolInputShape 是 Record<string,string>,'
    + '表达不了嵌套形状,该处靠 run 体显式检查并返回结构化诊断);'
    + '以及模型据此是否一定调用正确。'
}, 0);
