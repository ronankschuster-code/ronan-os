// Telegram send helpers. Kept dumb on purpose.

const API = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
export const CHAT_ID = () => process.env.TELEGRAM_CHAT_ID;

export async function send(text, { chatId = CHAT_ID(), keyboard = null, silent = false } = {}) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    disable_notification: silent,
  };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };

  const res = await fetch(`${API()}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error('telegram send failed', await res.text());
  return res.ok;
}

export async function answerCallback(callbackQueryId, text = '') {
  await fetch(`${API()}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

export async function editMessage(chatId, messageId, text, keyboard = null) {
  const body = {
    chat_id: chatId, message_id: messageId, text,
    parse_mode: 'HTML', disable_web_page_preview: true,
  };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  await fetch(`${API()}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Telegram voice note -> text, via OpenAI Whisper. Optional: skip if no key. */
export async function transcribeVoice(fileId) {
  if (!process.env.OPENAI_API_KEY) return null;

  const meta = await (await fetch(`${API()}/getFile?file_id=${fileId}`)).json();
  if (!meta.ok) return null;
  const audioRes = await fetch(
    `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${meta.result.file_path}`);
  const buf = await audioRes.arrayBuffer();

  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/ogg' }), 'voice.ogg');
  form.append('model', 'whisper-1');

  const tr = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!tr.ok) { console.error('whisper failed', await tr.text()); return null; }
  return (await tr.json()).text;
}

export function esc(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
