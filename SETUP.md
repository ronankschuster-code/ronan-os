# Ronan OS — setup

**Design rule:** Google Calendar is the source of truth. This bot reads and writes it. If the bot dies, your calendar keeps working exactly as it does today and your phone still shows everything. The bot is a convenience layer, never a dependency.

Work top to bottom. Roughly 30 minutes.

---

## 0. Undo the OAuth attempt (2 min)

We abandoned OAuth for a service account, so clean up what's half-built. None of it is harmful, it's just clutter that will confuse you in six months.

In [console.cloud.google.com](https://console.cloud.google.com), **stay in the same project** (Calendar API is already enabled there, and you want to keep that):

1. **Google Auth Platform → Clients** → delete the "Web application" client you created. It has a redirect URI pointing at `localhost:8910` and nothing will ever use it.
2. **Google Auth Platform → Data Access** → leave it. Harmless, and unused once no client exists.
3. **Google Auth Platform → Audience** → leave it unpublished. Ignore the "configuration incomplete" warning permanently. That warning only matters for apps that ask users for consent, and yours never will.
4. Anything already in your scratch file for `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, or `GOOGLE_REFRESH_TOKEN`: **delete those three lines.** They are not used anymore.

Do **not** delete the project. Do **not** disable the Calendar API.

---

## 1. Service account (5 min) — replaces all the OAuth pain

1. **APIs & Services → Credentials → Create Credentials → Service account**
2. Name it `ronan-os-bot`. Skip the optional "grant access" steps, just Create and Done.
3. Click into the service account you just made → **Keys** tab → **Add Key → Create new key → JSON** → Create

   A `.json` file downloads. Open it in a text editor. You need two values:
   - `"client_email"` — looks like `ronan-os-bot@yourproject.iam.gserviceaccount.com`
   - `"private_key"` — a long string starting `-----BEGIN PRIVATE KEY-----\n`

4. **Share your calendar with it.** This is the step that makes it work, and it happens in Google Calendar, not Cloud Console:
   - [calendar.google.com](https://calendar.google.com) → hover your calendar in the left sidebar → **⋮ → Settings and sharing**
   - **Share with specific people or groups → Add people**
   - Paste the service account's `client_email`
   - Permission: **Make changes to events**
   - Send

> **Why this works:** the service account is its own tiny Google identity. It can't see anything until you explicitly share with it. No consent screen, no verification, no privacy policy, and the credential never expires.

---

## 2. Telegram bot (3 min)

1. Message **@BotFather** → `/newbot` → pick a name and a username ending in `bot`
2. Copy the token → `TELEGRAM_BOT_TOKEN`
3. Your chat ID is **7087735312** (already known)
4. Invent any random string → `TELEGRAM_WEBHOOK_SECRET`

---

## 3. Supabase (done already)

Schema is run. You have `SUPABASE_URL` and the `service_role` key.

---

## 4. Env vars

Your scratch file should now read:

```
TELEGRAM_BOT_TOKEN=          (from BotFather)
TELEGRAM_CHAT_ID=7087735312
TELEGRAM_WEBHOOK_SECRET=     (any random string)

GOOGLE_SA_EMAIL=             (client_email from the JSON)
GOOGLE_SA_PRIVATE_KEY=       (private_key from the JSON, see note below)
GOOGLE_CALENDAR_ID=ronankschuster@gmail.com

SUPABASE_URL=
SUPABASE_SERVICE_KEY=

ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-4-5
CRON_SECRET=                 (another random string)
TIMEZONE=America/New_York
```

**Two things that will bite you:**

- **`GOOGLE_CALENDAR_ID` must be your email address, not `primary`.** To a service account, "primary" means its own empty calendar. Get this wrong and the bot runs fine, reports success, and writes to a calendar you can't see.
- **`GOOGLE_SA_PRIVATE_KEY`:** copy it out of the JSON exactly as it appears there, including the literal `\n` sequences. Do not convert them to real line breaks. The code unescapes them at runtime.

---

## 5. Deploy to Vercel (5 min)

Push the folder to a **public** GitHub repo (no secrets in the code, only in env vars), then import it at [vercel.com/new](https://vercel.com/new).

Paste every variable above into **Settings → Environment Variables**, then **Redeploy**. Vercel does not pick up new env vars on an existing deployment.

---

## 6. Wire the webhook (2 min)

Replace the two values and open this in a browser tab:

```
https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=https://<your-app>.vercel.app/api/telegram&secret_token=<YOUR_WEBHOOK_SECRET>&drop_pending_updates=true
```

You want `{"ok":true,"result":true,...}`.

**Test it:** message your bot `/today`. If it reads back your real calendar, the whole spine works.

---

## 7. Heartbeat (5 min)

GitHub repo → **Settings → Secrets and variables → Actions**:

- `APP_URL` = `https://your-app.vercel.app` (no trailing slash)
- `CRON_SECRET` = same value as in Vercel

**Actions** tab → **Run workflow** once by hand to confirm HTTP 200. After that it runs every 5 minutes on its own.

---

## Using it

| You say | What happens |
|---|---|
| `gym at 5` | 90 min block today |
| `golf friday morning` | 5 hour block, 7am to noon |
| `remind me to email Audrey` | Task, lands in Inbox |
| `order the calculator by friday` | Task with a Friday due date |
| `move my Connect block to sunday` | Finds it, moves it |
| `done with the calculator thing` | Checks it off |
| `what's due this week` | Reads it back |

Commands: `/today` `/tomorrow` `/week` `/tasks` `/inbox` `/due` `/quiet` `/loud`

**Voice:** use your phone keyboard's mic to dictate into Telegram. Free and instant.

## What it does unprompted

| When | What |
|---|---|
| 90 min before your first event, never before 6:30am | Morning brief |
| Top of each work block | Nudge with what the block is for. Classes skipped. |
| 48h and 12h before a deadline | Warning |
| 9:00pm | Evening sweep: Done / Move it / Drop it |

## Troubleshooting

**Bot silent.** Open `https://api.telegram.org/bot<TOKEN>/getWebhookInfo` and read `last_error_message`.


**"Service account auth failed".** The private key got mangled. Re-copy it from the JSON with the `\n` sequences intact.

**Bot works but the calendar never changes.** `GOOGLE_CALENDAR_ID` is still `primary`, or you never shared the calendar with the service account email.

**Cron not firing.** Actions tab, look for red runs. Usual cause is a trailing slash on `APP_URL`.
