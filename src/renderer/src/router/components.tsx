import { useEffect, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { formatTokens } from '../format';

/**
 * Every dialog that uses this modal closes via its footer (关闭/取消) or the
 * overlay click — no header X, so there is no fragile tiny click target.
 */
export function RouterModal({
  title,
  subtitle,
  children,
  footer,
  onClose,
  width = 580,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  width?: number;
}) {
  return (
    <div className="router-overlay" onMouseDown={onClose}>
      <div className="router-modal" style={{ width }} onMouseDown={(event) => event.stopPropagation()}>
        <div className="router-modal-head">
          <div>
            <div className="router-modal-title">{title}</div>
            {subtitle ? <div className="router-modal-sub">{subtitle}</div> : null}
          </div>
        </div>
        <div className="router-modal-body">{children}</div>
        {footer ? <div className="router-modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="router-field">
      <span className="router-field-label">{label}</span>
      <div className="router-field-control">{children}</div>
      {hint ? <span className="router-field-hint">{hint}</span> : null}
    </div>
  );
}

export function RouterStat({
  label,
  value,
  hint,
  tone,
  action,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'good' | 'warn' | 'danger';
  action?: ReactNode;
}) {
  return (
    <div className="router-stat">
      {action ? <div className="router-stat-action">{action}</div> : null}
      <div className={`router-stat-value ${tone ?? ''}`}>{value}</div>
      <div className="router-stat-label">{label}</div>
      {hint ? <div className="router-stat-hint">{hint}</div> : null}
    </div>
  );
}

export function RouterBadge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'good' | 'warn' | 'danger';
  children: ReactNode;
}) {
  return <span className={`router-badge ${tone}`}>{children}</span>;
}

export function RouterEmpty({ title, body }: { title: string; body: string }) {
  return (
    <div className="router-empty">
      <div className="router-empty-title">{title}</div>
      <div className="router-empty-body">{body}</div>
    </div>
  );
}

export function formatRouterTime(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatRouterDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatRouterTokens(value: number): string {
  return formatTokens(value);
}

export function CopyButton({ text, label = '复制', iconOnly = false }: { text: string; label?: string; iconOnly?: boolean }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  if (iconOnly) {
    return (
      <button
        type="button"
        className="router-icon-btn copy-infield"
        title={label}
        aria-label={label}
        onClick={() => {
          void navigator.clipboard
            .writeText(text)
            .then(() => setCopied(true))
            .catch(() => undefined);
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    );
  }

  return (
    <button
      type="button"
      className="router-btn ghost sm"
      title={label}
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => setCopied(true))
          .catch(() => undefined);
      }}
    >
      {copied ? '已复制' : label}
    </button>
  );
}

export function statusTone(status: number | null): 'neutral' | 'good' | 'warn' | 'danger' {
  if (status === null) return 'neutral';
  if (status >= 200 && status < 300) return 'good';
  if (status >= 400 && status < 500) return 'warn';
  if (status >= 500) return 'danger';
  return 'neutral';
}
