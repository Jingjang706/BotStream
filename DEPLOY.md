# BotStream deployment guide

BotStream is a stateful Node.js app. Choose the deployment target that matches how you intend to use it.

## Vercel — multi-creator hosting

The Vercel adapter stores account data in Upstash Redis and uses Ably to deliver OBS overlay events in realtime. Do not deploy the original JSON-file mode to Vercel: Vercel function filesystems are not durable between invocations.

### 1. Create the hosted services

1. Create an Upstash Redis database in a region close to the Vercel function region. Copy its REST URL and REST token.
2. Create an Ably app and an API key whose allowed capability includes **publish** and **subscribe**. Keep the complete key secret; it belongs only in Vercel environment variables.
3. Use a Vercel Pro project for commercial/client hosting. Vercel's free Hobby plan is restricted to personal and non-commercial use.

### 2. Import the repository

1. In Vercel, choose **Add New → Project** and import `Jingjang706/BotStream`.
2. Keep the project root as the repository root. Vercel detects the Node.js function from `api/index.js` and uses `vercel.json` to route the app pages and API requests through it.
3. Add the environment variables below in **Project → Settings → Environment Variables** for Production and Preview.

| Variable | Required | Value |
|---|---:|---|
| `UPSTASH_REDIS_REST_URL` | Yes | Upstash database REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Yes | Upstash database REST token |
| `ABLY_API_KEY` | Recommended for live use | Full Ably API key in `name:secret` format; never expose it in browser code |
| `BOTSTREAM_NAMESPACE` | Recommended | Unique prefix such as `botstream:production`; use a different prefix for every deployment sharing one Redis database |
| `OWNER_PASSWORD` | No | Leave unset for multi-creator signup. Set only for a single-owner installation |
| `OWNER_SLUG` | No | Defaults to `owner`; use `me` for the single-owner tip page |
| `ALERT_TOKEN` | No | Optional fixed OBS overlay token. Generate a long random value |
| `NOTIFY_TOKEN` | No | Optional fixed bank-notification webhook token. Generate a different long random value |
| `ADMIN_KEY` | No | Optional admin endpoint key |
| `TELEGRAM_BOT_TOKEN` | No | Optional Telegram bot integration |
| `GOOGLE_TTS_KEY` | No | Optional Google Cloud Text-to-Speech |
| `YOUTUBE_API_KEY` | No | Optional YouTube Data API |

For a multi-client service, do **not** set `OWNER_PASSWORD`; doing so intentionally switches off registration and creates a single-owner install. Add secrets in Vercel's dashboard, not in Git.

4. Deploy. The first deployment initializes Redis only when the first request arrives. Open the Vercel URL and create a test creator account.

### 3. Verify before inviting clients

1. Register a test account and save its recovery code.
2. Sign in, upload a test KHQR image, and save settings.
3. Open the tip page and submit a small test tip request. This only creates a pending tip; it does not verify a real bank payment.
4. Add the `alerts` link as an OBS Browser Source and click **Test alert** in the dashboard.
5. Verify the overlay receives events, refresh the page, and confirm the account and settings still exist.
6. Configure the Android notification automation only after you have verified the exact format of your bank's notifications. Keep the webhook URL private.

### 4. Cost and scaling notes

- Vercel Hobby is free but restricted to personal/non-commercial use. Client/business hosting must use a plan that permits commercial use.
- Upstash Redis Free currently includes 256 MB and 500,000 commands per month. It is suitable for a low-traffic pilot, not an unlimited free production database.
- Ably Free currently includes 6 million messages per month and up to 200 concurrent connections. Each connected OBS Browser Source consumes a connection, and published events are delivered to each subscribed source.
- If Ably is not configured, overlays fall back to frequent Redis polling. Configure Ably for normal Vercel use.
- The current adapter serializes writes with a shared Redis lock and loads creator records for a request. This is a safe first serverless migration for a small pilot, but it is not yet a high-throughput SaaS architecture. Before onboarding many simultaneous creators, move to per-tenant transactions/records and add load tests, monitoring, backups, and restore drills.
- Tip matching still relies on creator-provided bank notification text posted to the private webhook. It is not a direct bank payment API or an independent proof of settlement.

## Traditional Node hosting (Render or VPS)

The original local mode still stores state in `data.json`. Use a host with a persistent disk, mount it, set `DB_FILE` to that mounted path, and terminate HTTPS at the host or a reverse proxy.

For a single creator, set `OWNER_PASSWORD` and optionally set `OWNER_SLUG=me`, `ALERT_TOKEN`, and `NOTIFY_TOKEN`. The existing `render.yaml` is an example Render Blueprint and currently uses a paid persistent-disk plan.

## Security checklist

- Never commit `.env`, Redis credentials, the Ably API key, owner passwords, webhook tokens, or a real KHQR image.
- Use different random values for `ALERT_TOKEN` and `NOTIFY_TOKEN`. Anyone holding the notify token can submit fake payment notifications.
- Use a unique `BOTSTREAM_NAMESPACE` for each environment and do not point Preview and Production at the same namespace.
- Take regular Redis backups/exports and test restoring them before handling valuable client data.
- Do not treat the app as a regulated payment processor. Verify all bank notification matching and creator payout workflows manually.
