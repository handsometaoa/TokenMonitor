import { EventEmitter } from 'node:events';
import type { SpeedConfigInfo, SpeedRange, SpeedSeries, SpeedStatus } from '../../shared/types';
import { buildDemoSpeedSeries } from '../providers/opencodeGo/demo';
import type { Logger } from './logger';
import type { SettingsStore } from './settings';
import { SpeedProxyService } from './speedProxy';
import type { SpeedStore } from './speedStore';

export class SpeedManager extends EventEmitter {
  private readonly proxy: SpeedProxyService;

  constructor(
    baseDir: string,
    private readonly settings: SettingsStore,
    private readonly store: SpeedStore,
    logger: Logger,
    private readonly demo: boolean,
  ) {
    super();
    this.proxy = new SpeedProxyService(baseDir, settings, store, logger, demo);
    this.proxy.on('status', () => this.emit('changed'));
    this.proxy.on('sample', () => this.emit('changed'));
  }

  async start(): Promise<void> {
    if (this.demo) {
      this.emit('changed');
      return;
    }
    if (this.settings.get().speed.enabled) {
      await this.proxy.start();
    }
    this.emit('changed');
  }

  async stop(): Promise<void> {
    await this.proxy.stop();
    this.emit('changed');
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.settings.setSpeedConfig({ enabled, configApplied: enabled ? this.settings.get().speed.configApplied : false });
    if (enabled) {
      await this.proxy.start();
    } else {
      await this.proxy.stop();
    }
    this.emit('changed');
  }

  getStatus(): SpeedStatus {
    if (this.demo) {
      const series = buildDemoSpeedSeries('30d');
      return {
        enabled: true,
        running: true,
        port: 47831,
        upstreamBase: this.settings.get().speed.upstreamBase,
        sampleCount: series.totalSamples,
        lastSampleAt: Date.now() - 60_000,
        configApplied: false,
        error: null,
      };
    }
    return this.proxy.getStatus();
  }

  getSeries(range: SpeedRange): SpeedSeries {
    if (this.demo) return buildDemoSpeedSeries(range);
    const status = this.proxy.getStatus();
    const points = this.store.getSeries(range);
    return {
      range,
      generatedAt: Date.now(),
      enabled: status.enabled,
      running: status.running,
      points,
      totalSamples: points.reduce((sum, point) => sum + point.samples, 0),
      approximate: points.some((point) => point.tokenSource !== 'upstream'),
      error: status.error ?? undefined,
    };
  }

  getConfigInfo(): SpeedConfigInfo {
    if (this.demo) {
      const url = 'http://127.0.0.1:47831/p/demo';
      return {
        proxyUrl: url,
        snippet: `// 演示模式不会启动真实代理\n{ "provider": { "opencode": { "options": { "baseURL": "${url}" } } } }`,
        configPathHint: '演示模式',
        applied: false,
        running: true,
      };
    }
    return this.proxy.getConfigInfo();
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    if (this.demo) return { ok: true, message: '演示代理正常运行。' };
    const status = this.proxy.getStatus();
    if (!status.running || !status.port) {
      return { ok: false, message: '测速代理未运行，请先启用。' };
    }
    try {
      const response = await fetch(`http://127.0.0.1:${status.port}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      const ok = response.ok;
      return { ok, message: ok ? '本地测速代理响应正常。' : `代理返回 HTTP ${response.status}。` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '无法连接本地代理。' };
    }
  }

  clearSamples(): void {
    this.store.clear();
    this.emit('changed');
  }
}
