import { useEffect, useMemo, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  Bell,
  Check,
  Copy,
  Database,
  ExternalLink,
  FolderOpen,
  Gauge,
  Info,
  KeyRound,
  Palette,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import type {
  AppInfo,
  AppState,
  CredentialDetection,
  CredentialTestResult,
  SpeedConfigInfo,
  UpdateSettingsPatch,
} from '../../../shared/types';
import type { Translator } from '../i18n';
import { formatRelative } from '../format';
import { useCopy, useNow } from '../hooks';
import { Banner, SectionCard, Segmented, Spinner, Toggle } from '../components/ui';

type SettingsSection = 'general' | 'connection' | 'local' | 'speed' | 'notifications' | 'appearance' | 'data' | 'about';

interface Notice {
  tone: 'info' | 'danger';
  text: string;
}

const NAV: Array<{ id: SettingsSection; labelKey: Parameters<Translator>[0]; icon: LucideIcon }> = [
  { id: 'general', labelKey: 'settings.general', icon: SlidersHorizontal },
  { id: 'connection', labelKey: 'settings.connection', icon: KeyRound },
  { id: 'local', labelKey: 'settings.local', icon: Database },
  { id: 'speed', labelKey: 'settings.speed', icon: Gauge },
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
  const [section, setSection] = useState<SettingsSection>('connection');
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [key, setKey] = useState('');
  const [orgId, setOrgId] = useState(state.settings.orgId);
  const [busy, setBusy] = useState<'detect' | 'use' | 'save' | 'speed' | 'local' | null>(null);
  const [detection, setDetection] = useState<CredentialDetection | null>(null);
  const [result, setResult] = useState<CredentialTestResult | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [speedConfig, setSpeedConfig] = useState<SpeedConfigInfo | null>(null);
  const [speedTest, setSpeedTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [localInfo, setLocalInfo] = useState<{ path: string; messages: number; schema: string } | null>(null);
  const { copied, copy } = useCopy();
  const now = useNow(30_000);

  useEffect(() => {
    void window.tokenMonitor.getAppInfo().then(setAppInfo).catch(() => undefined);
  }, []);

  useEffect(() => {
    setOrgId(state.settings.orgId);
  }, [state.settings.orgId]);

  useEffect(() => {
    if (section !== 'speed') return;
    void window.tokenMonitor
      .getSpeedConfig()
      .then(setSpeedConfig)
      .catch((error) => setNotice({ tone: 'danger', text: error instanceof Error ? error.message : String(error) }));
  }, [section, state.settings.speed.enabled, state.speed.running]);

  useEffect(() => {
    if (section !== 'local') return;
    void window.tokenMonitor
      .refreshLocalUsage('all')
      .then((summary) => {
        setLocalInfo({ path: summary.dbPath, messages: summary.messages, schema: summary.schema });
      })
      .catch(() => undefined);
  }, [section, state.settings.localUsageEnabled, state.settings.localDataPath]);

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

  const detect = async () => {
    setBusy('detect');
    setResult(null);
    try {
      setDetection(await window.tokenMonitor.detectCredential());
    } catch (error) {
      setNotice({ tone: 'danger', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const useDetected = async () => {
    setBusy('use');
    setResult(null);
    try {
      setResult(await window.tokenMonitor.useAutoCredential(orgId));
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const saveKey = async () => {
    setBusy('save');
    setResult(null);
    try {
      const response = await window.tokenMonitor.testAndSaveKey(key, orgId);
      setResult(response);
      if (response.ok) setKey('');
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const clearKey = async () => {
    if (!window.confirm(t('settings.clearKey') + '?')) return;
    await window.tokenMonitor.clearCredential();
    setResult(null);
    setDetection(null);
  };

  const toggleSpeed = async (enabled: boolean) => {
    setBusy('speed');
    setSpeedTest(null);
    setNotice(null);
    try {
      await window.tokenMonitor.setSpeedEnabled(enabled);
      setSpeedConfig(await window.tokenMonitor.getSpeedConfig());
    } catch (error) {
      setNotice({ tone: 'danger', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const testProxy = async () => {
    setBusy('speed');
    setSpeedTest(await window.tokenMonitor.testSpeedProxy());
    setBusy(null);
  };

  const chooseDb = async () => {
    const path = await window.tokenMonitor.chooseLocalDb();
    if (path) {
      setLocalInfo({ path, messages: localInfo?.messages ?? 0, schema: localInfo?.schema ?? '—' });
      setNotice({ tone: 'info', text: path });
    }
  };

  const rescanLocal = async () => {
    setBusy('local');
    try {
      const summary = await window.tokenMonitor.refreshLocalUsage('all');
      setLocalInfo({ path: summary.dbPath, messages: summary.messages, schema: summary.schema });
      setNotice({ tone: 'info', text: `${summary.messages} messages · ${summary.schema}` });
    } catch (error) {
      setNotice({ tone: 'danger', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
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
            </>
          ) : null}

          {section === 'connection' ? (
            <>
              <h1 className="settings-page-title">{t('settings.connectionTitle')}</h1>
              <p className="settings-page-sub">{t('settings.connectionSub')}</p>

              <SectionCard title={t('settings.credential')}>
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <strong>{credentialSourceLabel}</strong>
                    <span className="mono">{state.credentials.masked ?? '—'}</span>
                    <span>{t('settings.safeStorage')}</span>
                  </div>
                  <div className="settings-control">
                    <span className={`chip ${state.credentials.configured ? 'good' : 'warn'}`}>
                      {state.credentials.configured ? t('status.normal') : t('status.off')}
                    </span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                  <button type="button" className="btn" onClick={() => void detect()} disabled={busy !== null}>
                    {busy === 'detect' ? <Spinner size={13} /> : <KeyRound size={13} />}
                    {t('settings.detect')}
                  </button>
                  {detection?.found ? (
                    <button type="button" className="btn" onClick={() => void useDetected()} disabled={busy !== null}>
                      {busy === 'use' ? <Spinner size={13} /> : <Check size={13} />}
                      {t('settings.useDetected')}
                    </button>
                  ) : null}
                  {state.credentials.configured ? (
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => void clearKey()}>
                      {t('settings.clearKey')}
                    </button>
                  ) : null}
                </div>
                {state.credentials.kind === 'manual' && state.credentials.configured && !state.credentials.persisted ? (
                  <div style={{ marginTop: 8 }}>
                    <Banner tone="warn">{t('settings.keySessionOnly')}</Banner>
                  </div>
                ) : null}
                {detection ? (
                  detection.found ? (
                    <Banner tone="info">{t('settings.detected', { masked: detection.masked ?? '' })}</Banner>
                  ) : (
                    <Banner tone="warn">{detection.message}</Banner>
                  )
                ) : null}
                {result ? (
                  <div style={{ marginTop: 10 }}>
                    <Banner tone={result.ok ? 'info' : 'danger'}>
                      {result.ok ? (result.message ?? t('settings.keySaved')) : result.message}
                    </Banner>
                  </div>
                ) : null}
              </SectionCard>

              <SectionCard title={t('settings.manualKey')}>
                <label className="label" htmlFor="settings-key">{t('settings.manualKey')}</label>
                <input
                  id="settings-key"
                  className="field"
                  type="password"
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  placeholder={t('settings.manualKeyPlaceholder')}
                  autoComplete="off"
                  spellCheck={false}
                />
                <div style={{ marginTop: 9 }}>
                  <label className="label" htmlFor="settings-org">{t('settings.orgId')}</label>
                  <input
                    id="settings-org"
                    className="field"
                    value={orgId}
                    onChange={(event) => setOrgId(event.target.value)}
                    placeholder="org_..."
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <div className="hint" style={{ marginTop: 4 }}>{t('settings.orgIdHint')}</div>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button type="button" className="btn btn-primary" onClick={() => void saveKey()} disabled={!key.trim() || busy !== null}>
                    {busy === 'save' ? <Spinner size={13} /> : null}
                    {busy === 'save' ? t('settings.testing') : t('settings.testSave')}
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => void window.tokenMonitor.openExternal('https://opencode.ai/auth')}>
                    {t('onboarding.link')}
                    <ExternalLink size={12} />
                  </button>
                </div>
              </SectionCard>
            </>
          ) : null}

          {section === 'local' ? (
            <>
              <h1 className="settings-page-title">{t('settings.localTitle')}</h1>
              <p className="settings-page-sub">{t('settings.localSub')}</p>
              <SectionCard title={t('settings.localTitle')}>
                <div className="switch-row">
                  <div className="switch-copy">
                    <strong>{t('settings.localEnabled')}</strong>
                    <span>{t('settings.localEnabledHint')}</span>
                  </div>
                  <Toggle checked={state.settings.localUsageEnabled} onChange={(next) => void update({ localUsageEnabled: next })} label={t('settings.localEnabled')} />
                </div>
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <strong>{t('settings.dbPath')}</strong>
                    <span className="mono" style={{ wordBreak: 'break-all' }}>{state.settings.localDataPath || t('settings.dbPathAuto')}</span>
                    {localInfo ? <span>{localInfo.messages} messages · {localInfo.schema}</span> : null}
                  </div>
                  <div className="settings-control" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <button type="button" className="btn btn-sm" onClick={() => void chooseDb()}>
                      <FolderOpen size={13} />
                      {t('settings.chooseDb')}
                    </button>
                    <button type="button" className="btn btn-sm" onClick={() => void update({ localDataPath: null })}>
                      {t('settings.resetDb')}
                    </button>
                    <button type="button" className="btn btn-sm" onClick={() => void rescanLocal()} disabled={busy === 'local'}>
                      {busy === 'local' ? <Spinner size={13} /> : <RefreshCw size={13} />}
                      {t('settings.rescan')}
                    </button>
                  </div>
                </div>
                <Banner tone="warn">{t('settings.privacy')}</Banner>
              </SectionCard>
            </>
          ) : null}

          {section === 'speed' ? (
            <>
              <h1 className="settings-page-title">{t('settings.speedTitle')}</h1>
              <p className="settings-page-sub">{t('settings.speedSub')}</p>
              <SectionCard
                title={t('settings.speedTitle')}
                action={
                  <span className={`chip ${state.speed.running ? 'good' : ''}`}>
                    {state.speed.running ? t('settings.speedRunning') : t('settings.speedStopped')}
                  </span>
                }
              >
                <div className="switch-row">
                  <div className="switch-copy">
                    <strong>{t('settings.speedEnable')}</strong>
                    <span>{t('settings.speedEnableHint')}</span>
                  </div>
                  <Toggle
                    checked={state.settings.speed.enabled}
                    onChange={(next) => void toggleSpeed(next)}
                    disabled={busy === 'speed'}
                    label={t('settings.speedEnable')}
                  />
                </div>

                {state.speed.error ? <Banner tone="danger">{state.speed.error}</Banner> : null}

                {state.speed.running && speedConfig ? (
                  <>
                    <div className="settings-row">
                      <div className="settings-row-copy">
                        <strong>{t('settings.speedProxyUrl')}</strong>
                        <span className="mono" style={{ wordBreak: 'break-all' }}>{speedConfig.proxyUrl}</span>
                      </div>
                      <div className="settings-control">
                        <button type="button" className="btn btn-sm" onClick={() => void testProxy()} disabled={busy === 'speed'}>
                          {busy === 'speed' ? <Spinner size={12} /> : <Activity size={13} />}
                          {t('settings.speedTest')}
                        </button>
                      </div>
                    </div>
                    <div style={{ marginTop: 6 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <div className="label" style={{ marginBottom: 0 }}>{t('settings.speedConfig')}</div>
                        <button type="button" className="btn btn-sm" onClick={() => void copy(speedConfig.snippet)}>
                          {copied ? <Check size={12} /> : <Copy size={12} />}
                          {copied ? t('common.copied') : t('common.copy')}
                        </button>
                      </div>
                      <pre className="code-block">{speedConfig.snippet}</pre>
                      <div className="hint" style={{ marginTop: 5 }}>{t('settings.speedConfigHint')}</div>
                      <div className="hint" style={{ marginTop: 5 }}>
                        {speedConfig.applied ? t('settings.speedApplied') : t('settings.speedNotApplied')}
                      </div>
                    </div>
                    {speedTest ? (
                      <div style={{ marginTop: 10 }}>
                        <Banner tone={speedTest.ok ? 'info' : 'danger'}>
                          {speedTest.ok ? t('settings.speedTestOk') : `${t('settings.speedTestFail')} ${speedTest.message}`}
                        </Banner>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <Banner tone="info">{t('settings.speedEnableHint')}</Banner>
                )}

                <div style={{ marginTop: 12 }}>
                  <Banner tone="warn">{t('settings.speedWarning')}</Banner>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={async () => {
                      if (!window.confirm(t('settings.speedClearConfirm'))) return;
                      await window.tokenMonitor.clearSpeedSamples();
                    }}
                  >
                    <Trash2 size={13} />
                    {t('settings.speedSamples')}
                  </button>
                </div>
              </SectionCard>
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
                    <strong>{t('settings.clearSpeed')}</strong>
                    <span>{t('settings.speedSamples')}</span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={async () => {
                      if (!window.confirm(t('settings.clearSpeedConfirm'))) return;
                      await window.tokenMonitor.clearSpeedSamples();
                      setNotice({ tone: 'info', text: t('settings.clearSpeedConfirm') });
                    }}
                  >
                    <Trash2 size={13} />
                    {t('common.confirm')}
                  </button>
                </div>
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <strong>{t('settings.logs')}</strong>
                    <span>settings.json / quota-history / speed-samples / logs</span>
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
