# Independent Telegram alerts
Both services run outside Streamlit. Do not add secrets to this public repository.
Use only if external market-data processing and messaging are allowed by your employer and data provider. Never send customer/account/order information. No order endpoints are used.

## Morning Brief
1. Repository Settings → Secrets and variables → Actions → New repository secret.
2. Copy the existing bot settings (without posting their values in chat): RADAR_TELEGRAM_BOT_TOKEN and RADAR_TELEGRAM_CHAT_ID.
3. Actions → HanaV Morning Brief → Run workflow. Leave preview checked to generate a PNG without sending, or uncheck to test actual delivery. Preview artifact is public market data only.
4. Schedule is 22:30 UTC every day (07:30 KST next day). GitHub schedules may be delayed or disabled after 60 days of repository inactivity. On US holidays/weekends, the last completed session is explicitly labeled. If the latest US index closes are missing, delivery stops rather than using stale numbers.
5. News are RSS headlines and conditional market observations, not AI-written causal analysis or personalized recommendations. Source data is Yahoo Finance; the provider may rate-limit cloud requests. No OpenAI API key needed. Existing ChatGPT brief is independent.

## Futures Radar
1. Use the Render Blueprint from render.yaml, or an approved equivalent always-on host. Render paid compute is selected; review cost before creating anything. The repo alone does not start the worker.
2. Enter environment values only in the hosting provider's secret settings:
   KIS_APP_KEY, KIS_APP_SECRET, FUTURES_CONTRACTS, RADAR_TELEGRAM_BOT_TOKEN, RADAR_TELEGRAM_CHAT_ID.
   FUTURES_CONTRACTS is the same multiline text from the Streamlit page: F,actual_short_code,label or JF,actual_short_code,label.
   Do not use display aliases or expired contracts. Update the environment at rollover. RADAR_ALERT_NEWS=true enables keyword-based news candidates, not confirmed market impact.
3. Run one instance only. The worker checks on weekdays 08:45–15:45 KST with ~60s sleep after each polling cycle; delays and outages are possible. No night session. It uses fresh quotes and in-memory history/cooldowns, so restarts can reset those. Defaults: 5-minute price movement 0.35%, volume acceleration 3x, basis change 0.5pt, OI change >=1%. It does not identify actual investor-specific flows.
4. Once the worker is running, turn off the Streamlit page's automatic Telegram send toggle to prevent duplicates. This does not affect the independent worker.
5. Verify live quote access, market-data terms, token issuance and Telegram delivery during a trading session before relying on it. Stop the hosting service to disable independent radar alerts.
