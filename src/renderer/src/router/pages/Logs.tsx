import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import type { RouterLogEntry, RouterLogPage } from '../../../../shared/routerTypes';
import { parseJson } from '../../../../shared/validation';
import { RouterBadge, RouterModal, formatRouterDuration, formatRouterTime, statusTone } from '../components';
import { CodeViewer } from '../CodeViewer';

function bodyLanguage(value: string | null): 'json' | 'plaintext' {
  if (!value) return 'plaintext';
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return 'plaintext';
  try {
    parseJson(trimmed);
    return 'json';
  } catch {
    return 'plaintext';
  }
}

/** Total input side: non-cached prompt + cache read + cache write. */
function contextTokens(entry: RouterLogEntry): number {
  return entry.promptTokens + entry.cacheReadTokens + entry.cacheWriteTokens;
}

/** Share of input tokens served from the prompt cache. */
function cacheHitPercent(entry: RouterLogEntry): number | null {
  const context = contextTokens(entry);
  if (context <= 0) return null;
  return (entry.cacheReadTokens / context) * 100;
}

export function Logs({ onError }: { onError: (message: string) => void }) {
  const [page, setPage] = useState<RouterLogPage>({ items: [], total: 0 });
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<RouterLogEntry | null>(null);
  const limit = 40;

  const load = useCallback(
    async (nextOffset = offset) => {
      setLoading(true);
      try {
        const result = await window.tokenMonitor.getRouterLogs({
          limit,
          offset: nextOffset,
          search: search.trim() || null,
          status: status ? Number(status) : null,
        });
        setPage(result);
        setOffset(nextOffset);
      } catch (reason) {
        onError(reason instanceof Error ? reason.message : '读取日志失败');
      } finally {
        setLoading(false);
      }
    },
    [offset, search, status, onError],
  );

  useEffect(() => {
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const detail = async (entry: RouterLogEntry) => {
    const full = await window.tokenMonitor.getRouterLog(entry.id);
    setSelected(full ?? entry);
  };

  const selectedCacheHit = selected ? cacheHitPercent(selected) : null;

  return (
    <div className="router-page">
      <div className="router-toolbar">
        <div className="router-toolbar-actions">
          <div className="router-search">
            <Search size={14} />
            <input
              className="router-input search"
              placeholder="搜索模型 / 提供商 / 错误"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void load(0);
              }}
            />
          </div>
          <select className="router-select" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">全部状态</option>
            <option value="200">200</option>
            <option value="400">400</option>
            <option value="401">401</option>
            <option value="404">404</option>
            <option value="429">429</option>
            <option value="499">499</option>
            <option value="500">500</option>
            <option value="502">502</option>
            <option value="503">503</option>
          </select>
          <button type="button" className="router-btn" onClick={() => void load(0)} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
            刷新
          </button>
        </div>
      </div>

      <div className="router-card table">
        <table className="router-table logs">
          <thead>
            <tr>
              <th>时间</th>
              <th>模型</th>
              <th>渠道</th>
              <th>状态</th>
              <th>耗时</th>
              <th>上下文</th>
              <th>缓存命中</th>
              <th>Tokens</th>
              <th>来源</th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((entry) => {
              const cacheHit = cacheHitPercent(entry);
              return (
                <tr key={entry.id} onClick={() => void detail(entry)} className="clickable">
                <td className="mono">{formatRouterTime(entry.startedAt)}</td>
                <td>
                  <strong className="mono">{entry.publicModel}</strong>
                  <div className="router-cell-sub mono">{entry.upstreamModel}</div>
                </td>
                <td>
                  {entry.providerName}
                  {entry.stream ? <div className="router-cell-sub">stream</div> : null}
                </td>
                <td>
                  <RouterBadge tone={statusTone(entry.status)}>{entry.status ?? '进行中'}</RouterBadge>
                </td>
                <td className="mono">{formatRouterDuration(entry.durationMs)}</td>
                <td className="mono">{contextTokens(entry).toLocaleString()}</td>
                <td className="mono">
                  {cacheHit === null ? '—' : `${cacheHit.toFixed(0)}%`}
                </td>
                <td className="mono">{entry.totalTokens.toLocaleString()}</td>
                <td className="mono">{entry.client ?? '—'}</td>
                </tr>
              );
            })}
            {page.items.length === 0 ? (
              <tr>
                <td colSpan={9}>
                  <div className="router-empty-inline">{loading ? '读取中…' : '还没有请求日志。'}</div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="router-pager">
        <span>
          共 {page.total} 条 · 第 {Math.floor(offset / limit) + 1} 页
        </span>
        <div className="router-row-actions">
          <button type="button" className="router-btn sm" disabled={offset <= 0 || loading} onClick={() => void load(Math.max(0, offset - limit))}>
            上一页
          </button>
          <button type="button" className="router-btn sm" disabled={offset + limit >= page.total || loading} onClick={() => void load(offset + limit)}>
            下一页
          </button>
        </div>
      </div>

      {selected ? (
        <RouterModal
          title="请求详情"
          subtitle={`${selected.publicModel} → ${selected.providerName} / ${selected.upstreamModel}`}
          width={880}
          onClose={() => setSelected(null)}
          footer={
            <button type="button" className="router-btn" onClick={() => setSelected(null)}>
              关闭
            </button>
          }
        >
          <div className="router-detail-grid">
            <div>
              <span>状态</span>
              <strong>{selected.status ?? '进行中'}</strong>
            </div>
            <div>
              <span>耗时</span>
              <strong>{formatRouterDuration(selected.durationMs)}</strong>
            </div>
            <div>
              <span>输出速度</span>
              <strong>
                {selected.durationMs != null && selected.ttftMs != null && selected.durationMs > selected.ttftMs
                  ? `${((selected.completionTokens / (selected.durationMs - selected.ttftMs)) * 1000).toFixed(1)} tok/s`
                  : '—'}
              </strong>
            </div>
            <div>
              <span>上下文大小</span>
              <strong>{contextTokens(selected).toLocaleString()}</strong>
            </div>
            <div>
              <span>缓存命中</span>
              <strong>
                {selectedCacheHit === null ? '—' : `${selectedCacheHit.toFixed(1)}%`}
              </strong>
            </div>
            <div>
              <span>Prompt</span>
              <strong>{selected.promptTokens.toLocaleString()}</strong>
            </div>
            <div>
              <span>Cache read</span>
              <strong>{selected.cacheReadTokens.toLocaleString()}</strong>
            </div>
            <div>
              <span>Cache write</span>
              <strong>{selected.cacheWriteTokens.toLocaleString()}</strong>
            </div>
            <div>
              <span>Completion</span>
              <strong>{selected.completionTokens.toLocaleString()}</strong>
            </div>
            <div>
              <span>Total</span>
              <strong>{selected.totalTokens.toLocaleString()}</strong>
            </div>
          </div>
          {selected.error ? (
            <div className="router-detail-section">
              <div className="router-detail-title">错误</div>
              <pre className="router-pre error">{selected.error}</pre>
            </div>
          ) : null}
          {selected.retryTrace ? (
            <div className="router-detail-section">
              <div className="router-detail-title">重试轨迹</div>
              <pre className="router-pre">{selected.retryTrace}</pre>
            </div>
          ) : null}
          <div className="router-detail-section">
            <div className="router-detail-title">请求头</div>
            <pre className="router-pre">{selected.requestHeaders ?? '—'}</pre>
          </div>
          <div className="router-detail-section">
            <div className="router-detail-title">请求正文</div>
            <CodeViewer value={selected.requestBody ?? '—'} language={bodyLanguage(selected.requestBody)} height={200} />
          </div>
          <div className="router-detail-section">
            <div className="router-detail-title">响应头</div>
            <pre className="router-pre">{selected.responseHeaders ?? '—'}</pre>
          </div>
          <div className="router-detail-section">
            <div className="router-detail-title">响应正文</div>
            <CodeViewer value={selected.responseBody ?? '—'} language={bodyLanguage(selected.responseBody)} height={200} />
          </div>
        </RouterModal>
      ) : null}
    </div>
  );
}
