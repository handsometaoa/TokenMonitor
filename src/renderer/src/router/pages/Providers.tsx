import { useEffect, useState } from 'react';
import { Archive, ListTree, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import type {
  RouterProvider,
  RouterProviderInput,
  RouterProviderKind,
  RouterProtocol,
  RouterQuotaStrategyInfo,
} from '../../../../shared/routerTypes';
import { RouterBadge, RouterModal, Field } from '../components';
import { isRecord, parseJson } from '../../../../shared/validation';
import { isRouterProviderKind, isRouterProtocol } from '../../../../shared/routerSchemas';

const PROTOCOLS: Array<{ value: RouterProtocol; label: string }> = [
  { value: 'openai', label: 'OpenAI Chat (/chat/completions)' },
  { value: 'anthropic', label: 'Anthropic Messages (/messages)' },
  { value: 'openai-responses', label: 'OpenAI Responses (/responses)' },
];

const KINDS: Array<{ value: RouterProviderKind; label: string }> = [
  { value: 'custom', label: '自定义' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'zai', label: 'Z.AI / GLM' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'moonshot', label: 'Moonshot / Kimi' },
  { value: 'siliconflow', label: 'SiliconFlow' },
  { value: 'groq', label: 'Groq' },
  { value: 'xai', label: 'xAI' },
  { value: 'google', label: 'Google Gemini' },
];

const PRESETS: Array<{
  label: string;
  kind: RouterProviderKind;
  protocol: RouterProtocol;
  baseUrl: string;
  strategy: string;
}> = [
  { label: 'OpenAI', kind: 'openai', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', strategy: '' },
  { label: 'Anthropic', kind: 'anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', strategy: 'claude' },
  { label: 'DeepSeek', kind: 'deepseek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', strategy: 'deepseek' },
  { label: 'Z.AI', kind: 'zai', protocol: 'openai', baseUrl: 'https://api.z.ai/api/coding/paas/v4', strategy: 'zai' },
  { label: 'OpenCode Go', kind: 'opencode', protocol: 'openai', baseUrl: 'https://opencode.ai/zen/go/v1', strategy: 'opencode' },
  { label: 'OpenCode Zen', kind: 'opencode', protocol: 'openai', baseUrl: 'https://opencode.ai/zen/v1', strategy: 'opencode' },
  { label: 'OpenRouter', kind: 'openrouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', strategy: 'openrouter' },
  { label: 'Moonshot', kind: 'moonshot', protocol: 'openai', baseUrl: 'https://api.moonshot.ai/v1', strategy: 'moonshot' },
  { label: 'SiliconFlow', kind: 'siliconflow', protocol: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', strategy: 'siliconflow' },
];

interface FormState {
  id?: string;
  name: string;
  protocol: RouterProtocol;
  kind: RouterProviderKind;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  quotaStrategyId: string;
  strategyConfig: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  protocol: 'openai',
  kind: 'custom',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  enabled: true,
  quotaStrategyId: '',
  strategyConfig: '{}',
};

export function Providers({
  initial,
  strategies,
  onChanged,
}: {
  initial: RouterProvider[];
  strategies: RouterQuotaStrategyInfo[];
  onChanged: () => void;
}) {
  const [providers, setProviders] = useState<RouterProvider[]>(initial);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [editing, setEditing] = useState<FormState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fetchingModelProvider, setFetchingModelProvider] = useState<string | null>(null);
  const [fetchedModels, setFetchedModels] = useState<{ providerName: string; models: string[] } | null>(null);

  // The parent only loads active providers. While "show archived" is on, keep the
  // locally fetched full list instead of letting the parent refresh wipe archived rows.
  useEffect(() => {
    if (!includeArchived) setProviders(initial);
  }, [initial, includeArchived]);

  const reload = async (archived = includeArchived) => {
    setProviders(await window.tokenMonitor.listRouterProviders(archived));
    onChanged();
  };

  const save = async () => {
    if (!editing) return;
    setError(null);
    setBusy(true);
    try {
      let strategyConfig: Record<string, string> = {};
      if (editing.strategyConfig.trim()) {
        const parsed = parseJson(editing.strategyConfig);
        if (!isRecord(parsed)) {
          throw new Error('策略附加配置必须是 JSON 对象');
        }
        strategyConfig = Object.fromEntries(
          Object.entries(parsed).map(([key, value]) => [key, String(value)]),
        );
      }
      const input: RouterProviderInput = {
        id: editing.id,
        name: editing.name,
        protocol: editing.protocol,
        kind: editing.kind,
        baseUrl: editing.baseUrl,
        apiKey: editing.apiKey.trim() || undefined,
        enabled: editing.enabled,
        quotaStrategyId: editing.quotaStrategyId || null,
        strategyConfig,
      };
      await window.tokenMonitor.saveRouterProvider(input);
      setEditing(null);
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const archive = async (provider: RouterProvider, archived: boolean) => {
    await window.tokenMonitor.archiveRouterProvider(provider.id, archived);
    await reload();
  };

  const remove = async (provider: RouterProvider) => {
    if (!window.confirm(`删除提供商「${provider.name}」及其全部模型映射？`)) return;
    await window.tokenMonitor.deleteRouterProvider(provider.id);
    await reload();
  };

  const fetchModels = async (provider: RouterProvider) => {
    setError(null);
    setFetchingModelProvider(provider.id);
    try {
      const models = await window.tokenMonitor.listRouterProviderModels(provider.id);
      setFetchedModels({ providerName: provider.name, models });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '拉取模型失败');
    } finally {
      setFetchingModelProvider(null);
    }
  };

  return (
    <div className="router-page">
      <div className="router-toolbar">
        <div className="router-toolbar-actions">
          <label className="router-check">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(event) => {
                setIncludeArchived(event.target.checked);
                void reload(event.target.checked);
              }}
            />
            显示已归档
          </label>
          <button type="button" className="router-btn primary" onClick={() => setEditing({ ...EMPTY_FORM })}>
            <Plus size={15} />
            添加提供商
          </button>
        </div>
      </div>

      {error ? <div className="router-banner danger">{error}</div> : null}

      <div className="router-card table">
        <table className="router-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>协议</th>
              <th>Base URL</th>
              <th>模型</th>
              <th>凭证</th>
              <th>余量策略</th>
              <th>状态</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {providers.map((provider) => (
              <tr key={provider.id} className={provider.archivedAt ? 'archived' : ''}>
                <td>
                  <strong>{provider.name}</strong>
                  <div className="router-cell-sub">{provider.kind}</div>
                </td>
                <td className="mono">{provider.protocol}</td>
                <td className="mono router-url">{provider.baseUrl}</td>
                <td>{provider.modelCount}</td>
                <td>{provider.hasKey ? <span className="mono">{provider.keyMasked}</span> : <RouterBadge tone="warn">未配置</RouterBadge>}</td>
                <td>{provider.quotaStrategyId ?? '—'}</td>
                <td>
                  {provider.archivedAt ? (
                    <RouterBadge>已归档</RouterBadge>
                  ) : provider.enabled ? (
                    <RouterBadge tone="good">启用</RouterBadge>
                  ) : (
                    <RouterBadge tone="warn">停用</RouterBadge>
                  )}
                </td>
                <td>
                  <div className="router-row-actions">
                    <button
                      type="button"
                      className="router-icon-btn"
                      title="拉取模型列表"
                      disabled={!provider.hasKey || fetchingModelProvider === provider.id}
                      onClick={() => void fetchModels(provider)}
                    >
                      <ListTree size={14} />
                    </button>
                    <button
                      type="button"
                      className="router-icon-btn"
                      title="编辑"
                      onClick={() =>
                        setEditing({
                          id: provider.id,
                          name: provider.name,
                          protocol: provider.protocol,
                          kind: provider.kind,
                          baseUrl: provider.baseUrl,
                          apiKey: '',
                          enabled: provider.enabled,
                          quotaStrategyId: provider.quotaStrategyId ?? '',
                          strategyConfig: JSON.stringify(provider.strategyConfig ?? {}, null, 2),
                        })
                      }
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      className="router-icon-btn"
                      title={provider.archivedAt ? '恢复' : '归档'}
                      onClick={() => void archive(provider, !provider.archivedAt)}
                    >
                      {provider.archivedAt ? <RotateCcw size={14} /> : <Archive size={14} />}
                    </button>
                    <button type="button" className="router-icon-btn danger" title="删除" onClick={() => void remove(provider)}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {providers.length === 0 ? (
              <tr>
                <td colSpan={8}>
                  <div className="router-empty-inline">还没有提供商。先添加一个上游 API，再配置模型映射。</div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {editing ? (
        <RouterModal
          title={editing.id ? '编辑提供商' : '添加提供商'}
          subtitle="Base URL 需要包含版本前缀，例如 https://api.openai.com/v1"
          onClose={() => setEditing(null)}
          footer={
            <>
              <button type="button" className="router-btn" onClick={() => setEditing(null)} disabled={busy}>
                取消
              </button>
              <button type="button" className="router-btn primary" onClick={() => void save()} disabled={busy || !editing.name.trim() || !editing.baseUrl.trim()}>
                {busy ? '保存中…' : '保存'}
              </button>
            </>
          }
        >
          <div className="router-preset-row">
            {PRESETS.map((preset) => (
              <button
                type="button"
                key={preset.label}
                className="router-preset"
                onClick={() =>
                  setEditing({
                    ...editing,
                    name: editing.name.trim() || preset.label,
                    kind: preset.kind,
                    protocol: preset.protocol,
                    baseUrl: preset.baseUrl,
                    quotaStrategyId: preset.strategy,
                  })
                }
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="router-form-grid">
            <Field label="名称">
              <input className="router-input" value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} />
            </Field>
            <Field label="类型">
              <select
                className="router-select"
                value={editing.kind}
                onChange={(event) => {
                  const kind = event.target.value;
                  if (isRouterProviderKind(kind)) setEditing({ ...editing, kind });
                }}
              >
                {KINDS.map((item) => (
                  <option key={item.value} value={item.value}>{item.label}</option>
                ))}
              </select>
            </Field>
            <Field label="协议">
              <select
                className="router-select"
                value={editing.protocol}
                onChange={(event) => {
                  const protocol = event.target.value;
                  if (isRouterProtocol(protocol)) setEditing({ ...editing, protocol });
                }}
              >
                {PROTOCOLS.map((item) => (
                  <option key={item.value} value={item.value}>{item.label}</option>
                ))}
              </select>
            </Field>
            <Field label="启用">
              <label className="router-check">
                <input type="checkbox" checked={editing.enabled} onChange={(event) => setEditing({ ...editing, enabled: event.target.checked })} />
                参与路由
              </label>
            </Field>
          </div>
          <Field label="Base URL" hint="统一约定：填写完整 API 根，不自动补 /v1">
            <input className="router-input mono" value={editing.baseUrl} onChange={(event) => setEditing({ ...editing, baseUrl: event.target.value })} />
          </Field>
          <Field label={editing.id ? 'API Key（留空保持不变）' : 'API Key'} hint="仅保存在本机，使用系统加密；不会传给渲染进程之外的其他服务">
            <input
              className="router-input mono"
              type="password"
              value={editing.apiKey}
              placeholder={editing.id ? '••••••••（留空不修改）' : 'sk-…'}
              onChange={(event) => setEditing({ ...editing, apiKey: event.target.value })}
            />
          </Field>
          <div className="router-form-grid">
            <Field label="余量策略">
              <select
                className="router-select"
                value={editing.quotaStrategyId}
                onChange={(event) => setEditing({ ...editing, quotaStrategyId: event.target.value })}
              >
                <option value="">不查询余量</option>
                {strategies.map((strategy) => (
                  <option key={strategy.id} value={strategy.id}>{strategy.label}</option>
                ))}
              </select>
            </Field>
            <Field
              label="策略附加配置"
              hint="JSON；Custom HTTP 支持 url / auth / headers / percentPath / usedPath / limitPath / balancePath / currency / windowMinutes"
            >
              <textarea
                className="router-input mono"
                style={{ height: 64, padding: '7px 10px', resize: 'vertical' }}
                value={editing.strategyConfig}
                onChange={(event) => setEditing({ ...editing, strategyConfig: event.target.value })}
              />
            </Field>
          </div>
        </RouterModal>
      ) : null}

      {fetchedModels ? (
        <RouterModal
          title={`可用模型 · ${fetchedModels.providerName}`}
          subtitle={`共 ${fetchedModels.models.length} 个模型，来自上游 /models 接口`}
          width={640}
          onClose={() => setFetchedModels(null)}
          footer={
            <button
              type="button"
              className="router-btn"
              onClick={() => void navigator.clipboard.writeText(fetchedModels.models.join('\n'))}
            >
              复制全部
            </button>
          }
        >
          {fetchedModels.models.length === 0 ? (
            <div className="router-empty-inline">上游返回了空列表。</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 420, overflowY: 'auto' }}>
              {fetchedModels.models.map((model) => (
                <span
                  key={model}
                  className="mono"
                  style={{
                    padding: '4px 10px',
                    borderRadius: 999,
                    border: '1px solid var(--border-strong)',
                    background: 'var(--surface-3)',
                    fontSize: 11,
                  }}
                >
                  {model}
                </span>
              ))}
            </div>
          )}
        </RouterModal>
      ) : null}
    </div>
  );
}
