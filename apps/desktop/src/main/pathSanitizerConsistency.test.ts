/**
 * S13：sanitizer 只打码路径片段 —— preload 与 main 必须共用 shared 的
 * maskPathFragments 同一规则，不得各自维护一套路径正则（两侧规则漂移
 * 会让 preload 漏一类载荷而 main 不漏，或反之）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { stripPathFields } from '../preload/resultTransforms.js';
import { sanitizeRendererValue } from './rendererDto.js';

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), 'apps', 'desktop', 'src', relativePath), 'utf8');
}

describe('S13 sanitizer 同一规则（preload 与 main）', () => {
  const preloadSource = readSource('preload/index.ts');
  const preloadTransformSource = readSource('preload/resultTransforms.ts');
  const mainSource = readSource('main/rendererDto.ts');
  const sharedSource = readFileSync(
    join(process.cwd(), 'packages', 'shared', 'src', 'path-sanitizer.ts'),
    'utf8'
  );

  it('generated preload 使用共享规则的 resultTransforms，main 同样从 shared 引入', () => {
    // 允许与其他符号合并 import，只钉「来自 shared 的唯一来源」。
    assert.match(preloadSource, /import \{[^}]*\bstripPathFields\b[^}]*\} from '\.\/resultTransforms\.js'/);
    assert.match(preloadTransformSource, /import \{[^}]*\bmaskPathFragments\b[^}]*\} from '@soulforge\/shared'/);
    assert.match(mainSource, /import \{[^}]*\bmaskPathFragments\b[^}]*\} from '@soulforge\/shared'/);
  });

  it('preload 不再自带路径检测正则（两侧同一规则）', () => {
    for (const source of [preloadSource, preloadTransformSource]) {
      assert.doesNotMatch(source, /containsWindowsDrivePath/);
      assert.doesNotMatch(source, /containsUncOrDevicePath/);
      assert.doesNotMatch(source, /containsAbsoluteFileUri/);
    }
  });

  it('main 的字符串 sanitizer 只打码片段（调用 maskPathFragments，不做整条替换）', () => {
    assert.match(mainSource, /return maskPathFragments\(value\);/);
  });

  it('shared 规则本体：片段替换 + 工作区 URI 不打码', () => {
    assert.match(sharedSource, /MASKED_PATH_PLACEHOLDER/);
    assert.match(sharedSource, /file:\/\/\/workspace/);
    assert.match(sharedSource, /替换为占位符，上下文原样保留/);
  });

  it('实际 preload/main transform 都隐藏路径片段并保留诊断上下文与逻辑 URI', () => {
    for (const [input, expected] of [
      ['写入失败：D:\\workspace\\mod\\a.fmg 被占用', '写入失败：[本机路径已隐藏] 被占用'],
      ['占用（\\\\?\\UNC\\host\\share\\b.fmg）', '占用（[本机路径已隐藏]）'],
      ['\\\\.\\device\\volume\\x', '[本机路径已隐藏]'],
      ['来源 file:///D:/game/msg/item.fmg 未索引', '来源 [本机路径已隐藏] 未索引'],
      ['目标 D:\\游戏\\mods\\a.fmg。请重试', '目标 [本机路径已隐藏]。请重试'],
      ['file:///workspace/a.fmg', 'file:///workspace/a.fmg'],
      ['字段定义来源未授信，拒绝写入。', '字段定义来源未授信，拒绝写入。'],
      ['', '']
    ]) {
      assert.equal(stripPathFields(input), expected);
      assert.equal(sanitizeRendererValue(input), expected);
    }
    const payload = { absolutePath: 'private', nested: [{ sourcePath: 'private', message: '来源 D:\\game\\a.fmg 未索引' }] };
    const expected = { nested: [{ message: '来源 [本机路径已隐藏] 未索引' }] };
    assert.deepEqual(stripPathFields(payload), expected);
    assert.deepEqual(sanitizeRendererValue(payload), expected);
  });

  it('main 保留源码内容中的路径字面量，同时继续隐藏诊断中的真实路径', () => {
    const source = 'const example = "D:\\game\\content.fmg";';
    const sourceKeys = ['dslTemplate', 'sourcePrefix', 'sliceText', 'draft', 'nextDslTemplate', 'text'];
    const payload = Object.fromEntries(sourceKeys.map((key) => [key, source]));
    assert.deepEqual(sanitizeRendererValue(payload), payload);
    assert.deepEqual(sanitizeRendererValue({ message: source }), { message: 'const example = "[本机路径已隐藏]";' });
  });
});
