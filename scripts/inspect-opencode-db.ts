import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') {
    const converted = Number(value);
    return Number.isSafeInteger(converted) ? converted : null;
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  const text = textValue(value);
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function names(rows: Array<Record<string, unknown>>): string[] {
  return rows
    .map((row) => textValue(row.name))
    .filter((name): name is string => name !== null);
}

const dbPath = process.argv[2] ?? join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
if (!existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;');

  const tables = names(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all());
  console.log('TABLES', tables.join(', '));

  for (const table of ['session', 'message', 'session_message', 'part']) {
    try {
      const cols = names(db.prepare(`PRAGMA table_info(${table})`).all());
      console.log('COLUMNS', table, cols.join(', '));
    } catch {
      console.log('NO_TABLE', table);
    }
  }

  for (const table of ['message', 'session_message']) {
    try {
      const n = numberValue(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
      if (n === null) throw new Error('Missing count');
      console.log('COUNT', table, n);
      if (table === 'message') {
        console.log('ROLES', JSON.stringify(db.prepare("SELECT json_extract(data, '$.role') AS role, count(*) AS n FROM message GROUP BY role").all()));
      } else {
        console.log('TYPES', JSON.stringify(db.prepare('SELECT type, count(*) AS n FROM session_message GROUP BY type').all()));
      }
    } catch (error) {
      console.log('ERR', table, errorMessage(error));
    }
  }

  try {
    console.log(
      'DATE_RANGE',
      JSON.stringify(
        db.prepare("SELECT min(time_created) AS min, max(time_created) AS max FROM message WHERE json_extract(data, '$.role') = 'assistant'").get(),
      ),
    );
  } catch (error) {
    console.log('DATE_RANGE_ERR', errorMessage(error));
  }

  try {
    const rows = db.prepare(`
      SELECT
        json_extract(data, '$.providerID') AS provider,
        json_extract(data, '$.modelID') AS model,
        count(*) AS n,
        sum(coalesce(json_extract(data, '$.tokens.input'), 0)) AS input,
        sum(coalesce(json_extract(data, '$.tokens.output'), 0)) AS output,
        sum(coalesce(json_extract(data, '$.tokens.reasoning'), 0)) AS reasoning,
        sum(coalesce(json_extract(data, '$.tokens.cache.read'), 0)) AS cache_read,
        sum(coalesce(json_extract(data, '$.tokens.cache.write'), 0)) AS cache_write,
        sum(coalesce(json_extract(data, '$.cost'), 0)) AS cost
      FROM message
      WHERE json_extract(data, '$.role') = 'assistant'
      GROUP BY provider, model
      ORDER BY n DESC
      LIMIT 10
    `).all();
    console.log('V1_ALL', JSON.stringify(rows));
  } catch (error) {
    console.log('V1_QUERY_ERR', errorMessage(error));
  }

  try {
    const sample = db.prepare("SELECT data FROM message WHERE json_extract(data, '$.role') = 'assistant' ORDER BY time_created DESC LIMIT 1").get();
    const message = parseRecord(sample?.data);
    if (message) {
      const tokens = isRecord(message.tokens) ? message.tokens : null;
      const time = isRecord(message.time) ? message.time : null;
      console.log('V1_KEYS', Object.keys(message).join(', '));
      console.log('V1_MODEL', JSON.stringify({ providerID: message.providerID, modelID: message.modelID }));
      console.log('V1_TOKEN_KEYS', tokens ? Object.keys(tokens).join(', ') : 'none');
      console.log(
        'V1_TIME',
        JSON.stringify({
          created: time?.created,
          completed: time?.completed,
          finish: message.finish,
        }),
      );
      console.log('V1_TOTAL_TOKENS', tokens?.total);
    }
  } catch (error) {
    console.log('V1_SAMPLE_ERR', errorMessage(error));
  }

  try {
    const sample = db.prepare("SELECT data FROM session_message WHERE type = 'assistant' LIMIT 1").get();
    const message = parseRecord(sample?.data);
    if (message) {
      const tokens = isRecord(message.tokens) ? message.tokens : null;
      console.log('V2_KEYS', Object.keys(message).join(', '));
      console.log('V2_MODEL', message.model ? JSON.stringify(message.model) : 'none');
      console.log('V2_TOKEN_KEYS', tokens ? Object.keys(tokens).join(', ') : 'none');
    } else {
      console.log('V2_NO_ASSISTANT');
    }
  } catch (error) {
    console.log('V2_SAMPLE_ERR', errorMessage(error));
  }

  try {
    const count = numberValue(db.prepare('SELECT count(*) AS n FROM session').get()?.n);
    if (count === null) throw new Error('Missing session count');
    console.log('SESSIONS', count);
    console.log(
      'SESSION_COLS_FORK',
      names(db.prepare('PRAGMA table_info(session)').all())
        .filter((name) => /fork|parent|time_created/.test(name))
        .join(','),
    );
    console.log(
      'SESSION_RANGE',
      JSON.stringify(db.prepare('SELECT min(time_created) AS min, max(time_updated) AS max FROM session').get()),
    );
  } catch (error) {
    console.log('SESSION_ERR', errorMessage(error));
  }

  try {
    console.log(
      'PARTS',
      JSON.stringify(
        db.prepare("SELECT json_extract(data, '$.type') AS type, count(*) AS n FROM part GROUP BY type ORDER BY n DESC").all(),
      ),
    );
  } catch (error) {
    console.log('PARTS_ERR', errorMessage(error));
  }
} finally {
  db.close();
}
