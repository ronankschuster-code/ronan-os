// Telegram webhook. Every inbound message lands here.
//
// Flow:
//   1. Is this a reply to a question the bot asked? Handle that first.
//   2. Is it a button press? Handle the callback.
//   3. Otherwise route it through Claude and execute.
//
// Hard rule: capture never fails. If routing breaks, the raw text still gets
// saved to the Inbox so nothing Ronan says is ever lost.

import { route, buildContext } from '../lib/brain.js';
import { send, answerCallback, transcribeVoice, esc, editMessage } from '../lib/telegram.js';
import * as cal from '../lib/calendar.js';
import * as db from '../lib/db.js';
import { fmtDate, fmtTime, untilText, startOfDay, endOfDay, addDays, dayKey } from '../lib/time.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  // Telegram retries aggressively on non-200. Always ack fast.
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (process.env.TELEGRAM_WEBHOOK_SECRET && secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false });
  }

  const update = req.body;
  res.status(200).json({ ok: true });   // ack immediately, then work

  try {
    if (update.callback_query) return await handleCallback(update.callback_query);
    if (update.message) return await handleMessage(update.message);
  } catch (err) {
    console.error('handler error', err);
    try { await send(`Something broke: ${esc(String(err.message || err))}`); } catch {}
  }
}

// ---------------------------------------------------------------------------

async function handleMessage(msg) {
  const chatId = String(msg.chat.id);
  if (process.env.TELEGRAM_CHAT_ID && chatId !== String(process.env.TELEGRAM_CHAT_ID)) return;

  let text = msg.text || msg.caption || '';

  if (msg.voice || msg.audio) {
    const t = await transcribeVoice((msg.voice || msg.audio).file_id);
    if (t) text = t;
    else return send('Voice transcription is not configured. Use your keyboard mic instead, it types straight into Telegram and costs nothing.');
  }
  if (!text.trim()) return;

  if (text.startsWith('/')) return handleCommand(text, chatId);

  // Is he answering a question the bot asked?
  const pending = await db.getPendingReply(chatId);
  if (pending) {
    const consumed = await handlePendingReply(pending, text, chatId);
    if (consumed) return;
  }

  // Give the model just enough calendar context to resolve references.
  let contextBlob = '';
  try {
    const upcoming = await cal.listEvents(new Date(), addDays(new Date(), 14), { maxResults: 60 });
    contextBlob = buildContext(upcoming);
  } catch (e) { console.error('context fetch failed', e); }

  let intent;
  try {
    intent = await route(text, { contextBlob });
  } catch (e) {
    // Routing died. Capture anyway. This is the promise: nothing gets lost.
    await db.addTask({ title: text.slice(0, 200), bucket: 'inbox' });
    return send('Could not parse that, so I dropped it in your Inbox verbatim. Nothing lost.');
  }

  return execute(intent, chatId, text);
}

// ---------------------------------------------------------------------------

