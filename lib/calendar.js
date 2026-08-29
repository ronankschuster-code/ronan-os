// Google Calendar wrapper. Calendar is the spine: anything with a time lives here.
// Auth uses a long-lived refresh token, exchanged for an access token per cold start.

import crypto from 'node:crypto';
import { TZ } from './time.js';

// GOOGLE_CALENDAR_ID must be your actual email address, NOT 'primary'.
// A service account's "primary" is its own empty calendar, not yours.
const CAL_ID = process.env.GOOGLE_CALENDAR_ID;
const BASE = 'https://www.googleapis.com/calendar/v3';
const SCOPE = 'https://www.googleapis.com/auth/calendar';

let _token = null;
let _tokenExpiry = 0;

/**
 * Service account auth. Sign a JWT with the private key, trade it for an
 * access token. No consent screen, no refresh token, nothing that expires.
 * The service account reaches your calendar because you shared it with the
 * service account's email in Google Calendar settings.
 */
async function accessToken() {
  if (_token && Date.now() < _tokenExpiry - 60_000) return _token;

  const email = process.env.GOOGLE_SA_EMAIL;
  // Vercel stores newlines escaped, so unescape them before signing.
  const key = (process.env.GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('Missing GOOGLE_SA_EMAIL or GOOGLE_SA_PRIVATE_KEY');

  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: email,
    scope: SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })}`;

  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(key, 'base64url');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });
  if (!res.ok) throw new Error(`Service account auth failed: ${await res.text()}`);

  const j = await res.json();
  _token = j.access_token;
  _tokenExpiry = Date.now() + (j.expires_in || 3600) * 1000;
  return _token;
}

async function gcal(path, { method = 'GET', body, query } = {}) {
  const token = await accessToken();
  const url = new URL(`${BASE}${path}`);
  if (query) for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`gcal ${method} ${path}: ${j.error?.message || res.status}`);
  return j;
}

/** Normalize a Google event into the shape the rest of the app uses. */
function normalize(e) {
  const allDay = Boolean(e.start?.date);
  return {
    id: e.id,
    title: e.summary || '(untitled)',
    description: e.description || '',
    location: e.location || '',
    allDay,
    start: allDay ? new Date(`${e.start.date}T00:00:00`) : new Date(e.start.dateTime),
    end: allDay ? new Date(`${e.end.date}T00:00:00`) : new Date(e.end.dateTime),
    colorId: e.colorId,
    status: e.status,
    recurringEventId: e.recurringEventId || null,
    htmlLink: e.htmlLink,
  };
}

export async function listEvents(timeMin, timeMax, { maxResults = 100 } = {}) {
  const j = await gcal(`/calendars/${encodeURIComponent(CAL_ID)}/events`, {
    query: {
      timeMin: new Date(timeMin).toISOString(),
      timeMax: new Date(timeMax).toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults,
      timeZone: TZ,
    },
  });
  return (j.items || []).filter(e => e.status !== 'cancelled').map(normalize);
}

export async function createEvent({
  title, start, end, allDay = false, description = '', location = '',
  colorId, reminderMinutes = 10, transparent = false,
}) {
  const body = {
    summary: title,
    description,
    location: location || undefined,
    colorId: colorId || undefined,
    transparency: transparent ? 'transparent' : undefined,
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: reminderMinutes }] },
  };
  if (allDay) {
    body.start = { date: isoDate(start) };
    body.end = { date: isoDate(end || addOneDay(start)) };
  } else {
    body.start = { dateTime: new Date(start).toISOString(), timeZone: TZ };
    body.end = { dateTime: new Date(end).toISOString(), timeZone: TZ };
  }
  return normalize(await gcal(`/calendars/${encodeURIComponent(CAL_ID)}/events`, {
    method: 'POST', body,
  }));
}

export async function updateEvent(eventId, patch) {
  const body = {};
  if (patch.title !== undefined) body.summary = patch.title;
  if (patch.description !== undefined) body.description = patch.description;
  if (patch.location !== undefined) body.location = patch.location;
  if (patch.colorId !== undefined) body.colorId = patch.colorId;
  if (patch.start) body.start = { dateTime: new Date(patch.start).toISOString(), timeZone: TZ };
  if (patch.end) body.end = { dateTime: new Date(patch.end).toISOString(), timeZone: TZ };
  return normalize(await gcal(
    `/calendars/${encodeURIComponent(CAL_ID)}/events/${encodeURIComponent(eventId)}`,
    { method: 'PATCH', body },
  ));
}

export async function deleteEvent(eventId) {
  await gcal(`/calendars/${encodeURIComponent(CAL_ID)}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE' });
  return true;
}

