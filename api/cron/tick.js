// The heartbeat. Runs every 5 minutes from GitHub Actions.
//
// Four jobs, each guarded by the sent_log so a double-fire can't double-send:
//   1. Morning brief  — 90 min before your first event, floored at 06:30
//   2. Block nudge    — at the top of each work block
//   3. Deadline warn  — 48h and 12h before anything with a hard due date
//   4. Evening sweep  — 21:00, asks about blocks that passed unresolved
//
// Everything here is idempotent. Running it twice is harmless.

import * as cal from '../../lib/calendar.js';
import * as db from '../../lib/db.js';
import { send, esc } from '../../lib/telegram.js';
import {
  startOfDay, endOfDay, addDays, dayKey, fmtTime, fmtDate, untilText,
  minutesOfDay, hhmmToMinutes,
} from '../../lib/time.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false });
  }

  const out = [];
  const now = new Date();
  const s = await db.getSettings();
  const quiet = s.quiet_until && new Date(s.quiet_until) > now;

  try { out.push(await morningBrief(now, s)); } catch (e) { out.push(`brief: ${e.message}`); }
  if (!quiet && s.nudge_enabled) {
    try { out.push(await blockNudge(now)); } catch (e) { out.push(`nudge: ${e.message}`); }
  }
  if (!quiet) {
    try { out.push(await deadlineWarnings(now)); } catch (e) { out.push(`deadline: ${e.message}`); }
    try { out.push(await eveningSweep(now, s)); } catch (e) { out.push(`sweep: ${e.message}`); }
  }

  return res.status(200).json({ ok: true, ran: out.filter(Boolean) });
}

// ---------------------------------------------------------------------------
// 1. MORNING BRIEF
// Fires `brief_lead_minutes` before the first event of the day, but never
// earlier than `brief_earliest_hhmm`. On golf Fridays your first event is 7am,
// which would put the brief at 5:30. The floor is what keeps you from muting it.
// ---------------------------------------------------------------------------
async function morningBrief(now, s) {
  const key = dayKey(now);
  const events = await cal.listEvents(startOfDay(now), endOfDay(now), { maxResults: 60 });
  const timed = events.filter(e => !e.allDay).sort((a, b) => a.start - b.start);

  const lead = s.brief_lead_minutes ?? 90;
  const floor = hhmmToMinutes(s.brief_earliest_hhmm || '06:30');

  let fireAt;
  if (timed.length) {
    fireAt = Math.max(floor, minutesOfDay(timed[0].start) - lead);
  } else {
    fireAt = Math.max(floor, 8 * 60);   // no events: still check in at 8
  }

  const nowMin = minutesOfDay(now);
  // 6-minute window so a 5-min cron can't skip it
  if (nowMin < fireAt || nowMin > fireAt + 6) return null;
  if (!(await db.claimSend('morning_brief', key))) return null;

  const inbox = await db.inboxTasks();
  const soon = await cal.listEvents(now, addDays(now, 3), { maxResults: 80 });
  const hardDeadlines = soon.filter(e =>
    e.allDay || /due|exam|deadline|midterm|final|dossier|drill/i.test(e.title));

  let msg = `<b>${fmtDate(now)}</b>\n\n`;

  if (!timed.length && !events.length) {
    msg += 'Nothing on the calendar today.\n';
  } else {
    for (const e of events) {
      msg += e.allDay
        ? `▫︎ ${esc(e.title)}\n`
        : `${fmtTime(e.start)}  ${esc(e.title)}\n`;
    }
  }

  // The one thing that matters most today
  const anchor = timed.find(e => /exam|midterm|due|deadline|interview|meeting/i.test(e.title))
    || timed[0];
  if (anchor) {
    msg += `\n<b>Anchor:</b> ${esc(anchor.title)} at ${fmtTime(anchor.start)}`;
  }

  if (hardDeadlines.length) {
    msg += `\n\n<b>Inside 72 hours</b>\n`;
    for (const d of hardDeadlines.slice(0, 6)) {
      msg += `• ${esc(d.title)} (${fmtDate(d.start)})\n`;
    }
  }

  if (inbox.length) {
    msg += `\n${inbox.length} untriaged in Inbox. /inbox to see them.`;
  }

  await send(msg.trim());
  return 'morning_brief';
}