async function execute(intent, chatId, rawText) {
  switch (intent.intent) {
    case 'add_event': {
      if (!intent.start_iso) {
        await db.addTask({ title: intent.title || rawText, bucket: intent.bucket || 'inbox' });
        return send('No time in that, so it went to the Inbox.');
      }
      const start = new Date(intent.start_iso);
      const end = intent.end_iso ? new Date(intent.end_iso) : new Date(start.getTime() + 60 * 60000);
      const ev = await cal.createEvent({
        title: intent.title,
        start, end,
        allDay: Boolean(intent.all_day),
        description: intent.notes || '',
        colorId: colorFor(intent.bucket),
        reminderMinutes: 15,
      });
      await db.recordBlockRun({
        gcal_event_id: ev.id, title: ev.title, scheduled_for: end.toISOString(),
      });
      return send(`<b>${esc(ev.title)}</b>\n${fmtDate(start)} ${fmtTime(start)} to ${fmtTime(end)}`);
    }

    case 'add_task': {
      const t = await db.addTask({
        title: intent.title || rawText,
        notes: intent.notes || null,
        bucket: intent.bucket || 'inbox',
        due_at: intent.due_iso || null,
        triaged: Boolean(intent.due_iso),
      });
      const where = intent.due_iso ? `due ${fmtDate(intent.due_iso)}` : 'Inbox, untriaged';
      return send(`Task saved: <b>${esc(t.title)}</b>\n${where}`,
        { keyboard: [[{ text: 'Done', callback_data: `done_task:${t.id}` }]] });
    }

    case 'complete': {
      const matches = await db.findTask(intent.target || intent.title || rawText);
      if (matches.length === 1) {
        await db.completeTask(matches[0].id);
        return send(`Checked off: <b>${esc(matches[0].title)}</b>`);
      }
      if (matches.length > 1) {
        return send('Which one?', {
          keyboard: matches.slice(0, 5).map(t => [{ text: t.title.slice(0, 60), callback_data: `done_task:${t.id}` }]),
        });
      }
      // Maybe it's a calendar block, not a task.
      const evs = await cal.findByTitle(intent.target || rawText, { days: 3 });
      if (evs.length) {
        return send(`That looks like a calendar block, not a task. Nothing to check off, it just passes.\nFound: <b>${esc(evs[0].title)}</b>`);
      }
      return send('Could not find that. Try /tasks to see what is open.');
    }

    case 'reschedule': {
      const evs = await cal.findByTitle(intent.target || intent.title || rawText);
      if (!evs.length) return send('Could not find that on your calendar.');
      if (!intent.start_iso) return send(`Found <b>${esc(evs[0].title)}</b>. Move it to when?`);
      const target = evs[0];
      const start = new Date(intent.start_iso);
      const dur = target.end - target.start;
      const end = intent.end_iso ? new Date(intent.end_iso) : new Date(start.getTime() + dur);
      await cal.updateEvent(target.id, { start, end });
      return send(`Moved <b>${esc(target.title)}</b> to ${fmtDate(start)} ${fmtTime(start)}.`);
    }

    case 'delete': {
      const tasks = await db.findTask(intent.target || rawText);
      if (tasks.length === 1) {
        await db.deleteTask(tasks[0].id);
        return send(`Deleted task: ${esc(tasks[0].title)}`);
      }
      const evs = await cal.findByTitle(intent.target || rawText);
      if (!evs.length) return send('Could not find that.');
      return send(`Delete <b>${esc(evs[0].title)}</b> on ${fmtDate(evs[0].start)}?`, {
        keyboard: [[
          { text: 'Yes, delete', callback_data: `del_ev:${evs[0].id}` },
          { text: 'Cancel', callback_data: 'noop' },
        ]],
      });
    }

    case 'query':
      return runQuery(intent.query_kind || 'today');

    case 'setting': {
      if (intent.setting_patch && Object.keys(intent.setting_patch).length) {
        await db.setSetting(intent.setting_patch);
        return send('Updated.');
      }
      return send(intent.reply || 'Nothing to change.');
    }

    default:
      await db.addTask({ title: rawText.slice(0, 200), bucket: 'inbox' });
      return send(`${esc(intent.reply || 'Not sure what that was.')}\nSaved to Inbox so it is not lost.`);
  }
}

// ---------------------------------------------------------------------------

async function runQuery(kind) {
  const now = new Date();

  if (kind === 'inbox') {
    const items = await db.inboxTasks();
    if (!items.length) return send('Inbox is empty.');
    return send(`<b>Inbox (${items.length})</b>\n` +
      items.map((t, i) => `${i + 1}. ${esc(t.title)}`).join('\n'));
  }

  if (kind === 'tasks') {
    const items = await db.openTasks({ limit: 30 });
    if (!items.length) return send('No open tasks.');
    return send('<b>Open tasks</b>\n' + items.map(t =>
      `• ${esc(t.title)}${t.due_at ? ` (${fmtDate(t.due_at)})` : ''}`).join('\n'));
  }

  const spans = {
    today: [startOfDay(now), endOfDay(now)],
    tomorrow: [startOfDay(addDays(now, 1)), endOfDay(addDays(now, 1))],
    week: [now, addDays(now, 7)],
    due_soon: [now, addDays(now, 3)],
  };
  const [from, to] = spans[kind] || spans.today;
  const events = await cal.listEvents(from, to, { maxResults: 60 });
  const label = { today: 'Today', tomorrow: 'Tomorrow', week: 'Next 7 days', due_soon: 'Next 72 hours' }[kind];

  if (!events.length) return send(`<b>${label}</b>\nNothing scheduled.`);

  let out = `<b>${label}</b>\n`;
  let lastDay = '';
  for (const e of events) {
    const dk = dayKey(e.start);
    if (kind !== 'today' && kind !== 'tomorrow' && dk !== lastDay) {
      out += `\n<i>${fmtDate(e.start)}</i>\n`; lastDay = dk;
    }
    out += e.allDay
      ? `• ${esc(e.title)} (all day)\n`
      : `• ${fmtTime(e.start)} ${esc(e.title)}\n`;
  }
  return send(out.trim());
}

