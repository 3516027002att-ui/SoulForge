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
 *      与 validateToolInput 实际强制的是同一套,而不是两份会漂移的副本。
 *
 * 判据⑥是本门禁与「读一遍源码看看有没有 properties」的区别所在:光比对 schema
 * 自身无法发现「schema 写对了但运行期不认」或反之。
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
 */
import { existsSync } from 'node:fs';
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

const { ToolRegistry, createDefaultToolRegistry, validateToolInput } = await import(pathToFileURL(REGISTRY_JS).href);
const { createAgentToolBridge } = await import(pathToFileURL(BRIDGE_JS).href);

const registry = createDefaultToolRegistry();
const descriptors = registry.list();
const bridge = createAgentToolBridge({
  registry,
  // workspaceIndex 只在 run 体内被用到;本门禁只观测 tools 投影与输入校验拒绝,
  // 不触达索引,故传占位。任何走到索引的判据都会抛异常而不是静默通过。
  context: { workspaceIndex: {}, mode: 'fullPermission' }
});

const findings = [];

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
const declaredCounts = { withSchema: 0, zeroArg: 0, fields: 0 };

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

  const expectedTypeFor = (declared) => {
    const bare = declared.endsWith('?') ? declared.slice(0, -1) : declared;
    return ['string', 'number', 'boolean', 'array', 'object'].includes(bare) ? bare : null;
  };

  for (const [field, declared] of Object.entries(shape)) {
    declaredCounts.fields += 1;
    const optional = declared.endsWith('?');
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

// 判据⑥:与运行期强制器同源。逐个必填字段构造「只缺这一个」的输入,
// registry.run 必须拒绝。这一条把 schema 与 validateToolInput 钉在一起。
const PLACEHOLDER = {
  string: 'x',
  number: 1,
  boolean: true,
  array: [],
  object: {}
};

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
      const bare = declared.endsWith('?') ? declared.slice(0, -1) : declared;
      if (declared.endsWith('?')) continue;
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

if (findings.length > 0) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'AGENT_TOOL_SCHEMA_VIOLATION',
    message: '生产 AI 工具向模型暴露的 parametersJsonSchema 与 registry 声明不一致。',
    toolCount: descriptors.length,
    declaredCounts,
    enforcementProbes,
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
  sample: bridge.tools
    .filter((tool) => Object.keys(tool.parametersJsonSchema.properties ?? {}).length > 0)
    .slice(0, 3)
    .map((tool) => ({ name: tool.name, schema: tool.parametersJsonSchema })),
  nonClaim: '本门禁只证明「registry 声明的字段名与类型确实到达模型」以及'
    + '「required 声明与 validateToolInput 同源」。它不证明字段名起得合理、'
    + '不证明 run 体真的读取了这些字段(那需要另一道断言),'
    + '也不证明模型据此就一定调用正确。'
}, 0);
