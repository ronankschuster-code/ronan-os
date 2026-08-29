// All time math happens in Ronan's timezone, never the server's.
// Vercel runs UTC. Getting this wrong is how you send a morning brief at 3am.

export const TZ = process.env.TIMEZONE || 'America/New_York';

/** Parts of a Date as seen in TZ. */
export function parts(date = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, weekday: 'short',
  });
  const o = {};
  for (const p of fmt.formatToParts(date)) o[p.type] = p.value;
  return {
    year: +o.year, month: +o.month, day: +o.day,
    hour: +(o.hour === '24' ? '00' : o.hour), minute: +o.minute, second: +o.second,
    weekday: o.weekday,
  };
}

/** 'YYYY-MM-DD' for a Date, in TZ. This is our day key everywhere. */
export function dayKey(date = new Date(), tz = TZ) {
  const p = parts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Minutes since midnight, in TZ. */
export function minutesOfDay(date = new Date(), tz = TZ) {
  const p = parts(date, tz);
  return p.hour * 60 + p.minute;
}

/** '06:30' -> 390 */
export function hhmmToMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
}

/**
 * Build a UTC Date for a wall-clock time in TZ.
 * Walks the offset twice so it stays correct across DST boundaries.
 */
export function zonedTimeToUtc(y, mo, d, h, mi, tz = TZ) {
  let guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  for (let i = 0; i < 2; i++) {
    const p = parts(new Date(guess), tz);
    const asSeen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
    const wanted = Date.UTC(y, mo - 1, d, h, mi, 0);
    guess += wanted - asSeen;
  }
  return new Date(guess);
}

/** Start of today (00:00) in TZ, as a UTC Date. */
export function startOfDay(date = new Date(), tz = TZ) {
  const p = parts(date, tz);
  return zonedTimeToUtc(p.year, p.month, p.day, 0, 0, tz);
}

export function endOfDay(date = new Date(), tz = TZ) {
  return new Date(startOfDay(date, tz).getTime() + 24 * 3600 * 1000);
}

export function addDays(date, n) {
  return new Date(date.getTime() + n * 24 * 3600 * 1000);
}

/** '3:30pm' style, in TZ. */
export function fmtTime(date, tz = TZ) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(date)).replace(' ', '').toLowerCase();
}

/** 'Thu Aug 27' style, in TZ. */
export function fmtDate(date, tz = TZ) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
  }).format(new Date(date));
}

/** Human gap: 'in 2h 15m', 'in 40m', 'now'. */
export function untilText(target, from = new Date()) {
  const ms = new Date(target) - from;
  if (ms <= 60_000) return 'now';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `in ${h}h ${m}m` : `in ${h}h`;
}
