// Natural-language -> structured intent, via Claude.
// This is the only "smart" part. Everything downstream is deterministic,
// which means when it misfires you get a wrong calendar entry, never a silent no-op.

import { TZ, fmtDate, fmtTime } from './time.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

const INTENT_TOOL = {
  name: 'route',
  description: 'Route the user message into exactly one structured action.',
  input_schema: {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        enum: [
          'add_event',    // time-bound -> Google Calendar
          'add_task',     // no time block -> task layer
          'complete',     // check something off
          'reschedule',   // move an existing event
          'delete',       // remove an event or task
          'query',        // what's today / what's due / what's in my inbox
          'triage',       // assign a date/bucket to an inbox item
          'setting',      // quiet hours, toggle nudges
          'unknown',
        ],
      },
      title: { type: 'string', description: 'Short imperative title. No filler words.' },
      notes: { type: 'string', description: 'Any extra detail worth keeping.' },
      bucket: {
        type: 'string',
        enum: ['school', 'pulseboard', 'lxa', 'errand', 'personal', 'inbox'],
        description: 'Life area. Default inbox only if genuinely unclear.',
      },
      start_iso: { type: 'string', description: 'ISO8601 with offset. Only for timed things.' },
      end_iso: { type: 'string', description: 'ISO8601 with offset.' },
      all_day: { type: 'boolean' },
      due_iso: { type: 'string', description: 'Soft deadline for a task. No time block reserved.' },
      target: { type: 'string', description: 'For complete/reschedule/delete: what the user is referring to, in their words.' },
      query_kind: {
        type: 'string',
        enum: ['today', 'tomorrow', 'week', 'due_soon', 'inbox', 'tasks'],
      },
      setting_patch: { type: 'object', description: 'For setting intent, e.g. {"nudge_enabled": false}' },
      reply: { type: 'string', description: 'One short line to send back. Plain, no emoji, no exclamation marks. Never use em dashes.' },
      confidence: { type: 'number', description: '0 to 1.' },
    },
    required: ['intent', 'reply', 'confidence'],
  },
};

function systemPrompt(nowISO, contextBlob) {
  return `You are the routing layer for Ronan's personal operating system. He is a Virginia Tech student (Business Information Technology, ops/supply chain concentration) who also runs a startup called PulseBoard and is a fraternity officer. He has ADHD and relies on this system to not forget things.

Current time: ${nowISO} (timezone ${TZ}).

Your job: turn one message into one structured action. Be decisive. A wrong-but-close entry he can fix beats a clarifying question he never answers.

RULES
- If the message names or implies a specific time ("gym at 5", "class tomorrow at 2", "lunch Friday noon"), use add_event with start_iso and end_iso. Guess a sensible duration: workouts 90m, meetings 60m, errands 30m, meals 60m, study/work blocks 120m.
- If it is a thing to do with no time attached ("remind me to email Audrey", "order the calculator"), use add_task. Set due_iso ONLY if he stated or clearly implied a deadline. Otherwise leave due_iso empty so it lands in the Inbox.
- "by Friday", "before the weekend", "sometime next week" are due dates on a task, not calendar events.
- complete: he is checking something off. Put his words in target.
- reschedule: he is moving something. target = what, start_iso/end_iso = where to.
- Buckets: school = classes, coursework, exams, professors. pulseboard = the startup. lxa = Lambda Chi Alpha fraternity. errand = shopping, appointments, pickups. personal = gym, golf, social, family.
- Golf is 5 hours door to door for 18 holes, 2.5 hours for 9. Assume 18 unless he says nine.
- Never schedule work between 11pm and 7am.
- reply: one short sentence confirming what you did, in plain language. Do not use em dashes. Do not use emoji. Do not be chirpy.
- If you genuinely cannot tell what he wants, intent=unknown with a reply asking one specific question.

${contextBlob ? `\nRELEVANT CONTEXT FROM HIS CALENDAR:\n${contextBlob}` : ''}`;
}

export async function route(message, { contextBlob = '' } = {}) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt(new Date().toISOString(), contextBlob),
      tools: [INTENT_TOOL],
      tool_choice: { type: 'tool', name: 'route' },
      messages: [{ role: 'user', content: message }],
    }),
  });

  if (!res.ok) throw new Error(`anthropic: ${await res.text()}`);
  const j = await res.json();
  const block = (j.content || []).find(c => c.type === 'tool_use');
  if (!block) return { intent: 'unknown', reply: 'Did not follow that. Say it another way.', confidence: 0 };
  return block.input;
}

/** Compact calendar context so the model can resolve "move my gym block". */
export function buildContext(events) {
  if (!events?.length) return '';
  return events.slice(0, 25)
    .map(e => `- ${e.title} | ${fmtDate(e.start)} ${e.allDay ? 'all day' : fmtTime(e.start)} | id:${e.id}`)
    .join('\n');
}
