import { describe, expect, it } from 'vitest';
import { normalizeStatusPage } from '../src/main/services/serviceStatus';

describe('normalizeStatusPage', () => {
  it('maps Statuspage indicators, active incidents and components', () => {
    const status = normalizeStatusPage(
      'codex',
      'Codex',
      'https://status.openai.com',
      {
        status: { indicator: 'minor', description: 'Partially degraded service' },
        incidents: [
          { id: 'i1', status: 'investigating' },
          { id: 'i2', status: 'resolved' },
        ],
        components: [
          { name: 'Codex API', status: 'major_outage' },
          { name: 'CLI', status: 'operational' },
          { name: 'Responses', status: 'degraded_performance' },
        ],
      },
      123,
    );
    expect(status.indicator).toBe('minor');
    expect(status.incidentCount).toBe(1);
    expect(status.components.find((component) => component.name === 'Codex API')?.status).toBe('major_outage');
    expect(status.updatedAt).toBe(123);
  });

  it('keeps unknown indicators unknown instead of reporting healthy', () => {
    const status = normalizeStatusPage('claude', 'Claude', 'https://status.claude.com', {
      status: { indicator: 'wat', description: 'odd' },
    });
    expect(status.indicator).toBe('unknown');
    expect(status.incidentCount).toBe(0);
  });
});
