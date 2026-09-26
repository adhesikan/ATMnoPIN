#!/usr/bin/env node
/*
 * Passwordless auth flow smoke test (Sprint 1B).
 *
 * Self-contained: loads server.js as a module against a throwaway SQLite
 * database, listens on an ephemeral port, and drives the /api/auth, /api/account,
 * /login, /account and profile-generator routes over HTTP. Resend is never
 * called: global fetch is stubbed and verification codes are read from the
 * stubbed request. Never touches data/blog-posts.sqlite. No deps.
 *
 * Usage:  node scripts/smoke-auth-flow.js
 * Exit code 0 = all checks passed, 1 = at least one failure.
 */

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_FILE = path.join(os.tmpdir(), `auth-flow-smoke-${Date.now()}.sqlite`);

process.env.SQLITE_DB_FILE = DB_FILE;
delete process.env.DATABASE_URL;
delete process.env.RAILWAY_ENVIRONMENT;
delete process.env.RAILWAY_PROJECT_ID;
delete process.env.RAILWAY_SERVICE_ID;
delete process.env.NODE_ENV;
process.env.RESEND_API_KEY = 're_test_SUPERSECRET';
process.env.AUTH_EMAIL_FROM = 'ATMwithNoPIN <auth@example.com>';

const Database = require('better-sqlite3');
const app = require(path.join(__dirname, '..', 'server.js'));