// ---------------------------------------------------------------------------

async function handleCommand(text, chatId) {
  const cmd = text.split(/\s+/)[0].toLowerCase();
  const map = {
    '/today': 'today', '/tomorrow': 'tomorrow', '/week': 'week',
    '/inbox': 'inbox', '/tasks': 'tasks', '/due': 'due_soon',
  };
  if (map[cmd]) return runQuery(map[cmd]);

  if (cmd === '/quiet') {
    await db.setSetting({ quiet_until: new Date(Date.now() + 4 * 3600e3).toISOString() });
    return send('Quiet for 4 hours. Morning brief still fires.');
  }
  if (cmd === '/loud') {
    await db.setSetting({ quiet_until: null });
    return send('Notifications back on.');
  }
  return send(
    '<b>Commands</b>\n' +
    '/today /tomorrow /week\n' +
    '/tasks /inbox /due\n' +
    '/quiet /loud\n\n' +
    'Or just talk to it. "gym at 5", "remind me to email Audrey", "move my Connect block to Sunday", "what is due this week".'
  );
}

// ---------------------------------------------------------------------------

async function handleCallback(cb) {
  const chatId = String(cb.message.chat.id);
  const [action, arg] = (cb.data || '').split(':');

  if (action === 'noop') { await answerCallback(cb.id, 'Cancelled'); return; }

  if (action === 'done_task') {
    const t = await db.completeTask(arg);
    await answerCallback(cb.id, 'Done');
    return editMessage(chatId, cb.message.message_id, `Done: ${t?.title || 'task'}`);
  }

  if (action === 'del_ev') {
    await cal.deleteEvent(arg);
    await answerCallback(cb.id, 'Deleted');
    return editMessage(chatId, cb.message.message_id, 'Deleted.');
  }

  // Evening sweep buttons
  if (action === 'blk_done') {
    await db.resolveBlockRun(arg, { status: 'done' });
    await answerCallback(cb.id, 'Nice');
    return editMessage(chatId, cb.message.message_id, 'Marked done.');
  }

  if (action === 'blk_move') {
    const run = (await db.pendingBlockRuns(new Date(Date.now() + 864e5).toISOString()))
      .find(r => r.id === arg);
    await answerCallback(cb.id, 'Finding a slot');
    const slots = await cal.findFreeSlots(60, { days: 5 });
    if (!slots.length) {
      await db.resolveBlockRun(arg, { status: 'skipped' });
      return editMessage(chatId, cb.message.message_id, 'No free slots in the next 5 days. Left it alone.');
    }
    const slot = slots[0];
    const title = run?.title || 'Rescheduled block';
    await cal.createEvent({
      title, start: slot.start, end: slot.end,
      description: 'Auto-rescheduled after it slipped.', reminderMinutes: 15,
    });
    await db.resolveBlockRun(arg, {
      status: 'moved', moved_to: slot.start.toISOString(),
      slip_count: (run?.slip_count || 0) + 1,
    });
    return editMessage(chatId, cb.message.message_id,
      `Moved to ${fmtDate(slot.start)} ${fmtTime(slot.start)}.`);
  }

  if (action === 'blk_skip') {
    await db.resolveBlockRun(arg, { status: 'skipped' });
    await answerCallback(cb.id, 'Dropped');
    return editMessage(chatId, cb.message.message_id, 'Dropped it.');
  }

  await answerCallback(cb.id);
}

// ---------------------------------------------------------------------------

async function handlePendingReply(pending, text, chatId) {
  // Reserved for multi-turn flows. Currently the sweep uses buttons, so
  // a free-text message is always treated as a new command.
  await db.clearPendingReply(chatId);
  return false;
}

function colorFor(bucket) {
  return ({
    school: '7',      // blue
    pulseboard: '6',  // tangerine
    lxa: '3',         // grape
    errand: '8',      // graphite
    personal: '2',    // sage
  })[bucket];
}
