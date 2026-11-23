import { useEffect, useMemo, useRef, useState } from 'react';
import type { Language } from '../../../shared/types';
import { formatDayLabel } from '../format';

export interface LineSeries {
  key: string;
  label: string;
  color: string;
  points: Array<{ day: string; value: number }>;
}

function niceMax(value: number): number {
  if (value <= 10) return 10;
  if (value <= 20) return 20;
  if (value <= 40) return 40;
  if (value <= 60) return 60;
  if (value <= 80) return 80;
  if (value <= 100) return 100;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

function smoothPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[index - 1] ?? points[index];
    const p1 = points[index];
    const p2 = points[index + 1];
    const p3 = points[index + 2] ?? p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    path += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return path;
}

export function LineChart({
  series,
  height = 190,
  language,
  yMax: fixedYMax,
  unit = '',
}: {
  series: LineSeries[];
  height?: number;
  language: Language;
  yMax?: number;
  unit?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(420);
  const [hoverDay, setHoverDay] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 420;
      setWidth(Math.max(220, next));
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const days = useMemo(() => {
    const set = new Set<string>();
    for (const item of series) for (const point of item.points) set.add(point.day);
    return [...set].sort();
  }, [series]);

  const maxValue = useMemo(() => {
    let max = 0;
    for (const item of series) for (const point of item.points) max = Math.max(max, point.value);
    return fixedYMax ?? niceMax(max * 1.12);
  }, [series, fixedYMax]);

  const margin = { top: 10, right: 8, bottom: 24, left: 30 };
  const chartWidth = Math.max(1, width - margin.left - margin.right);
  const chartHeight = Math.max(1, height - margin.top - margin.bottom);
  const xFor = (index: number) => margin.left + (days.length <= 1 ? chartWidth / 2 : (index / (days.length - 1)) * chartWidth);
  const yFor = (value: number) => margin.top + chartHeight - (Math.min(maxValue, Math.max(0, value)) / maxValue) * chartHeight;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => maxValue * fraction);
  const labelEvery = Math.max(1, Math.ceil(days.length / 6));
  const hoveredSeries = series
    .map((item) => ({ item, point: item.points.find((point) => point.day === hoverDay) }))
    .filter((entry): entry is { item: LineSeries; point: { day: string; value: number } } => Boolean(entry.point));
  const hoveredX = hoverDay ? xFor(days.indexOf(hoverDay)) : 0;

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%' }}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={language === 'zh-CN' ? '模型速度趋势图' : 'Model speed trend chart'}
        onMouseLeave={() => setHoverDay(null)}
        onMouseMove={(event) => {
          if (days.length === 0) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const x = event.clientX - rect.left;
          const ratio = Math.min(1, Math.max(0, (x - margin.left) / chartWidth));
          const index = days.length <= 1 ? 0 : Math.round(ratio * (days.length - 1));
          setHoverDay(days[index] ?? null);
        }}
      >
        {yTicks.map((tick) => {
          const y = yFor(tick);
          return (
            <g key={tick}>
              <line
                x1={margin.left}
                x2={width - margin.right}
                y1={y}
                y2={y}
                stroke="var(--border)"
                strokeDasharray={tick === 0 ? undefined : '3 5'}
              />
              <text x={margin.left - 6} y={y + 3.5} textAnchor="end" fontSize="9" fill="var(--faint)" className="mono">
                {Math.round(tick)}
              </text>
            </g>
          );
        })}

        {days.map((day, index) => {
          const date = new Date(`${day}T12:00:00`);
          const weekend = date.getDay() === 0 || date.getDay() === 6;
          return weekend ? (
            <rect
              key={`weekend-${day}`}
              x={xFor(index) - chartWidth / Math.max(1, days.length) / 2}
              y={margin.top}
              width={chartWidth / Math.max(1, days.length)}
              height={chartHeight}
              fill="var(--track)"
              opacity="0.35"
            />
          ) : null;
        })}

        {series.map((item) => {
          const points = item.points
            .filter((point) => days.includes(point.day))
            .map((point) => ({ x: xFor(days.indexOf(point.day)), y: yFor(point.value) }));
          return (
            <g key={item.key}>
              <path d={smoothPath(points)} fill="none" stroke={item.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              {days.length <= 12
                ? points.map((point, index) => (
                    <circle key={index} cx={point.x} cy={point.y} r="2.6" fill="var(--surface-solid)" stroke={item.color} strokeWidth="1.8" />
                  ))
                : null}
              {hoverDay ? (
                (() => {
                  const point = points[days.indexOf(hoverDay)];
                  return point ? <circle cx={point.x} cy={point.y} r="3.4" fill={item.color} stroke="var(--surface-solid)" strokeWidth="2" /> : null;
                })()
              ) : null}
            </g>
          );
        })}

        {hoverDay ? (
          <line x1={hoveredX} x2={hoveredX} y1={margin.top} y2={margin.top + chartHeight} stroke="var(--border-strong)" strokeDasharray="3 4" />
        ) : null}

        {days.map((day, index) => {
          if (index % labelEvery !== 0 && index !== days.length - 1) return null;
          const anchor = index === 0 ? 'start' : index === days.length - 1 ? 'end' : 'middle';
          return (
            <text key={day} x={xFor(index)} y={height - 7} textAnchor={anchor} fontSize="9" fill="var(--faint)">
              {formatDayLabel(day, language)}
            </text>
          );
        })}
      </svg>

      {hoverDay && hoveredSeries.length > 0 ? (
        <div
          className="chart-tooltip"
          style={{
            left: Math.min(Math.max(hoveredX + 10, 8), Math.max(8, width - 178)),
            top: 18,
          }}
        >
          <div className="mono" style={{ fontWeight: 700 }}>{formatDayLabel(hoverDay, language)}</div>
          {hoveredSeries.map(({ item, point }) => (
            <div key={item.key} className="chart-tooltip-row">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                <span className="legend-dot" style={{ background: item.color }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
              </span>
              <span className="mono" style={{ fontWeight: 650, whiteSpace: 'nowrap' }}>
                {point.value.toFixed(1)}
                {unit}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
