/**
 * 分页页大小的唯一来源。
 *
 * 为什么必须放在 shared：这些值同时被三方消费——
 *   - 主进程 `apps/desktop/src/main/ipc.ts` 的分页 channel（服务端窗口口径）；
 *   - renderer 各工作台面板（请求页大小 + 「每页 N」文案）；
 *   - e2e 的 `apps/desktop/e2e/editorFunctionalSmokeMain.mjs`（harness 侧 channel）。
 *
 * 此前三处各写一遍字面量。任一侧改动都**没有编译错误**，症状是分页错位或末页
 * 重复——即渲染出的页内容与导航元数据对不上，而这类错位不会抛异常，只会让用户
 * 看到一份「看起来完整」的错数据。这正是硬约束 7 意义上不可接受的形态：界面
 * 声称的「第 N 页 / 共 M 页」与实际服务的窗口不是同一个口径。
 *
 * 只收**跨进程契约**的页大小。纯 renderer 内部的分页粒度（Hex 每行字节数、
 * PARAM 字段表每页字段数）不放这里：它们没有对侧消费者，收进来只会增加一层
 * 无去重收益的间接引用。
 */

/** FMG 条目分页：`resource.readFmgPage`。 */
export const FMG_PAGE_SIZE = 100;

/** PARAM 行分页：`resource.readParamPage`。 */
export const PARAM_PAGE_SIZE = 20;

/** 容器子项分页：`resource.listContainerChildrenPage`。 */
export const CONTAINER_PAGE_SIZE = 50;

/** 脚本容器条目分页：`resource.listScriptContainerEntriesPage`。 */
export const SCRIPT_PAGE_SIZE = 50;
