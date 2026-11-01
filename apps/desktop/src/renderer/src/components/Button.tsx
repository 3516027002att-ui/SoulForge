import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react';
import { buttonClass, type ButtonSize, type ButtonVariant } from './buttonClass.js';
import { Icon, type IconName } from './Icon.js';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'aria-pressed'> {
  /** primary 是实心主按钮，一组操作里最多一个；其余用 secondary / ghost。 */
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  icon?: IconName | undefined;
  /** 切换按钮的选中态，输出 aria-pressed。 */
  pressed?: boolean | undefined;
  /** 禁用时说明为什么不能用。悬停提示组件接入前先放进 title。 */
  disabledReason?: string | undefined;
  children?: ReactNode;
}

/**
 * 统一按钮。禁用态只把字色降到 --ink-3、不降透明度：降透明度会把边框和字一起淡到约 2:1，
 * 工具条首屏全禁用时几乎看不见（Button.test.tsx 锁住了这条）。
 */
export function Button({ variant, size, icon, pressed, disabledReason, className, title, disabled, children, ...rest }: ButtonProps): ReactElement {
  return (
    <button
      {...rest}
      type="button"
      className={buttonClass({ variant, size, className })}
      disabled={disabled}
      title={disabled && disabledReason ? disabledReason : title}
      aria-pressed={pressed}
    >
      {icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
      {children}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonProps, 'icon' | 'children' | 'aria-label'> {
  icon: IconName;
  /** 必填：没有可见文字，读屏名和悬停提示都靠它。 */
  label: string;
}

/** 只有图标的方形按钮，默认 ghost。 */
export function IconButton({ icon, label, variant = 'ghost', className, title, ...rest }: IconButtonProps): ReactElement {
  return (
    <Button
      {...rest}
      variant={variant}
      icon={icon}
      aria-label={label}
      title={title ?? label}
      className={className ? `ui-btn--icon ${className}` : 'ui-btn--icon'}
    />
  );
}
