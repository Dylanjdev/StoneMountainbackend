# StoneBackend (Render + SignalWire)

This service receives inbound SMS from SignalWire and replies using TwiML/LaML.

## Endpoints

- `GET /` basic service status
- `GET /health` Render health check endpoint
- `POST /webhooks/sms` SignalWire inbound SMS webhook

## Local setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy env file:
   ```bash
   cp .env.example .env
   ```
3. Start server:
   ```bash
   npm run dev
   ```

## Environment variables

- `PORT` default `10000`
- `ALLOWED_ORIGIN` optional CORS allow origin
- `TEXT_CLUB_KEYWORD` default `YOGURT`
- `BUSINESS_NAME` default `Stone Mountain Yogurt`
- `SIGNALWIRE_PROJECT_ID` SignalWire project id
- `SIGNALWIRE_SPACE_URL` SignalWire space URL
- `SIGNALWIRE_TOKEN` token used for optional signature verification
- `WEBHOOK_SECRET` optional shared secret header value (`x-webhook-secret`)
- `WEBHOOK_RATE_LIMIT_WINDOW_MS` default `60000`
- `WEBHOOK_RATE_LIMIT_MAX` default `60`
- `REQUIRE_SIGNALWIRE_SIGNATURE` default `false`; set `true` in production after webhook URL is stable
- `SIGNALWIRE_FROM_NUMBER` the purchased SignalWire number used for outbound campaigns
- `ADMIN_API_KEY` required for admin campaign endpoints
- `SUBSCRIBERS_FILE` JSON file used to store opted-in numbers
- `CAMPAIGN_DRY_RUN` set `true` to test campaign sends without sending actual SMS
- `CAMPAIGN_API_BASE_URL` base URL used by `npm run send-drop` CLI helper

## SignalWire setup

After deploy, set the number's inbound SMS webhook URL to:

`https://<your-render-service>.onrender.com/webhooks/sms`

Method: `POST`

## Render setup

- Runtime: `Node`
- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/health`

## Quick webhook test

```bash
curl -X POST http://localhost:10000/webhooks/sms \
   -H "x-webhook-secret: stone-local-webhook-secret" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "Body=YOGURT&From=%2B12765551212&To=%2B12762684720"
```

Expected response: XML containing a welcome message.

If `WEBHOOK_SECRET` is set, requests without `x-webhook-secret` will return `401`.
If your provider cannot send custom headers, include the secret in the webhook URL query string:

`https://<your-render-service>.onrender.com/webhooks/sms?secret=<WEBHOOK_SECRET>`

## Outbound campaigns (new drops)

Subscribers are saved automatically when users text the join keyword (or `START`), and removed from active sends when they text `STOP`.

- `GET /admin/subscribers` returns active subscriber list
- `POST /admin/send-drop` sends one message to all active subscribers, or to a provided recipient list

### Send a new drop to all active subscribers

```bash
curl -X POST https://<your-render-service>.onrender.com/admin/send-drop \
   -H "x-admin-key: <ADMIN_API_KEY>" \
   -H "Content-Type: application/json" \
   -d '{"message":"🍓 New drop! Strawberry Cheesecake swirl lands at 2 PM. Reply STOP to opt out."}'
```

### Send a drop to specific numbers only

```bash
curl -X POST https://<your-render-service>.onrender.com/admin/send-drop \
   -H "x-admin-key: <ADMIN_API_KEY>" \
   -H "Content-Type: application/json" \
   -d '{"message":"✨ VIP early drop tonight at 6 PM! Reply STOP to opt out.","recipients":["+12765551212","+12765559876"]}'
```

### CLI helper for staff

From this folder, run:

```bash
npm run send-drop
```

It will prompt for message text and send to all active subscribers using `CAMPAIGN_API_BASE_URL` and `ADMIN_API_KEY`.

You can also pass the message directly:

```bash
npm run send-drop -- "🍦 New drop today at 4 PM! Reply STOP to opt out."
```
# StoneMountainbackend
