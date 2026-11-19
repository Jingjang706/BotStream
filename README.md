# BotStream · LiveTip KH

Multi-tenant live-tip pages, Khmer alerts, browser overlays and creator tools for OBS. Local development uses Node.js 20+. Vercel hosting uses Upstash Redis for durable shared state and Ably for realtime browser delivery.

## Deployment
See [DEPLOY.md](DEPLOY.md). For multiple creators, leave `OWNER_PASSWORD` unset so account registration remains enabled. Setting it enables single-owner mode and closes registration.

## Run it
    node server.js
Open http://localhost:3000, click Get started, and create an account. Save the recovery code it shows:
it is the only way to reset a forgotten password.

## Overlays (add each link as an OBS Browser Source)
Your dashboard shows every link. They share the form /overlay?w=NAME&token=YOURTOKEN
- alerts: tip alerts, Khmer voice, jumpscare, "new top donor" crown, YouTube media share
- wheel: spin wheel (triggered by tips) and raffle winner draws
- goal, top, timer (subathon countdown), poll (live results), predict (live prediction pools), chat (YouTube live chat)

## Tools in the dashboard (work from a phone while live)
Test alert, skip alert, test spin, draw or clear raffle, start or stop the timer, create or close a poll,
tell Telegram you are live. Settings set the spin, jumpscare and media-share thresholds, minutes added to the timer per $1, and the wheel slices.

## Fan points, redeems and predictions
- Viewers earn fan points for every matched tip (default 10 per $1, set in Settings). On the tip page they pick an optional passcode. The first tip with a passcode locks that name to it, so nobody else can spend those points.
- Redeems are set in Settings, one per line as `name | cost | alert, scare or spin`. A viewer spends points on the tip page and the alert, jumpscare or wheel spin fires on stream.
- Predictions: start one in the dashboard (2 or 3 outcomes). Viewers bet points on the tip page. Lock the bets, then pay out the winners: the whole pool is split between winners by how much they bet. Cancel refunds everyone.
- Points only come from tips that matched a pending tip on the tip page, never from unmatched bank texts.
- Discord: paste a Discord webhook URL in Settings to post each tip and your go-live message there.

## Collectible cards and boss battles
- Every named tip with a passcode pulls cards (one per `Tip needed per pull` in USD, up to 3). Bigger tips improve the odds of rare, epic and legendary cards.
- The Cards tab in the dashboard sets your own cards, one per line: `name | rarity | emoji | color | image URL`. Image URLs must be https, and you should only use art you own or have the right to use. Starter cards use emoji, so nothing is needed to begin.
- Viewers open their collection on the tip page with their name and passcode and can battle your boss. A battle costs points, a win pays points, and the arena has a 12 second cooldown. Pulls and battles show on the Alerts overlay.
- The dashboard Live tab shows a real-time feed of tips, redeems, pulls and battles, with a skip button for the current alert.

## How a tip flows
1. Viewer fills the tip page (name, amount, message, optional YouTube link), then sees your KHQR.
2. Viewer pays. Your bank sends you a payment notification.
3. Your notification text is POSTed to your webhook (shown in the dashboard).
4. The server reads the amount, matches it to the viewer's pending tip (within 15 minutes), and fires the alert, wheel, timer and so on.
If nothing matches, the alert still shows as "Anonymous". Raffle entries are everyone who tipped since you last cleared it.

## Sending bank notifications to the webhook
On Android use MacroDroid or Tasker. Trigger: notification from your bank app. Action: HTTP POST to your webhook URL with the notification text as the body.
Check how your bank words its messages and, if needed, edit the patterns in `parse()` in server.js.

## Optional settings (environment variables)
- OWNER_PASSWORD, OWNER_SLUG, ALERT_TOKEN, NOTIFY_TOKEN: private single-owner mode (see DEPLOY.md)
- ADMIN_KEY: turns on /admin (only useful with several accounts)
- TELEGRAM_BOT_TOKEN: posts each tip and "I'm live" messages to the Telegram chat ID you set in the dashboard
- GOOGLE_TTS_KEY: Google Cloud Text-to-Speech key, for server-made Khmer voice (language km-KH). Without it, the overlay uses the browser voice
- YOUTUBE_API_KEY: YouTube Data API key, for the chat overlay (the stream must be public)
- PORT, DB_FILE

## Deploy
For Vercel multi-tenant hosting, follow [DEPLOY.md](DEPLOY.md). For a traditional Node host (Render, a VPS), data lives in data.json, so use a persistent disk and back it up. Use HTTPS.
Behind a proxy, make sure it sets x-forwarded-for so rate limits see real visitors.

## Tested here
Accounts, recovery reset, rate limits, tip matching, alerts, spin, raffle, timer, polls and one-vote-per-visitor, media-share rules, admin, fan points, passcode checks, redeems, prediction bets and payouts.
## Written but not tested (needs internet or your keys)
YouTube video check before payment, Telegram and Discord messages, Google voice, YouTube chat, and how the new overlay and tip-page screens look in a real browser.

## Not built
- Telegram sign-in by QR (needs a Telegram user-account library; bots cannot read other bots' messages)
- Automatic go-live detection (use the Telegram button in the dashboard)
- Email, payments beyond the bank text, a billing system
