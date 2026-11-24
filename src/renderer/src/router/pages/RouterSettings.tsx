import { useEffect, useState } from 'react';
import { FolderOpen, RefreshCw, Save, Trash2 } from 'lucide-react';
import type { RouterState } from '../../../../shared/routerTypes';
import { Field } from '../components';

export function RouterSettings({
  state,
  onChanged,
}: {
  state: RouterState;
  onChanged: () => void;
}) {
  const [enabled, setEnabled] = useState(state.balance.enabled);
  const [sessionAffinity, setSessionAffinity] = useState(state.balance.sessionAffinity);
  const [quotaGuard, setQuotaGuard] = useState(state.balance.quotaGuard);
  const [maxAttempts, setMaxAttempts] = useState(String(state.balance.maxAttempts));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEnabled(state.balance.enabled);
    setSessionAffinity(state.balance.sessionAffinity);
    setQuotaGuard(state.balance.quotaGuard);
    setMaxAttempts(String(state.balance.maxAttempts));
  }, [state.balance]);

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      await window.tokenMonitor.saveRouterBalance({
        enabled,
        sessionAffinity,
        quotaGuard,
        maxAttempts: Number(maxAttempts),
      });
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="router-page">
      <div className="router-toolbar">
        <button type="button" className="router-btn primary" onClick={() => void save()} disabled={busy}>
          {busy ? <RefreshCw size={14} className="spin" /> : <Save size={14} />}
          {busy ? '保存中…' : '保存'}
        </button>
      </div>

      {error ? <div className="router-banner danger">{error}</div> : null}

      <div className="router-card">
        <div className="router-card-head compact">
          <div>
            <div className="router-card-title">负载均衡与故障转移</div>
            <div className="router-card-sub">关闭总开关后退化为单渠道直连；失败重试只发生在尚未向客户端写出任何字节时。</div>
          </div>
        </div>
        <div className="router-form-grid">
          <Field label="总开关">
            <label className="router-check">
              <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
              启用多渠道路由
            </label>
          </Field>
          <Field label="会话亲和" hint="同一会话固定同一渠道，提升上游 prompt cache 命中">
            <label className="router-check">
              <input type="checkbox" checked={sessionAffinity} onChange={(event) => setSessionAffinity(event.target.checked)} />
              开启会话亲和
            </label>
          </Field>
          <Field label="额度前置拦截" hint="余量耗尽或余额 ≤ 0 的渠道直接跳过">
            <label className="router-check">
              <input type="checkbox" checked={quotaGuard} onChange={(event) => setQuotaGuard(event.target.checked)} />
              开启额度拦截
            </label>
          </Field>
          <Field label="最大尝试渠道数" hint="1-5；包含首次尝试">
            <input
              className="router-input mono"
              value={maxAttempts}
              onChange={(event) => setMaxAttempts(event.target.value.replace(/\D/g, ''))}
            />
          </Field>
        </div>
      </div>

      <div className="router-card">
        <div className="router-card-head compact">
          <div>
            <div className="router-card-title">数据与维护</div>
            <div className="router-card-sub">日志保留 7 天；用量日聚合永久保留，小时聚合随日志清理。</div>
          </div>
        </div>
        <div className="router-settings-actions">
          <button type="button" className="router-btn" onClick={() => void window.tokenMonitor.openDataFolder()}>
            <FolderOpen size={14} />
            打开数据目录
          </button>
          <button
            type="button"
            className="router-btn danger"
            onClick={async () => {
              if (!window.confirm('清空全部请求日志？用量聚合不会被删除。')) return;
              await window.tokenMonitor.clearRouterLogs();
              onChanged();
            }}
          >
            <Trash2 size={14} />
            清空请求日志
          </button>
        </div>
        <div className="router-hint">
          路由器数据保存在 <code>router.db</code>（SQLite WAL）；提供商 Key 使用系统 DPAPI/Keychain 加密，仅主进程可读。
        </div>
      </div>
    </div>
  );
}
