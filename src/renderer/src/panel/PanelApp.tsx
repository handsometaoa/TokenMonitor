import { useEffect, useState } from 'react';
import type { AppState } from '../../../shared/types';
import { useTheme } from '../hooks';
import { PanelView } from '../views/Panel';

export function PanelApp() {
  const [state, setState] = useState<AppState | null>(null);
  useTheme(state?.settings.theme ?? 'system');

  useEffect(() => {
    let alive = true;
    void window.tokenMonitor
      .getState()
      .then((next) => {
        if (alive) setState(next);
      })
      .catch(() => undefined);
    const unsubscribe = window.tokenMonitor.onStateChanged((next) => {
      if (alive) setState(next);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  // Escape collapses the flyout; clicking a "open in main window" action
  // hides the panel as well so the main window comes forward.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void window.tokenMonitor.hidePanel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!state) return <div className="panel-window-shell" />;

  const openInMain = (action: () => Promise<void>) => {
    void action();
    void window.tokenMonitor.hidePanel();
  };

  return (
    <div className="panel-window-shell">
      <PanelView
        state={state}
        onOpenSettings={() => openInMain(() => window.tokenMonitor.openSettings())}
        onOpenRouter={() => openInMain(() => window.tokenMonitor.openRouterWindow())}
        onClose={() => void window.tokenMonitor.hidePanel()}
      />
    </div>
  );
}
