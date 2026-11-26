import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppState } from '../../../shared/types';
import { orbTargets, pickTarget, resolveOrbView, type OrbTarget } from '../orbTargets';

type TargetStatus = 'ok' | 'stale' | 'error' | 'loading' | 'none';

function statusOf(target: OrbTarget | null): TargetStatus {
  if (!target) return 'none';
  if (target.loading) return 'loading';
  // Credential not set up (yet) is a waiting state, not a failure — the stale
  // snapshot it may still show is already labeled 数据过期.
  if (target.notConfigured) return 'stale';
  if (target.hasError) return 'error';
  if (target.stale) return 'stale';
  return 'ok';
}

const RING_RADIUS = 24;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function ringColor(remaining: number | null, status: TargetStatus): string {
  if (remaining === null) return 'rgba(139, 148, 170, 0.45)';
  if (remaining <= 5) return '#f87171';
  if (remaining <= 20) return '#fbbf24';
  return '#34d399';
}

export function OrbApp() {
  const [state, setState] = useState<AppState | null>(null);
  const drag = useRef<{ active: boolean; dragging: boolean; originX: number; originY: number } | null>(null);

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

  const target = useMemo(() => (state ? pickTarget(state, orbTargets(state)) : null), [state]);
  const status = statusOf(target);
  const zh = state?.settings.language !== 'en';
  const view = state?.settings.orbQuotaView ?? 'all';
  const resolved = useMemo(() => resolveOrbView(target, view), [target, view]);

  const remaining = resolved.percent;
  const progressColor = ringColor(remaining, status);
  const dashOffset = remaining === null ? RING_CIRCUMFERENCE : RING_CIRCUMFERENCE * (1 - Math.min(100, Math.max(0, remaining)) / 100);
  const value = remaining !== null ? `${Math.round(remaining)}%` : (resolved.balanceText ?? '—');

  const ariaLabel = target
    ? `${target.label} · ${
        remaining !== null
          ? zh
            ? `剩余 ${Math.round(remaining)}%`
            : `${Math.round(remaining)}% left`
          : (target.balanceText ?? '')
      }`
    : 'TokenMonitor';

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    drag.current = { active: true, dragging: false, originX: event.screenX, originY: event.screenY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = drag.current;
    if (!dragState?.active || dragState.dragging) return;
    // Once the press moves past the click threshold, hand the drag to the
    // main process loop — it pins the orb to the cursor at high frequency.
    if (Math.hypot(event.screenX - dragState.originX, event.screenY - dragState.originY) < 5) return;
    dragState.dragging = true;
    void window.tokenMonitor.startOrbDrag();
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = drag.current;
    drag.current = null;
    if (!dragState?.active) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (dragState.dragging) {
      void window.tokenMonitor.endOrbDrag();
    } else {
      void window.tokenMonitor.togglePanel();
    }
  };

  return (
    <div
      className="orb-root"
      role="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(event) => {
        event.preventDefault();
        void window.tokenMonitor.requestOrbContextMenu();
      }}
    >
      <div className="orb-disc">
        <svg className="orb-ring" width="56" height="56" viewBox="0 0 56 56" aria-hidden="true">
          <circle cx="28" cy="28" r={RING_RADIUS} fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth="3.5" />
          <circle
            cx="28"
            cy="28"
            r={RING_RADIUS}
            fill="none"
            stroke={progressColor}
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={dashOffset}
          />
        </svg>
        <div className="orb-center">
          <span className="orb-value">{value}</span>
        </div>
        <span className={`orb-dot orb-dot-${status}`} aria-hidden="true" />
      </div>
    </div>
  );
}
