import { useEffect, useRef, useState } from 'react';
import type {
  HistoryMetrics,
  HistoryRange,
  LocalUsageRange,
  LocalUsageSummary,
  SpeedRange,
  SpeedSeries,
  Theme,
} from '../../shared/types';

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function useTheme(theme: Theme): void {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
      document.documentElement.dataset.theme = resolved;
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
}

export function useLocalUsage(range: LocalUsageRange, enabled: boolean) {
  const [summary, setSummary] = useState<LocalUsageSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = async (force = false) => {
    if (!enabled) {
      setSummary(null);
      setLoading(false);
      return;
    }
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await window.tokenMonitor.refreshLocalUsage(range);
      if (id === requestId.current) setSummary(result);
    } catch (reason) {
      if (id === requestId.current) {
        setError(reason instanceof Error ? reason.message : 'Could not read local usage');
      }
    } finally {
      if (id === requestId.current) setLoading(false);
    }
    void force;
  };

  useEffect(() => {
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, enabled]);

  return { summary, loading, error, reload: load };
}

export function useSpeedSeries(range: SpeedRange, enabled: boolean) {
  const [series, setSeries] = useState<SpeedSeries | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = async () => {
    if (!enabled) {
      setSeries(null);
      setLoading(false);
      return;
    }
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await window.tokenMonitor.getSpeedSeries(range);
      if (id === requestId.current) setSeries(result);
    } catch (reason) {
      if (id === requestId.current) {
        setError(reason instanceof Error ? reason.message : 'Could not read speed samples');
      }
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, enabled]);

  return { series, loading, error, reload: load };
}

export function useHistoryMetrics(range: HistoryRange, enabled: boolean) {
  const [metrics, setMetrics] = useState<HistoryMetrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = async (force = false) => {
    if (!enabled) {
      setMetrics(null);
      setLoading(false);
      return;
    }
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await window.tokenMonitor.getHistoryMetrics(range, force);
      if (id === requestId.current) setMetrics(result);
    } catch (reason) {
      if (id === requestId.current) {
        setError(reason instanceof Error ? reason.message : 'Could not read session history');
      }
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  };

  useEffect(() => {
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, enabled]);

  return { metrics, loading, error, reload: () => load(true) };
}

export function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return { copied, copy };
}
