export interface RankedItem {
  readonly id: string;
  readonly score: number;
}

export class RankingError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RankingError';
    this.code = code;
  }
}

/** Best-first comparator with a locale-independent code-point tie break. */
export function compareRanked<T extends RankedItem>(left: T, right: T): number {
  if (left.score !== right.score) return right.score - left.score;
  return compareCodePointText(left.id, right.id);
}

/**
 * Keep only the best k items.  The heap root is the worst retained item, so a
 * full scan costs O(n log k) and uses O(k) additional storage.
 */
export function topK<T extends RankedItem>(iterable: Iterable<T>, k: number): T[] {
  if (!Number.isSafeInteger(k) || k < 0) {
    throw new RankingError('INVALID_INTEGER', 'topK 的 k 必须是非负安全整数。');
  }
  if (k === 0) return [];

  const heap: T[] = [];
  const isWorse = (left: T, right: T): boolean => compareRanked(left, right) > 0;

  const siftUp = (index: number): void => {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      const current = heap[index];
      const parentItem = heap[parent];
      if (current === undefined || parentItem === undefined || !isWorse(current, parentItem)) break;
      heap[index] = parentItem;
      heap[parent] = current;
      index = parent;
    }
  };

  const siftDown = (index: number): void => {
    for (;;) {
      let target = index;
      const left = index * 2 + 1;
      const right = left + 1;
      const targetItem = heap[target];
      const leftItem = heap[left];
      const rightItem = heap[right];
      if (targetItem === undefined) break;
      if (leftItem !== undefined && isWorse(leftItem, targetItem)) target = left;
      const nextTarget = heap[target];
      if (rightItem !== undefined && nextTarget !== undefined && isWorse(rightItem, nextTarget)) target = right;
      if (target === index) break;
      const replacement = heap[target];
      if (replacement === undefined) break;
      heap[index] = replacement;
      heap[target] = targetItem;
      index = target;
    }
  };

  for (const item of iterable) {
    if (typeof item.id !== 'string' || item.id.length === 0) {
      throw new RankingError('EMPTY_IDENTITY', 'topK 项必须包含非空稳定 id。');
    }
    if (!Number.isFinite(item.score)) {
      throw new RankingError('INVALID_SCORE', `topK 项 ${item.id} 的 score 不是有限数。`);
    }
    if (heap.length < k) {
      heap.push(item);
      siftUp(heap.length - 1);
      continue;
    }
    const worst = heap[0];
    if (worst !== undefined && compareRanked(item, worst) < 0) {
      heap[0] = item;
      siftDown(0);
    }
  }
  return heap.sort(compareRanked);
}

/** Strict cosine contract used by the vector retrieval path. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) {
    throw new RankingError('VECTOR_DIMENSION', '向量维度必须相同且大于零。');
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined || right === undefined || !Number.isFinite(left) || !Number.isFinite(right)) {
      throw new RankingError('VECTOR_NONFINITE', '向量分量必须是有限数。');
    }
    dot += left * right;
    normA += left * left;
    normB += right * right;
    if (!Number.isFinite(dot) || !Number.isFinite(normA) || !Number.isFinite(normB)) {
      throw new RankingError('VECTOR_NORM', '向量计算发生数值溢出。');
    }
  }
  if (normA <= 0 || normB <= 0) {
    throw new RankingError('VECTOR_NORM', '零范数向量不能参与 cosine 检索。');
  }
  const result = dot / Math.sqrt(normA) / Math.sqrt(normB);
  if (!Number.isFinite(result)) throw new RankingError('VECTOR_NORM', 'cosine 结果不是有限数。');
  return Math.max(-1, Math.min(1, result));
}

/** Compatibility name for callers that previously imported the model client helper. */
export const cosineSimilarity = cosine;

export function compareCodePointText(left: string, right: string): number {
  let leftIndex = 0;
  let rightIndex = 0;
  let leftCodePointCount = 0;
  let rightCodePointCount = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftFirst = left.charCodeAt(leftIndex);
    const rightFirst = right.charCodeAt(rightIndex);
    const leftSecond = leftIndex + 1 < left.length ? left.charCodeAt(leftIndex + 1) : 0;
    const rightSecond = rightIndex + 1 < right.length ? right.charCodeAt(rightIndex + 1) : 0;
    const leftIsPair = leftFirst >= 0xd800 && leftFirst <= 0xdbff
      && leftSecond >= 0xdc00 && leftSecond <= 0xdfff;
    const rightIsPair = rightFirst >= 0xd800 && rightFirst <= 0xdbff
      && rightSecond >= 0xdc00 && rightSecond <= 0xdfff;
    const leftCodePoint = leftIsPair
      ? 0x10000 + ((leftFirst - 0xd800) << 10) + (leftSecond - 0xdc00)
      : leftFirst;
    const rightCodePoint = rightIsPair
      ? 0x10000 + ((rightFirst - 0xd800) << 10) + (rightSecond - 0xdc00)
      : rightFirst;
    if (leftCodePoint !== rightCodePoint) return leftCodePoint < rightCodePoint ? -1 : 1;
    leftIndex += leftIsPair ? 2 : 1;
    rightIndex += rightIsPair ? 2 : 1;
    leftCodePointCount += 1;
    rightCodePointCount += 1;
  }
  if (leftIndex === left.length && rightIndex === right.length) return 0;
  if (leftIndex === left.length) {
    while (rightIndex < right.length) {
      rightIndex += codePointWidth(right, rightIndex);
      rightCodePointCount += 1;
    }
  } else {
    while (leftIndex < left.length) {
      leftIndex += codePointWidth(left, leftIndex);
      leftCodePointCount += 1;
    }
  }
  return leftCodePointCount - rightCodePointCount;
}

function codePointWidth(text: string, index: number): 1 | 2 {
  const first = text.charCodeAt(index);
  if (first >= 0xd800 && first <= 0xdbff && index + 1 < text.length) {
    const second = text.charCodeAt(index + 1);
    if (second >= 0xdc00 && second <= 0xdfff) return 2;
  }
  return 1;
}
