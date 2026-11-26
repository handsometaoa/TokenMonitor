import { useEffect, useState } from 'react';
import { Copy, KeyRound, Play, RefreshCw, Square } from 'lucide-react';
import type { RouterState } from '../../../../shared/routerTypes';
import { CopyButton, RouterStat } from '../components';
import { Toggle } from '../../components/ui';

export function ServicePage({
  state,
  onChanged,
}: {
  state: RouterState;
  onChanged: () => void;
}) {
  const config = state.service.config;
  const [enabled, setEnabled] = useState(config.enabled);
  const [port, setPort] = useState(String(config.port));
  const [apiKey, setApiKey] = useState(config.apiKey);
  const [proxyUrl, setProxyUrl] = useState(config.proxyUrl);
  const [captureBodies, setCaptureBodies] = useState(config.captureBodies);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEnabled(config.enabled);
    setPort(String(config.port));
    setApiKey(config.apiKey);
    setProxyUrl(config.proxyUrl);
    setCaptureBodies(config.captureBodies);
  }, [config.enabled, config.port, config.apiKey, config.proxyUrl, config.captureBodies]);

  // Same instant-apply pattern as the Overview gateway card.
  const toggleGateway = async (next: boolean) => {
    setEnabled(next);
    try {
      await window.tokenMonitor.saveRouterServiceConfig({ enabled: next });
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '网关开关失败');
      setEnabled(!next);
    }
  };

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      await window.tokenMonitor.saveRouterServiceConfig({
        enabled,
        port: Number(port),
        apiKey: apiKey.trim(),
        proxyUrl: proxyUrl.trim(),
        captureBodies,
      });
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async () => {
    if (!window.confirm('重新生成 API Key？已配置的客户端需要更新 Key。')) return;
    const next = await window.tokenMonitor.regenerateRouterApiKey();
    setApiKey(next.service.config.apiKey);
    onChanged();
  };

  const baseUrl = `http://127.0.0.1:${port || config.port}/v1`;
  const openAiExample = `curl ${baseUrl}/chat/completions \\\n  -H "Authorization: Bearer ${apiKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"your-public-model","messages":[{"role":"user","content":"hi"}],"stream":true}'`;
  const anthropicExample = `curl ${baseUrl}/messages \\\n  -H "x-api-key: ${apiKey}" \\\n  -H "anthropic-version: 2023-06-01" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"your-public-model","max_tokens":1024,"messages":[{"role":"user","content":"hi"}],"stream":true}'`;
  const responsesExample = `curl ${baseUrl}/responses \\\n  -H "Authorization: Bearer ${apiKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"your-public-model","input":"hi","stream":true}'`;

  return (
    <div className="router-page">
      {state.service.error ? <div className="router-banner danger">{state.service.error}</div> : null}
      {error ? <div className="router-banner danger">{error}</div> : null}

      <div className="router-stats">
        <RouterStat
          label="网关"
          value={state.service.state === 'running' ? '运行中' : state.service.state === 'error' ? '错误' : '已停止'}
          hint={state.service.state === 'running' ? `127.0.0.1:${state.service.port}` : state.service.error ?? '未启动'}
          tone={state.service.state === 'running' ? 'good' : state.service.state === 'error' ? 'danger' : undefined}
          action={<Toggle checked={enabled} onChange={(next) => void toggleGateway(next)} label={enabled ? '停止本地网关' : '启动本地网关'} />}
        />
        <RouterStat label="进行中请求" value={String(state.service.activeRequests)} hint="当前并发" />
        <RouterStat label="今日请求" value={String(state.usageToday.requests)} hint={`${state.usageToday.tokens.toLocaleString()} tokens`} />
        <RouterStat label="成功率" value={state.usageToday.successRate === null ? '—' : `${state.usageToday.successRate.toFixed(1)}%`} hint="今日" />
      </div>

      <div className="router-card">
        <div className="router-card-head">
          <div>
            <div className="router-card-title">服务配置</div>
            <div className="router-card-sub">修改端口或开关会重启网关；API Key 保存后立即生效。</div>
          </div>
          <div className="router-row-actions">
            <button type="button" className="router-btn primary" onClick={() => void save()} disabled={busy}>
              {busy ? <RefreshCw size={14} className="spin" /> : enabled ? <Play size={14} /> : <Square size={14} />}
              {busy ? '保存中…' : '保存并应用'}
            </button>
          </div>
        </div>
        <div className="router-config-list">
          <div className="router-config-row">
            <div className="router-config-info">
              <div className="router-config-label">监听端口</div>
              <div className="router-config-hint">1024-65535，仅监听本机 127.0.0.1。</div>
            </div>
            <div className="router-config-control narrow">
              <input className="router-input mono" value={port} onChange={(event) => setPort(event.target.value.replace(/\D/g, ''))} />
            </div>
          </div>
          <div className="router-config-row">
            <div className="router-config-info">
              <div className="router-config-label">本地 API Key</div>
              <div className="router-config-hint">客户端访问网关时使用；与上游 API Key 无关。</div>
            </div>
            <div className="router-config-control">
              <div className="router-input-row">
                <div className="router-key-field">
                  <input className="router-input mono bare" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
                  <CopyButton text={apiKey} iconOnly />
                </div>
                <button type="button" className="router-btn" onClick={() => void regenerate()}>
                  <KeyRound size={14} />
                  重新生成
                </button>
              </div>
            </div>
          </div>
          <div className="router-config-row">
            <div className="router-config-info">
              <div className="router-config-label">上游代理 URL</div>
              <div className="router-config-hint">HTTP(S) 代理；留空直连，支持 CONNECT 隧道。</div>
            </div>
            <div className="router-config-control">
              <input
                className="router-input mono"
                value={proxyUrl}
                onChange={(event) => setProxyUrl(event.target.value)}
                placeholder="http://127.0.0.1:7890"
              />
            </div>
          </div>
          <div className="router-config-row">
            <div className="router-config-info">
              <div className="router-config-label">日志正文</div>
              <div className="router-config-hint">关闭后只记录状态、耗时和 token，不落库 prompt / 回复正文。</div>
            </div>
            <div className="router-config-control">
              <label className="router-check">
                <input type="checkbox" checked={captureBodies} onChange={(event) => setCaptureBodies(event.target.checked)} />
                保存请求 / 响应正文
              </label>
            </div>
          </div>
        </div>
      </div>

      <div className="router-card">
        <div className="router-card-head">
          <div>
            <div className="router-card-title">接入地址</div>
            <div className="router-card-sub">Base URL 固定为 /v1；模型名使用「模型路由」里的对外模型名。</div>
          </div>
          <CopyButton text={baseUrl} label="复制 Base URL" />
        </div>
        <div className="router-endpoint">
          <span className="router-endpoint-label">Base URL</span>
          <code>{baseUrl}</code>
        </div>
        <div className="router-code-block">
          <div className="router-code-head">
            <span>OpenAI Chat</span>
            <CopyButton text={openAiExample} />
          </div>
          <pre>{openAiExample}</pre>
        </div>
        <div className="router-code-block">
          <div className="router-code-head">
            <span>Anthropic Messages</span>
            <CopyButton text={anthropicExample} />
          </div>
          <pre>{anthropicExample}</pre>
        </div>
        <div className="router-code-block">
          <div className="router-code-head">
            <span>OpenAI Responses</span>
            <CopyButton text={responsesExample} />
          </div>
          <pre>{responsesExample}</pre>
        </div>
        <div className="router-hint">
          <Copy size={13} />
          三种入口可以混用：客户端用 OpenAI 协议请求，也可以路由到 Anthropic 或 Responses 上游；反之亦然。
        </div>
      </div>
    </div>
  );
}
