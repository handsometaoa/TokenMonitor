import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const dbPath = process.argv[2] ?? join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
if (!existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;');

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
console.log('TABLES', tables.join(', '));

for (const table of ['session', 'message', 'session_message', 'part']) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    console.log('COLUMNS', table, cols.join(','));
  } catch {
    console.log('NO_TABLE', table);
  }
}

for (const table of ['message', 'session_message']) {
  try {
    const n = db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
    console.log('COUNT', table, n);
    if (table === 'message') {
      console.log('ROLES', JSON.stringify(db.prepare("SELECT json_extract(data, '$.role') AS role, count(*) AS n FROM message GROUP BY role").all()));
    } else {
      console.log('TYPES', JSON.stringify(db.prepare('SELECT type, count(*) AS n FROM session_message GROUP BY type').all()));
    }
  } catch (error) {
    console.log('ERR', table, error.message);
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
  console.log('DATE_RANGE_ERR', error.message);
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
  console.log('V1_QUERY_ERR', error.message);
}

try {
  const sample = db.prepare("SELECT data FROM message WHERE json_extract(data, '$.role') = 'assistant' ORDER BY time_created DESC LIMIT 1").get();
  if (sample) {
    const message = JSON.parse(sample.data);
    console.log('V1_KEYS', Object.keys(message).join(','));
    console.log('V1_MODEL', JSON.stringify({ providerID: message.providerID, modelID: message.modelID }));
    console.log('V1_TOKEN_KEYS', message.tokens ? Object.keys(message.tokens).join(',') : 'none');
    console.log(
      'V1_TIME',
      JSON.stringify({
        created: message.time?.created,
        completed: message.time?.completed,
        finish: message.finish,
      }),
    );
    console.log('V1_TOTAL_TOKENS', message.tokens?.total);
  }
} catch (error) {
  console.log('V1_SAMPLE_ERR', error.message);
}

try {
  const sample = db.prepare("SELECT data FROM session_message WHERE type = 'assistant' LIMIT 1").get();
  if (sample) {
    const message = JSON.parse(sample.data);
    console.log('V2_KEYS', Object.keys(message).join(','));
    console.log('V2_MODEL', message.model ? JSON.stringify(message.model) : 'none');
    console.log('V2_TOKEN_KEYS', message.tokens ? Object.keys(message.tokens).join(',') : 'none');
  } else {
    console.log('V2_NO_ASSISTANT');
  }
} catch (error) {
  console.log('V2_SAMPLE_ERR', error.message);
}

try {
  console.log('SESSIONS', db.prepare('SELECT count(*) AS n FROM session').get().n);
  console.log(
    'SESSION_COLS_FORK',
    db.prepare('PRAGMA table_info(session)').all().filter((c) => /fork|parent|time_created/.test(c.name)).map((c) => c.name).join(','),
  );
  console.log(
    'SESSION_RANGE',
    JSON.stringify(db.prepare('SELECT min(time_created) AS min, max(time_updated) AS max FROM session').get()),
  );
} catch (error) {
  console.log('SESSION_ERR', error.message);
}

try {
  console.log(
    'PARTS',
    JSON.stringify(
      db.prepare("SELECT json_extract(data, '$.type') AS type, count(*) AS n FROM part GROUP BY type ORDER BY n DESC").all(),
    ),
  );
} catch (error) {
  console.log('PARTS_ERR', error.message);
}

db.close();
