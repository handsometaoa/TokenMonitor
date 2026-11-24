import { useEffect, useMemo, useState } from 'react';
import { Archive, Pencil, Plus, Power, RotateCcw, TextCursorInput, Trash2 } from 'lucide-react';
import type { RouterModelGroup, RouterModelInput, RouterProvider } from '../../../../shared/routerTypes';
import { RouterBadge, RouterModal, Field } from '../components';

interface FormState {
  id?: string;
  providerId: string;
  publicName: string;
  upstreamName: string;
  enabled: boolean;
}

export function Models({
  initial,
  providers,
  onChanged,
}: {
  initial: RouterModelGroup[];
  providers: RouterProvider[];
  onChanged: () => void;
}) {
  const [groups, setGroups] = useState<RouterModelGroup[]>(initial);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<FormState | null>(null);
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setGroups(initial);
  }, [initial]);

  const reload = async (archived = includeArchived) => {
    setGroups(await window.tokenMonitor.listRouterModels(archived));
    onChanged();
  };

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return groups;
    return groups
      .map((group) => ({
        ...group,
        channels: group.channels.filter(
          (channel) =>
            group.publicName.toLowerCase().includes(needle) ||
            channel.providerName.toLowerCase().includes(needle) ||
            channel.upstreamName.toLowerCase().includes(needle),
        ),
      }))
      .filter((group) => group.channels.length > 0);
  }, [groups, search]);

  const openNew = () => {
    setEditing({
      providerId: providers.find((provider) => !provider.archivedAt)?.id ?? '',
      publicName: '',
      upstreamName: '',
      enabled: true,
    });
  };

  const save = async () => {
    if (!editing) return;
    setError(null);
    setBusy(true);
    try {
      const input: RouterModelInput = {
        id: editing.id,
        providerId: editing.providerId,
        publicName: editing.publicName,
        upstreamName: editing.upstreamName,
        enabled: editing.enabled,
      };
      await window.tokenMonitor.saveRouterModel(input);
      setEditing(null);
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const archive = async (id: string, archived: boolean) => {
    await window.tokenMonitor.archiveRouterModel(id, archived);
    await reload();
  };

  const remove = async (id: string) => {
    if (!window.confirm('删除这条模型渠道？')) return;
    await window.tokenMonitor.deleteRouterModel(id);
    await reload();
  };

  const toggleGroup = async (group: RouterModelGroup) => {
    await window.tokenMonitor.setRouterModelGroupEnabled(group.publicName, group.enabledCount === 0);
    await reload();
  };

  const saveRename = async () => {
    if (!renaming || !renaming.to.trim()) return;
    setError(null);
    setBusy(true);
    try {
      await window.tokenMonitor.renameRouterModelGroup(renaming.from, renaming.to.trim());
      setRenaming(null);
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '重命名失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="router-page">
      <div className="router-toolbar">
        <div className="router-toolbar-actions">
          <input
            className="router-input search"
            placeholder="搜索模型 / 提供商"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
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
          <button type="button" className="router-btn primary" onClick={openNew} disabled={providers.filter((provider) => !provider.archivedAt).length === 0}>
            <Plus size={15} />
            添加渠道
          </button>
        </div>
      </div>

      {error ? <div className="router-banner danger">{error}</div> : null}
      {providers.filter((provider) => !provider.archivedAt).length === 0 ? (
        <div className="router-banner warn">先添加至少一个提供商，才能创建模型渠道。</div>
      ) : null}

      <div className="router-card table">
        <table className="router-table">
          <thead>
            <tr>
              <th>对外模型名</th>
              <th>渠道</th>
              <th>上游模型</th>
              <th>协议</th>
              <th>状态</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.map((group) =>
              group.channels.map((channel, index) => (
                <tr key={channel.id} className={channel.archivedAt ? 'archived' : ''}>
                  <td>
                    {index === 0 ? <strong className="mono">{group.publicName}</strong> : <span className="router-cell-sub mono">↳</span>}
                    {index === 0 ? (
                      <div className="router-cell-sub">
                        {group.totalCount} 条渠道 · {group.enabledCount} 启用
                      </div>
                    ) : null}
                  </td>
                  <td>{channel.providerName}</td>
                  <td className="mono">{channel.upstreamName}</td>
                  <td className="mono">{channel.providerProtocol}</td>
                  <td>
                    {channel.archivedAt ? (
                      <RouterBadge>已归档</RouterBadge>
                    ) : channel.enabled ? (
                      <RouterBadge tone="good">启用</RouterBadge>
                    ) : (
                      <RouterBadge tone="warn">停用</RouterBadge>
                    )}
                  </td>
                  <td>
                    <div className="router-row-actions">
                      {index === 0 ? (
                        <>
                          <button
                            type="button"
                            className="router-icon-btn"
                            title="重命名模型组"
                            onClick={() => setRenaming({ from: group.publicName, to: group.publicName })}
                          >
                            <TextCursorInput size={14} />
                          </button>
                          <button
                            type="button"
                            className="router-icon-btn"
                            title={group.enabledCount > 0 ? '停用整个模型组' : '启用整个模型组'}
                            onClick={() => void toggleGroup(group)}
                          >
                            <Power size={14} />
                          </button>
                        </>
                      ) : null}
                      <button
                        type="button"
                        className="router-icon-btn"
                        title="编辑"
                        onClick={() =>
                          setEditing({
                            id: channel.id,
                            providerId: channel.providerId,
                            publicName: group.publicName,
                            upstreamName: channel.upstreamName,
                            enabled: channel.enabled,
                          })
                        }
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        className="router-icon-btn"
                        title={channel.archivedAt ? '恢复' : '归档'}
                        onClick={() => void archive(channel.id, !channel.archivedAt)}
                      >
                        {channel.archivedAt ? <RotateCcw size={14} /> : <Archive size={14} />}
                      </button>
                      <button type="button" className="router-icon-btn danger" title="删除" onClick={() => void remove(channel.id)}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              )),
            )}
            {visible.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <div className="router-empty-inline">没有模型渠道。添加后，客户端即可用对外模型名调用本地网关。</div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {renaming ? (
        <RouterModal
          title="重命名模型组"
          subtitle="会同时修改该对外模型名下的全部渠道，并同步请求日志；历史用量保留原名称快照。"
          onClose={() => setRenaming(null)}
          footer={
            <>
              <button type="button" className="router-btn" onClick={() => setRenaming(null)} disabled={busy}>
                取消
              </button>
              <button type="button" className="router-btn primary" onClick={() => void saveRename()} disabled={busy || !renaming.to.trim()}>
                {busy ? '保存中…' : '重命名'}
              </button>
            </>
          }
        >
          <Field label="新的对外模型名">
            <input
              className="router-input mono"
              value={renaming.to}
              onChange={(event) => setRenaming({ ...renaming, to: event.target.value })}
              autoFocus
            />
          </Field>
        </RouterModal>
      ) : null}

      {editing ? (
        <RouterModal
          title={editing.id ? '编辑模型渠道' : '添加模型渠道'}
          subtitle="对外模型名相同即归入同一渠道组；一个提供商在同一对外名下只能有一条渠道。"
          onClose={() => setEditing(null)}
          footer={
            <>
              <button type="button" className="router-btn" onClick={() => setEditing(null)} disabled={busy}>
                取消
              </button>
              <button
                type="button"
                className="router-btn primary"
                onClick={() => void save()}
                disabled={busy || !editing.providerId || !editing.publicName.trim() || !editing.upstreamName.trim()}
              >
                {busy ? '保存中…' : '保存'}
              </button>
            </>
          }
        >
          <Field label="提供商">
            <select className="router-select" value={editing.providerId} onChange={(event) => setEditing({ ...editing, providerId: event.target.value })}>
              {providers.filter((provider) => !provider.archivedAt).map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name} · {provider.protocol}
                </option>
              ))}
            </select>
          </Field>
          <div className="router-form-grid">
            <Field label="对外模型名" hint="客户端请求里使用的 model">
              <input className="router-input mono" value={editing.publicName} onChange={(event) => setEditing({ ...editing, publicName: event.target.value })} placeholder="gpt-4o-mini" />
            </Field>
            <Field label="上游模型名" hint="发给提供商的真实 model">
              <input className="router-input mono" value={editing.upstreamName} onChange={(event) => setEditing({ ...editing, upstreamName: event.target.value })} placeholder="gpt-4o-mini" />
            </Field>
          </div>
          <label className="router-check">
            <input type="checkbox" checked={editing.enabled} onChange={(event) => setEditing({ ...editing, enabled: event.target.checked })} />
            参与路由
          </label>
        </RouterModal>
      ) : null}
    </div>
  );
}
