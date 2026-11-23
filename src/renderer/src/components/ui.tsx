import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { LoaderCircle } from 'lucide-react';

export function Chip({
  children,
  tone = 'neutral',
  className = '',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'good' | 'warn' | 'danger';
  className?: string;
}) {
  return <span className={`chip ${tone === 'neutral' ? '' : tone} ${className}`}>{children}</span>;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  wide = false,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  wide?: boolean;
}) {
  return (
    <div className={`segmented ${wide ? 'wide' : ''}`} role="tablist">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`seg-item ${value === option.value ? 'active' : ''}`}
          onClick={() => onChange(option.value)}
          role="tab"
          aria-selected={value === option.value}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled = false,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`toggle ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      aria-pressed={checked}
      aria-label={label}
      role="switch"
    />
  );
}

export function Banner({
  tone = 'neutral',
  icon: Icon,
  children,
  action,
}: {
  tone?: 'neutral' | 'warn' | 'danger' | 'info';
  icon?: LucideIcon;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`banner ${tone === 'neutral' ? '' : tone}`}>
      {Icon ? <Icon size={15} strokeWidth={2} style={{ flex: '0 0 auto', marginTop: 1 }} /> : null}
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
      {action}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon size={21} strokeWidth={1.9} />
      </div>
      <div className="empty-title">{title}</div>
      <div className="empty-body">{body}</div>
      {action ? <div style={{ marginTop: 14 }}>{action}</div> : null}
    </div>
  );
}

export function Spinner({ size = 15 }: { size?: number }) {
  return <LoaderCircle size={size} className="spin" strokeWidth={2} />;
}

export function SectionCard({
  title,
  subtitle,
  children,
  action,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="settings-section">
      <div className="settings-section-head" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div className="settings-section-title">{title}</div>
          {subtitle ? <div className="hint" style={{ marginTop: 3 }}>{subtitle}</div> : null}
        </div>
        {action}
      </div>
      <div className="settings-section-body">{children}</div>
    </section>
  );
}

export function IconButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  className = '',
}: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button type="button" className={`icon-btn no-drag ${className}`} title={label} aria-label={label} onClick={onClick} disabled={disabled}>
      <Icon size={16} strokeWidth={2} />
    </button>
  );
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="stat-card">
      <div className="stat-value mono">{value}</div>
      <div className="stat-label">{label}</div>
      {hint ? <div className="stat-label" style={{ color: 'var(--faint)', marginTop: 2 }}>{hint}</div> : null}
    </div>
  );
}
