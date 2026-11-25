# HanaV free independent Telegram alerts
No paid Render server required. Use only when employer and market-data provider permit external processing and messaging. Never transmit customer, account or order information. No order endpoints.

## Morning Brief
- GitHub Actions → HanaV Morning Brief → Run workflow. Preview is now unchecked by default. Actual delivery requires RADAR_TELEGRAM_BOT_TOKEN and RADAR_TELEGRAM_CHAT_ID in repository Actions secrets.
- Daily schedule: 22:30 UTC (07:30 KST next day). Standard runners on this public repository have no compute-minute charge; check billing/usage limits and GitHub terms. Scheduled runs can be delayed, skipped or disabled after inactivity.
- This is a daily generated public-market report, not an always-on server. US holidays/weekends use the last completed session. Missing latest index closes stop delivery. AI-style causal analysis is not included.

## Free Futures Radar (Google Apps Script)
1. Create a private project at https://script.google.com/home/projects/create. Name it HanaV Futures Radar.
2. Copy the entire free_radar/Code.gs from this repository into Code.gs and save.
3. Project Settings (gear) → Script Properties → Add script property:
   - KIS_APP_KEY
   - KIS_APP_SECRET
   - FUTURES_CONTRACTS (same multiline F,actual_short_code,label or JF,actual_short_code,label used by Streamlit; update at expiry)
   - RADAR_TELEGRAM_BOT_TOKEN
   - RADAR_TELEGRAM_CHAT_ID
   - RADAR_ALERT_NEWS (optional: true or false; default true)
   Copy values from existing Streamlit settings; never post them to GitHub or chat.
4. Select testRadar and Run. Approve required Apps Script permissions. Verify Telegram receipt and KIS authentication. KIS connectivity on port 9443 is unverified in Apps Script; if it fails, do not activate the trigger.
5. During market hours, run radarTick manually and check execution logs for fresh quotes. First run only builds history; repeated runs enable comparisons.
6. Select installRadar and Run once. It creates one recurring five-minute trigger, independent of the phone and PC. Disable automatic sending on the Streamlit page to avoid duplicates. Use stopRadar to disable.
7. Google free-account quotas apply, including 90 minutes total trigger runtime/day across the account. This implementation checks weekday 08:45–15:45 KST and skips other times; holidays are filtered only by quote freshness, not an exchange calendar. No guaranteed timing, no overnight coverage. Missing/stale quotes and gaps in history suppress signals. Data source and credentials must work on Google's network. Private Script Properties retain limited comparison history and a short-lived KIS token; do not share the project.
8. Defaults: price 0.35%, volume acceleration 3x, basis 0.5pt, OI 1%; news candidates are not confirmed material events. Free polling cannot detect all short-lived movements. No guarantee of uninterrupted delivery.
