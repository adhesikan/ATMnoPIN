#!/usr/bin/env node
/*
 * The Fish Tank branding + ATM Accounts admin + Fish Tank moderation smoke
 * test (Sprint 1C.3).
 *
 * Self-contained: loads server.js as a module against a throwaway SQLite
 * database, listens on an ephemeral port, logs in through the real
 * /api/admin/login with test-only credentials, and drives /community,
 * /api/community/* and /api/admin/users* / /api/admin/community/* over HTTP.
 * User sessions are minted directly with the identity helpers; global fetch is
 * stubbed so nothing leaves the machine. Never touches data/blog-posts.sqlite.
 *
 * Usage:  node scripts/smoke-admin-accounts.js
 * Exit code 0 = all checks passed, 1 = at least one failure.
 */

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_FILE = path.join(os.tmpdir(), `admin-accounts-smoke-${Date.now()}.sqlite`);
const ADMIN_EMAIL = 'smoke-admin@atmwithnopin.com';
const ADMIN_PASSWORD = 'smoke-admin-pass-123';

process.env.SQLITE_DB_FILE = DB_FILE;
process.env.ADMIN_EMAIL = ADMIN_EMAIL;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
process.env.ADMIN_PASSWORD_HASH = '';
process.env.RESEND_API_KEY = 're_smoke_test_key';
process.env.AUTH_EMAIL_FROM = 'ATM <login@example.com>';
delete process.env.DATABASE_URL;
delete process.env.RAILWAY_ENVIRONMENT;
delete process.env.RAILWAY_PROJECT_ID;
delete process.env.RAILWAY_SERVICE_ID;
delete process.env.NODE_ENV;
delete process.env.OPENAI_API_KEY;

