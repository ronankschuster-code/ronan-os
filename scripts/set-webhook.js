#!/usr/bin/env node
// Point Telegram at your deployed function. Run once after deploying,
// and again any time the URL changes.
//
//   APP_URL=https://your-app.vercel.app \
//   TELEGRAM_BOT_TOKEN=... \
//   TELEGRAM_WEBHOOK_SECRET=... \
//   node scripts/set-webhook.js

const { TELEGRAM_BOT_TOKEN, APP_URL, TELEGRAM_WEBHOOK_SECRET } = process.env;

if (!TELEGRAM_BOT_TOKEN || !APP_URL) {
  console.error('Need TELEGRAM_BOT_TOKEN and APP_URL');
  process.exit(1);
}

const body = {
  url: `${APP_URL.replace(/\/$/, '')}/api/telegram`,
  allowed_updates: ['message', 'callback_query'],
  drop_pending_updates: true,
};
if (TELEGRAM_WEBHOOK_SECRET) body.secret_token = TELEGRAM_WEBHOOK_SECRET;

const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
console.log(JSON.stringify(await res.json(), null, 2));

const info = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo`);
console.log('\nCurrent webhook:');
console.log(JSON.stringify(await info.json(), null, 2));
