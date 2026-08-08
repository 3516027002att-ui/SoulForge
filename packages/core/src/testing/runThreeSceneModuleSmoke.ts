/**
 * 共享 scene IR 契约的**源码文本级**检查。
 *
 * ⚠️ 本文件的断言是源码文本级，不构成运行期证据。
 *
 * 本轮（2026-08-08）删掉两部分，理由是实测对账：
 *   - renderer 侧 18 个 token 的 grep（mountThreeProxyScene / mountFlverScene /
 *     WebGPURenderer / rendererFactory / resourceAudit / dispose / setSelected …）
 *     已由 `npm run test:three-scene-functional` 在运行期真实覆盖：
 *     apps/desktop/src/renderer/src/scene/runThreeSceneFunctionalSmoke.ts（446 行）
 *     真 import mountFlverScene / mountThreeProxyScene / resolveRendererBackend，
 *     真跑后端选择（WebGPU-first + WebGL2 fallback）、真数 dispose 调用计数、
 *     真验 SCENE_ABSOLUTE_PATH_LEAK 时整体释放而非泄漏。
 *     符号存在性由真实执行证明，再 grep 一遍是冗余门禁——而冗余门禁也是技术债：
 *     它让「覆盖」看起来比实际多一份。
 *   - 原 :58 `if (rendererSource.includes('projection only') === false)` 断言的是
 *     一句**英文注释散文**。改写注释即误红，代码行为一字未改；反过来，只要注释里
 *     留着这三个词，控制器真的把 THREE.Object3D 当权威场景文档（违反硬约束 18）
 *     也照样报绿。判据打在注释上等于没打——与 T2-2 处理过的
 *     `never returns a path-bearing` 是同一形态。硬约束 18 的实质保障在
 *     test:three-scene-functional 与 test:scene-draw-list（语义场景与投影分离）。
 *
 * 保留的是 shared scene-ir 契约的 must-exist：任何 renderer 都必须消费这批字段与
 * 诊断码。must-exist 的失效方式是「改名即红」，属安全方向，保留 grep 有意义。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function main(): void {
  const sharedPath = resolve('../../packages/shared/src/scene-ir.ts');
  const sharedSource = readFileSync(sharedPath, 'utf8');
  const sharedTokens = [
    'schemaVersion: 2',
    'sourcePath: string',
    'revision: string',
    'SCENE_PROJECTION_PARTIAL',
    'SCENE_IDENTITY_FALLBACK',
    'packetId: string'
  ];
  for (const token of sharedTokens) {
    if (!sharedSource.includes(token)) throw new Error(`shared scene IR missing ${token}`);
  }

  console.log(JSON.stringify({
    ok: true,
    message: '共享 scene IR 契约结构验证通过（must-exist）',
    evidence: 'source-text-only',
    sharedContract: 'packages/shared/src/scene-ir.ts',
    mustExistTokens: sharedTokens.length,
    delegatedTo: 'npm run test:three-scene-functional（后端选择/资源释放/投影行为——真实执行）；npm run test:scene-draw-list（语义场景与渲染投影分离）',
    nonClaims: [
      '本套件只做源码文本匹配，不构成运行期证据。',
      '不声明 renderer 投影层行为正确——那由 test:three-scene-functional 真实执行覆盖。',
      '不声明硬约束 18（renderer object 不得作为权威场景文档）已被本套件保障；'
      + '原先那条 includes(\'projection only\') 注释散文判据已删除，它对实现零判别力。'
    ]
  }, null, 2));
}

main();
