import type { Language } from '../../../shared/types';
import type { RouterQuotaSnapshot } from '../../../shared/routerTypes';

function timeLabel(ts: number | null, language: Language): string {
  if (!ts) return language === 'zh-CN' ? '未查询' : 'Never';
  return new Date(ts).toLocaleTimeString(language === 'zh-CN' ? 'zh-CN' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function RouterQuotaCard({
  quota,
  language,
  onOpenRouter,
}: {
  quota: RouterQuotaSnapshot;
  language: Language;
  onOpenRouter: () => void;
}) {
  const zh = language === 'zh-CN';
  return (
    <section className="glass-card router-quota-mini">
      <div className="router-quota-mini-head">
        <div style={{ minWidth: 0 }}>
          <div className="router-quota-mini-title">
            <span className={`home-quota-dot ${quota.error ? 'danger' : 'good'}`} />
            {quota.providerName}
          </div>
          <div className="router-quota-mini-sub">{quota.strategyLabel ?? quota.strategyId ?? (zh ? '路由余量' : 'Router quota')}</div>
        </div>
        <button type="button" className="router-quota-mini-link" onClick={onOpenRouter}>
          {zh ? '控制台' : 'Console'}
        </button>
      </div>

      {quota.error ? <div className="router-quota-mini-error">{quota.error}</div> : null}

      {quota.balance !== null ? (
        <div className="router-quota-mini-balance">
          <span>{zh ? '余额' : 'Balance'}</span>
          <strong className="mono">
            {quota.balance.toFixed(2)} {quota.currency ?? ''}
          </strong>
        </div>
      ) : null}

      {quota.windows.map((window) => {
        const remaining = Math.max(0, 100 - window.usedPercent);
        return (
          <div className="router-quota-mini-window" key={window.id}>
            <div className="router-quota-mini-row">
              <span>{window.label}</span>
              <span className="mono">
                {zh ? '剩余' : 'left'} {remaining.toFixed(0)}%
              </span>
            </div>
            <div className="quota-track" style={{ height: 5, margin: '5px 0 0' }}>
              <div
                className={`quota-fill ${remaining <= 10 ? 'danger' : remaining <= 30 ? 'warn' : ''}`}
                style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }}
              />
            </div>
          </div>
        );
      })}

      {quota.windows.length === 0 && quota.balance === null && !quota.error ? (
        <div className="router-quota-mini-empty">
          {zh ? '策略尚未返回数据；到路由控制台刷新余量。' : 'No data yet; refresh quota in the router console.'}
        </div>
      ) : null}

      <div className="router-quota-mini-foot">
        {zh ? '查询于' : 'Queried'} {timeLabel(quota.queriedAt, language)}
      </div>
    </section>
  );
}
