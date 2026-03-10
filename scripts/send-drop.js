const readline = require('readline/promises')
const { stdin, stdout } = require('process')
const dotenv = require('dotenv')

dotenv.config()

const DEFAULT_API_BASE_URL = 'https://stonemountainbackend.onrender.com'

async function main() {
  const apiBaseUrl = (process.env.CAMPAIGN_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/$/, '')
  const adminApiKey = String(process.env.ADMIN_API_KEY || '').trim()

  if (!adminApiKey) {
    console.error('Missing ADMIN_API_KEY in environment.')
    process.exit(1)
  }

  const messageFromArgs = process.argv.slice(2).join(' ').trim()
  let message = messageFromArgs

  if (!message) {
    const rl = readline.createInterface({ input: stdin, output: stdout })
    try {
      message = (await rl.question('Enter drop message: ')).trim()
    } finally {
      rl.close()
    }
  }

  if (!message) {
    console.error('Message cannot be empty.')
    process.exit(1)
  }

  if (message.length > 320) {
    console.error(`Message too long (${message.length}). Keep it under 320 characters.`)
    process.exit(1)
  }

  const endpoint = `${apiBaseUrl}/admin/send-drop`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'x-admin-key': adminApiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message })
  })

  const text = await response.text()
  if (!response.ok) {
    console.error(`Send failed (${response.status}): ${text}`)
    process.exit(1)
  }

  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    payload = null
  }

  if (!payload) {
    console.log('Send complete, but response was not JSON:')
    console.log(text)
    return
  }

  console.log('Campaign sent.')
  console.log(`Attempted: ${payload.attempted}`)
  console.log(`Sent: ${payload.sent}`)
  console.log(`Failed: ${payload.failed}`)

  const results = Array.isArray(payload.results) ? payload.results : []
  const failedResults = results.filter((item) => !item.ok)
  const sentResults = results.filter((item) => item.ok)

  if (failedResults.length > 0) {
    console.log('\nFailed recipients:')
    for (const item of failedResults) {
      console.log(`- ${item.to}: ${item.error || 'Unknown error'}`)
    }
  }

  if (sentResults.length > 0) {
    console.log('\nSuccessful recipients:')
    for (const item of sentResults) {
      console.log(`- ${item.to}${item.sid ? ` (sid: ${item.sid})` : ''}`)
    }
  }
}

main().catch((error) => {
  console.error('Unexpected error sending drop:', error.message)
  process.exit(1)
})
