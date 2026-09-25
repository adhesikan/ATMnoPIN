#!/usr/bin/env node
/*
 * User Identity Foundation smoke test.
 *
 * Self-contained: loads server.js as a module (it does not start listening when
 * required) against a throwaway SQLite database, then exercises the identity
 * helpers directly. Never touches data/blog-posts.sqlite and never calls Resend
 * (global fetch is stubbed). No test framework, no deps.
 *
 * Usage:  node scripts/smoke-user-identity.js
 * Exit code 0 = all checks passed, 1 = at least one failure.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `identity-smoke-${Date.now()}.sqlite`);

// Must be set before server.js is required: forces SQLite mode on a temp file.
process.env.SQLITE_DB_FILE = DB_FILE;
delete process.env.DATABASE_URL;
delete process.env.RAILWAY_ENVIRONMENT;
delete process.env.RAILWAY_PROJECT_ID;
delete process.env.RAILWAY_SERVICE_ID;
delete process.env.NODE_ENV;
delete process.env.RESEND_API_KEY;
delete process.env.AUTH_EMAIL_FROM;

const Database = require('better-sqlite3');
const id = require(path.join(__dirname, '..', 'server.js'));

let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`  ✓ ${name}`); }
function bad(name, detail) { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
function check(name, cond, detail) { cond ? ok(name) : bad(name, detail); }
async function rejects(name, fn, code) {
  try { await fn(); bad(name, 'did not throw'); }
  catch (err) { check(name, !code || err.code === code, `got ${err.code}: ${err.message}`); }
}

async function main() {
  console.log(`Identity smoke — temp DB ${DB_FILE}`);

  console.log('\nSchema');
  await id.initializeDatabase();
  await id.initializeDatabase(); // idempotent re-run (existing DB upgrade path)
  const raw = new Database(DB_FILE);
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  for (const t of ['users', 'user_sessions', 'email_verification_codes', 'user_profile_links', 'player_submissions']) {
    check(`table ${t} exists`, tables.includes(t));
  }
  const indexes = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
  check('index on user_sessions.user_id', indexes.includes('idx_user_sessions_user_id'));
  check('index on email_verification_codes.user_id', indexes.includes('idx_email_verification_codes_user_id'));
  const psCols = raw.prepare('PRAGMA table_info(player_submissions)').all().map((c) => c.name).join(',');
  check('player_submissions schema unchanged', psCols === 'id,data,created_at', psCols);

  console.log('\nNormalization');
  check('email trimmed + lowercased', id.normalizeUserEmail('  Foo.Bar+Poker@GMail.COM ') === 'foo.bar+poker@gmail.com');
  check('gmail dots preserved', id.normalizeUserEmail('a.b.c@gmail.com') === 'a.b.c@gmail.com');
  check('plus addressing preserved', id.normalizeUserEmail('x+tag@example.com') === 'x+tag@example.com');
  check('email null-safe', id.normalizeUserEmail(null) === '');
  check('username trimmed + lowercased', id.normalizeUsername('  River_Rat42 ') === 'river_rat42');
  for (const u of ['abc', 'river_rat42', '9lives', 'a'.repeat(24)]) check(`valid username "${u}"`, id.isValidUsername(u));
  for (const u of ['ab', 'a'.repeat(25), '_abc', 'has space', 'dash-name', 'dot.name', 'UPPER', 'emoji😀x', '', null]) {
    check(`invalid username ${JSON.stringify(u)} rejected`, !id.isValidUsername(u));
  }
  check('invalid username not silently fixed', id.normalizeUsername('bad-name!') === 'bad-name!');

  console.log('\nTokens / codes');
  const token = id.createSessionToken();
  const tokenHash = id.hashAuthToken(token);
  check('session token is URL-safe and long', /^[A-Za-z0-9_-]{43}$/.test(token), token.length);
  check('session token differs from stored hash', token !== tokenHash);
  check('hash is 64-char hex', /^[a-f0-9]{64}$/.test(tokenHash));
  check('hash is deterministic', id.hashAuthToken(token) === tokenHash);
  check('known SHA-256 vector', id.hashAuthToken('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  check('session tokens are unique', id.createSessionToken() !== token);
  let codesOk = true;
  for (let i = 0; i < 500; i++) if (!/^\d{6}$/.test(id.createVerificationCode())) codesOk = false;
  check('verification codes are exactly six decimal digits (500 samples)', codesOk);

  console.log('\nUsers');
  const user = await id.createUser({ email: '  Player.One+ATM@Example.COM ', username: 'River_Rat', display_name: 'River Rat' });
  check('user created', !!user && !!user.id);
  check('raw email kept, normalized stored', user.email === 'Player.One+ATM@Example.COM' && user.email_normalized === 'player.one+atm@example.com');
  check('username normalized', user.username === 'River_Rat' && user.username_normalized === 'river_rat');
  check('defaults: status active, trust new, unverified', user.status === 'active' && user.trust_level === 'new' && user.email_verified_at === null);
  check('getUserById', (await id.getUserById(user.id))?.id === user.id);
  check('getUserByNormalizedEmail', (await id.getUserByNormalizedEmail('player.one+atm@example.com'))?.id === user.id);
  check('getUserByNormalizedUsername', (await id.getUserByNormalizedUsername('river_rat'))?.id === user.id);
  check('unknown user lookup returns null', (await id.getUserById('nope')) === null);
  await rejects('duplicate normalized email rejected', () => id.createUser({ email: 'PLAYER.ONE+atm@example.com' }), 'EMAIL_TAKEN');
  await rejects('duplicate normalized username rejected', () => id.createUser({ email: 'other@example.com', username: 'RIVER_RAT' }), 'USERNAME_TAKEN');
  await rejects('invalid username rejected on create', () => id.createUser({ email: 'x@example.com', username: 'no' }), 'INVALID_USERNAME');
  await rejects('invalid email rejected on create', () => id.createUser({ email: 'not-an-email' }), 'INVALID_EMAIL');
  await rejects('invalid status rejected', () => id.createUser({ email: 'y@example.com', status: 'god' }), 'INVALID_STATUS');
  const noName1 = await id.createUser({ email: 'nouser1@example.com' });
  const noName2 = await id.createUser({ email: 'nouser2@example.com' });
  check('multiple users may have NULL username', noName1.username_normalized === null && noName2.username_normalized === null);

  console.log('\nSessions');
  const sess = await id.createUserSession({ userId: user.id, tokenHash });
  check('session created', !!sess && sess.user_id === user.id);
  check('stored token_hash is the hash, not the raw token', sess.token_hash === tokenHash && sess.token_hash !== token);
  check('session expires ~30 days out', Math.abs(new Date(sess.expires_at) - Date.now() - 30 * 86400 * 1000) < 60000);
  const fetched = await id.getUserSessionByTokenHash(id.hashAuthToken(token));
  check('session retrieved by token hash', fetched?.id === sess.id);
  check('session active', id.isUserSessionActive(fetched));
  check('lookup by raw token finds nothing', (await id.getUserSessionByTokenHash(token)) === null);
  await rejects('raw token refused as tokenHash', () => id.createUserSession({ userId: user.id, tokenHash: token }), 'INVALID_SESSION');
  check('revokeUserSession returns true', (await id.revokeUserSession(sess.id)) === true);
  const revoked = await id.getUserSessionByTokenHash(tokenHash);
  check('session revoked_at set', !!revoked.revoked_at);
  check('revoked session inactive', !id.isUserSessionActive(revoked));
  check('second revoke is a no-op', (await id.revokeUserSession(sess.id)) === false);
  const expired = await id.createUserSession({ userId: user.id, tokenHash: id.hashAuthToken(id.createSessionToken()), expiresAt: new Date(Date.now() - 1000) });
  check('expired session inactive', !id.isUserSessionActive(expired));

  console.log('\nEmail verification');
  const code = id.createVerificationCode();
  const ver = await id.createEmailVerification({ userId: user.id, code, purpose: 'signup' });
  check('verification created', !!ver && ver.purpose === 'signup' && ver.attempt_count === 0);
  check('code not stored in plaintext', ver.code_hash !== code && !JSON.stringify(ver).includes(`"${code}"`));
  check('code hash is SHA-256 hex', /^[a-f0-9]{64}$/.test(ver.code_hash));
  check('getEmailVerificationById', (await id.getEmailVerificationById(ver.id))?.id === ver.id);
  check('correct code checks ok', id.checkEmailVerificationCode(ver, code).ok === true);
  const wrong = code === '000000' ? '000001' : '000000';
  check('wrong code rejected', id.checkEmailVerificationCode(ver, wrong).reason === 'mismatch');
  check('attempt count increments to 1', (await id.incrementEmailVerificationAttempts(ver.id)) === 1);
  check('attempt count increments to 2', (await id.incrementEmailVerificationAttempts(ver.id)) === 2);
  check('attempt count persisted', (await id.getEmailVerificationById(ver.id)).attempt_count === 2);
  check('markEmailVerificationUsed returns true', (await id.markEmailVerificationUsed(ver.id)) === true);
  const used = await id.getEmailVerificationById(ver.id);
  check('used_at set', !!used.used_at);
  check('used code no longer checks ok', id.checkEmailVerificationCode(used, code).reason === 'used');
  check('second mark-used is a no-op', (await id.markEmailVerificationUsed(ver.id)) === false);
  await rejects('invalid purpose rejected', () => id.createEmailVerification({ userId: user.id, code, purpose: 'reset' }), 'INVALID_VERIFICATION');
  const exp = await id.createEmailVerification({ userId: user.id, code, purpose: 'login', expiresAt: new Date(Date.now() - 1000) });
  check('expired code rejected', id.checkEmailVerificationCode(exp, code).reason === 'expired');
  check('same code hashes differently per row', exp.code_hash !== ver.code_hash);

  console.log('\nProfile lookup + links');
  const insert = raw.prepare('INSERT INTO player_submissions (id, data) VALUES (?, ?)');
  insert.run('sub-1', JSON.stringify({ id: 'sub-1', name: 'Player One', nickname: 'P1', slug: 'player-one', email: ' Player.One+ATM@example.com ', status: 'approved', edit_token: 'SECRET-EDIT-TOKEN-1' }));
  insert.run('sub-2', JSON.stringify({ id: 'sub-2', name: 'Someone Else', nickname: '', slug: 'someone-else', email: 'else@example.com', status: 'pending', edit_token: 'SECRET-EDIT-TOKEN-2' }));
  insert.run('sub-3', JSON.stringify({ id: 'sub-3', name: 'Dotless', slug: 'dotless', email: 'playerone+atm@example.com', status: 'pending', edit_token: 'SECRET-EDIT-TOKEN-3' }));
  const matches = await id.findPlayerSubmissionsByNormalizedEmail('player.one+atm@example.com');
  check('lookup finds the matching profile (case/whitespace-insensitive)', matches.length === 1 && matches[0].id === 'sub-1', JSON.stringify(matches));
  check('lookup does not collapse gmail-style dots', !matches.some((m) => m.id === 'sub-3'));
  check('lookup returns only identifying fields', matches[0] && Object.keys(matches[0]).sort().join(',') === 'email,id,name,nickname,slug,status');
  check('lookup does not return edit_token', !JSON.stringify(matches).includes('SECRET-EDIT-TOKEN') && !('edit_token' in (matches[0] || {})));
  check('lookup with empty email returns []', (await id.findPlayerSubmissionsByNormalizedEmail('')).length === 0);

  const link = await id.createUserProfileLink(user.id, 'sub-1');
  check('profile link created', link?.user_id === user.id && link.player_submission_id === 'sub-1');
  check('getUserProfileLink', (await id.getUserProfileLink(user.id))?.player_submission_id === 'sub-1');
  check('getProfileOwnerLink', (await id.getProfileOwnerLink('sub-1'))?.user_id === user.id);
  await rejects('duplicate profile ownership rejected', () => id.createUserProfileLink(noName1.id, 'sub-1'), 'PROFILE_LINK_EXISTS');
  await rejects('user cannot link a second profile', () => id.createUserProfileLink(user.id, 'sub-2'), 'PROFILE_LINK_EXISTS');
  const subAfter = JSON.parse(raw.prepare("SELECT data FROM player_submissions WHERE id = 'sub-1'").get().data);
  check('player_submissions row untouched by linking', subAfter.edit_token === 'SECRET-EDIT-TOKEN-1' && !('user_id' in subAfter));

  console.log('\nCookies');
  const devCookie = id.buildUserSessionCookie(token);
  check('cookie name atm_session', devCookie.startsWith(`atm_session=${token};`));
  check('cookie HttpOnly', /; HttpOnly(;|$)/.test(devCookie));
  check('cookie SameSite=Lax', /; SameSite=Lax(;|$)/.test(devCookie));
  check('cookie Path=/', /; Path=\/(;|$)/.test(devCookie));
  check('cookie Max-Age = 30 days', /; Max-Age=2592000(;|$)/.test(devCookie));
  check('development cookie has no Secure', !/Secure/.test(devCookie));
  process.env.NODE_ENV = 'production';
  const prodCookie = id.buildUserSessionCookie(token);
  const prodLogout = id.buildUserSessionLogoutCookie();
  delete process.env.NODE_ENV;
  check('production cookie has Secure', /; Secure(;|$)/.test(prodCookie));
  check('production logout cookie has Secure', /; Secure(;|$)/.test(prodLogout));
  const logout = id.buildUserSessionLogoutCookie();
  check('logout cookie clears atm_session', logout.startsWith('atm_session=;'));
  check('logout cookie Max-Age=0 + past Expires', /; Max-Age=0(;|$)/.test(logout) && /Expires=Thu, 01 Jan 1970/.test(logout));
  check('logout cookie keeps Path=/ and HttpOnly', /; Path=\/(;|$)/.test(logout) && /HttpOnly/.test(logout));
  await rejects('cookie refuses header-injection token', () => id.buildUserSessionCookie('abc;\r\nSet-Cookie: x=y' + 'a'.repeat(30)), 'INVALID_SESSION');

  console.log('\nVerification email (fetch stubbed — no network)');
  const realFetch = global.fetch;
  let fetchCalls = [];
  global.fetch = async (url, opts) => { fetchCalls.push({ url, opts }); return { ok: true, status: 200, json: async () => ({ id: 'email_123', extra: 'provider-data' }) }; };
  await rejects('missing RESEND_API_KEY → controlled error', () => id.sendVerificationEmail({ email: 'a@example.com', code: '123456', purpose: 'signup' }), 'EMAIL_NOT_CONFIGURED');
  process.env.RESEND_API_KEY = 're_test_SUPERSECRET';
  await rejects('missing AUTH_EMAIL_FROM → controlled error', () => id.sendVerificationEmail({ email: 'a@example.com', code: '123456', purpose: 'signup' }), 'EMAIL_NOT_CONFIGURED');
  check('no request made while unconfigured', fetchCalls.length === 0);
  process.env.AUTH_EMAIL_FROM = 'ATMNOPIN <auth@example.com>';
  const sent = await id.sendVerificationEmail({ email: ' A@Example.com ', code: '012345', purpose: 'login' });
  check('returns small success result', sent.ok === true && sent.id === 'email_123' && Object.keys(sent).length === 2);
  const call = fetchCalls[0];
  const body = call ? JSON.parse(call.opts.body) : {};
  check('POSTs to Resend emails API', call && call.url === 'https://api.resend.com/emails' && call.opts.method === 'POST');
  check('Bearer auth header', call && call.opts.headers.Authorization === 'Bearer re_test_SUPERSECRET');
  check('email includes code + expiry + brand', body.to?.[0] === 'a@example.com' && body.html.includes('012345') && body.text.includes('012345') && /expires in \d+ minutes/.test(body.text) && body.html.includes('ATMwithNoPIN'));
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  try {
    await id.sendVerificationEmail({ email: 'a@example.com', code: '123456', purpose: 'signup' });
    bad('provider error surfaces', 'did not throw');
  } catch (err) {
    check('provider error is controlled', err.code === 'EMAIL_SEND_FAILED');
    check('error does not leak API key or code', !err.message.includes('SUPERSECRET') && !err.message.includes('123456'));
  }
  global.fetch = realFetch;
  delete process.env.RESEND_API_KEY;
  delete process.env.AUTH_EMAIL_FROM;

  raw.close();
}

main()
  .catch((err) => { bad('unexpected error', err && err.stack); })
  .finally(() => {
    for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) { try { fs.unlinkSync(f); } catch {} }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
