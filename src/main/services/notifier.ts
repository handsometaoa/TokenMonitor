import { Notification } from 'electron';
import type { AppSettings, ProviderSnapshot, QuotaWindowId, QuotaWindowView } from '../../shared/types';
import type { QuotaNotifier } from './quotaService';
import type { SettingsStore } from './settings';

interface WindowNotificationState {
  cycle: string;
  notifiedThresholds: Set<number>;
  rateLimitedNotified: boolean;
  paceNotified: boolean;
}

const WINDOW_LABELS: Record<QuotaWindowId, { zh: string; en: string }> = {
  rolling: { zh: '5 小时窗口', en: '5-hour window' },
  weekly: { zh: '每周窗口', en: 'Weekly window' },
  monthly: { zh: '每月窗口', en: 'Monthly window' },
};

export class QuotaNotifierService implements QuotaNotifier {
  private readonly states = new Map<QuotaWindowId, WindowNotificationState>();

  constructor(
    private readonly settings: SettingsStore,
    private readonly onClick: () => void,
    private readonly demo: boolean,
  ) {}

  evaluate(previous: ProviderSnapshot | null, current: ProviderSnapshot): void {
    if (this.demo) return;
    const config = this.settings.get();
    if (!config.notifications.enabled) return;

    const activeCycles = new Set<string>();
    for (const window of current.windows) {
      const cycle = this.cycleKey(window);
      activeCycles.add(`${window.id}|${cycle}`);
      const previousWindow = previous?.windows.find((item) => item.id === window.id) ?? null;
      let state = this.states.get(window.id);
      if (!state || state.cycle !== cycle) {
        state = {
          cycle,
          notifiedThresholds: new Set(),
          rateLimitedNotified: false,
          paceNotified: false,
        };
        this.states.set(window.id, state);
        if (!previousWindow) {
          this.seed(state, window, config);
          continue;
        }
      }

      this.evaluateThresholds(state, window, previousWindow, config);
      this.evaluatePace(state, window, previousWindow, config);
      this.evaluateRateLimit(state, window, previousWindow, config);
    }

    for (const [id, state] of this.states) {
      if (!activeCycles.has(`${id}|${state.cycle}`)) this.states.delete(id);
    }
  }

  private seed(state: WindowNotificationState, window: QuotaWindowView, config: AppSettings): void {
    for (const threshold of config.notifications.remainingThresholds) {
      if (window.remainingPercent <= threshold) state.notifiedThresholds.add(threshold);
    }
    if (window.status === 'rate-limited') state.rateLimitedNotified = true;
    if (window.pace.state === 'behind') state.paceNotified = true;
  }

  private evaluateThresholds(
    state: WindowNotificationState,
    window: QuotaWindowView,
    previous: QuotaWindowView | null,
    config: AppSettings,
  ): void {
    const crossed = config.notifications.remainingThresholds
      .filter(
        (threshold) =>
          !state.notifiedThresholds.has(threshold) &&
          window.remainingPercent <= threshold &&
          (!previous || previous.remainingPercent > threshold),
      )
      .sort((a, b) => a - b);
    if (crossed.length === 0) return;

    const threshold = crossed[0];
    for (const value of crossed) state.notifiedThresholds.add(value);
    const label = this.label(window.id, config);
    const title = config.language === 'en' ? `OpenCode Go · ${label} low` : `OpenCode Go · ${label}余量偏低`;
    const body =
      config.language === 'en'
        ? `${Math.round(window.remainingPercent)}% remaining (threshold ${threshold}%). Reset ${this.resetText(window, config)}.`
        : `剩余 ${Math.round(window.remainingPercent)}%（阈值 ${threshold}%）。${this.resetText(window, config)}。`;
    this.show(title, body);
  }

  private evaluatePace(
    state: WindowNotificationState,
    window: QuotaWindowView,
    previous: QuotaWindowView | null,
    config: AppSettings,
  ): void {
    if (!config.notifications.pace || state.paceNotified) return;
    if (window.pace.state !== 'behind' || previous?.pace.state === 'behind') return;
    state.paceNotified = true;
    const label = this.label(window.id, config);
    const title = config.language === 'en' ? `OpenCode Go · ${label} burn rate` : `OpenCode Go · ${label}消耗偏快`;
    const body =
      config.language === 'en'
        ? 'Usage is ahead of the expected pace. Consider slowing down before the reset.'
        : '当前消耗快于时间进度，建议留意节奏，避免在重置前耗尽。';
    this.show(title, body);
  }

  private evaluateRateLimit(
    state: WindowNotificationState,
    window: QuotaWindowView,
    previous: QuotaWindowView | null,
    config: AppSettings,
  ): void {
    if (!config.notifications.rateLimited || state.rateLimitedNotified) return;
    if (window.status !== 'rate-limited' || previous?.status === 'rate-limited') return;
    state.rateLimitedNotified = true;
    const label = this.label(window.id, config);
    const title = config.language === 'en' ? `OpenCode Go · ${label} rate limited` : `OpenCode Go · ${label}已限流`;
    const body =
      config.language === 'en'
        ? `Requests are paused until ${this.resetText(window, config)}.`
        : `请求会暂停到${this.resetText(window, config)}。`;
    this.show(title, body);
  }

  private resetText(window: QuotaWindowView, config: AppSettings): string {
    if (!window.resetsAt) return config.language === 'en' ? 'reset time unknown' : '重置时间未知';
    const date = new Date(window.resetsAt);
    if (!Number.isFinite(date.getTime())) return config.language === 'en' ? 'reset time unknown' : '重置时间未知';
    return new Intl.DateTimeFormat(config.language === 'en' ? 'en-US' : 'zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  }

  private label(id: QuotaWindowId, config: AppSettings): string {
    return WINDOW_LABELS[id][config.language === 'en' ? 'en' : 'zh'];
  }

  private cycleKey(window: QuotaWindowView): string {
    return window.resetsAt ?? 'unknown';
  }

  private show(title: string, body: string): void {
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title, body, silent: false });
    notification.on('click', () => this.onClick());
    notification.show();
  }
}
