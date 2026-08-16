/**
 * 事件文档「在飞打开请求」的槽位表。
 *
 * 从 ipc.ts 抽出来的唯一理由是**可测**：这里的不变式（按窗口隔离、到达顺序等于
 * 建槽顺序、归还按身份而非按 key）全都是并发时序性质，埋在 8000 行的 ipc.ts 里
 * 只能靠读代码确认。抽成无 electron 依赖的模块后，窗口 id 只是一个数字，三条
 * 不变式可以直接用单元测试证伪。
 *
 * 不在这里做的事：不 import electron、不碰 webContents。调用方负责把
 * `event.sender.id` 传进来，并在窗口销毁时调 dispose。
 */

/** 一个窗口当前在飞的那次打开。 */
interface EmevdOpenSlot {
  readonly controller: AbortController;
  readonly sourceUri: string;
}

export class EmevdOpenSlots {
  private readonly slots = new Map<number, EmevdOpenSlot>();

  /**
   * 建新槽并中止**同一窗口**的前一份，返回本次的 controller。
   *
   * 必须在 handler 的第一个 `await` 之前同步调用。之前它排在
   * `await prepareBridgeRoots` 后面，于是「谁先开始」和「谁先建槽」脱钩了：两条
   * 打开请求交错时，先到的那条可能因为 root 准备更慢而后建槽，把后到的、更新的
   * 那条反过来取消掉；用户看到的是自己最后点的那个文件静默打不开，而屏幕上留着
   * 上一份。建槽是纯同步的，放到最前面即可让「到达顺序 = 建槽顺序」恒成立。
   *
   * 按 `webContents.id` 分槽而不是共用一个全局槽：全局槽下两个窗口会互相取消，
   * B 窗口打开任何事件文档都会打断 A 窗口正在读的那份，而 A 那边看到的是自己
   * 毫无理由地静默丢弃。窗口之间没有「一次只显示一份」的关系，共享槽位是错的。
   */
  begin(windowId: number, sourceUri: string): AbortController {
    this.slots.get(windowId)?.controller.abort();
    const controller = new AbortController();
    this.slots.set(windowId, { controller, sourceUri });
    return controller;
  }

  /**
   * 主动取消某窗口在飞的那份。返回是否真的中止了一份 —— 没有在飞的读不是错误
   * （用户可能已经读完），调用方据此区分「取消掉了」和「无事可取消」。
   */
  cancel(windowId: number): boolean {
    const slot = this.slots.get(windowId);
    if (!slot || slot.controller.signal.aborted) return false;
    slot.controller.abort();
    return true;
  }

  /**
   * 成功结束后按身份归还槽位，不 abort。
   * 已完成的请求不得再被 cancel 报成「取消成功」。
   */
  finish(windowId: number, sourceUri: string, controller: AbortController): boolean {
    const slot = this.slots.get(windowId);
    if (!slot || slot.controller !== controller || slot.sourceUri !== sourceUri) return false;
    this.slots.delete(windowId);
    return true;
  }

  /**
   * 窗口销毁时清槽。不清的话 Map 会按窗口 id 无界增长，且 controller 连着
   * signal 监听者一起留在内存里。顺带 abort，让那个窗口在飞的读尽早停下 ——
   * 它的结果已经没有接收方了。
   */
  dispose(windowId: number): void {
    const slot = this.slots.get(windowId);
    if (!slot) return;
    slot.controller.abort();
    this.slots.delete(windowId);
  }

  /** 仅供测试与诊断：当前有槽的窗口数。用它断言 dispose 真的回收了。 */
  get size(): number {
    return this.slots.size;
  }
}
