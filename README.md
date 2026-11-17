# LiveTip KH

Tip alerts and overlays for OBS. No dependencies: needs only Node 18 or newer.

## Deploying for yourself
See DEPLOY.md. Setting OWNER_PASSWORD makes it a one-account private install.

## Run it
    node server.js
Open http://localhost:3000, click Get started, and create an account. Save the recovery code it shows:
it is the only way to reset a forgotten password.

## Overlays (add each link as an OBS Browser Source)
Your dashboard shows every link. They share the form /overlay?w=NAME&token=YOURTOKEN
- alerts: tip alerts, Khmer voice, jumpscare, "new top donor" crown, YouTube media share
- wheel: spin wheel (triggered by tips) and raffle winner draws
- goal, top, timer (subathon countdown), poll (live results), chat (YouTube live chat)

## Tools in the dashboard (work from a phone while live)
Test alert, skip alert, test spin, draw or clear raffle, start or stop the timer, create or close a poll,
tell Telegram you are live. Settings set the spin, jumpscare and media-share thresholds, minutes added to the timer per $1, and the wheel slices.

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
Any Node host (Render, a VPS). Data lives in data.json, so use a persistent disk and back it up. Use HTTPS.
Behind a proxy, make sure it sets x-forwarded-for so rate limits see real visitors.

## Tested here
Accounts, recovery reset, rate limits, tip matching, alerts, spin, raffle, timer, polls and one-vote-per-visitor, media-share rules, admin.
## Written but not tested (needs internet or your keys)
YouTube video check before payment, Telegram messages, Google voice, YouTube chat.

## Not built
- Telegram sign-in by QR (needs a Telegram user-account library; bots cannot read other bots' messages)
- Card pulls and battles, fan points and redeems (these need card art, game rules and donor identities that can't be faked)
- Automatic go-live detection (use the Telegram button in the dashboard)
- Email, payments beyond the bank text, a billing system
