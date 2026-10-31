'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ms = require('../msauth')
const { Mail } = require('../mail')

const CLIENT = '11111111-2222-3333-4444-555555555555'
/** Microsoft's token endpoint, as far as these tests need it: it checks the PKCE verifier against the challenge it saw. */
function fakeMicrosoft() {
  const seen = { challenge: null, bodies: [] }
  const fetch = async (url, { body }) => {
    const b = Object.fromEntries(new URLSearchParams(body)); seen.bodies.push(b)
    if (b.grant_type === 'authorization_code') {
      const ok = b.code === 'the-code' && crypto.createHash('sha256').update(b.code_verifier).digest('base64url') === seen.challenge
      return { json: async () => ok ? { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 } : { error: 'invalid_grant' } }
    }
    if (b.refresh_token === 'refresh-1') return { json: async () => ({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }) }
    return { json: async () => ({ error: 'invalid_grant', error_description: 'AADSTS70008: The refresh token has expired' }) }
  }
  // the browser: Microsoft's page "signs in" and sends the browser back to Tetra's one-time address
  const browser = answer => async url => {
    const u = new URL(url)
    seen.challenge = u.searchParams.get('code_challenge'); seen.url = u
    const back = new URL(u.searchParams.get('redirect_uri'))
    for (const [k, v] of Object.entries(answer(u))) back.searchParams.set(k, v)
    setTimeout(() => globalThis.fetch(back).catch(() => {}), 10)
  }
  return { seen, fetch, browser }
}

test('microsoft: sign-in by the browser with PKCE, the code back on localhost, then tokens', async () => {
  const m = fakeMicrosoft()
  const t = await ms.signIn({ clientId: CLIENT, address: 't@nup.ac.cy', fetch: m.fetch, open: m.browser(u => ({ code: 'the-code', state: u.searchParams.get('state') })) })
  assert.equal(t.access, 'access-1'); assert.equal(t.refresh, 'refresh-1'); assert.ok(t.expires > Date.now())
  assert.equal(m.seen.url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(m.seen.url.searchParams.get('login_hint'), 't@nup.ac.cy')
  assert.match(m.seen.url.searchParams.get('scope'), /IMAP\.AccessAsUser\.All .*SMTP\.Send/)
  assert.match(m.seen.url.searchParams.get('redirect_uri'), /^http:\/\/localhost:\d+\/$/)
  assert.equal(m.seen.bodies[0].redirect_uri, m.seen.url.searchParams.get('redirect_uri'), 'the same address both times')
})

test('microsoft: a university that must approve the app first, a wrong answer, a missing app id', async () => {
  const m = fakeMicrosoft()
  await assert.rejects(ms.signIn({ clientId: CLIENT, address: 'a@b.c', fetch: m.fetch,
    open: m.browser(u => ({ error: 'access_denied', error_description: 'AADSTS65001: The user or administrator has not consented to use the application', state: u.searchParams.get('state') })) }),
  e => e.reason === 'approval')
  await assert.rejects(ms.signIn({ clientId: 'not-an-id', address: 'a@b.c', open: () => {} }), e => e.reason === 'noClient')
  // an answer with another state is not this sign-in's: ignored, and it times out
  await assert.rejects(ms.signIn({ clientId: CLIENT, address: 'a@b.c', fetch: m.fetch, timeout: 400, open: m.browser(() => ({ code: 'the-code', state: 'forged' })) }), /too long/)
})

test('microsoft: the refresh token renews the access token and may change itself; an expired one says sign in again', async () => {
  const m = fakeMicrosoft()
  const t = await ms.refresh({ clientId: CLIENT, refreshToken: 'refresh-1', fetch: m.fetch })
  assert.deepEqual([t.access, t.refresh], ['access-2', 'refresh-2'])
  await assert.rejects(ms.refresh({ clientId: CLIENT, refreshToken: 'old', fetch: m.fetch }), e => e.reason === 'auth')
  await assert.rejects(ms.refresh({ clientId: CLIENT, refreshToken: null }), e => e.reason === 'auth')
})

test('microsoft: an account signed in with a token reads by IMAP XOAUTH2 and sends by SMTP XOAUTH2', { timeout: 60_000 }, async () => {
  const hoodiecrow = require('hoodiecrow-imap'), { SMTPServer } = require('smtp-server')
  const got = []
  const smtp = new SMTPServer({ disabledCommands: ['STARTTLS'], allowInsecureAuth: true, authMethods: ['XOAUTH2'],
    onAuth: (a, s, cb) => cb(a.method === 'XOAUTH2' && a.accessToken === 'tok' ? null : new Error('535 no'), { user: a.username }),
    onData: (stream, s, cb) => { stream.on('data', () => {}); stream.on('end', () => { got.push(s.envelope.rcptTo.map(r => r.address)); cb() }) } })
  const imap = hoodiecrow({ plugins: ['ID', 'IDLE', 'SPECIAL-USE', 'SASL-IR', 'XOAUTH2', 'UIDPLUS'], users: { 't@nup.ac.cy': { password: 'unused', xoauth2: { accessToken: 'tok' } } },
    storage: { INBOX: { messages: [{ raw: 'From: a@b.c\r\nSubject: Hi\r\nMessage-ID: <hi@b.c>\r\n\r\nHello\r\n' }] }, '': { separator: '/', folders: { Sent: { 'special-use': '\\Sent', messages: [] } } } } })
  await new Promise(r => smtp.listen(0, '127.0.0.1', r)); await new Promise(r => imap.listen(0, '127.0.0.1', r))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msmail-'))
  const asked = []
  const mail = new Mail(root, { secret: () => null, token: async acc => { asked.push(acc.id); return 'tok' } })
  try {
    mail.add({ address: 't@nup.ac.cy', auth: 'microsoft', user: 't@nup.ac.cy',
      server: { host: '127.0.0.1', port: imap.server.address().port, secure: false, provider: 'microsoft', smtp: { host: '127.0.0.1', port: smtp.server.address().port, secure: false } } })
    const end = Date.now() + 20_000
    while (!mail.status()['t@nup.ac.cy']?.synced) { if (Date.now() > end) throw new Error(JSON.stringify(mail.status())); await new Promise(r => setTimeout(r, 100)) }
    assert.equal(mail.list('Inbox')[0].subject, 'Hi')
    await mail.send({ account: 't@nup.ac.cy', to: [{ address: 'x@y.gr' }], subject: 'Από Microsoft', html: '<p>ok</p>' })
    assert.deepEqual(got, [['x@y.gr']])
    assert.ok(asked.length >= 2 && asked.every(a => a === 't@nup.ac.cy'))
  } finally { mail.stopAll(); await new Promise(r => setTimeout(r, 200)); imap.close(); smtp.close(); fs.rmSync(root, { recursive: true, force: true }) }
})
