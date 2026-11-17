# Deploy LiveTip KH for yourself

Owner mode is on whenever OWNER_PASSWORD is set: one account (yours), signups closed,
and the home page sends visitors straight to your tip page.

## 1. Make two private link tokens (run on your computer)
    node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
Run it twice. One is ALERT_TOKEN (in your OBS links), the other is NOTIFY_TOKEN (in your phone webhook).
Because you set them yourself, your links never change when the server restarts.

## 2. Render (easiest)
1. Put this folder in a GitHub repo (keep it private). data.json and .env are already ignored.
2. Render > New > Blueprint > pick the repo. It reads render.yaml.
3. When asked, enter OWNER_PASSWORD (long, only you know it), ALERT_TOKEN and NOTIFY_TOKEN.
4. Deploy. Your site is at https://YOURAPP.onrender.com. Log in at /app with username "me" and your password.
The "starter" plan is needed for the 1 GB disk. Without a disk, tips, your KHQR image and settings are erased on every restart,
and the free plan also sleeps, which would delay alerts. Do not use the free plan for live streaming.

## Cheaper or other options
Any small VPS or Fly.io works: `docker build -t livetip .` then run with a volume mounted at /data and the same environment variables.
Put HTTPS in front (Caddy or the host's built-in HTTPS).

## 3. First-time setup (in /app)
1. Upload your KHQR image and press Save.
2. Copy the overlay links into OBS as Browser Sources (alerts, goal, etc.).
3. Press "Test alert" to check OBS.
4. Phone webhook: MacroDroid or Tasker, trigger = notification from your bank app, action = HTTP POST to the webhook URL shown in /app, body = the notification text.
5. Share your tip page link: https://YOURAPP.onrender.com/pay/me

## Staying safe
- Anyone with your ALERT_TOKEN can watch your alert stream, and anyone with NOTIFY_TOKEN can fake a tip. Keep both private. To change them, edit the variables and redeploy, then update OBS and your phone.
- Use "Download backup" in /app now and then.
- Forgot the password? Change OWNER_PASSWORD on the server and restart.
