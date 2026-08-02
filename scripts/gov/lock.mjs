/**
 * 治理数据的跨进程互斥锁。
 *
 * 为什么必须是文件锁而不是进程内变量：并行 agent 是**独立进程**，进程内锁
 * 对它们完全无效。两个 agent 同时读到同一份 slices.json、各自改完再写回，
 * 后写的会静默覆盖先写的 claim——两个 agent 都认为自己独占了同一个切片。
 *
 * 为什么用 openSync(..., 'wx') 而不是「先 existsSync 再创建」：后者在
 * 检查与创建之间有窗口，两个进程可以同时通过检查。'wx' 是 O_CREAT|O_EXCL，
 * 由内核保证「创建成功」与「已存在」互斥，这是唯一无竞态的原语。
 *
 * 为什么锁文件在 os.tmpdir() 而不是仓库内：硬约束禁止在 Mod 工作区写旁路
 * 文件；写进仓库还会污染 git status 并进入 trackedDiffSha256 指纹。锁是
 * 运行期协调状态，不是仓库数据。
 */
import { openSync, closeSync, writeSync, readFileSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 死锁回收窗口。持锁进程崩溃时锁文件会留下，必须能被回收，否则一次崩溃
 * 就永久冻结治理写入。但窗口不能太短：正常 claim 含一次完整治理校验，
 * 在冷启动下可能数秒，窗口过短会让并发进程误判存活锁为死锁。
 */
export const STALE_LOCK_MS = 30_000;

function lockPath(root) {
  // 按仓库根路径哈希，避免多个 clone 或多个 worktree 抢同一把锁。
  const key = createHash('sha256').update(root).digest('hex').slice(0, 16);
  return join(tmpdir(), `soulforge-governance-${key}.lock`);
}

function readLockHolder(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // 锁文件不可解析：可能是上一个进程写到一半就崩了。按「无法确认持有者」
    // 处理，交由 staleness 判定决定是否回收，而不是当作无锁直接闯入。
    return null;
  }
}

/**
 * 锁的年龄。
 *
 * 内容里的 acquiredAtMs 是首选来源，但内容损坏时必须有回退——否则「年龄未知」
 * 会被当成「无限旧」而立即回收，等于持锁进程写到一半崩了就能被任意抢锁。
 * 回退用文件 mtime：它由内核维护，损坏的内容影响不到它，因此仍然可判定。
 * 两者都不可得时返回 null，调用方必须按「不可回收」处理。
 */
function lockAgeMs(path, holder) {
  if (Number.isFinite(holder?.acquiredAtMs)) return Date.now() - holder.acquiredAtMs;
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // signal 0 只做权限与存在性探测，不投递信号。
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 表示进程存在但不属于当前用户——存在即视为存活。
    return error.code === 'EPERM';
  }
}

/**
 * 尝试获取锁。
 *
 * @param {string} root 仓库根绝对路径。
 * @param {string} owner 持有者标识，写入锁文件供诊断。
 * @returns {{ ok: true, path: string, release: () => void }
 *          |{ ok: false, code: string, message: string, holder: object|null }}
 */
export function acquireGovernanceLock(root, owner) {
  const path = lockPath(root);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = openSync(path, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') {
        return {
          ok: false,
          code: 'GOV_LOCK_IO_FAIL',
          message: `锁文件不可创建：${error.message}`,
          holder: null
        };
      }

      const holder = readLockHolder(path);
      const ageMs = lockAgeMs(path, holder);
      const alive = processAlive(holder?.pid);

      // 只有「持有者进程已不存在」且「明确超过回收窗口」才回收。三点都必需：
      // pid 可能被系统复用（误判存活），时间窗口单独用会在长任务正常持锁时被
      // 抢走，而年龄不可判定（ageMs===null）必须按不可回收处理——否则「读不出
      // 年龄」就成了绕过互斥的通道。
      if (!alive && ageMs !== null && ageMs > STALE_LOCK_MS) {
        try {
          unlinkSync(path);
        } catch {
          // 竞态下可能已被别的进程回收，下一轮 openSync 会给出准确结果。
        }
        continue;
      }

      return {
        ok: false,
        code: 'GOV_LOCK_HELD',
        message: alive
          ? `治理锁被 pid=${holder?.pid ?? '?'}（owner=${holder?.owner ?? '?'}）持有；请等待或先让其释放。`
          : `治理锁疑似残留但未达回收条件（age=${ageMs === null ? '不可判定' : `${Math.round(ageMs)}ms`}，窗口 ${STALE_LOCK_MS}ms）；稍后重试。`,
        holder
      };
    }

    try {
      writeSync(fd, JSON.stringify({
        pid: process.pid,
        owner,
        acquiredAtMs: Date.now(),
        acquiredAt: new Date().toISOString()
      }));
    } finally {
      closeSync(fd);
    }

    let released = false;
    return {
      ok: true,
      path,
      release() {
        if (released) return;
        released = true;
        try {
          // 只删自己写的锁：若内容里 pid 已不是自己，说明锁已被回收并被
          // 他人持有，此时删除会破坏对方的互斥。
          const holder = readLockHolder(path);
          if (holder?.pid === process.pid && existsSync(path)) unlinkSync(path);
        } catch {
          // 释放失败不能掩盖主流程结果；残留锁会由 staleness 回收。
        }
      }
    };
  }

  return {
    ok: false,
    code: 'GOV_LOCK_CONTENDED',
    message: '连续两次获取治理锁均失败（疑似高并发或残留锁回收竞态）；请重试。',
    holder: readLockHolder(path)
  };
}
