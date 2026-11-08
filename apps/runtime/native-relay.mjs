#!/usr/bin/env node
// Native Relay PoC client.
//
// An external agent session (running on the user's machine) uses the user's
// Bearer token to poll assignments for one native-bound Bot and advance slots.
// This process does not start any model and never sees Roost's runtime token.
//
//   ROOST_API=https://roostbots.com \
//   ROOST_USER_TOKEN=... ROOST_ROOM_ID=rm_... ROOST_BOT_ID=bot_... \
//   node apps/runtime/native-relay.mjs --once
//
// Use --loop for a 2s poll. The JSON lines are assignments for the external
// session; it answers with POST /api/native/advance (see docs).
const base = (process.env.ROOST_API ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')
const token = process.env.ROOST_USER_TOKEN ?? ''
const roomId = process.env.ROOST_ROOM_ID ?? ''
const botId = process.env.ROOST_BOT_ID ?? ''
const once = process.argv.includes('--once')

if (token === '' || roomId === '' || botId === '') {
  console.error('ROOST_USER_TOKEN, ROOST_ROOM_ID and ROOST_BOT_ID are required')
  process.exit(2)
}

async function poll() {
  const response = await fetch(`${base}/api/native/assignments?roomId=${encodeURIComponent(roomId)}&botId=${encodeURIComponent(botId)}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    console.error(`native relay poll failed: HTTP ${response.status} ${JSON.stringify(body)}`)
    return false
  }
  if (Array.isArray(body.assignments) && body.assignments.length > 0) {
    for (const assignment of body.assignments) console.log(JSON.stringify(assignment))
  }
  return true
}

if (once) {
  await poll()
} else {
  for (;;) {
    await poll()
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}