// ---------------------------------------------------------------------------
// 2. BLOCK NUDGE
// Pings at the top of a work block with what it is for. Skips classes and
// anything you don't need reminding to attend.
// ---------------------------------------------------------------------------
const NUDGE_SKIP = /^(MGT|BIT|FIN|BMES)\s*\d{4}\s*[—-]\s*(Principles|Business Process|Introduction|Advanced)/i;

async function blockNudge(now) {
  const soon = await cal.listEvents(now, new Date(now.getTime() + 10 * 60000), { maxResults: 20 });
  let sent = 0;

  for (const e of soon) {
    if (e.allDay) continue;
    if (NUDGE_SKIP.test(e.title)) continue;
    const delta = e.start - now;
    if (delta < 0 || delta > 6 * 60000) continue;

    const ref = `${e.id}:${e.start.toISOString()}`;
    if (!(await db.claimSend('block_nudge', ref))) continue;

    const firstLine = (e.description || '').split('\n').find(l => l.trim());
    let msg = `<b>${esc(e.title)}</b>\nStarting now, until ${fmtTime(e.end)}.`;
    if (firstLine) msg += `\n\n${esc(firstLine.slice(0, 220))}`;
    if (e.location) msg += `\n\n📍 ${esc(e.location)}`;

    await send(msg);
    // Queue it for the evening sweep
    await db.recordBlockRun({
      gcal_event_id: e.id, title: e.title, scheduled_for: e.end.toISOString(),
    });
    sent++;
  }
  return sent ? `nudged:${sent}` : null;
}

// ---------------------------------------------------------------------------
// 3. DEADLINE WARNINGS — 48h and 12h
// ---------------------------------------------------------------------------
const DEADLINE_RE = /due|exam|deadline|midterm|final|dossier|drill|submit|capstone|portfolio/i;

async function deadlineWarnings(now) {
  const horizon = await cal.listEvents(now, addDays(now, 3), { maxResults: 100 });
  let sent = 0;

  for (const e of horizon) {
    if (!DEADLINE_RE.test(e.title)) continue;
    const hoursOut = (e.start - now) / 3600000;

    for (const [stage, threshold] of [['48h', 48], ['12h', 12]]) {
      if (hoursOut > threshold || hoursOut < threshold - 0.25) continue;
      if (!(await db.claimSend('deadline_warn', `${e.id}:${stage}`))) continue;
      await send(`<b>${stage} out</b>\n${esc(e.title)}\n${fmtDate(e.start)}${e.allDay ? '' : ` ${fmtTime(e.start)}`}`);
      sent++;
    }
  }
  return sent ? `deadline:${sent}` : null;
}

// ---------------------------------------------------------------------------
// 4. EVENING SWEEP
// One batched question covering everything that passed unresolved today.
// Buttons: Done / Move it / Drop it. "Move it" finds the next free slot.
// ---------------------------------------------------------------------------
async function eveningSweep(now, s) {
  const target = hhmmToMinutes(s.evening_sweep_hhmm || '21:00');
  const nowMin = minutesOfDay(now);
  if (nowMin < target || nowMin > target + 6) return null;
  if (!(await db.claimSend('evening_sweep', dayKey(now)))) return null;

  const runs = await db.pendingBlockRuns(now.toISOString());
  if (!runs.length) {
    await send('Nothing slipped today. Clean sheet.');
    return 'sweep:clean';
  }

  await send(`<b>Did these happen?</b>\n${runs.length} block${runs.length > 1 ? 's' : ''} passed today.`);
  for (const r of runs.slice(0, 8)) {
    const slipNote = r.slip_count >= 2 ? `\n⚠️ Slipped ${r.slip_count} times already.` : '';
    await send(`${esc(r.title)}${slipNote}`, {
      keyboard: [[
        { text: 'Done', callback_data: `blk_done:${r.id}` },
        { text: 'Move it', callback_data: `blk_move:${r.id}` },
        { text: 'Drop it', callback_data: `blk_skip:${r.id}` },
      ]],
    });
  }
  return `sweep:${runs.length}`;
}
