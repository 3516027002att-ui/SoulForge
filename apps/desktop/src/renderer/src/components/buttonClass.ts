/**
 * 按钮类名。Button 组件和不经 React 的 DOM 按钮（如 CodeMirror 提示里的修复按钮）共用，
 * 两边的外观和禁用规则才不会分叉。样式在 Button.css。
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'sm';

export interface ButtonClassOptions {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  className?: string | undefined;
}

export function buttonClass({ variant = 'secondary', size = 'md', className }: ButtonClassOptions = {}): string {
  return ['ui-btn', `ui-btn--${variant}`, `ui-btn--${size}`, ...(className ? [className] : [])].join(' ');
}
