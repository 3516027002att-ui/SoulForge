/**
 * 欢迎层只在「还没有工作区」时作为空态出现。
 *
 * 旧条件是 openTabs.length === 0：打开工作区后仍盖住开始页和工作台，
 * 半透明 --forge-0 让两层文字叠在一起，并且拦截全部点击。
 */
export function shouldShowEditorWelcome(input: {
  hasWorkspace: boolean;
  openTabCount: number;
}): boolean {
  return !input.hasWorkspace && input.openTabCount === 0;
}
