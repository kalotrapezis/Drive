'use strict'
/**
 * «Σύνδεση με Microsoft» for Hotmail/Outlook.com and Microsoft 365 (MAIL_PLAN §9b, §10 step 5): OAuth 2.0 with the
 * authorization code and PKCE. Microsoft's own page opens in the browser; the user signs in there (with their phone code
 * if they use one); the browser comes back to a one-time server on this computer (http://localhost:<port>/), which takes
 * the code. Tetra never sees the password. The refresh token is kept by main in safeStorage, like a password; an access
 * token lives an hour, in memory. The app's id ("client id") is registered by the user once (MAIL_PLAN §13).
 */
const http = require('node:http')
const crypto = require('node:crypto')

const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0'
const SCOPES = ['offline_access', 'https://outlook.office.com/IMAP.AccessAsUser.All', 'https://outlook.office.com/SMTP.Send']
const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const isClientId = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id.trim())

/** A PKCE pair: the verifier stays here, its SHA-256 goes to Microsoft. */
function pkce() {
  const verifier = b64url(crypto.randomBytes(32))
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) }
}

function authorizeUrl({ clientId, redirect, challenge, state, address }) {
  const u = new URL(`${AUTHORITY}/authorize`)
  for (const [k, v] of Object.entries({ client_id: clientId, response_type: 'code', redirect_uri: redirect, response_mode: 'query', scope: SCOPES.join(' '),
    code_challenge: challenge, code_challenge_method: 'S256', state, login_hint: address, prompt: 'select_account' })) u.searchParams.set(k, v)
  return u.toString()
}

/** What Microsoft said, as tokens, or as an error with a reason the window says in one sentence. */
function tokens(json, now = Date.now()) {
  if (!json || json.error || !json.access_token) {
    const text = `${json?.error ?? ''} ${json?.error_description ?? ''}`
    // AADSTS65001/90094/90008: the organisation (a university) must approve the app first
    const reason = /AADSTS(65001|90094|90008|900971)|admin|consent/i.test(text) ? 'approval' : /invalid_grant|AADSTS70008|AADSTS700082|AADSTS50173/i.test(text) ? 'auth' : 'other'
    throw Object.assign(new Error(json?.error_description?.split('\r\n')[0] || json?.error || 'Microsoft gave no token'), { reason })
  }
  return { access: json.access_token, refresh: json.refresh_token ?? null, expires: now + (Number(json.expires_in) || 3600) * 1000 - 60_000 }
}

async function post(fetch, body) {
  const r = await fetch(`${AUTHORITY}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(), signal: AbortSignal.timeout(20_000) })
  return r.json().catch(() => ({ error: `HTTP ${r.status}` }))
}

const PAGE = ok => `<!doctype html><meta charset="utf-8"><title>Tetra</title><body style="font:16px system-ui;padding:40px;text-align:center">` +
  `<h2>${ok ? '✓' : '✗'} Tetra</h2><p>${ok ? 'Μπορείς να κλείσεις αυτή τη σελίδα και να γυρίσεις στο Tetra. · You can close this page and go back to Tetra.' : 'Η σύνδεση δεν έγινε. Γύρνα στο Tetra. · Sign-in did not finish. Go back to Tetra.'}</p>`

/**
 * The whole sign-in: a one-time server on 127.0.0.1, Microsoft's page in the browser ([open]), the code back, then the
 * tokens. Gives up after five minutes. { access, refresh, expires }.
 */
async function signIn({ clientId, address, open, fetch = globalThis.fetch, timeout = 5 * 60_000 }) {
  if (!isClientId(clientId)) throw Object.assign(new Error('No Microsoft app id set'), { reason: 'noClient' })
  const { verifier, challenge } = pkce(), state = b64url(crypto.randomBytes(16))
  const server = http.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const redirect = `http://localhost:${server.address().port}/`
  try {
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('Microsoft sign-in took too long'), { reason: 'other' })), timeout)
      server.on('request', (req, res) => {
        const u = new URL(req.url, redirect)
        if (u.pathname !== '/' || u.searchParams.get('state') !== state) { res.writeHead(404).end(); return } // not Microsoft's answer to this sign-in
        const ok = !!u.searchParams.get('code')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE(ok))
        clearTimeout(timer)
        if (ok) resolve(u.searchParams.get('code'))
        else { try { tokens({ error: u.searchParams.get('error'), error_description: u.searchParams.get('error_description') }) } catch (e) { reject(e) } }
      })
      Promise.resolve(open(authorizeUrl({ clientId: clientId.trim(), redirect, challenge, state, address }))).catch(reject)
    })
    return tokens(await post(fetch, { client_id: clientId.trim(), grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier, scope: SCOPES.join(' ') }))
  } finally { server.close() }
}

/** A new access token from the refresh token; Microsoft may hand back a new refresh token too. */
async function refresh({ clientId, refreshToken, fetch = globalThis.fetch }) {
  if (!isClientId(clientId)) throw Object.assign(new Error('No Microsoft app id set'), { reason: 'noClient' })
  if (!refreshToken) throw Object.assign(new Error('Not signed in with Microsoft on this computer'), { reason: 'auth' })
  const t = tokens(await post(fetch, { client_id: clientId.trim(), grant_type: 'refresh_token', refresh_token: refreshToken, scope: SCOPES.join(' ') }))
  return { ...t, refresh: t.refresh ?? refreshToken }
}

module.exports = { AUTHORITY, SCOPES, pkce, authorizeUrl, tokens, signIn, refresh, isClientId }
