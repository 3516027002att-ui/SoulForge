/**
 * 分页页大小单一来源的对账测试。
 *
 * 这组断言存在的理由是一个实测缺陷：`apps/desktop/src/main/ipc.ts` 定义
 * FMG 100 / PARAM 20 / CONTAINER 50 / SCRIPT 50，而 renderer 侧 6 处面板与
 * e2e harness 各写一遍同样的字面量。任一侧改动**没有编译错误**，症状是分页错位
 * 或末页重复——渲染出的页内容与导航元数据（第 N 页 / 共 M 页）不是同一个口径，
 * 而这类错位不抛异常，只让用户看到一份「看起来完整」的错数据。
 *
 * 因此这里做的是**双向对账**，不是「常量值等于 100」：
 *   - 值断言（`FMG_PAGE_SIZE === 100`）会随口径调整一起改，挡不住漂移；
 *   - 真正要锁的是「所有消费方都 import 同一个符号，没人再写字面量」。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  CONTAINER_PAGE_SIZE,
  FMG_PAGE_SIZE,
  PARAM_PAGE_SIZE,
  SCRIPT_PAGE_SIZE
} from '@soulforge/shared';

/** 仓库根与 renderer 源码根，由测试入口在编译期注入。 */
declare const __SOULFORGE_REPO_ROOT__: string;

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(__SOULFORGE_REPO_ROOT__, relativePath), 'utf8');
}

/** 每个页大小常量的消费方登记表。 */
const PAGE_SIZE_CONSUMERS: ReadonlyArray<{
  symbol: string;
  files: readonly string[];
}> = [
  {
    symbol: 'FMG_PAGE_SIZE',
    files: [
      'apps/desktop/src/main/ipc.ts',
      // FmgWorkbenchPanel 3-C 起一次拿全表（REVEAL_SCAN_PAGE_SIZE 100000），
      // 不再分页消费该常量（同 PARAM 的 ParamTablePanel 先例）。
      'apps/desktop/e2e/editorFunctionalSmokeMain.mjs'
    ]
  },
  {
    symbol: 'PARAM_PAGE_SIZE',
    files: [
      'apps/desktop/src/main/ipc.ts',
      // ParamDefPanel 已全量渲染行表（问题 5），不再分页消费该常量；PARAM_PAGE_SIZE
      // 只作为跨进程运输契约保留（App 打开一张 param 经 includeAllPayloads 一次取回）。
      'apps/desktop/src/renderer/src/App.tsx',
      'apps/desktop/e2e/editorFunctionalSmokeMain.mjs'
    ]
  },
  {
    symbol: 'CONTAINER_PAGE_SIZE',
    files: [
      'apps/desktop/src/main/ipc.ts',
      'apps/desktop/src/renderer/src/editors/Bnd4WorkbenchPanel.tsx',
      'apps/desktop/e2e/editorFunctionalSmokeMain.mjs'
    ]
  },
  {
    symbol: 'SCRIPT_PAGE_SIZE',
    files: [
      'apps/desktop/src/main/ipc.ts',
      'apps/desktop/src/renderer/src/editors/ScriptContainerPanel.tsx',
      'apps/desktop/e2e/editorFunctionalSmokeMain.mjs'
    ]
  }
];

describe('页大小常量可从 shared 取到', () => {
  it('四个跨进程页大小都是有限正整数', () => {
    for (const [name, value] of [
      ['FMG_PAGE_SIZE', FMG_PAGE_SIZE],
      ['PARAM_PAGE_SIZE', PARAM_PAGE_SIZE],
      ['CONTAINER_PAGE_SIZE', CONTAINER_PAGE_SIZE],
      ['SCRIPT_PAGE_SIZE', SCRIPT_PAGE_SIZE]
    ] as const) {
      assert.ok(Number.isInteger(value) && value > 0, `${name} 必须是正整数，实际 ${value}`);
    }
  });
});

describe('页大小只有一个定义处', () => {
  it('shared 是唯一定义处', () => {
    const source = readRepoFile('packages/shared/src/editor-pagination.ts');
    for (const { symbol } of PAGE_SIZE_CONSUMERS) {
      assert.match(
        source,
        new RegExp(`export const ${symbol} = \\d+`),
        `${symbol} 必须在 shared 定义`
      );
    }
  });

  it('没有任何消费方再自己定义这些常量（这正是双写的形态）', () => {
    const offenders: string[] = [];
    for (const { symbol, files } of PAGE_SIZE_CONSUMERS) {
      for (const file of files) {
        const source = readRepoFile(file);
        // 匹配本地定义：const X = <数字>。import 进来的不会长这样。
        if (new RegExp(`(?:const|let|var)\\s+${symbol}\\s*=\\s*\\d+`).test(source)) {
          offenders.push(`${file}: 本地定义了 ${symbol}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      '本地重新定义会让两侧口径独立漂移，且改一侧没有编译错误'
    );
  });

  it('每个消费方都从 @soulforge/shared import 该符号', () => {
    const missing: string[] = [];
    for (const { symbol, files } of PAGE_SIZE_CONSUMERS) {
      for (const file of files) {
        const source = readRepoFile(file);
        // import 语句可能跨行，故先取出所有从 shared 来的 import 块再查符号。
        const sharedImports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@soulforge\/shared'/g)]
          .map((match) => match[1] ?? '')
          .join(',');
        if (!new RegExp(`\\b${symbol}\\b`).test(sharedImports)) {
          missing.push(`${file}: 未从 shared import ${symbol}`);
        }
      }
    }
    assert.deepEqual(missing, [], '没 import 就说明它在用别的来源——收敛是假的');
  });

  it('对账能发现本地重新定义（负向：注入一份本地定义）', () => {
    const injected = `${readRepoFile('apps/desktop/src/main/ipc.ts')}\nconst FMG_PAGE_SIZE = 999;\n`;
    assert.match(
      injected,
      /(?:const|let|var)\s+FMG_PAGE_SIZE\s*=\s*\d+/,
      '判据必须抓到本地定义，否则上一条断言形同虚设'
    );
  });

  it('对账能发现 import 被摘掉（负向：从 import 块里删掉符号）', () => {
    // FMG 面板 3-C 起全量加载，不再消费 FMG_PAGE_SIZE；负向靶标改用仍在消费它的
    // ipc.ts（多符号 import 块，用通用替换摘掉该标识符）。
    const source = readRepoFile('apps/desktop/src/main/ipc.ts');
    const stripped = source.replace(/\bFMG_PAGE_SIZE\b/g, '');
    assert.notEqual(stripped, source, '注入失败：靶标已变，请更新本用例');
    const sharedImports = [...stripped.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@soulforge\/shared'/g)]
      .map((match) => match[1] ?? '')
      .join(',');
    assert.doesNotMatch(
      sharedImports,
      /\bFMG_PAGE_SIZE\b/,
      '判据必须在 import 被摘掉后报红'
    );
  });
});
