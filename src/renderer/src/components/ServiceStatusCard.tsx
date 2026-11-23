import { Activity, ExternalLink } from 'lucide-react';
import type { Language, ServiceStatus } from '../../../shared/types';
import { Chip } from './ui';

function statusLabel(status: string, language: Language): string {
  const zh = language === 'zh-CN';
  const normalized = status.toLowerCase();
  if (['operational', 'none', 'ok'].includes(normalized)) return zh ? '正常' : 'Operational';
  if (['degraded_performance', 'minor', 'partial_outage', 'under_maintenance'].includes(normalized)) {
    return normalized === 'under_maintenance' ? (zh ? '维护中' : 'Maintenance') : zh ? '降级' : 'Degraded';
  }
  if (['major_outage', 'major'].includes(normalized)) return zh ? '中断' : 'Outage';
  if (normalized === 'critical') return zh ? '严重中断' : 'Critical';
  return zh ? '未知' : 'Unknown';
}

function toneFor(status: string): 'good' | 'warn' | 'danger' | 'neutral' {
  const normalized = status.toLowerCase();
  if (['operational', 'none', 'ok'].includes(normalized)) return 'good';
  if (['degraded_performance', 'minor', 'partial_outage', 'under_maintenance'].includes(normalized)) return 'warn';
  if (['major_outage', 'major', 'critical'].includes(normalized)) return 'danger';
  return 'neutral';
}

function overall(statuses: ServiceStatus[], language: Language): { label: string; tone: 'good' | 'warn' | 'danger' | 'neutral' } {
  if (statuses.some((status) => status.indicator === 'critical' || status.indicator === 'major')) {
    return { label: language === 'zh-CN' ? '服务异常' : 'Service issues', tone: 'danger' };
  }
  if (statuses.some((status) => status.indicator === 'minor' || status.incidentCount > 0)) {
    return { label: language === 'zh-CN' ? '部分降级' : 'Partial degradation', tone: 'warn' };
  }
  return { label: language === 'zh-CN' ? '运行正常' : 'Operational', tone: 'good' };
}

export function ServiceStatusCard({
  statuses,
  language,
  onOpenExternal,
}: {
  statuses: ServiceStatus[];
  language: Language;
  onOpenExternal: (url: string) => void;
}) {
  if (statuses.length === 0) return null;
  const summary = overall(statuses, language);
  return (
    <div className="soft-card" style={{ padding: '13px 15px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 650 }}>
          <Activity size={14} />
          {language === 'zh-CN' ? '服务状态' : 'Service status'}
        </div>
        <Chip tone={summary.tone}>{summary.label}</Chip>
      </div>

      {statuses.map((status) => {
        const incidentLabel =
          status.incidentCount > 0
            ? language === 'zh-CN'
              ? `${status.incidentCount} 个事件`
              : `${status.incidentCount} incident${status.incidentCount === 1 ? '' : 's'}`
            : '';
        const components = status.components
          .filter((component) => component.status !== 'operational')
          .slice(0, 4);
        return (
          <div key={status.providerId} style={{ padding: '8px 0', borderTop: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                <span
                  className="pace-dot"
                  style={{
                    background:
                      status.indicator === 'major' || status.indicator === 'critical'
                        ? 'var(--danger)'
                        : status.indicator === 'minor'
                          ? 'var(--warn)'
                          : status.indicator === 'none'
                            ? 'var(--good)'
                            : 'var(--faint)',
                  }}
                />
                <span style={{ fontSize: 12, fontWeight: 620 }}>{status.providerName}</span>
                <span className="faint" style={{ fontSize: 10.5 }}>
                  {status.error ? (language === 'zh-CN' ? '状态页不可用' : 'Status unavailable') : status.description}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                {incidentLabel ? <Chip tone={status.indicator === 'none' ? 'neutral' : toneFor(status.indicator)}>{incidentLabel}</Chip> : null}
                <button
                  type="button"
                  className="icon-btn"
                  style={{ width: 24, height: 24 }}
                  title={language === 'zh-CN' ? '打开状态页' : 'Open status page'}
                  onClick={() => onOpenExternal(status.url)}
                >
                  <ExternalLink size={12} />
                </button>
              </div>
            </div>
            {components.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginTop: 5, paddingLeft: 13 }}>
                {components.map((component) => (
                  <span key={component.name} className="legend-item" style={{ fontSize: 10 }}>
                    <span className="legend-dot" style={{ background: toneFor(component.status) === 'danger' ? 'var(--danger)' : toneFor(component.status) === 'warn' ? 'var(--warn)' : 'var(--good)' }} />
                    {component.name} · {statusLabel(component.status, language)}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
