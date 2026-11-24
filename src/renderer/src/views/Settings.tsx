import { useEffect, useMemo, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Bell,
  Copy,
  Database,
  ExternalLink,
  FolderOpen,
  GripVertical,
  Info,
  Palette,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import type {
  AppInfo,
  AppState,
  ExtraProviderId,
  HomeCardId,
  UpdateSettingsPatch,
} from '../../../shared/types';
import type { Translator } from '../i18n';
import { formatRelative } from '../format';
import { useNow } from '../hooks';
import { Banner, SectionCard, Segmented, Spinner, Toggle } from '../components/ui';
import { SubscriptionCredentials } from './SubscriptionCredentials';

type SettingsSection = 'general' | 'notifications' | 'appearance' | 'data' | 'about';

const HOME_CARD_LABELS: Record<HomeCardId, { zh: string; en: string }> = {
  quota: { zh: '余量概览', en: 'Quota overview' },
  health: { zh: '路由健康', en: 'Channel health' },
  trend: { zh: '近 7 天用量', en: '7-day usage' },
  recent: { zh: '最近请求', en: 'Recent requests' },
};

interface Notice {
  tone: 'info' | 'danger';
  text: string;
}

const NAV: Array<{ id: SettingsSection; labelKey: Parameters<Translator>[0]; icon: LucideIcon }> = [
  { id: 'general', labelKey: 'settings.general', icon: SlidersHorizontal },
  { id: 'notifications', labelKey: 'settings.notifications', icon: Bell },
  { id: 'appearance', labelKey: 'settings.appearance', icon: Palette },
  { id: 'data', labelKey: 'settings.data', icon: Trash2 },
  { id: 'about', labelKey: 'settings.about', icon: Info },
];

export function SettingsPage({
  state,
  t,
  language,
}: {
  state: AppState;
  t: Translator;
  language: 'zh-CN' | 'en';
}) {
  const [section, setSection] = useState<SettingsSection>('general');
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const now = useNow(30_000);

  useEffect(() => {
    void window.tokenMonitor.getAppInfo().then(setAppInfo).catch(() => undefined);
  }, []);

  const update = async (patch: UpdateSettingsPatch) => {
    setNotice(null);
    try {
      await window.tokenMonitor.updateSettings(patch);
    } catch (error) {
      setNotice({ tone: 'danger', text: error instanceof Error ? error.message : String(error) });
    }
  };

  const credentialSourceLabel = useMemo(() => {
    switch (state.credentials.kind) {
      case 'manual':
        return t('settings.sourceManual');
      case 'env':
        return t('settings.sourceEnv');
      case 'auth-file':
        return t('settings.sourceAuth');
      default:
        return t('settings.sourceNone');
    }
  }, [state.credentials.kind, t]);

  const moveHomeCard = (from: number, to: number) => {
    const current = state.settings.homeCardOrder;
    if (from === to || from < 0 || to < 0 || from >= current.length || to >= current.length) return;
    const next = [...current];
    const [item] = next.splice(from, 1);
    if (!item) return;
    next.splice(to, 0, item);
    void update({ homeCardOrder: next });
  };

  const providerHint = (providerId: ExtraProviderId): string => {
    const zh = language === 'zh-CN';
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

  const sourceLabel = (source: string): string => {
    const zh = language === 'zh-CN';
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
    <div className="settings-shell">
      <aside className="settings-sidebar">
        <div className="settings-brand">
          <span className="brand-mark" style={{ width: 28, height: 28 }} aria-hidden="true">
            <svg width="17" height="17" viewBox="0 0 32 32" fill="none">
              <rect x="5" y="17" width="5.5" height="10" rx="2.2" fill="white" opacity="0.82" />
              <rect x="13.25" y="11" width="5.5" height="16" rx="2.2" fill="white" opacity="0.92" />
              <rect x="21.5" y="5" width="5.5" height="22" rx="2.2" fill="white" />
            </svg>
          </span>
          <div>
            <div className="brand-title">TokenMonitor</div>
            <div className="brand-sub">{t('app.subtitle')}</div>
          </div>
        </div>
        {NAV.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className={`settings-nav-item ${section === item.id ? 'active' : ''}`}
              onClick={() => setSection(item.id)}
            >
              <Icon size={15} strokeWidth={1.9} />
              {t(item.labelKey)}
            </button>
          );
        })}
        <div className="settings-sidebar-footer">
          v{appInfo?.version ?? state.version}
          <br />
          {t('app.official')}
        </div>
      </aside>

      <main className="settings-main">
        <div className="settings-content fade-in" key={section}>
          {notice ? (
            <div style={{ marginBottom: 14 }}>
              <Banner tone={notice.tone === 'danger' ? 'danger' : 'info'}>{notice.text}</Banner>
            </div>
          ) : null}

          {section === 'general' ? (
            <>
              <h1 className="settings-page-title">{t('settings.general')}</h1>
              <p className="settings-page-sub">{t('app.subtitle')}</p>
              <SectionCard title={t('provider.openCodeGo')} subtitle={t('settings.connectionSub')}>
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <strong>{t('settings.credential')}</strong>
                    <span>{credentialSourceLabel}{state.credentials.masked ? ` · ${state.credentials.masked}` : ''}</span>
                  </div>
                  <div className="settings-control">
                    <span className={`chip ${state.credentials.configured ? 'good' : 'warn'}`}>
                      {state.credentials.configured ? t('status.normal') : t('status.off')}
                    </span>
                  </div>
                </div>
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <strong>{t('common.refresh')}</strong>
                    <span>{t('provider.updated', { time: formatRelative(state.quota.fetchedAt, now, language) })}</span>
                  </div>
                  <div className="settings-control">
                    <select
                      className="field"
                      style={{ width: 110, height: 34 }}
                      value={state.settings.refreshMinutes}
                      onChange={(event) => void update({ refreshMinutes: Number(event.target.value) })}
                    >
                      {[1, 5, 10, 15, 30].map((minutes) => (
                        <option key={minutes} value={minutes}>{minutes} min</option>
                      ))}
                    </select>
                    <button type="button" className="btn btn-sm" onClick={() => void window.tokenMonitor.refreshQuota()}>
                      <RefreshCw size={13} />
                      {t('common.refresh')}
                    </button>
                  </div>
                </div>
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <strong>{t('settings.launchAtLogin')}</strong>
                    <span>{t('settings.startHidden')}</span>
                  </div>
                  <div className="settings-control">
                    <Toggle checked={state.settings.launchAtLogin} onChange={(next) => void update({ launchAtLogin: next })} label={t('settings.launchAtLogin')} />
                  </div>
                </div>
                {state.demo ? <Banner tone="info">{t('settings.demoNote')}</Banner> : null}
              </SectionCard>
              <SubscriptionCredentials state={state} language={language} onChanged={() => undefined} />
            </>
          ) : null}

          {section === 'notifications' ? (
            <>
              <h1 className="settings-page-title">{t('settings.notificationsTitle')}</h1>
              <p className="settings-page-sub">{t('settings.notificationsSub')}</p>
              <SectionCard title={t('settings.notificationsTitle')}>
                <div className="switch-row">
                  <div className="switch-copy">
                    <strong>{t('settings.notifyEnabled')}</strong>
                  </div>
                  <Toggle checked={state.settings.notifications.enabled} onChange={(next) => void update({ notifications: { enabled: next } })} label={t('settings.notifyEnabled')} />
                </div>
                <div className="switch-row">
                  <div className="switch-copy">
                    <strong>{t('settings.notifyThresholds')}</strong>
                    <span>20% / 5% remaining</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Toggle
                      checked={state.settings.notifications.remainingThresholds.includes(20)}
                      onChange={(next) => {
                        const current = new Set(state.settings.notifications.remainingThresholds);
                        if (next) current.add(20);
                        else current.delete(20);
                        void update({ notifications: { remainingThresholds: [...current].sort((a, b) => b - a) } });
                      }}
                      label={t('settings.notify20')}
                    />
                    <span className="hint">20%</span>
                    <Toggle
                      checked={state.settings.notifications.remainingThresholds.includes(5)}
                      onChange={(next) => {
                        const current = new Set(state.settings.notifications.remainingThresholds);
                        if (next) current.add(5);
                        else current.delete(5);
                        void update({ notifications: { remainingThresholds: [...current].sort((a, b) => b - a) } });
                      }}
                      label={t('settings.notify5')}
                    />
                    <span className="hint">5%</span>
                  </div>
                </div>
                <div className="switch-row">
                  <div className="switch-copy">
                    <strong>{t('settings.notifyRate')}</strong>
                  </div>
                  <Toggle checked={state.settings.notifications.rateLimited} onChange={(next) => void update({ notifications: { rateLimited: next } })} label={t('settings.notifyRate')} />
                </div>
                <div className="switch-row">
                  <div className="switch-copy">
                    <strong>{t('settings.notifyPace')}</strong>
                  </div>
                  <Toggle checked={state.settings.notifications.pace} onChange={(next) => void update({ notifications: { pace: next } })} label={t('settings.notifyPace')} />
                </div>
              </SectionCard>
            </>
          ) : null}

          {section === 'appearance' ? (
            <>
              <h1 className="settings-page-title">{t('settings.appearanceTitle')}</h1>
              <p className="settings-page-sub">{t('settings.behavior')}</p>
              <SectionCard title={t('settings.appearanceTitle')}>
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <strong>{t('settings.theme')}</strong>
                  </div>
                  <div className="settings-control">
                    <Segmented
                      value={state.settings.theme}
                      options={[
                        { value: 'system', label: t('settings.themeSystem') },
                        { value: 'light', label: t('settings.themeLight') },
                        { value: 'dark', label: t('settings.themeDark') },
                      ]}
                      onChange={(value) => void update({ theme: value })}
                    />
                  </div>
                </div>
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <strong>{t('settings.language')}</strong>
                  </div>
                  <div className="settings-control">
                    <Segmented
                      value={state.settings.language}
                      options={[
                        { value: 'zh-CN', label: '中文' },
                        { value: 'en', label: 'English' },
                      ]}
                      onChange={(value) => void update({ language: value })}
                    />
                  </div>
                </div>
                <div className="switch-row">
                  <div className="switch-copy">
                    <strong>{t('settings.hideOnBlur')}</strong>
                    <span>{t('settings.hideOnBlurHint')}</span>
                  </div>
                  <Toggle checked={state.settings.hideOnBlur} onChange={(next) => void update({ hideOnBlur: next })} label={t('settings.hideOnBlur')} />
                </div>
                <div className="switch-row">
                  <div className="switch-copy">
                    <strong>{t('settings.startHidden')}</strong>
                  </div>
                  <Toggle checked={state.settings.startHidden} onChange={(next) => void update({ startHidden: next })} label={t('settings.startHidden')} />
                </div>
                <div className="switch-row">
                  <div className="switch-copy">
                    <strong>{t('settings.launchAtLogin')}</strong>
                  </div>
                  <Toggle checked={state.settings.launchAtLogin} onChange={(next) => void update({ launchAtLogin: next })} label={t('settings.launchAtLogin')} />
                </div>
                <div className="switch-row">
                  <div className="switch-copy">
                    <strong>{t('settings.trayShowRemaining')}</strong>
                    <span>{t('settings.trayShowRemainingHint')}</span>
                  </div>
                  <Toggle checked={state.settings.trayShowRemaining} onChange={(next) => void update({ trayShowRemaining: next })} label={t('settings.trayShowRemaining')} />
                </div>
                <div className="switch-row">
                  <div className="switch-copy">
                    <strong>{language === 'zh-CN' ? '托盘显示路由余量' : 'Show router quota in tray'}</strong>
                    <span>
                      {language === 'zh-CN'
                        ? '在托盘菜单和 tooltip 中显示 AI Router Provider 余量；顺序跟随路由控制台。'
                        : 'Show AI Router provider quotas in the tray menu and tooltip.'}
                    </span>
                  </div>
                  <Toggle
                    checked={state.settings.trayShowRouterQuota}
                    onChange={(next) => void update({ trayShowRouterQuota: next })}
                    label={language === 'zh-CN' ? '托盘显示路由余量' : 'Show router quota in tray'}
                  />
                </div>
              </SectionCard>

              <SectionCard
                title={language === 'zh-CN' ? '主面板卡片' : 'Home cards'}
                subtitle={
                  language === 'zh-CN'
                    ? '控制「总览」页显示哪些卡片；修改即保存。'
                    : 'Choose which cards appear on the Overview tab; changes save immediately.'
                }
              >
                <div className="hint" style={{ marginBottom: 6 }}>
                  {language === 'zh-CN' ? '拖拽调整顺序，开关控制显示。' : 'Drag to reorder; toggles control visibility.'}
                </div>
                {state.settings.homeCardOrder.map((id, index) => {
                  const item = HOME_CARD_LABELS[id];
                  const label = language === 'zh-CN' ? item.zh : item.en;
                  return (
                    <div
                      className="switch-row"
                      key={id}
                      draggable
                      style={{ cursor: 'grab' }}
                      onDragStart={(event) => event.dataTransfer.setData('text/plain', String(index))}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.preventDefault();
                        moveHomeCard(Number(event.dataTransfer.getData('text/plain')), index);
                      }}
                    >
                      <GripVertical size={14} style={{ color: 'var(--faint)', flex: '0 0 auto' }} />
                      <div className="switch-copy" style={{ flex: 1 }}>
                        <strong>{label}</strong>
                      </div>
                      <Toggle
                        checked={state.settings.homeCards[id]}
                        onChange={(next) => void update({ homeCards: { [id]: next } })}
                        label={label}
                      />
                    </div>
                  );
                })}
              </SectionCard>
            </>
          ) : null}

          {section === 'data' ? (
            <>
              <h1 className="settings-page-title">{t('settings.dataTitle')}</h1>
              <p className="settings-page-sub">{t('settings.dataSub')}</p>
              <SectionCard title={t('settings.dataTitle')}>
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <strong>{t('settings.clearHistory')}</strong>
                    <span>{t('settings.dataSub')}</span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={async () => {
                      if (!window.confirm(t('settings.clearHistoryConfirm'))) return;
                      await window.tokenMonitor.clearQuotaHistory();
                      setNotice({ tone: 'info', text: t('settings.clearHistoryConfirm') });
                    }}
                  >
                    <Trash2 size={13} />
                    {t('common.confirm')}
                  </button>
                </div>
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <strong>{t('settings.logs')}</strong>
                    <span>settings.json / quota-history / logs</span>
                  </div>
                  <button type="button" className="btn btn-sm" onClick={() => void window.tokenMonitor.openDataFolder()}>
                    <FolderOpen size={13} />
                    {t('settings.logs')}
                  </button>
                </div>
              </SectionCard>
            </>
          ) : null}

          {section === 'about' ? (
            <>
              <h1 className="settings-page-title">{t('settings.aboutTitle')}</h1>
              <p className="settings-page-sub">{t('settings.aboutSub')}</p>
              <SectionCard title={t('settings.aboutTitle')}>
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <strong>{t('settings.version')}</strong>
                    <span className="mono">{appInfo?.version ?? state.version} · Electron {appInfo?.electron ?? '—'}</span>
                  </div>
                </div>
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <strong>{t('settings.license')}</strong>
                    <span>MIT · CodexBar attribution</span>
                  </div>
                </div>
                <Banner tone="info">{t('settings.attribution')}</Banner>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                  <button type="button" className="btn btn-sm" onClick={() => void window.tokenMonitor.openExternal('https://opencode.ai/auth')}>
                    <ExternalLink size={13} />
                    {t('settings.openCodeLink')}
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => void window.tokenMonitor.openExternal('https://github.com/steipete/CodexBar')}>
                    <ExternalLink size={13} />
                    CodexBar
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => void window.tokenMonitor.openDataFolder()}>
                    <FolderOpen size={13} />
                    {t('settings.logs')}
                  </button>
                </div>
                <div className="hint" style={{ display: 'flex', gap: 6, marginTop: 14, alignItems: 'flex-start' }}>
                  <ShieldCheck size={13} style={{ flex: '0 0 auto', marginTop: 1 }} />
                  <span>{t('settings.privacy')}</span>
                </div>
              </SectionCard>
            </>
          ) : null}
        </div>
      </main>
    </div>
  );
}
