import { useEffect, useMemo, useRef, useState } from 'react';
import type { Language } from '../../../shared/types';
import { formatDayLabel, formatTokens } from '../format';
import type { Translator } from '../i18n';

export interface BarPoint {
  day: string;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

const COLORS = {
  input: '#2F6BFF',
  output: '#8B5CF6',
  reasoning: '#F59E0B',
  cache: '#14B8A6',
};

function niceMax(value: number): number {
  if (value <= 10) return 10;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

export function BarChart({
  data,
  height = 170,
  language,
  t,
}: {
  data: BarPoint[];
  height?: number;
  language: Language;
  t: Translator;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(420);
  const [hoverDay, setHoverDay] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      setWidth(Math.max(220, entries[0]?.contentRect.width ?? 420));
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const max = useMemo(() => niceMax(Math.max(1, ...data.map((point) => point.total)) * 1.1), [data]);
  const margin = { top: 10, right: 6, bottom: 24, left: 34 };
  const chartWidth = Math.max(1, width - margin.left - margin.right);
  const chartHeight = Math.max(1, height - margin.top - margin.bottom);
  const slot = chartWidth / Math.max(1, data.length);
  const barWidth = Math.max(2, Math.min(18, slot * 0.64));
  const yFor = (value: number) => margin.top + chartHeight - (value / max) * chartHeight;
  const labelEvery = Math.max(1, Math.ceil(data.length / 6));
  const hovered = data.find((point) => point.day === hoverDay) ?? null;
  const hoveredIndex = hovered ? data.indexOf(hovered) : -1;
  const hoveredX = hoveredIndex >= 0 ? margin.left + slot * hoveredIndex + slot / 2 : 0;

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%' }}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={t('local.chartLabel')}
        onMouseLeave={() => setHoverDay(null)}
        onMouseMove={(event) => {
          if (data.length === 0) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const x = event.clientX - rect.left - margin.left;
          const index = Math.max(0, Math.min(data.length - 1, Math.floor(x / slot)));
          setHoverDay(data[index]?.day ?? null);
        }}
      >
        {[0, 0.5, 1].map((fraction) => {
          const value = max * fraction;
          const y = yFor(value);
          return (
            <g key={fraction}>
              <line
                x1={margin.left}
                x2={width - margin.right}
                y1={y}
                y2={y}
                stroke="var(--border)"
                strokeDasharray={fraction === 0 ? undefined : '3 5'}
              />
              <text x={margin.left - 6} y={y + 3.5} textAnchor="end" fontSize="9" fill="var(--faint)" className="mono">
                {formatTokens(value)}
              </text>
            </g>
          );
        })}

        {data.map((point, index) => {
          const x = margin.left + slot * index + (slot - barWidth) / 2;
          const cache = point.cacheRead + point.cacheWrite;
          const segments = [
            { value: point.input, color: COLORS.input },
            { value: point.output, color: COLORS.output },
            { value: point.reasoning, color: COLORS.reasoning },
            { value: cache, color: COLORS.cache },
          ];
          let cursor = margin.top + chartHeight;
          return (
            <g key={point.day} opacity={hoverDay && hoverDay !== point.day ? 0.55 : 1}>
              {segments.map((segment, segmentIndex) => {
                const segmentHeight = (segment.value / max) * chartHeight;
                cursor -= segmentHeight;
                return segmentHeight > 0 ? (
                  <rect
                    key={segmentIndex}
                    x={x}
                    y={cursor}
                    width={barWidth}
                    height={Math.max(0.5, segmentHeight)}
                    rx={segmentIndex === segments.length - 1 ? 3 : 0}
                    fill={segment.color}
                  />
                ) : null;
              })}
            </g>
          );
        })}

        {data.map((point, index) => {
          if (index % labelEvery !== 0 && index !== data.length - 1) return null;
          const x = margin.left + slot * index + slot / 2;
          const anchor = index === 0 ? 'start' : index === data.length - 1 ? 'end' : 'middle';
          return (
            <text key={point.day} x={x} y={height - 7} textAnchor={anchor} fontSize="9" fill="var(--faint)">
              {formatDayLabel(point.day, language)}
            </text>
          );
        })}
      </svg>

      {hovered ? (
        <div
          className="chart-tooltip"
          style={{
            left: Math.min(Math.max(hoveredX + 10, 8), Math.max(8, width - 180)),
            top: 10,
          }}
        >
          <div className="mono" style={{ fontWeight: 700 }}>{formatDayLabel(hovered.day, language)}</div>
          <div className="chart-tooltip-row">
            <span>{t('local.tokens')}</span>
            <span className="mono" style={{ fontWeight: 650 }}>{formatTokens(hovered.total)}</span>
          </div>
          <div className="chart-tooltip-row">
            <span style={{ color: COLORS.input }}>{t('local.input')}</span>
            <span className="mono">{formatTokens(hovered.input)}</span>
          </div>
          <div className="chart-tooltip-row">
            <span style={{ color: COLORS.output }}>{t('local.output')}</span>
            <span className="mono">{formatTokens(hovered.output)}</span>
          </div>
          <div className="chart-tooltip-row">
            <span style={{ color: COLORS.reasoning }}>{t('local.reasoning')}</span>
            <span className="mono">{formatTokens(hovered.reasoning)}</span>
          </div>
          <div className="chart-tooltip-row">
            <span style={{ color: COLORS.cache }}>{t('local.cacheRead')}</span>
            <span className="mono">{formatTokens(hovered.cacheRead + hovered.cacheWrite)}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
