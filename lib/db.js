// Supabase REST wrapper. Holds the task layer, dedupe log, and conversation state.
// Deliberately thin: no ORM, no client lib, just fetch against PostgREST.

const URL_BASE = `${process.env.SUPABASE_URL}/rest/v1`;
const KEY = process.env.SUPABASE_SERVICE_KEY;

async function sb(path, { method = 'GET', body, prefer, query } = {}) {
  const url = new URL(`${URL_BASE}${path}`);
  if (query) for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) url.searchParams.set(k, v);
  }
  const headers = {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 204) return null;
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`supabase ${method} ${path}: ${json?.message || text}`);
  return json;
}

// ---------------------------------------------------------------------------
// SETTINGS
// ---------------------------------------------------------------------------
export async function getSettings() {
  const rows = await sb('/settings', { query: { id: 'eq.1', select: '*' } });
  return rows?.[0] || {
    timezone: 'America/New_York', brief_lead_minutes: 90,
    brief_earliest_hhmm: '06:30', evening_sweep_hhmm: '21:00', nudge_enabled: true,
  };
}

export async function setSetting(patch) {
  return sb('/settings', {
    method: 'PATCH', query: { id: 'eq.1' }, body: patch, prefer: 'return=representation',
  });
}

// ---------------------------------------------------------------------------
// TASKS
// ---------------------------------------------------------------------------
export async function addTask({ title, notes = null, bucket = 'inbox', due_at = null, triaged = false }) {
  const rows = await sb('/tasks', {
    method: 'POST', body: [{ title, notes, bucket, due_at, triaged }],
    prefer: 'return=representation',
  });
  return rows[0];
}

export async function openTasks({ bucket, limit = 50 } = {}) {
  const query = { done: 'eq.false', select: '*', order: 'due_at.asc.nullslast,created_at.asc', limit };
  if (bucket) query.bucket = `eq.${bucket}`;
  return sb('/tasks', { query });
}

export async function inboxTasks() {
  return sb('/tasks', {
    query: { done: 'eq.false', triaged: 'eq.false', select: '*', order: 'created_at.asc' },
  });
}

/** Tasks with a due date inside the window. */
export async function tasksDueBetween(fromISO, toISO) {
  return sb('/tasks', {
    query: {
      done: 'eq.false', due_at: `gte.${fromISO}`, and: `(due_at.lte.${toISO})`,
      select: '*', order: 'due_at.asc',
    },
  });
}

export async function completeTask(id) {
  const rows = await sb('/tasks', {
    method: 'PATCH', query: { id: `eq.${id}` },
    body: { done: true, done_at: new Date().toISOString() },
    prefer: 'return=representation',
  });
  return rows[0];
}

export async function updateTask(id, patch) {
  const rows = await sb('/tasks', {
    method: 'PATCH', query: { id: `eq.${id}` }, body: patch, prefer: 'return=representation',
  });
  return rows[0];
}

export async function deleteTask(id) {
  await sb('/tasks', { method: 'DELETE', query: { id: `eq.${id}` } });
  return true;
}

/** Fuzzy find an open task by title, for "check off the calculator thing". */
export async function findTask(text) {
  const all = await openTasks({ limit: 200 });
  const needle = text.toLowerCase().trim();
  return all
    .map(t => {
      const title = t.title.toLowerCase();
      let score = title === needle ? 100 : title.includes(needle) ? 70 : 0;
      if (!score) {
        const words = needle.split(/\s+/).filter(w => w.length > 2);
        const hits = words.filter(w => title.includes(w)).length;
        score = words.length ? (hits / words.length) * 60 : 0;
      }
      return { t, score };
    })
    .filter(x => x.score > 25)
    .sort((a, b) => b.score - a.score)
    .map(x => x.t);
}

// ---------------------------------------------------------------------------
// BLOCK RUNS — the follow-up queue for work blocks
// ---------------------------------------------------------------------------
export async function recordBlockRun({ gcal_event_id, title, scheduled_for }) {
  try {
    const rows = await sb('/block_runs', {
      method: 'POST', body: [{ gcal_event_id, title, scheduled_for }],
      prefer: 'return=representation,resolution=ignore-duplicates',
    });
    return rows?.[0] || null;
  } catch { return null; }
}

export async function pendingBlockRuns(beforeISO) {
  return sb('/block_runs', {
    query: {
      status: 'eq.pending', scheduled_for: `lte.${beforeISO}`,
      select: '*', order: 'scheduled_for.asc', limit: '20',
    },
  });
}

export async function resolveBlockRun(id, { status, moved_to = null, slip_count }) {
  const body = { status, resolved_at: new Date().toISOString() };
  if (moved_to) body.moved_to = moved_to;
  if (slip_count !== undefined) body.slip_count = slip_count;
  const rows = await sb('/block_runs', {
    method: 'PATCH', query: { id: `eq.${id}` }, body, prefer: 'return=representation',
  });
  return rows[0];
}

// ---------------------------------------------------------------------------
// SENT LOG — dedupe guard for the 5-minute cron
// ---------------------------------------------------------------------------
/** Returns true if this is the first time we're sending (kind, ref). */
export async function claimSend(kind, ref) {
  try {
    const rows = await sb('/sent_log', {
      method: 'POST', body: [{ kind, ref }],
      prefer: 'return=representation',
    });
    return Boolean(rows?.length);
  } catch (e) {
    if (String(e).includes('duplicate') || String(e).includes('23505')) return false;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// PENDING REPLIES — short-lived conversation state
// ---------------------------------------------------------------------------
export async function setPendingReply(chat_id, kind, payload, ttlMinutes = 180) {
  await sb('/pending_replies', { method: 'DELETE', query: { chat_id: `eq.${chat_id}` } });
  const rows = await sb('/pending_replies', {
    method: 'POST',
    body: [{
      chat_id: String(chat_id), kind, payload,
      expires_at: new Date(Date.now() + ttlMinutes * 60000).toISOString(),
    }],
    prefer: 'return=representation',
  });
  return rows[0];
}

export async function getPendingReply(chat_id) {
  const rows = await sb('/pending_replies', {
    query: {
      chat_id: `eq.${chat_id}`, expires_at: `gt.${new Date().toISOString()}`,
      select: '*', order: 'created_at.desc', limit: '1',
    },
  });
  return rows?.[0] || null;
}

export async function clearPendingReply(chat_id) {
  await sb('/pending_replies', { method: 'DELETE', query: { chat_id: `eq.${chat_id}` } });
}
