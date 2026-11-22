import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, Ref } from 'react';
import { Icon, type IconName } from './Icon';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  ref?: Ref<HTMLButtonElement>;
}) {
  const sizeClass = size === 'md' ? '' : ` ${size}`;
  return (
    <button
      type="button"
      className={`rx-btn ${variant}${sizeClass}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function IconButton({
  size = 'md',
  icon,
  label,
  title,
  active,
  className = '',
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> & {
  size?: ButtonSize;
  icon: IconName;
  label: string;
  active?: boolean;
  ref?: Ref<HTMLButtonElement>;
}) {
  const sizeClass = size === 'md' ? '' : ` ${size}`;
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      aria-pressed={active}
      className={`rx-ibtn${sizeClass}${active ? ' active' : ''}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      <Icon name={icon} size={size === 'sm' ? 14 : size === 'lg' ? 18 : 16} />
    </button>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  shortcut,
  className = '',
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: string;
  onChange: (value: string) => void;
  shortcut?: string;
}) {
  return (
    <div className={`rx-input${className ? ` ${className}` : ''}`}>
      <Icon name="search" size={15} />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        {...rest}
      />
      {shortcut ? <span className="rx-kbd">{shortcut}</span> : null}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className = '',
}: {
  options: ReadonlyArray<{ value: T; label: ReactNode; title?: string; disabled?: boolean }>;
  value: T;
  onChange: (next: T) => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div className={`rx-seg${className ? ` ${className}` : ''}`} role="group" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-pressed={value === opt.value}
          title={opt.title}
          disabled={opt.disabled}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  className = '',
}: {
  items: ReadonlyArray<{ value: T; label: ReactNode; badge?: number | string }>;
  value: T;
  onChange: (next: T) => void;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div className={`rx-tabs${className ? ` ${className}` : ''}`} role="tablist" aria-label={ariaLabel}>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-selected={value === item.value}
          onClick={() => onChange(item.value)}
        >
          <span>{item.label}</span>
          {item.badge !== undefined && Number(item.badge) > 0 ? (
            <span className="rx-badge num">{item.badge}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export type ChipTone = 'good' | 'warn' | 'bad' | 'info' | 'accent' | 'mute';

export function Chip({
  tone = 'mute',
  icon,
  spin,
  children,
  className = '',
  title,
}: {
  tone?: ChipTone;
  icon?: IconName;
  spin?: boolean;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span className={`rx-chip ${tone}${className ? ` ${className}` : ''}`} title={title}>
      {icon ? <Icon name={icon} size={13} className={spin ? 'rx-spin' : undefined} /> : null}
      {children}
    </span>
  );
}

export function CiteBadge({
  label,
  kind = 'page',
  onClick,
  title,
}: {
  label: string;
  kind?: 'page' | 'figure';
  onClick?: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      className="rx-cite num"
      onClick={onClick}
      title={title ?? `跳转到 ${label}`}
    >
      <Icon name={kind === 'figure' ? 'image' : 'file'} size={12} />
      <span>{label}</span>
    </button>
  );
}

export function ProgressBar({ value, max = 100 }: { value: number; max?: number }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className="rx-progress">
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

export function ProgressRing({
  value,
  max = 100,
  size = 22,
  color = 'var(--color-info)',
}: {
  value: number;
  max?: number;
  size?: number;
  color?: string;
}) {
  const pct = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0.35;
  const circumference = 2 * Math.PI * 9;
  const dash = `${(pct * circumference).toFixed(1)} ${circumference.toFixed(1)}`;
  return (
    <svg className="rx-ring" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="var(--color-line-strong)" strokeWidth="2.5" />
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke={color}
        strokeWidth="2.5"
        strokeDasharray={dash}
        strokeLinecap="round"
        transform="rotate(-90 12 12)"
      />
    </svg>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: IconName;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="rx-empty">
      {icon ? (
        <span className="rx-empty-icon" aria-hidden="true">
          <Icon name={icon} size={22} />
        </span>
      ) : (
        <svg
          width="120"
          height="80"
          viewBox="0 0 120 80"
          fill="none"
          stroke="var(--color-line-strong)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="30" y="14" width="44" height="56" rx="3" transform="rotate(-8 52 42)" />
          <rect x="44" y="10" width="44" height="56" rx="3" />
          <path d="M52 22h28M52 30h28M52 38h20M52 52h28M52 58h16" />
          <path d="M96 60l10 10M101 51v-6M108 58h6" />
        </svg>
      )}
      <h4>{title}</h4>
      {description ? <p>{description}</p> : null}
      {action}
    </div>
  );
}

export function Skeleton({ width = '100%' }: { width?: string }) {
  return <div className="rx-skel" style={{ width }} aria-hidden="true" />;
}
