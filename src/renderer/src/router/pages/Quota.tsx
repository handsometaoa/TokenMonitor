import { RefreshCw } from 'lucide-react';
import type { RouterQuotaSnapshot } from '../../../../shared/routerTypes';
import { RouterBadge, formatRouterTime } from '../components';

function QuotaWindowRow({ window }: { window: RouterQuotaSnapshot['windows'][number] }) {
  const remaining = Math.max(0, 100 - window.usedPercent);
  return (
    <div className="router-quota-window">
      <div className="router-quota-row">
        <span>{window.label}</span>
        <span className="mono">{window.usedPercent.toFixed(0)}% used</span>
      </div>
      <div className="router-progress">
        <div
          className={`router-progress-fill ${remaining <= 10 ? 'danger' : remaining <= 30 ? 'warn' : ''}`}
          style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }}
        />
      </div>
      <div className="router-quota-meta">
        <span>剩余 {remaining.toFixed(0)}%</span>
        <span>{window.resetsAt ? `重置 ${formatRouterTime(window.resetsAt)}` : '重置时间未知'}</span>
      </div>
    </div>
  );
}

export function Quota({
  quota,
  onRefresh,
}: {
  quota: RouterQuotaSnapshot[];
  onRefresh: () => void;
}) {
  return (
    <div className="router-page">
      <div className="router-toolbar">
        <button type="button" className="router-btn" onClick={onRefresh}>
          <RefreshCw size={14} />
          刷新余量
        </button>
      </div>

      {quota.length === 0 ? (
        <div className="router-card">
          <div className="router-empty-inline">还没有绑定余量策略。到「提供商」编辑一个提供商，选择余量策略即可。</div>
        </div>
      ) : (
        <div className="router-quota-grid">
          {quota.map((item) => (
            <div className="router-card quota" key={item.providerId}>
              <div className="router-card-head compact">
                <div>
                  <div className="router-card-title">{item.providerName}</div>
                  <div className="router-card-sub">{item.strategyLabel ?? item.strategyId ?? '未绑定策略'}</div>
                </div>
                {item.error ? <RouterBadge tone="danger">异常</RouterBadge> : <RouterBadge tone="good">正常</RouterBadge>}
              </div>
              {item.error ? <div className="router-banner danger">{item.error}</div> : null}
              {item.balance !== null ? (
                <div className="router-quota-balance">
                  <span>余额</span>
                  <strong>
                    {item.balance.toFixed(2)} {item.currency ?? ''}
                  </strong>
                </div>
              ) : null}
              <div className="router-quota-windows">
                {item.windows.map((window) => (
                  <QuotaWindowRow key={window.id} window={window} />
                ))}
                {item.windows.length === 0 && !item.error ? (
                  <div className="router-empty-inline">策略尚未返回窗口数据。</div>
                ) : null}
              </div>
              {item.details.length > 0 ? (
                <div className="router-quota-details">
                  {item.details.map((detail) => (
                    <div key={`${detail.label}-${detail.value}`}>
                      <span>{detail.label}</span>
                      <strong className="mono">{detail.value}</strong>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="router-quota-foot">查询于 {formatRouterTime(item.queriedAt)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
