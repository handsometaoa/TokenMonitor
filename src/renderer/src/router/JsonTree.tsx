import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { parseJson } from '../../../shared/validation';

const VALUE_PREVIEW_LIMIT = 96;

type JsonLike = string | number | boolean | null | JsonLike[] | { [key: string]: JsonLike };

function tryParse(text: string | null): JsonLike | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return parseJson(trimmed) as JsonLike;
  } catch {
    return null;
  }
}

function entriesOf(value: JsonLike): Array<[string, JsonLike]> {
  if (Array.isArray(value)) return value.map((item, index) => [String(index), item]);
  if (typeof value === 'object' && value !== null) return Object.entries(value);
  return [];
}

function summaryOf(value: JsonLike): string {
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value);
    return `{${keys.length} ${keys.length === 1 ? 'field' : 'fields'}}`;
  }
  return '';
}

function JsonValue({ value }: { value: JsonLike }) {
  if (value === null) return <span className="json-value null">null</span>;
  if (typeof value === 'number') return <span className="json-value number">{String(value)}</span>;
  if (typeof value === 'boolean') return <span className="json-value boolean">{String(value)}</span>;
  const text = String(value);
  const truncated = text.length > VALUE_PREVIEW_LIMIT;
  return (
    <span className="json-value string" title={truncated ? text : undefined}>
      {truncated ? `"${text.slice(0, VALUE_PREVIEW_LIMIT)}…"` : `"${text}"`}
    </span>
  );
}

function JsonNode({ name, value, depth }: { name: string | null; value: JsonLike; depth: number }) {
  // First level starts expanded; nested containers start collapsed.
  const [open, setOpen] = useState(depth < 1);
  const isContainer = value !== null && typeof value === 'object';

  if (!isContainer) {
    return (
      <div className="json-row">
        {name !== null ? <span className="json-key">{name}</span> : null}
        <JsonValue value={value} />
      </div>
    );
  }

  const children = entriesOf(value);
  return (
    <div className="json-node">
      <button type="button" className="json-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {name !== null ? <span className="json-key">{name}</span> : null}
        <span className="json-summary">{summaryOf(value)}</span>
      </button>
      {open ? (
        <div className="json-children">
          {children.map(([key, child]) => (
            <JsonNode key={key} name={key} value={child} depth={depth + 1} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Collapsible JSON tree for stored header strings. Falls back to the raw
 * pre-formatted text when the value is not valid JSON.
 */
export function JsonTree({ value }: { value: string | null }) {
  const parsed = useMemo(() => tryParse(value), [value]);
  if (!parsed) return <pre className="router-pre">{value ?? '—'}</pre>;
  return (
    <div className="json-tree">
      <JsonNode name={null} value={parsed} depth={0} />
    </div>
  );
}