// No real network. Resend calls are recorded so we can prove suspended /
// banned accounts never get a login code.
const resendCalls = [];
global.fetch = async (url, opts = {}) => {
  if (String(url).includes('api.resend.com')) {
    resendCalls.push(JSON.parse(opts.body || '{}'));
    return { ok: true, status: 200, json: async () => ({ id: 'email_smoke' }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const Database = require('better-sqlite3');
const app = require(path.join(__dirname, '..', 'server.js'));

let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`  ✓ ${name}`); }
function bad(name, detail) { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
function check(name, cond, detail) { cond ? ok(name) : bad(name, detail); }

let BASE = '';
function request(method, urlPath, { cookie, body, rawBody, contentType } = {}) {
  return new Promise((resolve, reject) => {
    const data = rawBody != null ? rawBody : body !== undefined ? JSON.stringify(body) : null;
    const headers = {};
    if (data != null || contentType) headers['Content-Type'] = contentType || 'application/json';
    if (data != null) headers['Content-Length'] = Buffer.byteLength(data);
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

async function makeSession(userId) {
  const token = app.createSessionToken();
  const tokenHash = app.hashAuthToken(token);
  await app.createUserSession({ userId, tokenHash });
  return { token, tokenHash, cookie: `${app.USER_SESSION_COOKIE}=${token}` };
}

async function makeUser(email, { username = null, display_name = '', verified = true } = {}) {
  const user = await app.createUser({ email, username, display_name, email_verified_at: verified ? new Date().toISOString() : null });
  const s = await makeSession(user.id);
  return { user, ...s };
}

const me = async (cookie) => (await request('GET', '/api/auth/me', { cookie })).json;
const isAuthed = async (cookie) => { const j = await me(cookie); return !!(j && j.authenticated); };

async function main() {
  console.log(`Admin accounts smoke — temp DB ${DB_FILE}`);
  await app.initializeDatabase();
  await app.seedCommunityChannels();
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  BASE = `http://127.0.0.1:${app.server.address().port}`;
  const db = new Database(DB_FILE);
  const countRows = () => ({
    users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    sessions: db.prepare('SELECT COUNT(*) AS n FROM user_sessions').get().n,
    posts: db.prepare('SELECT COUNT(*) AS n FROM community_posts').get().n,
    replies: db.prepare('SELECT COUNT(*) AS n FROM community_replies').get().n,
    likes: db.prepare('SELECT COUNT(*) AS n FROM community_likes').get().n,
  });

  // ── Fixtures ──
  const algo = await makeUser('algo.fish@example.com', { username: 'AlgoFish', display_name: 'Algo Fish' });
  const algo2 = await makeSession(algo.user.id);
  const bob = await makeUser('bob.shark@example.com', { username: 'BobShark', display_name: 'Bob the Shark' });
  const carol = await makeUser('carol@example.com', { username: 'CarolWhale', display_name: 'Carol' });
  const unverified = await makeUser('newbie@example.com', { verified: false });
  // Linked approved Poker Profile for AlgoFish (edit_token must never leak).
  const profile = { id: crypto.randomUUID(), name: 'Algo Person', nickname: 'Algo', slug: 'algo-fish-a1b2c3', status: 'approved', email: 'algo.fish@example.com', photo_url: 'https://res.cloudinary.com/demo/image/upload/v1/algo.jpg', edit_token: 'EDITTOKEN_ADMIN_SMOKE_SECRET' };
  db.prepare('INSERT INTO player_submissions (id, data, created_at) VALUES (?, ?, ?)').run(profile.id, JSON.stringify(profile), new Date().toISOString());
  await app.createUserProfileLink(algo.user.id, profile.id);
  // A verification row (its hash must never leak).
  const verification = await app.createEmailVerification({ userId: algo.user.id, code: '123456', purpose: 'login' });

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nFish Tank branding');
  let r = await request('GET', '/community');
  check('/community route still 200', r.status === 200, String(r.status));
  check('page shows THE FISH TANK heading', r.text.includes('<h1>The Fish Tank</h1>') && !r.text.includes('<h1>Community</h1>'));
  check('Table Talk tagline present', r.text.includes('Table Talk from ATMwithNoPIN.'));
  check('secondary "What\'s happening at the table?" kept', r.text.includes("What's happening at the table?"));
  check('SEO title', r.text.includes('<title>The Fish Tank — Poker Table Talk | ATMwithNoPIN</title>'), (r.text.match(/<title>[^<]*<\/title>/) || [''])[0]);
  check('SEO description', r.text.includes('content="Join The Fish Tank, the ATMwithNoPIN poker community for table talk, cash games, tournaments, hand discussions and Poker Wildlife."'));
  check('canonical stays /community', r.text.includes('/community" />') && !r.text.includes('/fish-tank'));
  check('nav label Fish Tank → /community', r.text.includes('<li><a href="/community">Fish Tank</a></li>'));
  check('logged-out invite: JOIN THE FISH TANK + CREATE MY ATM / SIGN IN', r.text.includes('Join The Fish Tank') && r.text.includes('Create your ATM identity and join the table talk.') && r.text.includes('>Create My ATM</a>') && r.text.includes('>Sign In</a>'));
  check('channels unchanged', ['General Poker', 'Cash Games', 'Tournaments', 'Hand Talk', 'Poker Wildlife'].every((c) => r.text.includes(`>${c}</a>`)));
  check('Community Guidelines + Community Wall labels kept', r.text.includes('>Community Guidelines</a>') && r.text.includes('<a href="/community-wall">Community Wall</a>'));
  r = await request('GET', '/community-wall');
  check('Community Wall unchanged', r.status === 200 && r.text.includes('<h1>Community Wall</h1>'));
  r = await request('GET', '/fish-tank');
  check('no /fish-tank route', r.status === 404, String(r.status));
  r = await request('GET', '/blog');
  check('shared layout nav shows Fish Tank', r.text.includes('<li><a href="/community">Fish Tank</a></li>') && !r.text.includes('<li><a href="/community">Community</a></li>'));
  const idx = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const shop = fs.readFileSync(path.join(__dirname, '..', 'shop.html'), 'utf8');
  check('index.html + shop.html nav Fish Tank → /community', idx.includes('<li><a href="/community">Fish Tank</a></li>') && shop.includes('<li><a href="/community">Fish Tank</a></li>'));
  r = await request('GET', '/account', { cookie: carol.cookie });
  check('My ATM: Fish Tank copy + GO TO THE FISH TANK → /community', r.text.includes('Join the conversation in The Fish Tank.') && r.text.includes('<a class="atm-btn" href="/community">GO TO THE FISH TANK</a>'));

  // ── Community APIs unchanged: post / reply / like ──
  r = await request('GET', '/api/community/channels');
  check('GET /api/community/channels unchanged', r.status === 200 && Array.isArray(r.json.channels) && r.json.channels.length === 5);
  r = await request('POST', '/api/community/posts', { cookie: algo.cookie, body: { channel: 'general', body: 'AlgoFish post one' } });
  const p1 = r.json && r.json.post;
  check('posting works', r.status === 201 && p1 && p1.id, `${r.status} ${r.text}`);
  r = await request('POST', '/api/community/posts', { cookie: algo.cookie, body: { channel: 'hand-talk', body: 'AlgoFish post two' } });
  const p2 = r.json && r.json.post;
  r = await request('POST', '/api/community/posts', { cookie: bob.cookie, body: { channel: 'general', body: 'Bob unrelated post' } });
  const bobPost = r.json && r.json.post;
  r = await request('POST', `/api/community/posts/${p1.id}/replies`, { cookie: bob.cookie, body: { body: 'Bob replies to Algo' } });
  const bobReply = r.json && r.json.reply;
  check('replies work', r.status === 201 && bobReply && bobReply.id, `${r.status} ${r.text}`);
  r = await request('POST', `/api/community/posts/${bobPost.id}/replies`, { cookie: algo.cookie, body: { body: 'Algo replies to Bob' } });
  const algoReply = r.json && r.json.reply;
  r = await request('POST', `/api/community/posts/${p1.id}/replies`, { cookie: carol.cookie, body: { body: 'Carol replies to Algo' } });
  const carolReply = r.json && r.json.reply;
  r = await request('POST', `/api/community/posts/${p1.id}/like`, { cookie: bob.cookie, body: {} });
  check('likes work', r.status === 200 && r.json.liked === true && r.json.like_count === 1);
  await request('POST', `/api/community/posts/${bobPost.id}/like`, { cookie: algo.cookie, body: {} });
  await request('POST', `/api/community/posts/${p1.id}/like`, { cookie: algo.cookie, body: {} });

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nAuthorization');
  const anyId = algo.user.id;
  const endpoints = [
    ['GET', '/api/admin/users'],
    ['GET', `/api/admin/users/${anyId}`],
    ['POST', `/api/admin/users/${anyId}/status`, { status: 'suspended' }],
    ['POST', `/api/admin/users/${anyId}/revoke-sessions`, {}],
    ['POST', `/api/admin/community/posts/${bobPost.id}/remove`, {}],
    ['POST', `/api/admin/community/replies/${bobReply.id}/remove`, {}],
  ];
  let allAnon = true, allUser = true, allForged = true;
  for (const [m, u, b] of endpoints) {
    const a = await request(m, u, { body: b });
    if (a.status !== 401) { allAnon = false; console.log('    anon', m, u, a.status); }
    const n = await request(m, u, { body: b, cookie: bob.cookie });
    if (n.status !== 401) { allUser = false; console.log('    user', m, u, n.status); }
    const f = await request(m, u, { body: b, cookie: 'admin_session=' + crypto.randomUUID() });
    if (f.status !== 401) { allForged = false; console.log('    forged', m, u, f.status); }
  }
  check('all new admin endpoints reject anonymous requests (401)', allAnon);
  check('normal signed-in user cannot use admin endpoints (401)', allUser);
  check('forged admin_session rejected (401)', allForged);
  check('no status change / moderation happened via non-admin calls',
    (await app.getUserById(anyId)).status === 'active'
    && db.prepare('SELECT deleted_at FROM community_posts WHERE id = ?').get(bobPost.id).deleted_at === null
    && db.prepare('SELECT deleted_at FROM community_replies WHERE id = ?').get(bobReply.id).deleted_at === null
    && await isAuthed(algo.cookie));
  r = await request('POST', `/api/community/posts/${bobPost.id}/remove`, { cookie: algo.cookie, body: {} });
  check('no user-facing remove endpoint for another user\'s post', r.status === 404 && db.prepare('SELECT deleted_at FROM community_posts WHERE id = ?').get(bobPost.id).deleted_at === null, String(r.status));

  r = await request('POST', '/api/admin/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  const adminCookie = ((r.headers['set-cookie'] || [])[0] || '').split(';')[0];
  check('admin login (existing flow) works', r.status === 200 && /^admin_session=/.test(adminCookie));
  r = await request('GET', '/admin', { cookie: adminCookie });
  check('/admin shows ATM Accounts tab + panel', r.status === 200 && r.text.includes('data-panel="accountsPanel">ATM Accounts</button>') && r.text.includes('id="accountsPanel"'));
  check('existing admin tabs intact', ['blogPanel', 'chronPanel', 'wildlifePanel', 'communityPanel', 'visitorsPanel', 'consentPanel'].every((p) => r.text.includes(`data-panel="${p}"`)));
  check('admin UI uses Fish Tank labels', r.text.includes('Fish Tank Activity') && r.text.includes('Recent Fish Tank posts') && r.text.includes('Recent Fish Tank replies'));
  check('admin UI has confirmation copy', r.text.includes('This immediately signs the user out and prevents new sign-ins until the account is reactivated.') && r.text.includes('Suspend Account') && r.text.includes('Ban Account'));

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nAccount list');
  const A = (m, u, body) => request(m, u, { cookie: adminCookie, body });
  const FORBIDDEN_KEYS = /email_normalized|username_normalized|token_hash|code_hash|edit_token|EDITTOKEN_|password|"token"/;
  r = await A('GET', '/api/admin/users');
  check('GET /api/admin/users 200 no-store', r.status === 200 && r.headers['cache-control'] === 'no-store' && r.json.ok === true, `${r.status} ${r.text.slice(0, 200)}`);
  const listed = r.json.users || [];
  check('lists all accounts, newest first', listed.length === 4 && listed[0].id === unverified.user.id && listed[3].id === algo.user.id, listed.map((u) => u.username).join());
  const algoRow = listed.find((u) => u.id === algo.user.id) || {};
  check('safe field set exactly', JSON.stringify(Object.keys(algoRow).sort()) === JSON.stringify(['active_session_count', 'avatar_type', 'avatar_wildlife_slug', 'created_at', 'display_name', 'email', 'email_verified_at', 'id', 'last_login_at', 'like_count', 'linked_profile', 'post_count', 'reply_count', 'status', 'trust_level', 'updated_at', 'username'].sort()), Object.keys(algoRow).join());
  check('email visible to admin', algoRow.email === 'algo.fish@example.com');
  check('no *_normalized / token_hash / code hashes / edit_token in list', !FORBIDDEN_KEYS.test(r.text) && !r.text.includes(algo.tokenHash) && !r.text.includes(algo.token) && !r.text.includes(verification.code_hash));
  check('list counts: posts 2 / replies 1 / likes 2 / sessions 2', algoRow.post_count === 2 && algoRow.reply_count === 1 && algoRow.like_count === 2 && algoRow.active_session_count === 2, JSON.stringify(algoRow));
  check('linked profile summary + public url', algoRow.linked_profile && algoRow.linked_profile.status === 'approved' && algoRow.linked_profile.public_url === '/players/algo-fish-a1b2c3' && algoRow.linked_profile.has_photo === true && !('id' in algoRow.linked_profile));
  check('unverified account shows username not set (null)', listed[0].username === null && listed[0].email_verified_at === null);
  const s = r.json.summary;
  check('summary metrics', s && s.total === 4 && s.active === 4 && s.suspended === 0 && s.banned === 0 && s.verified === 3 && s.new_last_7_days === 4, JSON.stringify(s));
  r = await A('GET', '/api/admin/users?limit=5000');
  check('limit clamped to 100', r.json.limit === 100);
  r = await A('GET', '/api/admin/users?limit=2&offset=1');
  check('pagination: limit 2 offset 1', r.json.users.length === 2 && r.json.offset === 1 && r.json.total === 4 && r.json.users[0].id === carol.user.id);
  r = await A('GET', '/api/admin/users?q=%40algofish');
  check('search @username (case-insensitive)', r.json.users.length === 1 && r.json.users[0].id === algo.user.id && r.json.total === 1);
  r = await A('GET', '/api/admin/users?q=the%20shark');
  check('search display name', r.json.users.length === 1 && r.json.users[0].id === bob.user.id);
  r = await A('GET', '/api/admin/users?q=newbie%40');
  check('search email', r.json.users.length === 1 && r.json.users[0].id === unverified.user.id);
  r = await A('GET', '/api/admin/users?q=%25');
  check('search treats % literally (no wildcard)', r.json.users.length === 0);
  r = await A('GET', '/api/admin/users?q=' + encodeURIComponent("' OR 1=1 --"));
  check('SQL-ish search is inert', r.status === 200 && r.json.users.length === 0);
  r = await A('GET', '/api/admin/users?verified=no');
  check('verified filter: unverified', r.json.users.length === 1 && r.json.users[0].id === unverified.user.id);
  r = await A('GET', '/api/admin/users?verified=yes');
  check('verified filter: verified', r.json.users.length === 3);
  r = await A('GET', '/api/admin/users?status=bogus');
  check('invalid status filter → 400', r.status === 400);

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nAccount detail');
  r = await A('GET', `/api/admin/users/${algo.user.id}`);
  const d = r.json || {};
  check('detail 200', r.status === 200 && d.ok && d.user && d.user.id === algo.user.id, `${r.status}`);
  check('detail counts + active sessions', d.user.post_count === 2 && d.user.reply_count === 1 && d.user.like_count === 2 && d.security.active_session_count === 2);
  check('detail security has latest activity only', typeof d.security.last_session_activity_at === 'string' && JSON.stringify(Object.keys(d.security).sort()) === '["active_session_count","last_session_activity_at"]');
  check('detail recent posts (newest first) with view urls', d.recent_posts.length === 2 && d.recent_posts[0].id === p2.id && d.recent_posts[0].public_url === `/community/post/${p2.id}` && d.recent_posts[1].like_count === 2 && d.recent_posts[1].reply_count === 2);
  check('detail recent replies with view url', d.recent_replies.length === 1 && d.recent_replies[0].id === algoReply.id && d.recent_replies[0].public_url === `/community/post/${bobPost.id}#replies`);
  check('detail leaks no secrets', !FORBIDDEN_KEYS.test(r.text) && ![algo.token, algo.tokenHash, algo2.token, algo2.tokenHash, verification.id, verification.code_hash, profile.id].some((x) => r.text.includes(x)));
  const sessionIds = db.prepare('SELECT id FROM user_sessions WHERE user_id = ?').all(algo.user.id).map((x) => x.id);
  check('detail leaks no session ids', sessionIds.every((sid) => !r.text.includes(sid)));
  r = await A('GET', `/api/admin/users/${crypto.randomUUID()}`);
  check('unknown user → 404', r.status === 404);
  r = await A('GET', '/api/admin/users/not-a-uuid');
  check('malformed id → 404', r.status === 404);

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nStatus + sessions');
  const before = countRows();
  r = await A('POST', `/api/admin/users/${algo.user.id}/status`, { status: 'deleted' });
  check('invalid status rejected (400)', r.status === 400 && (await app.getUserById(algo.user.id)).status === 'active');
  r = await A('POST', `/api/admin/users/${algo.user.id}/status`, { status: 'active' });
  check('same status → 409', r.status === 409);
  r = await A('POST', `/api/admin/users/${crypto.randomUUID()}/status`, { status: 'suspended' });
  check('nonexistent user rejected (404)', r.status === 404);
  r = await request('POST', `/api/admin/users/${algo.user.id}/status`, { cookie: adminCookie, rawBody: 'status=suspended', contentType: 'application/x-www-form-urlencoded' });
  check('non-JSON status POST rejected (400)', r.status === 400 && (await app.getUserById(algo.user.id)).status === 'active');
  const updatedBefore = (await app.getUserById(algo.user.id)).updated_at;
  await new Promise((res) => setTimeout(res, 5));
  check('AlgoFish authenticated on both sessions before suspension', await isAuthed(algo.cookie) && await isAuthed(algo2.cookie));
  r = await A('POST', `/api/admin/users/${algo.user.id}/status`, { status: 'suspended' });
  check('active → suspended', r.status === 200 && r.json.previous_status === 'active' && r.json.status === 'suspended' && r.json.sessions_revoked === 2, r.text);
  let row = await app.getUserById(algo.user.id);
  check('status stored + updated_at bumped', row.status === 'suspended' && row.updated_at > updatedBefore);
  check('suspension revoked all sessions (rows kept)', db.prepare('SELECT COUNT(*) AS n FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL').get(algo.user.id).n === 0 && countRows().sessions === before.sessions);
  check('revoked session cannot authenticate', !(await isAuthed(algo.cookie)) && !(await isAuthed(algo2.cookie)));
  r = await request('POST', '/api/community/posts', { cookie: algo.cookie, body: { channel: 'general', body: 'should fail' } });
  check('suspended user cannot post (401)', r.status === 401);
  // Even a fresh session for a suspended user is rejected (status check).
  const fresh = await makeSession(algo.user.id);
  check('fresh session for suspended user rejected', !(await isAuthed(fresh.cookie)));
  resendCalls.length = 0;
  app.resetAuthRateLimits();
  r = await request('POST', '/api/auth/request-code', { body: { email: 'algo.fish@example.com' } });
  const generic = r.json && JSON.stringify(r.json);
  check('suspended: request-code generic 200, no email sent', r.status === 200 && resendCalls.length === 0, `${r.status} ${generic} calls=${resendCalls.length}`);
  r = await A('GET', `/api/admin/users/${algo.user.id}`);
  check('suspended detail: only the post-suspension test session counts', r.json.security.active_session_count === 1);
  r = await A('POST', `/api/admin/users/${algo.user.id}/status`, { status: 'active' });
  check('suspended → active', r.status === 200 && r.json.previous_status === 'suspended' && r.json.status === 'active' && r.json.sessions_revoked === 0);
  check('old sessions stay revoked after reactivation', !(await isAuthed(algo.cookie)));
  resendCalls.length = 0;
  app.resetAuthRateLimits();
  r = await request('POST', '/api/auth/request-code', { body: { email: 'algo.fish@example.com' } });
  check('reactivated: login code is sent again', r.status === 200 && resendCalls.length === 1);
  const algo3 = await makeSession(algo.user.id);
  check('reactivated user can authenticate with a new session', await isAuthed(algo3.cookie));

  // explicit revoke sessions (account stays active)
  const bob2 = await makeSession(bob.user.id);
  r = await A('POST', `/api/admin/users/${bob.user.id}/revoke-sessions`, {});
  check('revoke sessions → 200, count reported', r.status === 200 && r.json.sessions_revoked === 2, r.text);
  check('revoked sessions cannot authenticate', !(await isAuthed(bob.cookie)) && !(await isAuthed(bob2.cookie)));
  check('account stays active after revoke', (await app.getUserById(bob.user.id)).status === 'active');
  r = await A('POST', `/api/admin/users/${bob.user.id}/revoke-sessions`, {});
  check('revoke is idempotent (0 newly revoked)', r.status === 200 && r.json.sessions_revoked === 0);
  r = await A('POST', `/api/admin/users/${crypto.randomUUID()}/revoke-sessions`, {});
  check('revoke for unknown user → 404', r.status === 404);
  check('other users\' sessions untouched', await isAuthed(carol.cookie) && await isAuthed(algo3.cookie));

  // active → banned, banned → only reactivate
  r = await A('POST', `/api/admin/users/${carol.user.id}/status`, { status: 'banned' });
  check('active → banned revokes sessions', r.status === 200 && r.json.status === 'banned' && r.json.sessions_revoked === 1 && !(await isAuthed(carol.cookie)));
  resendCalls.length = 0;
  app.resetAuthRateLimits();
  r = await request('POST', '/api/auth/request-code', { body: { email: 'carol@example.com' } });
  check('banned: request-code generic 200, no email sent', r.status === 200 && resendCalls.length === 0);
  r = await A('POST', `/api/admin/users/${carol.user.id}/status`, { status: 'suspended' });
  check('banned → suspended not allowed (409)', r.status === 409 && (await app.getUserById(carol.user.id)).status === 'banned');
  r = await A('GET', '/api/admin/users?status=banned');
  check('status filter: banned', r.json.users.length === 1 && r.json.users[0].id === carol.user.id && r.json.summary.banned === 1);
  r = await A('POST', `/api/admin/users/${carol.user.id}/status`, { status: 'active' });
  check('banned → active', r.status === 200 && r.json.status === 'active');
  r = await A('POST', `/api/admin/users/${bob.user.id}/status`, { status: 'suspended' });
  r = await A('POST', `/api/admin/users/${bob.user.id}/status`, { status: 'banned' });
  check('suspended → banned', r.status === 200 && r.json.previous_status === 'suspended' && r.json.status === 'banned');
  r = await A('GET', '/api/admin/users?status=suspended');
  check('status filter: suspended (none now)', r.status === 200 && r.json.users.length === 0);
  await A('POST', `/api/admin/users/${bob.user.id}/status`, { status: 'active' });
  const bob3 = await makeSession(bob.user.id);
  check('no users / sessions deleted by status changes', countRows().users === before.users && db.prepare('SELECT COUNT(*) AS n FROM user_sessions').get().n === before.sessions + 4); // fresh, algo3, bob2, bob3
  check('email + username never changed', (await app.getUserById(algo.user.id)).email === 'algo.fish@example.com' && (await app.getUserById(algo.user.id)).username === 'AlgoFish');

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nFish Tank moderation');
  const pre = countRows();
  r = await A('POST', `/api/admin/community/posts/${p1.id}/remove`, {});
  check('admin soft-deletes post', r.status === 200 && r.json.ok && r.json.type === 'post' && r.json.removed === true && r.json.already_removed === false, r.text);
  const p1Row = db.prepare('SELECT * FROM community_posts WHERE id = ?').get(p1.id);
  check('post row remains with deleted_at + body intact', p1Row && typeof p1Row.deleted_at === 'string' && p1Row.body === 'AlgoFish post one');
  r = await request('GET', '/community');
  check('removed post gone from /community feed', !r.text.includes('AlgoFish post one') && r.text.includes('AlgoFish post two') && r.text.includes('Bob unrelated post'));
  r = await request('GET', '/api/community/posts');
  check('removed post gone from feed API', r.json.posts.every((p) => p.id !== p1.id) && r.json.posts.length === 2);
  r = await request('GET', `/community/post/${p1.id}`);
  check('removed post detail page 404', r.status === 404);
  r = await request('GET', `/api/community/posts/${p1.id}`);
  check('removed post detail API 404', r.status === 404);
  r = await request('POST', `/api/community/posts/${p1.id}/replies`, { cookie: bob3.cookie, body: { body: 'late reply' } });
  check('cannot reply to removed post', r.status === 404);
  const post = countRows();
  check('replies + likes of removed post kept (no cascade)', post.replies === pre.replies && post.likes === pre.likes && db.prepare('SELECT COUNT(*) AS n FROM community_replies WHERE post_id = ? AND deleted_at IS NULL').get(p1.id).n === 2 && db.prepare('SELECT COUNT(*) AS n FROM community_likes WHERE post_id = ?').get(p1.id).n === 2);
  check('no rows physically deleted', post.posts === pre.posts);
  r = await A('POST', `/api/admin/community/posts/${p1.id}/remove`, {});
  check('removing again is idempotent (already_removed)', r.status === 200 && r.json.already_removed === true);
  r = await A('GET', `/api/admin/users/${algo.user.id}`);
  check('detail activity refreshed after removal', r.json.user.post_count === 1 && r.json.recent_posts.length === 1 && r.json.recent_posts[0].id === p2.id);
  r = await A('GET', `/api/admin/users/${bob.user.id}`);
  check('reply on removed post shows no view link', r.json.recent_replies.length === 1 && r.json.recent_replies[0].public_url === null);

  r = await A('POST', `/api/admin/community/replies/${algoReply.id}/remove`, {});
  check('admin soft-deletes reply', r.status === 200 && r.json.type === 'reply' && r.json.removed === true && r.json.already_removed === false);
  const rRow = db.prepare('SELECT * FROM community_replies WHERE id = ?').get(algoReply.id);
  check('reply row remains with deleted_at', rRow && typeof rRow.deleted_at === 'string' && rRow.body === 'Algo replies to Bob');
  r = await request('GET', `/community/post/${bobPost.id}`);
  check('removed reply disappears; parent post stays', r.status === 200 && !r.text.includes('Algo replies to Bob') && r.text.includes('Bob unrelated post'));
  r = await request('GET', `/api/community/posts/${bobPost.id}`);
  check('reply count excludes removed reply', r.json.post.reply_count === 0 && r.json.replies.length === 0);
  check('unrelated content intact', db.prepare('SELECT COUNT(*) AS n FROM community_posts WHERE deleted_at IS NULL').get().n === 2 && db.prepare('SELECT deleted_at FROM community_replies WHERE id = ?').get(carolReply.id).deleted_at === null);
  check('no rows physically deleted by reply removal', countRows().replies === pre.replies);
  r = await A('POST', `/api/admin/community/posts/${crypto.randomUUID()}/remove`, {});
  check('unknown post → 404', r.status === 404);
  r = await A('POST', '/api/admin/community/replies/not-a-uuid/remove', {});
  check('malformed reply id → 404', r.status === 404);
  r = await A('GET', `/api/admin/community/posts/${p2.id}/remove`);
  check('GET on remove endpoint → 405', r.status === 405);
  r = await request('POST', `/api/admin/community/posts/${p2.id}/remove`, { cookie: adminCookie, rawBody: 'x', contentType: 'text/plain' });
  check('non-JSON remove rejected (400)', r.status === 400 && db.prepare('SELECT deleted_at FROM community_posts WHERE id = ?').get(p2.id).deleted_at === null);
  r = await request('POST', '/api/community/posts', { cookie: bob3.cookie, body: { channel: 'general', body: 'Community still works after moderation' } });
  check('posting still works after moderation', r.status === 201);

  // ── Admin session logout ends access ──
  await request('POST', '/api/admin/logout', { cookie: adminCookie });
  r = await A('GET', '/api/admin/users');
  check('after admin logout, admin API rejected', r.status === 401);

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
