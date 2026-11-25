import { EventEmitter } from 'node:events';
import { asRecord, errorMessage } from '../../shared/validation';
import type { ExtraProviderId, ServiceStatus } from '../../shared/types';
import type { ExtraFetch } from '../providers/extra/types';
import type { Logger } from './logger';

interface StatusPageConfig {
  providerId: ExtraProviderId;
  providerName: string;
  url: string;
  components: RegExp;
}

const STATUS_PAGES: StatusPageConfig[] = [
  {
    providerId: 'codex',
    providerName: 'Codex',
    url: 'https://status.openai.com/api/v2/summary.json',
    components: /codex|api|chat completions|responses|cli/i,
  },
  {
    providerId: 'claude',
    providerName: 'Claude',
    url: 'https://status.claude.com/api/v2/summary.json',
    components: /claude|api|console|code/i,
  },
  {
    providerId: 'cursor',
    providerName: 'Cursor',
    url: 'https://status.cursor.com/api/v2/summary.json',
    components: /cursor|api|agent/i,
  },
];

function indicator(value: unknown): ServiceStatus['indicator'] {
  return value === 'none' || value === 'minor' || value === 'major' || value === 'critical' ? value : 'unknown';
}

export function normalizeStatusPage(
  providerId: ExtraProviderId,
  providerName: string,
  url: string,
  json: unknown,
  now = Date.now(),
): ServiceStatus {
  const root = asRecord(json) ?? {};
  const status = asRecord(root.status) ?? {};
  const incidents = Array.isArray(root.incidents) ? root.incidents : [];
  const rawComponents = Array.isArray(root.components) ? root.components : [];
  const components = rawComponents
    .map((raw) => asRecord(raw))
    .filter((raw): raw is Record<string, unknown> => raw !== null)
    .map((raw) => ({
      name: typeof raw.name === 'string' ? raw.name : 'Component',
      status: typeof raw.status === 'string' ? raw.status : 'unknown',
    }));

  return {
    providerId,
    providerName,
    indicator: indicator(status.indicator),
    description: typeof status.description === 'string' ? status.description : 'Unknown status',
    incidentCount: incidents.filter((raw) => {
      const incident = asRecord(raw);
      return incident !== null && incident.status !== 'resolved' && incident.status !== 'postmortem';
    }).length,
    components,
    updatedAt: now,
    url,
    error: undefined,
  };
}

export class ServiceStatusService extends EventEmitter {
  private statuses: ServiceStatus[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly fetchImpl: ExtraFetch,
    private readonly logger: Logger,
    private readonly demo: boolean,
  ) {
    super();
  }

  start(): void {
    if (this.demo) {
      this.statuses = this.demoStatuses();
      this.emit('changed');
      return;
    }
    void this.refresh();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  getStatuses(): ServiceStatus[] {
    return this.statuses.map((status) => ({
      ...status,
      components: status.components.map((component) => ({ ...component })),
    }));
  }

  async refresh(): Promise<void> {
    if (this.demo) return;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doRefresh(): Promise<void> {
    const results: ServiceStatus[] = [];
    await Promise.all(
      STATUS_PAGES.map(async (page) => {
        try {
          const response = await this.fetchImpl(page.url, {
            method: 'GET',
            headers: { Accept: 'application/json', 'User-Agent': 'TokenMonitor/0.4.6' },
            signal: AbortSignal.timeout(12_000),
            cache: 'no-store',
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const json: unknown = await response.json();
          const normalized = normalizeStatusPage(page.providerId, page.providerName, page.url.replace('/api/v2/summary.json', ''), json);
          const relevant = normalized.components.filter((component) => page.components.test(component.name));
          results.push({
            ...normalized,
            components: (relevant.length ? relevant : normalized.components).slice(0, 6),
          });
        } catch (error) {
          this.logger.warn(`${page.providerName} status fetch failed: ${errorMessage(error)}`);
          results.push({
            providerId: page.providerId,
            providerName: page.providerName,
            indicator: 'unknown',
            description: '状态页暂时不可用',
            incidentCount: 0,
            components: [],
            updatedAt: Date.now(),
            url: page.url.replace('/api/v2/summary.json', ''),
            error: errorMessage(error),
          });
        }
      }),
    );

    const order = new Map<ExtraProviderId, number>([
      ['codex', 0],
      ['claude', 1],
      ['cursor', 2],
      ['zai', 3],
      ['zcode', 4],
    ]);
    this.statuses = results.sort((a, b) => (order.get(a.providerId) ?? 9) - (order.get(b.providerId) ?? 9));
    this.emit('changed');
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, 5 * 60 * 1000);
  }

  private demoStatuses(): ServiceStatus[] {
    return [
      {
        providerId: 'codex',
        providerName: 'Codex',
        indicator: 'minor',
        description: 'Partially degraded service',
        incidentCount: 2,
        components: [
          { name: 'Codex API', status: 'major_outage' },
          { name: 'Chat Completions', status: 'degraded_performance' },
          { name: 'CLI', status: 'operational' },
          { name: 'Responses', status: 'operational' },
        ],
        updatedAt: Date.now(),
        url: 'https://status.openai.com',
      },
      {
        providerId: 'claude',
        providerName: 'Claude',
        indicator: 'none',
        description: 'All systems operational',
        incidentCount: 0,
        components: [{ name: 'Claude API', status: 'operational' }],
        updatedAt: Date.now(),
        url: 'https://status.claude.com',
      },
      {
        providerId: 'cursor',
        providerName: 'Cursor',
        indicator: 'unknown',
        description: '状态页暂时不可用',
        incidentCount: 0,
        components: [],
        updatedAt: Date.now(),
        url: 'https://status.cursor.com',
        error: 'No status page',
      },
    ];
  }
}
