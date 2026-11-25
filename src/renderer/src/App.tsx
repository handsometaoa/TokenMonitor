import { useEffect, useState } from 'react';
import type { AppState } from '../../shared/types';
import { BrandMark } from './components/Logo';
import { Spinner } from './components/ui';
import { useTheme } from './hooks';
import { RouterApp } from './router/RouterApp';

function Splash() {
  return (
    <div className="app-bg" style={{ display: 'grid', placeItems: 'center' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, position: 'relative', zIndex: 1 }}>
        <BrandMark size={42} />
        <div className="muted" style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12 }}>
          <Spinner /> TokenMonitor
        </div>
      </div>
    </div>
  );
}

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const theme = state?.settings.theme ?? 'system';
  useTheme(theme);

  useEffect(() => {
    let alive = true;
    void window.tokenMonitor
      .getState()
      .then((next) => {
        if (alive) setState(next);
      })
      .catch((reason) => {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason));
      });
    const unsubscribe = window.tokenMonitor.onStateChanged((next) => {
      if (alive) setState(next);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  if (!state) {
    return error ? (
      <div className="app-bg" style={{ display: 'grid', placeItems: 'center', padding: 24 }}>
        <div className="glass-card" style={{ padding: 20, maxWidth: 360, position: 'relative', zIndex: 1 }}>
          <div className="empty-title">TokenMonitor</div>
          <div className="empty-body">{error}</div>
        </div>
      </div>
    ) : (
      <Splash />
    );
  }

  return <RouterApp state={state} />;
}
