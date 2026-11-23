import type { Language } from '../../shared/types';

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value < 1000) return String(Math.round(value));
  return compact.format(value);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(value));
}

export function formatPercent(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

export function formatCountdown(iso: string | null, now: number, language: Language): string {
  if (!iso) return language === 'zh-CN' ? '重置时间未知' : 'Reset time unknown';
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return language === 'zh-CN' ? '重置时间未知' : 'Reset time unknown';
  const diff = target - now;
  if (diff <= 0) return language === 'zh-CN' ? '等待重置' : 'Waiting for reset';
  const totalMinutes = Math.floor(diff / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (language === 'zh-CN') {
    if (days > 0) return `${days}天${hours}小时`;
    if (hours > 0) return `${hours}小时${minutes}分钟`;
    return `${Math.max(1, minutes)}分钟`;
  }
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}

export function formatAbsolute(iso: string | null, language: Language): string {
  if (!iso) return language === 'zh-CN' ? '未知' : 'Unknown';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return language === 'zh-CN' ? '未知' : 'Unknown';
  return new Intl.DateTimeFormat(language === 'zh-CN' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function formatTime(ts: number | null, language: Language): string {
  if (!ts) return '—';
  return new Intl.DateTimeFormat(language === 'zh-CN' ? 'zh-CN' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(ts));
}

export function formatRelative(ts: number | null, now: number, language: Language): string {
  if (!ts) return language === 'zh-CN' ? '尚未更新' : 'Not updated yet';
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return language === 'zh-CN' ? '刚刚更新' : 'Updated just now';
  if (diff < 60 * 60_000) {
    const n = Math.floor(diff / 60_000);
    return language === 'zh-CN' ? `${n} 分钟前` : `${n} min ago`;
  }
  if (diff < 24 * 60 * 60_000) {
    const n = Math.floor(diff / (60 * 60_000));
    return language === 'zh-CN' ? `${n} 小时前` : `${n} h ago`;
  }
  return new Intl.DateTimeFormat(language === 'zh-CN' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts));
}

export function formatDayLabel(day: string, language: Language): string {
  const [year, month, date] = day.split('-').map(Number);
  if (!year || !month || !date) return day;
  return `${month}/${date}`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatDaily(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(1)}%`;
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
