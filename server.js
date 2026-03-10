const express = require('express')
const crypto = require('crypto')
const dotenv = require('dotenv')

dotenv.config()

const app = express()
const port = process.env.PORT || 10000
app.set('trust proxy', true)

const webhookSecret = process.env.WEBHOOK_SECRET
const signatureRequired = String(process.env.REQUIRE_SIGNALWIRE_SIGNATURE || 'false').toLowerCase() === 'true'
const rateLimitWindowMs = Number(process.env.WEBHOOK_RATE_LIMIT_WINDOW_MS || 60000)
const rateLimitMax = Number(process.env.WEBHOOK_RATE_LIMIT_MAX || 60)
const ipRequestBuckets = new Map()

app.use(express.json())
app.use(express.urlencoded({ extended: false }))

// Simple CORS for any future frontend calls to this service.
app.use((req, res, next) => {
  const origin = process.env.ALLOWED_ORIGIN
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204)
  }

  next()
})

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'stone-text-club-backend'
  })
})

app.get('/health', (req, res) => {
  res.json({ ok: true })
})

app.post('/webhooks/sms', enforceWebhookRateLimit, enforceWebhookSecret, enforceSignalWireSignature, (req, res) => {
  const incomingBody = String(req.body.Body || '').trim()
  const from = String(req.body.From || 'unknown')
  const normalized = incomingBody.toUpperCase()
  const keyword = String(process.env.TEXT_CLUB_KEYWORD || 'YOGURT').toUpperCase()
  const businessName = process.env.BUSINESS_NAME || 'Stone Mountain Yogurt'

  console.log(`[sms] inbound from=${from} body="${incomingBody}"`)

  let reply

  if (['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(normalized)) {
    reply = `You are unsubscribed from ${businessName} text alerts and will receive no more messages. Reply START to opt back in.`
  } else if (normalized === 'HELP') {
    reply = `${businessName}: Reply ${keyword} to join, STOP to opt out, HELP for help.`
  } else if (normalized.includes(keyword)) {
    reply = `Welcome to ${businessName} Text Club. You are subscribed for specials, flavor drops, and event updates. Reply STOP to opt out.`
  } else {
    reply = `Reply ${keyword} to join ${businessName} Text Club. Msg freq varies. Reply STOP to opt out, HELP for help.`
  }

  // SignalWire accepts TwiML/LaML response for inbound SMS webhooks.
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(reply)}</Message></Response>`

  res.type('text/xml').send(twiml)
})

function enforceWebhookRateLimit(req, res, next) {
  const now = Date.now()
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const existing = ipRequestBuckets.get(ip)

  if (!existing || now > existing.resetAt) {
    ipRequestBuckets.set(ip, { count: 1, resetAt: now + rateLimitWindowMs })
    pruneRateLimitBuckets(now)
    return next()
  }

  if (existing.count >= rateLimitMax) {
    return res.status(429).json({ error: 'Too many webhook requests. Try again shortly.' })
  }

  existing.count += 1
  next()
}

function pruneRateLimitBuckets(now) {
  if (ipRequestBuckets.size < 500) return
  for (const [key, bucket] of ipRequestBuckets.entries()) {
    if (now > bucket.resetAt) {
      ipRequestBuckets.delete(key)
    }
  }
}

function enforceWebhookSecret(req, res, next) {
  if (!webhookSecret) return next()

  const incoming = req.get('x-webhook-secret') || String(req.query.secret || '')
  if (safeEquals(incoming, webhookSecret)) return next()

  console.warn('[sms] rejected webhook due to invalid secret')
  return res.status(401).json({ error: 'Invalid webhook secret.' })
}

function enforceSignalWireSignature(req, res, next) {
  if (!signatureRequired) return next()

  const token = process.env.SIGNALWIRE_TOKEN
  if (!token) {
    return res.status(500).json({ error: 'SIGNALWIRE_TOKEN is required when signature verification is enabled.' })
  }

  const signature = req.get('x-twilio-signature') || req.get('x-signalwire-signature') || ''
  if (!signature) {
    console.warn('[sms] rejected webhook due to missing signature')
    return res.status(401).json({ error: 'Missing webhook signature.' })
  }

  const expected = computeTwilioCompatibleSignature(req, token)
  if (!safeEquals(signature, expected)) {
    console.warn('[sms] rejected webhook due to invalid signature')
    return res.status(401).json({ error: 'Invalid webhook signature.' })
  }

  next()
}

function computeTwilioCompatibleSignature(req, token) {
  const proto = req.get('x-forwarded-proto') || req.protocol
  const host = req.get('x-forwarded-host') || req.get('host')
  const url = `${proto}://${host}${req.originalUrl}`
  const params = req.body && typeof req.body === 'object' ? req.body : {}
  const sortedKeys = Object.keys(params).sort()

  let payload = url
  for (const key of sortedKeys) {
    payload += `${key}${params[key]}`
  }

  return crypto.createHmac('sha1', token).update(payload, 'utf8').digest('base64')
}

function safeEquals(a, b) {
  if (!a || !b) return false
  const aBuffer = Buffer.from(String(a), 'utf8')
  const bBuffer = Buffer.from(String(b), 'utf8')
  if (aBuffer.length !== bBuffer.length) return false
  return crypto.timingSafeEqual(aBuffer, bBuffer)
}

function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

app.listen(port, () => {
  console.log(`Stone backend listening on port ${port}`)
})
