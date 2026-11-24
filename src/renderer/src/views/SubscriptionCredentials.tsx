import { useEffect, useState } from 'react';
import { Check, ExternalLink, KeyRound, RefreshCw } from 'lucide-react';
import type {
  AppState,
  CredentialDetection,
  CredentialTestResult,
  ExtraProviderId,
} from '../../../shared/types';
import { EXTRA_PROVIDER_IDS } from '../../../shared/types';
import { EXTRA_PROVIDER_NAMES, EXTRA_PROVIDER_URLS } from '../../../shared/providers';
import { Banner, SectionCard, Spinner } from '../components/ui';
import { RouterBadge } from '../router/components';

/**
 * 订阅额度凭证管理：自动检测本机登录态（~/.codex/auth.json 等）+ 手动粘贴覆盖。
 * 该能力只用于查询订阅余量，不参与网关转发；转发用的 API Key 在路由控制台「提供商」页配置。
 */
export function SubscriptionCredentials({
  state,
  language,
  onChanged,
}: {
  state: AppState;
  language: 'zh-CN' | 'en';
  onChanged: () => void;
}) {
  const zh = language === 'zh-CN';
  const [busy, setBusy] = useState<'detect' | 'use' | 'save' | null>(null);
  const [detection, setDetection] = useState<CredentialDetection | null>(null);
  const [result, setResult] = useState<CredentialTestResult | null>(null);
  const [providerInputs, setProviderInputs] = useState<Record<ExtraProviderId, string>>({
    codex: '',
    claude: '',
    cursor: '',
    zai: '',
    zcode: '',
  });
  const [providerBusy, setProviderBusy] = useState<ExtraProviderId | null>(null);

  useEffect(() => {
    setProviderInputs({ codex: '', claude: '', cursor: '', zai: '', zcode: '' });
  }, [state.version]);

  const detect = async () => {
    setBusy('detect');
    setResult(null);
    try {
      setDetection(await window.tokenMonitor.detectCredential());
      onChanged();
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const saveProviderSecret = async (providerId: ExtraProviderId) => {
    const secret = providerInputs[providerId].trim();
    if (!secret) return;
    setProviderBusy(providerId);
    try {
      await window.tokenMonitor.setProviderSecret(providerId, secret);
      setProviderInputs((current) => ({ ...current, [providerId]: '' }));
      onChanged();
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setProviderBusy(null);
    }
  };

  const clearProviderSecret = async (providerId: ExtraProviderId) => {
    setProviderBusy(providerId);
    try {
      await window.tokenMonitor.clearProviderSecret(providerId);
      onChanged();
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setProviderBusy(null);
    }
  };

  const providerHint = (providerId: ExtraProviderId): string => {
    switch (providerId) {
      case 'codex':
        return zh
          ? '自动读取 ~/.codex/auth.json 的 OAuth 登录；失效后可粘贴 access token。'
          : 'Reads the OAuth login from ~/.codex/auth.json; paste an access token to override.';
      case 'claude':
        return zh
          ? '自动读取 ~/.claude/.credentials.json；也可粘贴 Claude Code OAuth Token。'
          : 'Reads ~/.claude/.credentials.json; paste a Claude Code OAuth token to override.';
      case 'cursor':
        return zh
          ? '粘贴 cursor.com 的 Cookie header（含 WorkosCursorSessionToken），或 Cursor session token。'
          : 'Paste the cursor.com Cookie header (including WorkosCursorSessionToken), or a Cursor session token.';
      case 'zai':
        return zh
          ? 'API Key 默认使用 api.z.ai（Global）。团队 BigModel 版可粘贴 JSON：{"apiKey","organizationId","projectId","region":"bigmodel-cn"}。'
          : 'API key defaults to api.z.ai (Global). For team BigModel, paste JSON: {"apiKey","organizationId","projectId","region":"bigmodel-cn"}.';
      case 'zcode':
        return zh
          ? '自动读取 ~/.zcode/v2/config.json 的 Coding Plan 凭证；团队版可粘贴含 organizationId/projectId 的 JSON 覆盖。'
          : 'Reads Coding Plan credentials from ~/.zcode/v2/config.json; override team plans with JSON containing organizationId/projectId.';
      default:
        return '';
    }
  };

  const providerPlaceholder = (providerId: ExtraProviderId): string => {
    switch (providerId) {
      case 'cursor':
        return zh ? 'Cookie header 或 session token' : 'Cookie header or session token';
      case 'zai':
      case 'zcode':
        return zh ? 'API Key 或 JSON（团队版）' : 'API key or team JSON';
      default:
        return zh ? 'OAuth access token' : 'OAuth access token';
    }
  };

  const sourceLabel = (source: string): string => {
    switch (source) {
      case 'manual':
        return zh ? '手动凭证' : 'Manual';
      case 'env':
        return zh ? '环境变量' : 'Environment';
      case 'auth-file':
        return zh ? '本机登录态' : 'Local sign-in';
      case 'zcode':
        return zh ? 'ZCode 本机配置' : 'ZCode config';
      case 'auto':
        return zh ? '自动检测' : 'Auto';
      default:
        return zh ? '未连接' : 'Not connected';
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Banner tone="info">
        {zh
          ? '这些凭证用于查询订阅余量（自动检测本机登录态），与网关转发的 API Key 相互独立。'
          : 'These credentials query subscription quota (auto-detected from local sign-in); they are independent from gateway API keys.'}
      </Banner>

      <SectionCard
        title={zh ? 'OpenCode Go 凭证' : 'OpenCode Go credential'}
        subtitle={zh ? '额度总览的数据来源' : 'Source of the quota overview'}
        action={
          <button type="button" className="router-btn" onClick={() => void detect()} disabled={busy !== null}>
            {busy === 'detect' ? <Spinner size={13} /> : <KeyRound size={13} />}
            {zh ? '重新检测' : 'Detect'}
          </button>
        }
      >
        <div className="settings-row" style={{ paddingTop: 0 }}>
          <div className="settings-row-copy">
            <strong>
              {state.credentials.configured
                ? zh
                  ? '已连接'
                  : 'Connected'
                : zh
                  ? '未配置'
                  : 'Not configured'}
            </strong>
            <span className="mono">{state.credentials.masked ?? '—'}</span>
            <span>
              {state.credentials.kind === 'manual'
                ? zh ? '手动凭证' : 'Manual'
                : state.credentials.kind === 'env'
                  ? zh ? '环境变量' : 'Environment'
                  : state.credentials.kind === 'auth-file'
                    ? zh ? '本机登录态' : 'Local sign-in'
                    : zh ? '未检测' : 'Not detected'}
            </span>
          </div>
          <div className="settings-control">
            <span className={`router-badge ${state.credentials.configured ? 'good' : 'warn'}`}>
              {state.credentials.configured ? (zh ? '正常' : 'OK') : zh ? '未配置' : 'Missing'}
            </span>
          </div>
        </div>
        {detection ? (
          detection.found ? (
            <Banner tone="info">
              {zh ? `检测到本机凭证 ${detection.masked ?? ''}，额度监控将自动使用。` : `Detected local credential ${detection.masked ?? ''}.`}
            </Banner>
          ) : (
            <Banner tone="warn">{detection.message}</Banner>
          )
        ) : null}
        {result ? (
          <div style={{ marginTop: 10 }}>
            <Banner tone={result.ok ? 'info' : 'danger'}>{result.ok ? (result.message ?? (zh ? '已保存。' : 'Saved.')) : result.message}</Banner>
          </div>
        ) : null}
      </SectionCard>

      {EXTRA_PROVIDER_IDS.map((providerId) => {
        const provider = state.extraProviders.find((item) => item.providerId === providerId) ?? null;
        const configured = Boolean(provider?.configured);
        const snapshot = provider?.snapshot ?? null;
        return (
          <SectionCard
            key={providerId}
            title={EXTRA_PROVIDER_NAMES[providerId]}
            subtitle={providerHint(providerId)}
            action={
              <span className={`router-badge ${configured ? 'good' : 'warn'}`}>
                {configured ? sourceLabel(provider?.source ?? 'none') : zh ? '未连接' : 'Not connected'}
              </span>
            }
          >
            <div className="settings-row" style={{ paddingTop: 0 }}>
              <div className="settings-row-copy">
                <strong>{snapshot?.planLabel ?? (zh ? '未连接' : 'Not connected')}</strong>
                <span>
                  {provider?.error && !snapshot
                    ? provider.error.message
                    : snapshot
                      ? `${zh ? '更新于' : 'Updated'} ${new Date(snapshot.fetchedAt).toLocaleString()}`
                      : providerHint(providerId)}
                </span>
              </div>
              <div className="settings-control">
                <button
                  type="button"
                  className="router-btn"
                  onClick={() => void window.tokenMonitor.openExternal(EXTRA_PROVIDER_URLS[providerId])}
                >
                  <ExternalLink size={12} />
                  {zh ? '控制台' : 'Console'}
                </button>
              </div>
            </div>

            <div style={{ marginTop: 4 }}>
              <div className="key-row">
                <input
                  className="field"
                  type="password"
                  value={providerInputs[providerId]}
                  onChange={(event) =>
                    setProviderInputs((current) => ({ ...current, [providerId]: event.target.value }))
                  }
                  placeholder={providerPlaceholder(providerId)}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="router-btn primary"
                  disabled={!providerInputs[providerId].trim() || providerBusy === providerId}
                  onClick={() => void saveProviderSecret(providerId)}
                >
                  {providerBusy === providerId ? <Spinner size={12} /> : <Check size={12} />}
                  {zh ? '保存' : 'Save'}
                </button>
                {configured ? (
                  <button
                    type="button"
                    className="router-btn"
                    disabled={providerBusy === providerId}
                    onClick={() => void clearProviderSecret(providerId)}
                  >
                    <RefreshCw size={12} />
                    {zh ? '清除手动' : 'Clear manual'}
                  </button>
                ) : null}
              </div>
              <div className="hint" style={{ marginTop: 5 }}>
                {providerId === 'zai' || providerId === 'zcode'
                  ? zh
                    ? '个人 Key 直接粘贴；BigModel 团队版粘贴 JSON（apiKey + organizationId + projectId）。'
                    : 'Paste a personal key directly; for BigModel team plans paste JSON with apiKey + organizationId + projectId.'
                  : zh
                    ? '凭证使用系统加密保存，不会写入日志或渲染进程。'
                    : 'Credentials are encrypted with the OS keystore and never sent to the renderer.'}
              </div>
            </div>
          </SectionCard>
        );
      })}
    </div>
  );
}
