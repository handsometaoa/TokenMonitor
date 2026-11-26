import { useEffect, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowLeft,
  Bell,
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
  HomeCardId,
  UpdateSettingsPatch,
} from '../../../shared/types';
import type { Translator } from '../i18n';
import { formatRelative } from '../format';
import { useNow } from '../hooks';
import { Banner, SectionCard, Segmented, Toggle } from '../components/ui';
import { BrandMark } from '../components/Logo';
import { orbTargets } from '../orbTargets';
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
  onClose,
}: {
  state: AppState;
  t: Translator;
  language: 'zh-CN' | 'en';
  onClose?: () => void;
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

  const moveHomeCard = (from: number, to: number) => {
    const current = state.settings.homeCardOrder;
    if (from === to || from < 0 || to < 0 || from >= current.length || to >= current.length) return;
    const next = [...current];
    const [item] = next.splice(from, 1);
    if (!item) return;
    next.splice(to, 0, item);
    void update({ homeCardOrder: next });
  };


  const sectionLabel = t(NAV.find((item) => item.id === section)?.labelKey ?? 'settings.general');

  return (
    <div className="settings-shell">
      <aside className="router-sidebar">
        <div className="router-brand">
          <BrandMark size={26} />
          <div>
            <div className="router-brand-title">TokenMonitor</div>
            <div className="router-brand-sub">AI Router</div>
          </div>
        </div>
        <nav className="router-nav">
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className={`router-nav-item ${section === item.id ? 'active' : ''}`}
                onClick={() => setSection(item.id)}
              >
                <Icon size={16} strokeWidth={1.9} />
                {t(item.labelKey)}
              </button>
            );
          })}
        </nav>
        <div className="router-sidebar-foot">
          {onClose ? (
            <button type="button" className="router-sidebar-action" onClick={onClose}>
              <ArrowLeft size={15} />
              {language === 'zh-CN' ? '返回路由台' : 'Back to router'}
            </button>
          ) : null}
          <div className="router-service-line">
            <span
              className={`router-dot ${
                state.router.service.state === 'running' ? 'good' : state.router.service.state === 'error' ? 'danger' : 'warn'
              }`}
            />
            <span>
              {state.router.service.state === 'running' ? `127.0.0.1:${state.router.service.port}` : '网关未启动'}
            </span>
          </div>
          <div className="router-faint">
            v{appInfo?.version ?? state.version} · 本地优先 · {t('app.official')}
          </div>
        </div>
      </aside>

      <main className="settings-main">
        <header className="router-header settings-header drag">
          <div>
            <div className="router-header-title">{sectionLabel}</div>
            <div className="router-header-sub">{t('app.subtitle')}</div>
          </div>
        </header>
        <div className="settings-scroll">
          <div className="settings-content fade-in" key={section}>
          {notice ? (
            <div style={{ marginBottom: 14 }}>
              <Banner tone={notice.tone === 'danger' ? 'danger' : 'info'}>{notice.text}</Banner>
            </div>
          ) : null}

          {section === 'general' ? (
            <>
              <SectionCard title={t('settings.runtimeTitle')} subtitle={t('settings.runtimeSub')}>
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
              <SubscriptionCredentials
                state={state}
                language={language}
                onChanged={() => void window.tokenMonitor.refreshQuota()}
              />
            </>
          ) : null}

          {section === 'notifications' ? (
            <>
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
                title={language === 'zh-CN' ? '悬浮球' : 'Floating orb'}
                subtitle={
                  language === 'zh-CN'
                    ? '常驻桌面的实时小圆窗：可拖拽，单击展开 Token 面板，右键快捷设置。'
                    : 'A live desktop mini-window: drag to move, click to expand the Token panel, right-click for quick settings.'
                }
              >
                <div className="switch-row">
                  <div className="switch-copy">
                    <strong>{language === 'zh-CN' ? '启用悬浮球' : 'Enable floating orb'}</strong>
                    <span>
                      {language === 'zh-CN'
                        ? '关闭后仍可从托盘菜单或左键托盘图标打开面板。'
                        : 'When off, the panel stays available from the tray icon and menu.'}
                    </span>
                  </div>
                  <Toggle
                    checked={state.settings.orbEnabled}
                    onChange={(next) => void update({ orbEnabled: next })}
                    label={language === 'zh-CN' ? '启用悬浮球' : 'Enable floating orb'}
                  />
                </div>
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <strong>{language === 'zh-CN' ? '展示口径' : 'Quota view'}</strong>
                    <span>
                      {language === 'zh-CN'
                        ? '金额显示余额；5 小时/周/月锁定对应窗口；全部取最低剩余窗口。'
                        : 'Balance shows money; the window options pin a fixed window; All uses the lowest remaining window.'}
                    </span>
                  </div>
                  <div className="settings-control">
                    <Segmented
                      value={state.settings.orbQuotaView}
                      options={[
                        { value: 'all', label: language === 'zh-CN' ? '全部' : 'All' },
                        { value: 'money', label: language === 'zh-CN' ? '金额' : 'Money' },
                        { value: 'hours', label: language === 'zh-CN' ? '5 小时' : '5h' },
                        { value: 'week', label: language === 'zh-CN' ? '周' : 'Week' },
                        { value: 'month', label: language === 'zh-CN' ? '月' : 'Month' },
                      ]}
                      onChange={(value) => void update({ orbQuotaView: value })}
                    />
                  </div>
                </div>
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <strong>{language === 'zh-CN' ? '余量来源' : 'Quota source'}</strong>
                    <span>
                      {language === 'zh-CN'
                        ? '外环与百分比取自该供应商的最低剩余窗口。'
                        : 'Ring and percentage come from the lowest remaining window of this provider.'}
                    </span>
                  </div>
                  <div className="settings-control">
                    <select
                      className="field"
                      style={{ width: 190, height: 34 }}
                      value={state.settings.orbTargetKey ?? ''}
                      onChange={(event) =>
                        void update({ orbTargetKey: event.target.value === '' ? null : event.target.value })
                      }
                    >
                      <option value="">{language === 'zh-CN' ? '自动（第一个可用）' : 'Auto (first available)'}</option>
                      {orbTargets(state).map((target) => (
                        <option key={target.key} value={target.key}>
                          {target.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <strong>{language === 'zh-CN' ? '位置' : 'Position'}</strong>
                    <span>
                      {language === 'zh-CN' ? '拖回默认位置（托盘附近屏幕右上角）。' : 'Reset to the default spot near the tray.'}
                    </span>
                  </div>
                  <div className="settings-control">
                    <button type="button" className="btn btn-sm" onClick={() => void window.tokenMonitor.resetOrbPosition()}>
                      {language === 'zh-CN' ? '重置位置' : 'Reset position'}
                    </button>
                  </div>
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
        </div>
      </main>
    </div>
  );
}