export async function getEvent(eventId) {
  return normalize(await gcal(
    `/calendars/${encodeURIComponent(CAL_ID)}/events/${encodeURIComponent(eventId)}`));
}

/**
 * Search upcoming events by fuzzy title match. Used when Ronan says
 * "move my gym block" without giving an id.
 */
export async function findByTitle(text, { days = 21 } = {}) {
  const now = new Date();
  const events = await listEvents(now, new Date(now.getTime() + days * 864e5), { maxResults: 250 });
  const needle = text.toLowerCase().trim();
  const scored = events
    .map(e => {
      const t = e.title.toLowerCase();
      let score = 0;
      if (t === needle) score = 100;
      else if (t.includes(needle)) score = 70;
      else {
        const words = needle.split(/\s+/).filter(w => w.length > 2);
        const hits = words.filter(w => t.includes(w)).length;
        score = words.length ? (hits / words.length) * 50 : 0;
      }
      return { e, score };
    })
    .filter(x => x.score > 25)
    .sort((a, b) => b.score - a.score || a.e.start - b.e.start);
  return scored.map(x => x.e);
}

/**
 * Find open gaps of at least `minMinutes`, within waking hours, over the next N days.
 * Used to reschedule slipped blocks. Deliberately conservative: it will not
 * suggest anything before 8am or after 10pm.
 */
export async function findFreeSlots(minMinutes, { fromDate = new Date(), days = 7,
  dayStartMin = 8 * 60, dayEndMin = 22 * 60 } = {}) {
  const { parts, zonedTimeToUtc } = await import('./time.js');
  const out = [];
  const events = await listEvents(fromDate, new Date(fromDate.getTime() + days * 864e5),
    { maxResults: 250 });
  const busy = events.filter(e => !e.allDay).sort((a, b) => a.start - b.start);

  for (let d = 0; d < days; d++) {
    const cursorDate = new Date(fromDate.getTime() + d * 864e5);
    const p = parts(cursorDate);
    let cursor = zonedTimeToUtc(p.year, p.month, p.day, Math.floor(dayStartMin / 60), dayStartMin % 60);
    const dayEnd = zonedTimeToUtc(p.year, p.month, p.day, Math.floor(dayEndMin / 60), dayEndMin % 60);
    if (cursor < fromDate) cursor = new Date(Math.ceil(fromDate.getTime() / 9e5) * 9e5); // round to 15m

    const todays = busy.filter(e => e.end > cursor && e.start < dayEnd);
    for (const e of todays) {
      if (e.start - cursor >= minMinutes * 60000) {
        out.push({ start: new Date(cursor), end: new Date(cursor.getTime() + minMinutes * 60000) });
      }
      if (e.end > cursor) cursor = e.end;
    }
    if (dayEnd - cursor >= minMinutes * 60000) {
      out.push({ start: new Date(cursor), end: new Date(cursor.getTime() + minMinutes * 60000) });
    }
  }
  return out;
}

function isoDate(d) {
  const dt = new Date(d);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}
function addOneDay(d) { return new Date(new Date(d).getTime() + 864e5); }
