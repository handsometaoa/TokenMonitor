import { useEffect, useState } from 'react';
import { Check, ExternalLink, KeyRound, ShieldCheck } from 'lucide-react';
import type { AppState, CredentialDetection, CredentialTestResult } from '../../../shared/types';
import type { Translator } from '../i18n';
import { Banner, Spinner } from '../components/ui';

export function Onboarding({
  state,
  t,
  onOpenSettings,
}: {
  state: AppState;
  t: Translator;
  onOpenSettings: () => void;
}) {
  const [key, setKey] = useState('');
  const [orgId, setOrgId] = useState(state.settings.orgId);
  const [busy, setBusy] = useState<'detect' | 'use' | 'save' | null>(null);
  const [detection, setDetection] = useState<CredentialDetection | null>(null);
  const [result, setResult] = useState<CredentialTestResult | null>(null);

  const detect = async () => {
    setBusy('detect');
    setResult(null);
    try {
      setDetection(await window.tokenMonitor.detectCredential());
    } catch (error) {
      setDetection({
        found: false,
        masked: null,
        provider: null,
        message: error instanceof Error ? error.message : '检测失败',
      });
    } finally {
      setBusy(null);
    }
  };

  const useDetected = async () => {
    setBusy('use');
    setResult(null);
    try {
      const response = await window.tokenMonitor.useAutoCredential(orgId);
      setResult(response);
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : '验证失败' });
    } finally {
      setBusy(null);
    }
  };

  const saveManual = async () => {
    setBusy('save');
    setResult(null);
    try {
      const response = await window.tokenMonitor.testAndSaveKey(key, orgId);
      setResult(response);
      if (response.ok) setKey('');
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : '保存失败' });
    } finally {
      setBusy(null);
    }
  };

  const skip = async () => {
    await window.tokenMonitor.updateSettings({
      onboardingCompleted: true,
    });
  };

  return (
    <div className="onboarding fade-in">
      <div className="onboarding-hero">
        <h1 className="onboarding-title">{t('onboarding.title')}</h1>
        <p className="onboarding-sub">{t('onboarding.sub')}</p>
      </div>

      <section className="step-card">
        <div className="step-head">
          <span className="step-num">1</span>
          <span className="step-title">{t('onboarding.step1')}</span>
        </div>
        <div className="hint" style={{ marginBottom: 12 }}>{t('onboarding.step1Body')}</div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <button type="button" className="btn" onClick={() => void detect()} disabled={busy !== null}>
            {busy === 'detect' ? <Spinner size={14} /> : <KeyRound size={14} />}
            {busy === 'detect' ? t('onboarding.detecting') : t('onboarding.detect')}
          </button>
          {detection?.found ? <span className="chip good"><Check size={11} /> {detection.masked}</span> : null}
        </div>

        {detection ? (
          detection.found ? (
            <Banner
              tone="info"
              action={
                <button type="button" className="btn btn-sm" onClick={() => void useDetected()} disabled={busy !== null}>
                  {busy === 'use' ? <Spinner size={12} /> : null}
                  {t('onboarding.useDetected')}
                </button>
              }
            >
              {t('onboarding.detected', { provider: detection.provider ?? 'OpenCode' })}
            </Banner>
          ) : (
            <div className="hint" style={{ marginBottom: 10 }}>{detection.message}</div>
          )
        ) : null}

        <div style={{ marginTop: detection ? 14 : 0 }}>
          <label className="label" htmlFor="api-key">{t('onboarding.keyLabel')}</label>
          <input
            id="api-key"
            className="field"
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder={t('onboarding.keyPlaceholder')}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div style={{ marginTop: 9 }}>
          <label className="label" htmlFor="org-id">{t('onboarding.orgLabel')}</label>
          <input
            id="org-id"
            className="field"
            value={orgId}
            onChange={(event) => setOrgId(event.target.value)}
            placeholder={t('onboarding.orgPlaceholder')}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 13 }}>
          <button type="button" className="btn btn-primary" onClick={() => void saveManual()} disabled={!key.trim() || busy !== null}>
            {busy === 'save' ? <Spinner size={14} /> : null}
            {busy === 'save' ? t('onboarding.saving') : t('onboarding.testAndSave')}
          </button>
          <button type="button" className="btn-ghost btn btn-sm" onClick={() => void window.tokenMonitor.openExternal('https://opencode.ai/auth')}>
            {t('onboarding.link')}
            <ExternalLink size={12} />
          </button>
        </div>

        {result && !result.ok ? <div className="error-text" style={{ marginTop: 10 }}>{result.message}</div> : null}
        {result?.ok ? <div className="success-text" style={{ marginTop: 10 }}>{result.message ?? t('settings.keySaved')}</div> : null}

        <div className="hint" style={{ display: 'flex', gap: 6, marginTop: 12, alignItems: 'flex-start' }}>
          <ShieldCheck size={13} style={{ flex: '0 0 auto', marginTop: 1 }} />
          <span>{t('onboarding.security')}</span>
        </div>
      </section>

      <section className="step-card">
        <div className="step-head">
          <span className="step-num">2</span>
          <span className="step-title">{t('onboarding.step2')}</span>
        </div>
        <div className="hint" style={{ marginBottom: 10 }}>{t('onboarding.step2Body')}</div>
      </section>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 16 }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void skip()}>
          {t('onboarding.skip')}
        </button>
        <button type="button" className="btn btn-sm" onClick={onOpenSettings}>
          {t('common.settings')}
        </button>
      </div>
    </div>
  );
}
