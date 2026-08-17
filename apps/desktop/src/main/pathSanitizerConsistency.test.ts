/**
 * S13：sanitizer 只打码路径片段 —— preload 与 main 必须共用 shared 的
 * maskPathFragments 同一规则，不得各自维护一套路径正则（两侧规则漂移
 * 会让 preload 漏一类载荷而 main 不漏，或反之）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), 'apps', 'desktop', 'src', relativePath), 'utf8');
}

describe('S13 sanitizer 同一规则（preload 与 main）', () => {
  const preloadSource = readSource('preload/index.ts');
  const mainSource = readSource('main/rendererDto.ts');
  const sharedSource = readFileSync(
    join(process.cwd(), 'packages', 'shared', 'src', 'path-sanitizer.ts'),
    'utf8'
  );

  it('preload 与 main 都从 shared 引入 maskPathFragments', () => {
    // 允许与其他符号合并 import，只钉「来自 shared 的唯一来源」。
    assert.match(preloadSource, /import \{[^}]*\bmaskPathFragments\b[^}]*\} from '@soulforge\/shared'/);
    assert.match(mainSource, /import \{[^}]*\bmaskPathFragments\b[^}]*\} from '@soulforge\/shared'/);
  });

  it('preload 不再自带路径检测正则（两侧同一规则）', () => {
    assert.doesNotMatch(preloadSource, /containsWindowsDrivePath/);
    assert.doesNotMatch(preloadSource, /containsUncOrDevicePath/);
    assert.doesNotMatch(preloadSource, /containsAbsoluteFileUri/);
  });

  it('main 的字符串 sanitizer 只打码片段（调用 maskPathFragments，不做整条替换）', () => {
    assert.match(mainSource, /return maskPathFragments\(value\);/);
  });

  it('shared 规则本体：片段替换 + 工作区 URI 不打码', () => {
    assert.match(sharedSource, /MASKED_PATH_PLACEHOLDER/);
    assert.match(sharedSource, /file:\/\/\/workspace/);
    assert.match(sharedSource, /替换为占位符，上下文原样保留/);
  });
});