let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`  ✓ ${name}`); }
function bad(name, detail) { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
function check(name, cond, detail) { cond ? ok(name) : bad(name, detail); }

// ── Resend stub: capture outgoing mail, optionally fail ──
const sentEmails = [];
let resendFails = false;
global.fetch = async (url, opts = {}) => {
  if (String(url).startsWith('https://api.resend.com/')) {
    sentEmails.push(JSON.parse(opts.body));
    if (resendFails) return { ok: false, status: 500, json: async () => ({ message: 'provider exploded' }) };
    return { ok: true, status: 200, json: async () => ({ id: `em_${sentEmails.length}` }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
function lastCodeFor(email) {
  for (let i = sentEmails.length - 1; i >= 0; i--) {
    if (sentEmails[i].to[0] === email) return (sentEmails[i].text.match(/code is (\d{6})/) || [])[1];
  }
  return null;
}

let BASE = '';
let ipSeq = 0;
function nextIp() { ipSeq++; return `10.9.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`; }

function request(method, urlPath, { cookie, body, ip, rawBody, contentType } = {}) {
  return new Promise((resolve, reject) => {
    const data = rawBody != null ? rawBody : body !== undefined ? JSON.stringify(body) : null;
    const headers = { 'X-Forwarded-For': ip || nextIp() };
    if (data != null) {
      headers['Content-Type'] = contentType || 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (cookie) headers.Cookie = cookie;
    const req = http.request(BASE + urlPath, { method, headers }, (res) => {
      let chunks = '';
      res.on('data', (c) => chunks += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(chunks); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text: chunks, json });
      });
    });
    req.on('error', reject);
    if (data != null) req.write(data);
    req.end();
  });
}

function sessionCookieFrom(res) {
  const sc = [].concat(res.headers['set-cookie'] || []).find((c) => c.startsWith('atm_session='));
  if (!sc) return null;
  return sc.split(';')[0];
}

function wrongCode(code) { return String((Number(code) + 1) % 1000000).padStart(6, '0'); }

async function login(email) {
  app.resetAuthRateLimits();
  const r1 = await request('POST', '/api/auth/request-code', { body: { email } });
  if (r1.status !== 200) throw new Error(`request-code ${r1.status} for ${email}`);
  const r2 = await request('POST', '/api/auth/verify-code', { body: { email, code: lastCodeFor(app.normalizeUserEmail(email)) } });
  if (r2.status !== 200) throw new Error(`verify-code ${r2.status} for ${email}`);
  return sessionCookieFrom(r2);
}

function multipart(fields) {
  const boundary = `----smoke${crypto.randomBytes(8).toString('hex')}`;
  let body = '';
  for (const [k, v] of Object.entries(fields)) body += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  body += `--${boundary}--\r\n`;
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function main() {
  console.log(`Auth flow smoke — temp DB ${DB_FILE}`);
  await app.initializeDatabase();
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  BASE = `http://127.0.0.1:${app.server.address().port}`;
  const db = new Database(DB_FILE);
  const userByEmail = (e) => db.prepare('SELECT * FROM users WHERE email_normalized = ?').get(e);
  const insertSubmission = (s) => db.prepare('INSERT INTO player_submissions (id, data) VALUES (?, ?)').run(s.id, JSON.stringify(s));

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nRequest code');
  app.resetAuthRateLimits();
  let r = await request('POST', '/api/auth/request-code', { body: { email: 'not-an-email' } });
  check('invalid email rejected (400)', r.status === 400);
  r = await request('POST', '/api/auth/request-code', { rawBody: 'email=a@example.com', contentType: 'application/x-www-form-urlencoded' });
  check('non-JSON body rejected (400)', r.status === 400);
  const sendsBefore = sentEmails.length;
  const rNew = await request('POST', '/api/auth/request-code', { body: { email: '  Player.One@Example.com ' } });
  check('valid email → 200', rNew.status === 200, rNew.text);
  check('response is generic (ok + message only)', rNew.json && rNew.json.ok === true && Object.keys(rNew.json).sort().join() === 'message,ok', rNew.text);
  check('auth JSON is no-store', rNew.headers['cache-control'] === 'no-store');
  const p1 = userByEmail('player.one@example.com');
  check('user created (new, unverified, active, no username)', p1 && p1.trust_level === 'new' && !p1.email_verified_at && p1.status === 'active' && p1.username === null);
  check('email sent via stub to normalized address', sentEmails.length === sendsBefore + 1 && sentEmails[sentEmails.length - 1].to[0] === 'player.one@example.com');
  const code1 = lastCodeFor('player.one@example.com');
  check('real code never returned in response', code1 && !rNew.text.includes(code1));
  const vRows = db.prepare('SELECT * FROM email_verification_codes WHERE user_id = ?').all(p1.id);
  check('login verification record created', vRows.length === 1 && vRows[0].purpose === 'login' && !vRows[0].code_hash.includes(code1));
  const mail = sentEmails[sentEmails.length - 1];
  check('email copy: brand, expiry, ignore line', mail.subject.includes('ATMwithNoPIN') && mail.html.includes(code1) && mail.text.includes('This code expires in 10 minutes') && mail.text.includes("If you didn't request this code, you can ignore this email."));
  check('no user id / verification id in response', !rNew.text.includes(p1.id) && !rNew.text.includes(vRows[0].id));

  r = await request('POST', '/api/auth/request-code', { body: { email: 'player.one@example.com' } });
  check('send cooldown enforced (429 within 60s)', r.status === 429);
  check('rate-limit error exposes no internal state', r.json && Object.keys(r.json).join() === 'error' && !/\d+ (requests|remaining)/i.test(r.text));

  app.resetAuthRateLimits();
  const rExisting = await request('POST', '/api/auth/request-code', { body: { email: 'PLAYER.ONE@example.com' } });
  check('normalized duplicate reuses user (no second row)', rExisting.status === 200 && db.prepare("SELECT COUNT(*) AS n FROM users WHERE email_normalized = 'player.one@example.com'").get().n === 1);
  check('existing vs new account responses identical', rExisting.text === rNew.text);

  // Per-email hourly limit: advance the limiter clock past the cooldown each time.
  app.resetAuthRateLimits();
  const realNow = Date.now;
  let fake = realNow();
  Date.now = () => fake;
  let statuses = [];
  for (let i = 0; i < 6; i++) {
    statuses.push((await request('POST', '/api/auth/request-code', { body: { email: 'limit@example.com' } })).status);
    fake += 61 * 1000;
  }
  check('email limit: 5/hour then 429', statuses.slice(0, 5).every((s) => s === 200) && statuses[5] === 429, statuses.join());
  // Per-IP hourly limit.
  app.resetAuthRateLimits();
  statuses = [];
  for (let i = 0; i < 16; i++) statuses.push((await request('POST', '/api/auth/request-code', { body: { email: `ip${i}@example.com` }, ip: '10.200.0.1' })).status);
  check('IP limit: 15/hour then 429', statuses.slice(0, 15).every((s) => s === 200) && statuses[15] === 429, statuses.join());
  Date.now = realNow;

  app.resetAuthRateLimits();
  resendFails = true;
  r = await request('POST', '/api/auth/request-code', { body: { email: 'failmail@example.com' } });
  resendFails = false;
  const failCode = lastCodeFor('failmail@example.com');
  check('provider failure → controlled 503', r.status === 503 && r.json && typeof r.json.error === 'string');
  check('provider failure leaks no details/code/key', !/provider|resend|HTTP|500|SUPERSECRET/i.test(r.text) && !r.text.includes(failCode));
  const failUser = userByEmail('failmail@example.com');
  check('provider failure leaves no unsent verification row', db.prepare('SELECT COUNT(*) AS n FROM email_verification_codes WHERE user_id = ?').get(failUser.id).n === 0);
  // A. Failed delivery does not consume the 60s email cooldown (no limiter reset).
  r = await request('POST', '/api/auth/request-code', { body: { email: 'failmail@example.com' } });
  check('provider failure does not consume email cooldown', r.status === 200, String(r.status));
  // E. A successful send still starts the cooldown.
  r = await request('POST', '/api/auth/request-code', { body: { email: 'failmail@example.com' } });
  check('successful send still enforces cooldown after a failure', r.status === 429, String(r.status));

  // B. Failed deliveries do not consume the per-email hourly quota; successes still do.
  app.resetAuthRateLimits();
  fake = realNow();
  Date.now = () => fake;
  resendFails = true;
  const failStatuses = [];
  for (let i = 0; i < 3; i++) failStatuses.push((await request('POST', '/api/auth/request-code', { body: { email: 'quota@example.com' } })).status);
  resendFails = false;
  statuses = [];
  for (let i = 0; i < 6; i++) {
    statuses.push((await request('POST', '/api/auth/request-code', { body: { email: 'quota@example.com' } })).status);
    fake += 61 * 1000;
  }
  check('provider failures do not consume hourly email quota', failStatuses.every((s) => s === 503) && statuses.slice(0, 5).every((s) => s === 200) && statuses[5] === 429, failStatuses.join() + ' | ' + statuses.join());

  // D. Per-IP abuse limiter still counts failed provider attempts.
  app.resetAuthRateLimits();
  resendFails = true;
  statuses = [];
  for (let i = 0; i < 16; i++) statuses.push((await request('POST', '/api/auth/request-code', { body: { email: `ipfail${i}@example.com` }, ip: '10.202.0.1' })).status);
  resendFails = false;
  check('IP limit counts failed deliveries: 15 then 429', statuses.slice(0, 15).every((s) => s === 503) && statuses[15] === 429, statuses.join());
  Date.now = realNow;

  // C. A failed send does not supersede a previously delivered code.
  app.resetAuthRateLimits();
  await request('POST', '/api/auth/request-code', { body: { email: 'keep@example.com' } });
  const keepCode = lastCodeFor('keep@example.com');
  const keepUser = userByEmail('keep@example.com');
  app.resetAuthRateLimits();
  resendFails = true;
  r = await request('POST', '/api/auth/request-code', { body: { email: 'keep@example.com' } });
  resendFails = false;
  check('second send failed (503)', r.status === 503);
  check('only the delivered code remains unused', db.prepare("SELECT COUNT(*) AS n FROM email_verification_codes WHERE user_id = ? AND used_at IS NULL").get(keepUser.id).n === 1);
  r = await request('POST', '/api/auth/verify-code', { body: { email: 'keep@example.com', code: keepCode } });
  check('failed send does not supersede previously delivered code', r.status === 200, r.text);

  app.resetAuthRateLimits();
  db.prepare("UPDATE users SET status = 'banned' WHERE email_normalized = 'failmail@example.com'").run();
  const sentBeforeBan = sentEmails.length;
  r = await request('POST', '/api/auth/request-code', { body: { email: 'failmail@example.com' } });
  check('banned user: generic 200, no email sent', r.status === 200 && r.text === rNew.text && sentEmails.length === sentBeforeBan);

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nVerify code');
  app.resetAuthRateLimits();
  await request('POST', '/api/auth/request-code', { body: { email: 'verify@example.com' } });
  const vCode = lastCodeFor('verify@example.com');
  const vUser = userByEmail('verify@example.com');
  r = await request('POST', '/api/auth/verify-code', { body: { email: 'verify@example.com', code: wrongCode(vCode) } });
  check('wrong code rejected with generic message', r.status === 400 && r.json.error === 'Invalid or expired verification code.');
  const vRow = db.prepare('SELECT * FROM email_verification_codes WHERE user_id = ? ORDER BY created_at DESC').get(vUser.id);
  check('wrong code increments attempt_count', vRow.attempt_count === 1);
  const rUnknown = await request('POST', '/api/auth/verify-code', { body: { email: 'nobody@example.com', code: '123456' } });
  check('unknown email → same generic response', rUnknown.status === 400 && rUnknown.text === r.text);
  const rOk = await request('POST', '/api/auth/verify-code', { body: { email: ' Verify@Example.com ', code: vCode } });
  check('correct code → 200', rOk.status === 200, rOk.text);
  check('response is safe state only', rOk.json && Object.keys(rOk.json).sort().join() === 'has_profile,needs_username,ok' && rOk.json.needs_username === true && rOk.json.has_profile === false, rOk.text);
  const vCookie = sessionCookieFrom(rOk);
  const vToken = vCookie ? vCookie.split('=')[1] : '';
  const rawSetCookie = [].concat(rOk.headers['set-cookie'] || []).join(';');
  check('Set-Cookie atm_session HttpOnly SameSite=Lax', !!vToken && /HttpOnly/.test(rawSetCookie) && /SameSite=Lax/.test(rawSetCookie));
  check('raw session token not in JSON body', !rOk.text.includes(vToken));
  const vAfter = userByEmail('verify@example.com');
  check('trust new → verified', vAfter.trust_level === 'verified');
  check('email_verified_at + last_login_at set', !!vAfter.email_verified_at && !!vAfter.last_login_at);
  check('verification marked used', !!db.prepare('SELECT used_at FROM email_verification_codes WHERE id = ?').get(vRow.id).used_at);
  const sessRow = db.prepare('SELECT * FROM user_sessions WHERE user_id = ?').get(vUser.id);
  check('session stored as SHA-256 hash only', sessRow && sessRow.token_hash === crypto.createHash('sha256').update(vToken).digest('hex') && !JSON.stringify(db.prepare('SELECT * FROM user_sessions').all()).includes(vToken));
  r = await request('POST', '/api/auth/verify-code', { body: { email: 'verify@example.com', code: vCode } });
  check('replayed code rejected', r.status === 400);

  app.resetAuthRateLimits();
  await request('POST', '/api/auth/request-code', { body: { email: 'verify@example.com' } });
  const aCode = lastCodeFor('verify@example.com');
  for (let i = 0; i < 5; i++) await request('POST', '/api/auth/verify-code', { body: { email: 'verify@example.com', code: wrongCode(aCode) } });
  r = await request('POST', '/api/auth/verify-code', { body: { email: 'verify@example.com', code: aCode } });
  check('attempt limit: correct code rejected after 5 misses', r.status === 400);

  app.resetAuthRateLimits();
  await request('POST', '/api/auth/request-code', { body: { email: 'verify@example.com' } });
  const eCode = lastCodeFor('verify@example.com');
  db.prepare("UPDATE email_verification_codes SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ? AND used_at IS NULL").run(vUser.id);
  r = await request('POST', '/api/auth/verify-code', { body: { email: 'verify@example.com', code: eCode } });
  check('expired code rejected', r.status === 400);

  app.resetAuthRateLimits();
  await request('POST', '/api/auth/request-code', { body: { email: 'verify@example.com' } });
  const oldCode = lastCodeFor('verify@example.com');
  app.resetAuthRateLimits();
  await request('POST', '/api/auth/request-code', { body: { email: 'verify@example.com' } });
  const newCode = lastCodeFor('verify@example.com');
  if (oldCode !== newCode) {
    r = await request('POST', '/api/auth/verify-code', { body: { email: 'verify@example.com', code: oldCode } });
    check('older code superseded by newer one', r.status === 400);
  } else ok('older code superseded by newer one (codes collided; skipped)');

  app.resetAuthRateLimits();
  statuses = [];
  for (let i = 0; i < 31; i++) statuses.push((await request('POST', '/api/auth/verify-code', { body: { email: 'verify@example.com', code: '000000' }, ip: '10.201.0.1' })).status);
  check('verify IP limit: 30/hour then 429', statuses.slice(0, 30).every((s) => s === 400) && statuses[30] === 429, statuses.join());

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nSession');
  r = await request('GET', '/api/auth/me');
  check('/me unauthenticated', r.status === 200 && r.json.authenticated === false && r.headers['cache-control'] === 'no-store');
  r = await request('GET', '/api/auth/me', { cookie: vCookie });
  check('/me authenticated', r.json && r.json.authenticated === true && r.json.user.email === 'verify@example.com' && r.json.user.email_verified === true && r.json.user.trust_level === 'verified' && r.json.has_profile === false);
  check('/me user has only safe fields', r.json && Object.keys(r.json.user).sort().join() === 'display_name,email,email_verified,trust_level,username');
  check('/me leaks no internal ids/hashes', !r.text.includes(vUser.id) && !r.text.includes(sessRow.id) && !r.text.includes(sessRow.token_hash) && !/email_normalized|token_hash|edit_token/.test(r.text));
  r = await request('GET', '/api/auth/me', { cookie: 'atm_session=garbage-token-value-000000' });
  check('bogus cookie → unauthenticated', r.json.authenticated === false);

  const mkSession = async (userId, opts = {}) => {
    const t = app.createSessionToken();
    const s = await app.createUserSession({ userId, tokenHash: app.hashAuthToken(t), ...opts });
    return { cookie: `atm_session=${t}`, session: s };
  };
  const expired = await mkSession(vUser.id, { expiresAt: new Date(Date.now() - 1000) });
  r = await request('GET', '/api/auth/me', { cookie: expired.cookie });
  check('expired session rejected', r.json.authenticated === false);
  const revoked = await mkSession(vUser.id);
  await app.revokeUserSession(revoked.session.id);
  r = await request('GET', '/api/auth/me', { cookie: revoked.cookie });
  check('revoked session rejected', r.json.authenticated === false);
  for (const status of ['banned', 'suspended']) {
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, vUser.id);
    r = await request('GET', '/api/auth/me', { cookie: vCookie });
    check(`${status} user rejected`, r.json.authenticated === false);
  }
  db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(vUser.id);
  r = await request('GET', '/api/auth/me', { cookie: vCookie });
  check('reactivated user accepted again', r.json.authenticated === true);

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nUsername');
  r = await request('POST', '/api/account/username', { body: { username: 'river_rat', display_name: 'River Rat' } });
  check('authentication required (401)', r.status === 401);
  const unverified = await app.createUser({ email: 'unverified@example.com' });
  const uvSess = await mkSession(unverified.id);
  r = await request('POST', '/api/account/username', { cookie: uvSess.cookie, body: { username: 'uv_user', display_name: 'UV' } });
  check('verified email required (403)', r.status === 403);
  r = await request('POST', '/api/account/username', { cookie: vCookie, body: { username: 'bad name!', display_name: 'River Rat' } });
  check('invalid username rejected', r.status === 400);
  r = await request('POST', '/api/account/username', { cookie: vCookie, body: { username: 'ab', display_name: 'River Rat' } });
  check('too-short username rejected', r.status === 400);
  r = await request('POST', '/api/account/username', { cookie: vCookie, body: { username: 'river_rat', display_name: '   ' } });
  check('empty display name rejected', r.status === 400);
  r = await request('POST', '/api/account/username', { cookie: vCookie, body: { username: 'river_rat', display_name: 'x'.repeat(51) } });
  check('display name > 50 chars rejected', r.status === 400);
  r = await request('POST', '/api/account/username', { cookie: vCookie, body: { username: 'River_Rat', display_name: '  River   Rat ' } });
  const vNamed = userByEmail('verify@example.com');
  check('valid username works', r.status === 200 && vNamed.username_normalized === 'river_rat' && vNamed.display_name === 'River Rat', r.text);
  r = await request('POST', '/api/account/username', { cookie: vCookie, body: { username: 'new_name', display_name: 'New' } });
  check('username cannot be changed once set (409)', r.status === 409 && userByEmail('verify@example.com').username_normalized === 'river_rat');
  const dupCookie = await login('dupe@example.com');
  r = await request('POST', '/api/account/username', { cookie: dupCookie, body: { username: 'RIVER_RAT', display_name: 'Copycat' } });
  check('duplicate username rejected (409)', r.status === 409 && !userByEmail('dupe@example.com').username_normalized);
  check('duplicate error exposes no DB detail', !/UNIQUE|constraint|SQLITE/i.test(r.text));

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nProfile claim');
  const sub = (id, name, email, extra = {}) => ({ id, name, nickname: '', email, slug: `${id}-slug`, status: 'pending', edit_token: `SECRET-${id}`, consent_ip: '203.0.113.9', admin_notes: 'internal note', created_at: new Date().toISOString(), ...extra });
  insertSubmission(sub('ps-claim', 'Claimer Carl', ' Claimer@Example.com ', { nickname: 'The Clam', status: 'approved' }));
  insertSubmission(sub('ps-other', 'Other Olive', 'other@example.com'));
  insertSubmission(sub('ps-multi-1', 'Multi One', 'multi@example.com'));
  insertSubmission(sub('ps-multi-2', 'Multi Two', 'multi@example.com'));
  insertSubmission(sub('ps-owned', 'Owned Oscar', 'shared@example.com'));
  insertSubmission(sub('ps-xss', '<script>alert(1)</script>', 'xss@example.com'));
  await app.createUserProfileLink(unverified.id, 'ps-owned'); // someone else already owns it

  const claimCookie = await login('claimer@example.com');
  r = await request('POST', '/api/account/claim-profile', { cookie: claimCookie, body: { player_submission_id: 'ps-claim' } });
  check('claim requires username first (403)', r.status === 403);
  await request('POST', '/api/account/username', { cookie: claimCookie, body: { username: 'carl', display_name: 'Carl' } });
  r = await request('GET', '/api/account/profile-candidates?email=other@example.com', { cookie: claimCookie });
  check('candidates use account email, not request email', r.json && r.json.linked === false && r.json.candidates.length === 1 && r.json.candidates[0].id === 'ps-claim', r.text);
  check('candidate has only safe fields', r.json && Object.keys(r.json.candidates[0]).sort().join() === 'id,name,nickname,slug,status');
  check('candidates leak no email/edit_token/consent/notes', !/SECRET-|edit_token|claimer@example|203\.0\.113|internal note|consent/i.test(r.text));
  check('candidates are no-store', r.headers['cache-control'] === 'no-store');
  r = await request('GET', '/api/account/profile-candidates');
  check('candidates require auth (401)', r.status === 401);
  r = await request('POST', '/api/account/claim-profile', { cookie: claimCookie, body: { player_submission_id: 'ps-other' } });
  check('unrelated profile cannot be claimed', r.status === 404 && !db.prepare("SELECT 1 FROM user_profile_links WHERE player_submission_id = 'ps-other'").get());
  r = await request('POST', '/api/account/claim-profile', { cookie: claimCookie, body: { player_submission_id: 'ps-claim' } });
  const carl = userByEmail('claimer@example.com');
  check('matching profile can be claimed', r.status === 200 && r.text === '{"ok":true}');
  check('profile link persisted', db.prepare('SELECT player_submission_id FROM user_profile_links WHERE user_id = ?').get(carl.id)?.player_submission_id === 'ps-claim');
  r = await request('GET', '/api/account/profile-candidates', { cookie: claimCookie });
  check('linked user sees linked state, not candidates', r.json.linked === true && r.json.profile.id === 'ps-claim' && r.json.candidates.length === 0 && !/SECRET-/.test(r.text));
  r = await request('GET', '/api/auth/me', { cookie: claimCookie });
  check('/me has_profile true after claim', r.json.has_profile === true);

  const sharedCookie = await login('shared@example.com');
  await request('POST', '/api/account/username', { cookie: sharedCookie, body: { username: 'shared_sam', display_name: 'Sam' } });
  r = await request('GET', '/api/account/profile-candidates', { cookie: sharedCookie });
  check('already-owned profile not offered', r.json.candidates.length === 0);
  r = await request('POST', '/api/account/claim-profile', { cookie: sharedCookie, body: { player_submission_id: 'ps-owned' } });
  check('already-owned profile cannot be claimed (409)', r.status === 409 && db.prepare("SELECT user_id FROM user_profile_links WHERE player_submission_id = 'ps-owned'").get().user_id === unverified.id);

  const multiCookie = await login('multi@example.com');
  await request('POST', '/api/account/username', { cookie: multiCookie, body: { username: 'multi_mo', display_name: 'Mo' } });
  r = await request('GET', '/api/account/profile-candidates', { cookie: multiCookie });
  const multi = userByEmail('multi@example.com');
  check('multiple candidates listed, none auto-selected', r.json.candidates.length === 2 && !db.prepare('SELECT 1 FROM user_profile_links WHERE user_id = ?').get(multi.id));
  r = await request('POST', '/api/account/claim-profile', { cookie: multiCookie, body: {} });
  check('claim without explicit selection rejected (400)', r.status === 400);
  r = await request('POST', '/api/account/claim-profile', { cookie: multiCookie, body: { player_submission_id: 'ps-multi-2' } });
  check('explicitly selected candidate claimed', r.status === 200);
  r = await request('POST', '/api/account/claim-profile', { cookie: multiCookie, body: { player_submission_id: 'ps-multi-1' } });
  check('user cannot claim a second profile (409)', r.status === 409 && !db.prepare("SELECT 1 FROM user_profile_links WHERE player_submission_id = 'ps-multi-1'").get());

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nPages');
  r = await request('GET', '/login');
  check('/login renders', r.status === 200 && r.text.includes('WELCOME TO THE ATM') && r.text.includes('SEND MY CODE') && r.text.includes('CHECK YOUR EMAIL'));
  check('/login accessible inputs', r.text.includes('autocomplete="email"') && r.text.includes('autocomplete="one-time-code"') && r.text.includes('inputmode="numeric"') && r.text.includes('<label for="authEmail">') && r.text.includes('role="status"'));
  check('/login is no-store', r.headers['cache-control'] === 'no-store');
  r = await request('GET', '/login', { cookie: claimCookie });
  check('/login: returning user with linked profile defaults to /community (1C.4)', r.status === 302 && r.headers.location === '/community');
  r = await request('GET', '/login?next=/account', { cookie: claimCookie });
  check('/login: explicit next=/account still respected', r.status === 302 && r.headers.location === '/account');
  r = await request('GET', '/login?next=' + encodeURIComponent('/players/ps-claim-slug'), { cookie: claimCookie });
  check('/login: explicit next=/players/<slug> respected', r.status === 302 && r.headers.location === '/players/ps-claim-slug');
  r = await request('GET', '/login?next=' + encodeURIComponent('/community/post/abc'), { cookie: claimCookie });
  check('/login: explicit next=/community/post/… respected', r.status === 302 && r.headers.location === '/community/post/abc');
  r = await request('GET', '/login?next=' + encodeURIComponent('//evil.example'), { cookie: claimCookie });
  check('/login: unsafe next ignored → default /community', r.status === 302 && r.headers.location === '/community');
  app.resetAuthRateLimits();
  await request('POST', '/api/auth/request-code', { body: { email: 'claimer@example.com' } });
  r = await request('POST', '/api/auth/verify-code', { body: { email: 'claimer@example.com', code: lastCodeFor('claimer@example.com') } });
  check('returning verify → has_profile true, needs_username false (client → /community)', r.status === 200 && r.json.has_profile === true && r.json.needs_username === false);
  r = await request('GET', '/account');
  check('/account redirects unauthenticated → /login', r.status === 302 && r.headers.location === '/login');
  r = await request('GET', '/account/setup');
  check('/account/setup redirects unauthenticated → /login', r.status === 302 && r.headers.location === '/login');
  r = await request('GET', '/account', { cookie: dupCookie });
  check('/account without username → /account/setup', r.status === 302 && r.headers.location === '/account/setup');
  r = await request('GET', '/account/setup', { cookie: dupCookie });
  check('/account/setup renders for user without username', r.status === 200 && r.text.includes('YOUR ATM IDENTITY') && r.text.includes('CREATE MY ATM IDENTITY') && r.headers['cache-control'] === 'no-store');
  r = await request('GET', '/account/setup', { cookie: claimCookie });
  check('/account/setup with username → /account', r.status === 302 && r.headers.location === '/account');
  r = await request('GET', '/account', { cookie: claimCookie });
  check('/account renders linked profile', r.status === 200 && r.text.includes('MY ATM') && r.text.includes('@carl') && r.text.includes('Claimer Carl') && r.text.includes('Your Poker Profile is live.') && r.text.includes('VIEW MY POKER PROFILE') && r.text.includes('href="/players/ps-claim-slug"') && r.text.includes('LOG OUT') && r.text.includes('Join the conversation in The Fish Tank.') && r.text.includes('<a class="atm-btn" href="/community">GO TO THE FISH TANK</a>'));
  check('/account stays My ATM (no redirect to Fish Tank)', r.status === 200 && !r.headers.location);
  check('/account leaks no edit_token and is no-store', !/SECRET-|edit_token/.test(r.text) && r.headers['cache-control'] === 'no-store');
  r = await request('GET', '/account', { cookie: vCookie });
  check('/account with no profile offers CREATE', r.text.includes('CREATE MY POKER PROFILE') && r.text.includes('href="/ai-profile-generator"'));
  const xssCookie = await login('xss@example.com');
  await request('POST', '/api/account/username', { cookie: xssCookie, body: { username: 'xss_x', display_name: 'X' } });
  r = await request('GET', '/account', { cookie: xssCookie });
  check('/account with candidate offers CLAIM (escaped)', r.text.includes('CLAIM MY EXISTING PROFILE') && r.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !r.text.includes('<script>alert(1)'));

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nProfile generator compatibility');
  const genForm = (email, name) => multipart({ name, nickname: '', email, permission: 'yes', city: 'Ledyard' });
  let f = genForm('anon@example.com', 'Anon Andy');
  r = await request('POST', '/request-feature', { rawBody: f.body, contentType: f.contentType });
  const anonUrl = r.json && r.json.profile_url;
  check('unauthenticated generator still works', r.status === 200 && /^\/profile\/setup\/[0-9a-f-]{36}$/.test(anonUrl || ''), r.text);
  r = await request('GET', anonUrl);
  check('edit_token setup URL still works', r.status === 200);
  const anonSubId = db.prepare("SELECT id FROM player_submissions WHERE json_extract(data, '$.email') = 'anon@example.com'").get().id;
  check('unauthenticated submission not linked', !db.prepare('SELECT 1 FROM user_profile_links WHERE player_submission_id = ?').get(anonSubId));

  const genCookie = await login('gen@example.com');
  f = genForm('GEN@example.com', 'Gen Gina');
  r = await request('POST', '/request-feature', { cookie: genCookie, rawBody: f.body, contentType: f.contentType });
  const gen = userByEmail('gen@example.com');
  const genLink = db.prepare('SELECT player_submission_id FROM user_profile_links WHERE user_id = ?').get(gen.id);
  const genSub = genLink && db.prepare('SELECT data FROM player_submissions WHERE id = ?').get(genLink.player_submission_id);
  check('matching signed-in user auto-linked to new profile', r.status === 200 && /^\/profile\/setup\//.test(r.json.profile_url) && genSub && JSON.parse(genSub.data).name === 'Gen Gina', r.text);

  const gen2Cookie = await login('gen2@example.com');
  f = genForm('someone-else@example.com', 'Else Eddie');
  r = await request('POST', '/request-feature', { cookie: gen2Cookie, rawBody: f.body, contentType: f.contentType });
  const gen2 = userByEmail('gen2@example.com');
  check('mismatched email does NOT auto-link', r.status === 200 && !db.prepare('SELECT 1 FROM user_profile_links WHERE user_id = ?').get(gen2.id));
  check('earlier claims survive submissions re-save', db.prepare('SELECT player_submission_id FROM user_profile_links WHERE user_id = ?').get(carl.id)?.player_submission_id === 'ps-claim');

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nLogout');
  const loCookie = await login('logout@example.com');
  const loSess = db.prepare('SELECT * FROM user_sessions WHERE user_id = ?').get(userByEmail('logout@example.com').id);
  r = await request('POST', '/api/auth/logout', { cookie: `${loCookie}; admin_session=keep-me` });
  const loSetCookie = [].concat(r.headers['set-cookie'] || []).join(';');
  check('logout 200 + clears atm_session', r.status === 200 && /atm_session=;/.test(loSetCookie) && /Max-Age=0/.test(loSetCookie));
  check('logout does not touch admin_session', !/admin_session/.test(loSetCookie));
  check('logout revokes DB session', !!db.prepare('SELECT revoked_at FROM user_sessions WHERE id = ?').get(loSess.id).revoked_at);
  r = await request('GET', '/api/auth/me', { cookie: loCookie });
  check('revoked cookie no longer authenticates', r.json.authenticated === false);
  r = await request('POST', '/api/auth/logout', { cookie: loCookie });
  check('repeated logout succeeds', r.status === 200 && r.json.ok === true);
  r = await request('POST', '/api/auth/logout');
  check('logout without cookie succeeds', r.status === 200 && /atm_session=;/.test([].concat(r.headers['set-cookie'] || []).join(';')));

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nAccount-first next (Sprint 1B.4)');
  const GEN = '/ai-profile-generator';
  r = await request('GET', '/login?next=/ai-profile-generator');
  check('/login?next= renders and embeds the safe next', r.status === 200 && r.text.includes('var next = "/ai-profile-generator";'));
  check('verify step: username needed → /account/setup?next=…, else next || (profile ? /community : /account)', r.text.includes("'/account/setup' + (next ? '?next=' + encodeURIComponent(next) : '')") && r.text.includes("(next || (res.data.has_profile ? '/community' : '/account'))"));
  r = await request('GET', '/login');
  check('/login without next embeds next = null (default → /account)', r.status === 200 && r.text.includes('var next = null;'));
  r = await request('GET', '/account/setup?next=/ai-profile-generator');
  check('unauthenticated /account/setup keeps next through /login', r.status === 302 && r.headers.location === '/login?next=%2Fai-profile-generator');
  app.resetAuthRateLimits();
  await request('POST', '/api/auth/request-code', { body: { email: 'nextflow@example.com' } });
  r = await request('POST', '/api/auth/verify-code', { body: { email: 'nextflow@example.com', code: lastCodeFor('nextflow@example.com') } });
  const nextCookie = sessionCookieFrom(r);
  check('new user verify → needs_username (client goes to /account/setup?next=…)', r.status === 200 && r.json.needs_username === true && !JSON.stringify(r.json).includes('ai-profile-generator'));
  r = await request('GET', GEN, { cookie: nextCookie });
  check('verified, no username: generator → /account/setup?next=/ai-profile-generator', r.status === 302 && r.headers.location === '/account/setup?next=/ai-profile-generator');
  r = await request('GET', '/account/setup?next=/ai-profile-generator', { cookie: nextCookie });
  check('/account/setup?next= continues to the generator after username', r.status === 200 && r.text.includes('var done = "/ai-profile-generator";') && r.text.includes('href="/ai-profile-generator">NOT MINE / CONTINUE WITHOUT CLAIMING'));
  r = await request('GET', '/account/setup', { cookie: nextCookie });
  check('/account/setup without next still ends at /account', r.text.includes('var done = "/account";') && r.text.includes('href="/account">NOT MINE'));
  r = await request('POST', '/api/account/username', { cookie: nextCookie, body: { username: 'next_flow', display_name: 'Next Flow' } });
  check('username set', r.status === 200, r.text);
  r = await request('GET', '/account/setup?next=/ai-profile-generator', { cookie: nextCookie });
  check('/account/setup with username + next → generator', r.status === 302 && r.headers.location === GEN);
  r = await request('GET', '/login?next=/ai-profile-generator', { cookie: nextCookie });
  check('signed-in /login?next= → generator', r.status === 302 && r.headers.location === GEN);
  r = await request('GET', '/login', { cookie: nextCookie });
  check('signed-in /login, username but no profile → /account (profile step still offered)', r.status === 302 && r.headers.location === '/account');
  r = await request('GET', GEN, { cookie: nextCookie });
  check('verified + username → AI-first generator', r.status === 200 && r.text.includes('CREATE YOUR POKER IDENTITY') && !r.text.includes('Start My Poker Profile'));
  r = await request('GET', GEN);
  check('logged out generator → /login?next=/ai-profile-generator', r.status === 302 && r.headers.location === '/login?next=/ai-profile-generator');
  const BAD_NEXT = ['//evil.example', '//evil.example/ai-profile-generator', 'https://evil.example', 'http:/evil.example', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', '/\\evil.example', '\\\\evil.example', '/\t/evil.example', '/\n/evil.example', '/.//evil.example', '/a/..//evil.example', 'evil.example', ' /account', ''];
  check('safeLocalNextPath rejects external/malformed destinations', BAD_NEXT.every((n) => app.safeLocalNextPath(n) === null), BAD_NEXT.filter((n) => app.safeLocalNextPath(n) !== null).join(' '));
  check('safeLocalNextPath accepts local paths', app.safeLocalNextPath(GEN) === GEN && app.safeLocalNextPath('/account') === '/account' && app.safeLocalNextPath('/blog?x=1') === '/blog?x=1');
  let badOk = true;
  for (const n of BAD_NEXT.concat(['%2F%2Fevil.example', '%2F%5Cevil.example', '/%09/evil.example'])) {
    const q = /%/.test(n) ? n : encodeURIComponent(n);
    const signedIn = await request('GET', '/login?next=' + q, { cookie: nextCookie });
    const signedOut = await request('GET', '/login?next=' + q);
    const setup = await request('GET', '/account/setup?next=' + q);
    if (signedIn.headers.location !== '/account' || !signedOut.text.includes('var next = null;') || /evil/.test(signedOut.text) || setup.headers.location !== '/login') { badOk = false; console.log('    bad next leaked:', JSON.stringify(n)); }
  }
  check('open-redirect attempts ignored (→ /account, next = null, /login)', badOk);

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nAccount nav');
  const NAV_LABELS = ['Stories', 'Poker Wildlife', 'Fish Tank', 'Shop', 'More', 'Create My ATM'];
  const signInLink = '<li><a href="/login" data-account-nav>Sign In</a></li>';
  const navCookie = await login('nav@example.com');
  const navPages = [
    ['homepage', '/'],
    ['server-rendered layout (/blog)', '/blog'],
    ['shop', '/shop.html'],
  ];
  for (const [label, url] of navPages) {
    // Fetch signed in: the default markup must not depend on auth state.
    r = await request('GET', url, { cookie: navCookie });
    const navHtml = (r.text.match(/<ul class="nav-links" id="navLinks">[\s\S]*?<\/nav>/) || [''])[0];
    check(`${label}: default SIGN IN -> /login inside #navLinks`, r.status === 200 && navHtml.includes(signInLink), r.status);
    check(`${label}: exactly one account nav item`, (r.text.match(/data-account-nav/g) || []).length === 1);
    check(`${label}: account item follows CREATE MY ATM`, navHtml.includes(`<li><a href="/login?next=/ai-profile-generator" class="nav-cta" data-account-cta>Create My ATM</a></li>\n        ${signInLink}`));
    check(`${label}: no GET FEATURED nav CTA`, !/class="nav-cta"[^>]*>Get Featured</.test(navHtml));
    const idx = NAV_LABELS.map((l) => navHtml.indexOf(l === 'More' ? 'id="navMoreBtn"' : `>${l}</a>`));
    check(`${label}: existing nav labels present and in order`, idx.every((n, i) => n >= 0 && (i === 0 || n > idx[i - 1])), idx.join(','));
    check(`${label}: mobile toggle + More menu intact`, /id="navToggle"[^>]*aria-controls="navLinks"/.test(r.text) && r.text.includes('id="navMoreMenu"'));
    check(`${label}: loads /account-nav.js`, r.text.includes('<script src="/account-nav.js" defer></script>'));
    check(`${label}: no account data in markup`, !r.text.includes('nav@example.com') && !r.text.includes(navCookie.split('=')[1]) && !/>My ATM</.test(r.text));
  }
  r = await request('GET', '/account-nav.js');
  check('/account-nav.js served as JavaScript', r.status === 200 && /javascript/.test(r.headers['content-type']));

  // Run account-nav.js against a fake DOM + fetch.
  const vm = require('vm');
  const navSrc = fs.readFileSync(path.join(__dirname, '..', 'account-nav.js'), 'utf8');
  async function runAccountNav(fetchImpl) {
    const makeLink = () => ({ href: '/login', textContent: 'Sign In', setAttribute(k, v) { this[k] = v; } });
    const links = [makeLink(), makeLink()];
    const ctas = [{ href: '/login?next=/ai-profile-generator', textContent: 'Create My ATM', setAttribute(k, v) { this[k] = v; } }];
    const calls = [];
    const errors = [];
    const sandbox = {
      document: { querySelectorAll: (sel) => (sel === '[data-account-nav]' ? links : sel === '[data-account-cta]' ? ctas : []) },
      fetch: (url, opts) => { calls.push({ url, opts }); return fetchImpl(); },
      console: { error: (...a) => errors.push(a), warn: (...a) => errors.push(a), log() {} },
    };
    vm.runInNewContext(navSrc, sandbox);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { links, ctas, calls, errors };
  }
  const jsonRes = (body, okStatus = true) => Promise.resolve({ ok: okStatus, json: async () => body });

  let nav = await runAccountNav(() => jsonRes({ authenticated: true, user: { username: 'x' } }));
  check('enhancement requests /api/auth/me once (same-origin, no-store)', nav.calls.length === 1 && nav.calls[0].url === '/api/auth/me' && nav.calls[0].opts.credentials === 'same-origin' && nav.calls[0].opts.cache === 'no-store');
  check('authenticated -> every account link becomes MY ATM -> /account', nav.links.every((l) => l.textContent === 'My ATM' && l.href === '/account'));
  check('authenticated -> CREATE MY ATM points at /ai-profile-generator', nav.ctas.every((c) => c.textContent === 'Create My ATM' && c.href === '/ai-profile-generator'));
  nav = await runAccountNav(() => jsonRes({ authenticated: false }));
  check('logged out -> SIGN IN -> /login unchanged', nav.links.every((l) => l.textContent === 'Sign In' && l.href === '/login'));
  check('logged out -> CREATE MY ATM -> /login?next=/ai-profile-generator unchanged', nav.ctas.every((c) => c.href === '/login?next=/ai-profile-generator'));
  nav = await runAccountNav(() => Promise.reject(new Error('network down')));
  check('fetch rejection -> SIGN IN unchanged, no console errors', nav.links.every((l) => l.textContent === 'Sign In' && l.href === '/login') && nav.errors.length === 0);
  nav = await runAccountNav(() => jsonRes({ authenticated: true }, false));
  check('non-OK response -> SIGN IN unchanged', nav.links.every((l) => l.textContent === 'Sign In' && l.href === '/login'));
  nav = await runAccountNav(() => Promise.resolve({ ok: true, json: async () => { throw new Error('bad json'); } }));
  check('malformed JSON -> SIGN IN unchanged, no console errors', nav.links.every((l) => l.textContent === 'Sign In' && l.href === '/login') && nav.errors.length === 0);

  // Real /api/auth/me shapes the script keys off.
  r = await request('GET', '/api/auth/me');
  check('/api/auth/me logged out -> authenticated:false', r.json && r.json.authenticated === false);
  r = await request('GET', '/api/auth/me', { cookie: navCookie });
  check('/api/auth/me signed in -> authenticated:true', r.json && r.json.authenticated === true);

  db.close();
}

main()
  .catch((err) => { bad('unexpected error', err && err.stack); })
  .finally(() => {
    try { app.server.close(); } catch {}
    for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) { try { fs.unlinkSync(f); } catch {} }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
