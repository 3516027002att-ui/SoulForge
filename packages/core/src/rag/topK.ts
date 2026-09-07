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
  const leftChars = [...left];
  const rightChars = [...right];
  const length = Math.min(leftChars.length, rightChars.length);
  for (let index = 0; index < length; index += 1) {
    const leftCodePoint = leftChars[index]!.codePointAt(0)!;
    const rightCodePoint = rightChars[index]!.codePointAt(0)!;
    if (leftCodePoint !== rightCodePoint) return leftCodePoint < rightCodePoint ? -1 : 1;
  }
  return leftChars.length - rightChars.length;
}
