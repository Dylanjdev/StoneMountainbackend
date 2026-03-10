const express = require('express')
const crypto = require('crypto')
const fs = require('fs/promises')
const path = require('path')
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
const subscribersFile = process.env.SUBSCRIBERS_FILE || path.join(__dirname, 'data', 'subscribers.json')
const adminApiKey = process.env.ADMIN_API_KEY || ''
const signalWireFromNumber = process.env.SIGNALWIRE_FROM_NUMBER || process.env.TEXT_CLUB_NUMBER || '+12762684720'
const campaignDryRun = String(process.env.CAMPAIGN_DRY_RUN || 'false').toLowerCase() === 'true'

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
    updateSubscriberStatus(from, false).catch((error) => {
      console.error('[sms] failed to mark subscriber opted out', error)
    })
    reply = `You’re all set 👍 You’ve been unsubscribed from ${businessName} texts. No more messages will be sent. Reply START to jump back in anytime.`
  } else if (normalized === 'HELP') {
    reply = `${businessName} 🍦 Need help? Reply ${keyword} to join, STOP to opt out, HELP for help.`
  } else if (normalized.includes(keyword)) {
    updateSubscriberStatus(from, true).catch((error) => {
      console.error('[sms] failed to mark subscriber opted in', error)
    })
    reply = `Welcome to the ${businessName} Text Club 🎉🍦 You’re in for flavor drops, sweet deals, and first-look updates. Reply STOP to opt out.`
  } else if (normalized === 'START') {
    updateSubscriberStatus(from, true).catch((error) => {
      console.error('[sms] failed to mark subscriber opted in after START', error)
    })
    reply = `Welcome back to ${businessName} 🎉 You are subscribed again for flavor drops and sweet updates. Reply STOP to opt out.`
  } else {
    reply = `Hey there 👋 Reply ${keyword} to join the ${businessName} Text Club for deals, new menu drops, and early updates ✨ Msg freq varies. Reply STOP to opt out, HELP for help.`
  }

  // SignalWire accepts TwiML/LaML response for inbound SMS webhooks.
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(reply)}</Message></Response>`

  res.type('text/xml').send(twiml)
})

app.get('/admin/subscribers', enforceAdminAuth, async (req, res) => {
  const subscribers = await readSubscribers()
  const activeSubscribers = subscribers.filter((entry) => entry.optedIn)
  res.json({
    ok: true,
    total: subscribers.length,
    active: activeSubscribers.length,
    subscribers: activeSubscribers
  })
})

app.post('/admin/send-drop', enforceAdminAuth, async (req, res) => {
  const message = String(req.body.message || '').trim()
  const recipients = Array.isArray(req.body.recipients) ? req.body.recipients : null

  if (!message) {
    return res.status(400).json({ error: 'message is required' })
  }

  if (message.length > 320) {
    return res.status(400).json({ error: 'message is too long; keep it under 320 characters' })
  }

  const subscribers = await readSubscribers()
  const activeNumbers = subscribers
    .filter((entry) => entry.optedIn)
    .map((entry) => entry.phone)

  const targetNumbers = recipients && recipients.length > 0
    ? recipients.map(normalizePhone).filter(Boolean)
    : activeNumbers

  if (targetNumbers.length === 0) {
    return res.status(400).json({ error: 'No recipients available. Collect opt-ins first.' })
  }

  const results = []
  for (const to of targetNumbers) {
    try {
      const sendResult = await sendSignalWireSms({ to, body: message })
      results.push({ to, ok: true, sid: sendResult.sid || null })
    } catch (error) {
      results.push({ to, ok: false, error: error.message })
    }
  }

  const sent = results.filter((item) => item.ok).length
  const failed = results.length - sent

  console.log(`[campaign] attempted=${results.length} sent=${sent} failed=${failed}`)

  return res.json({
    ok: failed === 0,
    dryRun: campaignDryRun,
    attempted: results.length,
    sent,
    failed,
    results
  })
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

function enforceAdminAuth(req, res, next) {
  if (!adminApiKey) {
    return res.status(500).json({ error: 'ADMIN_API_KEY is not configured.' })
  }

  const bearerToken = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
  const headerToken = req.get('x-admin-key') || ''
  const incomingToken = bearerToken || headerToken

  if (safeEquals(incomingToken, adminApiKey)) {
    return next()
  }

  return res.status(401).json({ error: 'Invalid admin credentials.' })
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

async function sendSignalWireSms({ to, body }) {
  if (campaignDryRun) {
    return { sid: `dry-run-${Date.now()}` }
  }

  const projectId = process.env.SIGNALWIRE_PROJECT_ID
  const token = process.env.SIGNALWIRE_TOKEN
  const spaceUrl = process.env.SIGNALWIRE_SPACE_URL

  if (!projectId || !token || !spaceUrl) {
    throw new Error('SIGNALWIRE_PROJECT_ID, SIGNALWIRE_TOKEN, and SIGNALWIRE_SPACE_URL are required.')
  }

  const endpoint = `https://${spaceUrl}/api/laml/2010-04-01/Accounts/${projectId}/Messages.json`
  const auth = Buffer.from(`${projectId}:${token}`).toString('base64')
  const payload = new URLSearchParams({
    From: signalWireFromNumber,
    To: to,
    Body: body
  })

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: payload.toString()
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`SignalWire send failed (${response.status}): ${text.slice(0, 200)}`)
  }

  let parsed = {}
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    parsed = {}
  }

  return { sid: parsed.sid || null }
}

async function readSubscribers() {
  try {
    const raw = await fs.readFile(subscribersFile, 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function writeSubscribers(entries) {
  await fs.mkdir(path.dirname(subscribersFile), { recursive: true })
  await fs.writeFile(subscribersFile, JSON.stringify(entries, null, 2), 'utf8')
}

async function updateSubscriberStatus(rawPhone, optedIn) {
  const phone = normalizePhone(rawPhone)
  if (!phone) return

  const subscribers = await readSubscribers()
  const now = new Date().toISOString()
  const existing = subscribers.find((entry) => entry.phone === phone)

  if (existing) {
    existing.optedIn = optedIn
    existing.updatedAt = now
    existing.lastSource = 'inbound-sms'
  } else {
    subscribers.push({
      phone,
      optedIn,
      createdAt: now,
      updatedAt: now,
      lastSource: 'inbound-sms'
    })
  }

  await writeSubscribers(subscribers)
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '')
  if (!digits) return ''
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (digits.length >= 11 && String(value).trim().startsWith('+')) return `+${digits}`
  return ''
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
