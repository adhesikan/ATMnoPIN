#!/usr/bin/env node
/*
 * Community smoke test (Sprint 1C.1).
 *
 * Self-contained: loads server.js as a module against a throwaway SQLite
 * database, listens on an ephemeral port, and drives /community,
 * /community/post/<id> and /api/community/* over HTTP. Sessions are minted
 * directly with the identity helpers (no email round-trip); global fetch is
 * stubbed so nothing leaves the machine. Never touches data/blog-posts.sqlite.
 *
 * Usage:  node scripts/smoke-community.js
 * Exit code 0 = all checks passed, 1 = at least one failure.
 */

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_FILE = path.join(os.tmpdir(), `community-smoke-${Date.now()}.sqlite`);

process.env.SQLITE_DB_FILE = DB_FILE;
delete process.env.DATABASE_URL;
delete process.env.RAILWAY_ENVIRONMENT;
delete process.env.RAILWAY_PROJECT_ID;
delete process.env.RAILWAY_SERVICE_ID;
delete process.env.NODE_ENV;
delete process.env.OPENAI_API_KEY;
delete process.env.RESEND_API_KEY;

// No real network: geo lookups etc. get an inert response.
global.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });

const Database = require('better-sqlite3');

// Pre-1C.2 users table (no avatar columns) with one existing account, so the
// additive avatar migration is exercised against a legacy row.
const LEGACY_USER_ID = crypto.randomUUID();
{
  const legacy = new Database(DB_FILE);
  legacy.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL, email_normalized TEXT NOT NULL UNIQUE, username TEXT,
    username_normalized TEXT UNIQUE, display_name TEXT NOT NULL DEFAULT '', email_verified_at TEXT,
    status TEXT NOT NULL DEFAULT 'active', trust_level TEXT NOT NULL DEFAULT 'new',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_login_at TEXT)`);
  legacy.prepare("INSERT INTO users (id, email, email_normalized, username, username_normalized, display_name, email_verified_at) VALUES (?, 'legacy@example.com', 'legacy@example.com', 'OldTimer', 'oldtimer', 'Old Timer', ?)")
    .run(LEGACY_USER_ID, new Date().toISOString());
  legacy.close();
}

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

// Creates a user + live atm_session; returns { user, cookie, token, tokenHash }.
async function makeUser(email, { username = null, display_name = '', verified = true, status = 'active' } = {}) {
  const user = await app.createUser({ email, username, display_name, status, email_verified_at: verified ? new Date().toISOString() : null });
  const token = app.createSessionToken();
  const tokenHash = app.hashAuthToken(token);
  await app.createUserSession({ userId: user.id, tokenHash });
  return { user, token, tokenHash, cookie: `${app.USER_SESSION_COOKIE}=${token}` };
}

const post = (cookie, body) => request('POST', '/api/community/posts', { cookie, body });
const reply = (cookie, id, body) => request('POST', `/api/community/posts/${id}/replies`, { cookie, body });
const like = (cookie, id) => request('POST', `/api/community/posts/${id}/like`, { cookie, body: {} });

async function main() {
  console.log(`Community smoke — temp DB ${DB_FILE}`);
  await app.initializeDatabase();
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  BASE = `http://127.0.0.1:${app.server.address().port}`;
  const db = new Database(DB_FILE);

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nDatabase');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
  check('community tables exist', ['community_channels', 'community_posts', 'community_replies', 'community_likes'].every((t) => tables.includes(t)), tables.join(','));
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_community_%'").all().map((i) => i.name);
  check('community indexes exist', ['idx_community_posts_created', 'idx_community_posts_channel_created', 'idx_community_posts_user_created', 'idx_community_replies_post_created'].every((i) => indexes.includes(i)), indexes.join(','));
  const firstSeed = await app.seedCommunityChannels();
  check('first seed inserts 5 channels', firstSeed === 5, String(firstSeed));
  const secondSeed = await app.seedCommunityChannels();
  check('second seed inserts nothing (idempotent)', secondSeed === 0 && db.prepare('SELECT COUNT(*) AS n FROM community_channels').get().n === 5);
  const slugs = db.prepare('SELECT slug, name FROM community_channels ORDER BY display_order').all();
  check('five official channels in order', slugs.map((c) => c.slug).join() === 'general,cash-games,tournaments,hand-talk,poker-wildlife' && slugs[0].name === 'General Poker', JSON.stringify(slugs));
  db.prepare("UPDATE community_channels SET name = 'Hand Talk (edited)', description = 'admin edit' WHERE slug = 'hand-talk'").run();
  await app.seedCommunityChannels();
  const edited = db.prepare("SELECT name, description FROM community_channels WHERE slug = 'hand-talk'").get();
  check('re-seed does not overwrite an edited channel', edited.name === 'Hand Talk (edited)' && edited.description === 'admin edit');
  db.prepare("UPDATE community_channels SET name = 'Hand Talk', description = 'Break down a hand and ask the table.' WHERE slug = 'hand-talk'").run();
  const userCols = db.prepare('PRAGMA table_info(users)').all();
  const avCol = userCols.find((c) => c.name === 'avatar_type');
  check('users gains avatar_type (NOT NULL DEFAULT default) + avatar_wildlife_slug', avCol && avCol.notnull === 1 && /default/.test(avCol.dflt_value) && userCols.some((c) => c.name === 'avatar_wildlife_slug'), JSON.stringify(userCols.map((c) => c.name)));
  const legacyRow = db.prepare('SELECT username, avatar_type, avatar_wildlife_slug FROM users WHERE id = ?').get(LEGACY_USER_ID);
  check('existing (pre-migration) user defaults to avatar default / null slug', legacyRow && legacyRow.username === 'OldTimer' && legacyRow.avatar_type === 'default' && legacyRow.avatar_wildlife_slug === null, JSON.stringify(legacyRow));
  await app.initializeDatabase();
  check('avatar migration is idempotent (re-run ok, no duplicate columns)', db.prepare('PRAGMA table_info(users)').all().filter((c) => c.name.startsWith('avatar_')).length === 2);
  check('seeded channel ids are unique uuids', new Set(db.prepare('SELECT id FROM community_channels').all().map((r) => r.id)).size === 5);

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nPublic (logged out)');
  let r = await request('GET', '/community');
  check('GET /community → 200', r.status === 200, String(r.status));
  check('page is no-store HTML', r.headers['cache-control'] === 'no-store' && /text\/html/.test(r.headers['content-type']));
  check('header + subhead render', r.text.includes('<h1>Community</h1>') && r.text.includes("What's happening at the table?"));
  check('logged out: invitation instead of composer', r.text.includes('Join the conversation.') && r.text.includes('Create My ATM') && r.text.includes('/login?next=%2Fcommunity') && !r.text.includes('<textarea') && !r.text.includes('data-cm-form="'));
  check('channel tabs render (ALL + 5)', ['>All<', '>General Poker<', '>Cash Games<', '>Tournaments<', '>Hand Talk<', '>Poker Wildlife<'].every((t) => r.text.includes(t)) && r.text.includes('href="/community?channel=cash-games"'));
  check('ALL tab is current by default', /href="\/community" aria-current="page">All</.test(r.text));
  check('tabs scroll horizontally, not the page', /\.cm-tabs \{[^}]*overflow-x: auto/.test(r.text));
  check('empty feed renders safely', r.text.includes('No posts yet. Start the conversation.'));
  check('Community Guidelines link present', r.text.includes('href="/community-guidelines"'));
  check('shared nav Community → /community', r.text.includes('<li><a href="/community">Community</a></li>') && !r.text.includes('<li><a href="/community-wall">Community</a></li>'));
  r = await request('GET', '/community?channel=tournaments');
  check('channel filter page renders with tab current', r.status === 200 && /href="\/community\?channel=tournaments" aria-current="page"/.test(r.text) && r.text.includes('No posts in Tournaments yet.'));
  r = await request('GET', '/community?channel=nope');
  check('unknown channel falls back to ALL', r.status === 200 && /href="\/community" aria-current="page">All</.test(r.text));
  r = await request('GET', '/api/community/channels');
  check('GET /api/community/channels', r.status === 200 && r.json.channels.length === 5 && r.headers['cache-control'] === 'no-store' && /application\/json/.test(r.headers['content-type']));
  check('channels API exposes no internal ids', r.json.channels.every((c) => Object.keys(c).sort().join() === 'description,name,slug'));
  r = await request('GET', '/api/community/posts');
  check('GET /api/community/posts empty', r.status === 200 && Array.isArray(r.json.posts) && r.json.posts.length === 0);
  r = await request('GET', '/api/community/posts?channel=bogus');
  check('unknown channel on API → 400', r.status === 400);

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nAuth');
  const alice = await makeUser('Alice.Private@Example.com', { username: 'AceAlice', display_name: 'Alice Aces' });
  const bob = await makeUser('bob.secret@example.com', { username: 'bob_nuts', display_name: 'bob_nuts' });
  const carol = await makeUser('carol@example.com', { username: 'carol_pending', display_name: 'Carol' });
  const noName = await makeUser('noname@example.com');
  const suspended = await makeUser('sus@example.com', { username: 'sus_player', status: 'suspended' });
  const banned = await makeUser('ban@example.com', { username: 'ban_player', status: 'banned' });

  r = await request('GET', '/community', { cookie: alice.cookie });
  check('verified @username user sees composer', r.text.includes('data-cm-form="/api/community/posts"') && r.text.includes('placeholder="What\'s happening at the table?"') && r.text.includes('0/500') && r.text.includes('>Post</button>') && !r.text.includes('Join the conversation.'));
  check('composer shows handle + guidelines link', r.text.includes('Posting as @AceAlice') && r.text.includes('href="/community-guidelines"'));
  r = await request('GET', '/community', { cookie: noName.cookie });
  check('verified w/o username sees Finish Account Setup', r.text.includes('Finish Account Setup') && r.text.includes('/account/setup?next=%2Fcommunity') && !r.text.includes('<textarea'));
  r = await post(null, { channel: 'general', body: 'hi' });
  check('logged out cannot post (401 JSON)', r.status === 401 && r.json && r.json.code === 'auth_required' && r.headers['cache-control'] === 'no-store');
  r = await post(noName.cookie, { channel: 'general', body: 'hi' });
  check('no username cannot post (403 setup_required)', r.status === 403 && r.json.code === 'setup_required' && r.json.setup_url === '/account/setup?next=/community');
  r = await post(suspended.cookie, { channel: 'general', body: 'hi' });
  check('suspended user cannot post', r.status === 401 || r.status === 403, String(r.status));
  r = await post(banned.cookie, { channel: 'general', body: 'hi' });
  check('banned user cannot post', r.status === 401 || r.status === 403, String(r.status));
  r = await request('GET', '/community', { cookie: suspended.cookie });
  check('suspended user sees no composer', !r.text.includes('<textarea'));
  r = await post(`${app.USER_SESSION_COOKIE}=not-a-real-token-aaaaaaaaaaaaaaaaaaaa`, { channel: 'general', body: 'hi' });
  check('bogus session cannot post', r.status === 401);
  check('no posts written by rejected users', db.prepare('SELECT COUNT(*) AS n FROM community_posts').get().n === 0);

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nPosts');
  app.resetAuthRateLimits();
  r = await post(alice.cookie, { channel: 'general', body: '  First hand of the night — flopped a set.  ' });
  check('valid post → 201', r.status === 201 && r.json.ok === true, r.text);
  const p1 = r.json.post;
  check('post body trimmed', p1.body === 'First hand of the night — flopped a set.');
  check('post shape is public-only', Object.keys(p1).sort().join() === 'author,body,channel,created_at,id,like_count,liked_by_me,reply_count' && Object.keys(p1.author).sort().join() === 'avatar,display_name,profile_url,username' && Object.keys(p1.author.avatar).sort().join() === 'initial,species_name,type,url');
  r = await post(alice.cookie, { channel: 'general', body: '   \n\t ' });
  check('empty/whitespace rejected (400)', r.status === 400);
  r = await post(alice.cookie, { channel: 'general' });
  check('missing body rejected (400)', r.status === 400);
  r = await post(alice.cookie, { channel: 'general', body: 'x'.repeat(501) });
  check('>500 chars rejected (400)', r.status === 400);
  r = await post(alice.cookie, { channel: 'general', body: '♠'.repeat(500) });
  check('exactly 500 (multi-byte) accepted', r.status === 201, r.text);
  r = await post(alice.cookie, { channel: 'nope', body: 'hello' });
  check('invalid channel rejected (400)', r.status === 400);
  r = await post(alice.cookie, { channel: 'all', body: 'hello' });
  check('"all" is not a postable channel', r.status === 400);
  r = await request('POST', '/api/community/posts', { cookie: alice.cookie, rawBody: 'channel=general&body=hi', contentType: 'application/x-www-form-urlencoded' });
  check('non-JSON body rejected (400)', r.status === 400);
  r = await request('POST', '/api/community/posts', { cookie: alice.cookie, rawBody: JSON.stringify({ channel: 'general', body: 'a'.repeat(9000) }) });
  check('oversized request body rejected (413)', r.status === 413);
  r = await post(alice.cookie, { channel: 'cash-games', body: 'Spoofed identity attempt', user_id: bob.user.id, username: 'bob_nuts', author: { username: 'bob_nuts' }, created_at: '2001-01-01T00:00:00.000Z', id: '11111111-1111-1111-1111-111111111111' });
  const spoof = r.json && r.json.post;
  const spoofRow = spoof && db.prepare('SELECT * FROM community_posts WHERE id = ?').get(spoof.id);
  check('identity from session, not payload', r.status === 201 && spoof.author.username === 'AceAlice' && spoofRow.user_id === alice.user.id && spoof.id !== '11111111-1111-1111-1111-111111111111' && !spoof.created_at.startsWith('2001'));
  r = await post(bob.cookie, { channel: 'hand-talk', body: '<script>alert("x")</script><b>bold</b> & <img src=x onerror=alert(1)>' });
  const xss = r.json.post;
  check('HTML post stored as text', r.status === 201 && xss.body.includes('<script>'));
  r = await post(bob.cookie, { channel: 'tournaments', body: 'Bubble boy again. Newest post.' });
  const newest = r.json.post;

  r = await request('GET', '/community');
  check('HTML content escaped on feed', !r.text.includes('<script>alert("x")</script>') && !r.text.includes('<img src=x') && r.text.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&lt;b&gt;bold&lt;/b&gt; &amp; &lt;img src=x onerror=alert(1)&gt;'));
  r = await request('GET', `/community/post/${xss.id}`);
  check('HTML content escaped on post page', r.status === 200 && !r.text.includes('<script>alert("x")</script>') && r.text.includes('&lt;script&gt;'));
  r = await request('GET', '/api/community/posts');
  const allIds = r.json.posts.map((p) => p.id);
  check('posts appear in ALL', [p1.id, spoof.id, xss.id, newest.id].every((id) => allIds.includes(id)));
  check('newest-first ordering', allIds[0] === newest.id && allIds[1] === xss.id && allIds[allIds.length - 1] === p1.id, allIds.join(','));
  const times = r.json.posts.map((p) => p.created_at);
  check('created_at strictly descending', times.every((t, i) => i === 0 || times[i - 1] > t));
  r = await request('GET', '/api/community/posts?channel=cash-games');
  check('channel filter (API)', r.json.posts.length === 1 && r.json.posts[0].id === spoof.id);
  r = await request('GET', '/community?channel=hand-talk');
  check('channel filter (page)', r.text.includes(`/community/post/${xss.id}`) && !r.text.includes(`/community/post/${p1.id}`) && !r.text.includes(`/community/post/${newest.id}`));
  r = await request('GET', '/api/community/posts?limit=2');
  check('limit param respected', r.json.posts.length === 2);
  r = await request('GET', '/api/community/posts?limit=9999');
  check('limit capped', r.json.posts.length <= 50);
  r = await request('GET', '/community');
  check('feed card links to /community/post/<id>', r.text.includes(`href="/community/post/${p1.id}"`) && r.text.includes('class="cm-body"'));
  check('feed shows @username + display name + channel', r.text.includes('@AceAlice') && r.text.includes('Alice Aces') && r.text.includes('>Cash Games</a>'));
  check('display name hidden when same as handle', !r.text.includes('<span class="cm-name">bob_nuts</span>'));
  check('compact timestamp rendered', /<time datetime="[^"]+"[^>]*>now<\/time>/.test(r.text));

  // Rate limit: 10 successful posts / hour, failed attempts don't count.
  app.resetAuthRateLimits();
  const rl = await makeUser('ratelimit@example.com', { username: 'rate_limited' });
  await post(rl.cookie, { channel: 'bogus', body: 'not counted' });
  await post(rl.cookie, { channel: 'general', body: '' });
  let okCount = 0;
  for (let i = 0; i < 10; i++) { if ((await post(rl.cookie, { channel: 'general', body: `rl ${i}` })).status === 201) okCount++; }
  r = await post(rl.cookie, { channel: 'general', body: 'eleventh' });
  check('post limit: 10 succeed, 11th → 429 (failures not counted)', okCount === 10 && r.status === 429, `${okCount} / ${r.status}`);
  db.prepare('DELETE FROM community_posts WHERE user_id = ?').run(rl.user.id);
  app.resetAuthRateLimits();

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nReplies');
  r = await reply(bob.cookie, p1.id, { body: '  Nice hand!  ' });
  check('valid reply → 201', r.status === 201 && r.json.reply.body === 'Nice hand!' && r.json.reply.post_id === p1.id && r.json.reply.author.username === 'bob_nuts', r.text);
  const r1 = r.json.reply;
  r = await reply(alice.cookie, p1.id, { body: 'Thanks — rivered quads too.', parent_reply_id: r1.id, post_id: xss.id, user_id: bob.user.id });
  const r2 = r.json.reply;
  const r2Row = db.prepare('SELECT * FROM community_replies WHERE id = ?').get(r2.id);
  check('reply ignores parent/post/user fields in payload', r.status === 201 && r2.post_id === p1.id && r2Row.user_id === alice.user.id && !('parent_reply_id' in r2Row));
  r = await reply(alice.cookie, p1.id, { body: '' });
  check('empty reply rejected (400)', r.status === 400);
  r = await reply(alice.cookie, p1.id, { body: 'y'.repeat(501) });
  check('>500 reply rejected (400)', r.status === 400);
  r = await reply(alice.cookie, crypto.randomUUID(), { body: 'hello?' });
  check('reply to nonexistent post → 404', r.status === 404);
  r = await reply(alice.cookie, 'not-a-uuid', { body: 'hello?' });
  check('reply to malformed id → 404', r.status === 404);
  r = await reply(alice.cookie, r1.id, { body: 'nested?' });
  check('no nested replies (reply id is not a post) → 404', r.status === 404);
  r = await reply(null, p1.id, { body: 'anon' });
  check('logged-out reply → 401', r.status === 401);
  r = await reply(noName.cookie, p1.id, { body: 'no name' });
  check('no-username reply → 403', r.status === 403);
  r = await request('GET', `/api/community/posts/${p1.id}`);
  check('replies oldest-first', r.status === 200 && r.json.replies.map((x) => x.id).join() === `${r1.id},${r2.id}` && r.json.post.reply_count === 2);
  r = await request('GET', `/community/post/${p1.id}`);
  check('post page renders post + replies in order', r.status === 200 && r.text.indexOf('Nice hand!') < r.text.indexOf('rivered quads') && r.text.includes('id="replies"'));
  check('logged-out post page: invite, no reply composer', r.text.includes('Join the conversation.') && !r.text.includes('<textarea') && r.text.includes('/login?next=%2Fcommunity%2Fpost%2F'));
  r = await request('GET', `/community/post/${p1.id}`, { cookie: bob.cookie });
  check('signed-in post page has reply composer', r.text.includes(`data-cm-form="/api/community/posts/${p1.id}/replies"`) && r.text.includes('Post your reply'));
  r = await request('GET', '/community');
  check('feed shows reply count', new RegExp(`href="/community/post/${p1.id}#replies"[^>]*>💬 2<`).test(r.text));
  r = await request('GET', '/community/post/not-a-uuid');
  check('malformed post page → 404', r.status === 404);

  // Soft-deleted content never surfaces.
  const doomed = (await post(bob.cookie, { channel: 'general', body: 'I will be moderated' })).json.post;
  const doomedReply = (await reply(alice.cookie, p1.id, { body: 'this reply gets removed' })).json.reply;
  db.prepare('UPDATE community_posts SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), doomed.id);
  db.prepare('UPDATE community_replies SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), doomedReply.id);
  r = await request('GET', '/api/community/posts');
  check('deleted post hidden from feed API', !r.json.posts.some((p) => p.id === doomed.id));
  r = await request('GET', '/community');
  check('deleted post hidden from feed page', !r.text.includes('I will be moderated'));
  r = await request('GET', `/api/community/posts/${doomed.id}`);
  check('deleted post detail API → 404', r.status === 404);
  r = await request('GET', `/community/post/${doomed.id}`);
  check('deleted post page → 404', r.status === 404);
  r = await reply(alice.cookie, doomed.id, { body: 'too late' });
  check('reply to deleted post → 404', r.status === 404);
  r = await like(alice.cookie, doomed.id);
  check('like deleted post → 404', r.status === 404);
  r = await request('GET', `/api/community/posts/${p1.id}`);
  check('deleted reply hidden + not counted', !r.json.replies.some((x) => x.id === doomedReply.id) && r.json.post.reply_count === 2);

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nLikes');
  r = await like(bob.cookie, p1.id);
  check('like → liked, count 1', r.status === 200 && r.json.liked === true && r.json.like_count === 1, r.text);
  r = await like(bob.cookie, p1.id);
  check('second call unlikes, count 0', r.status === 200 && r.json.liked === false && r.json.like_count === 0);
  await like(bob.cookie, p1.id);
  r = await like(alice.cookie, p1.id);
  check('two users → count 2', r.json.liked === true && r.json.like_count === 2);
  let dup = null;
  try { db.prepare('INSERT INTO community_likes (post_id, user_id, created_at) VALUES (?, ?, ?)').run(p1.id, bob.user.id, new Date().toISOString()); } catch (e) { dup = e; }
  check('duplicate like row impossible (PK)', dup && /UNIQUE|PRIMARY/.test(String(dup.code || dup.message)));
  check('exactly one like row per user', db.prepare('SELECT COUNT(*) AS n FROM community_likes WHERE post_id = ? AND user_id = ?').get(p1.id, bob.user.id).n === 1);
  r = await request('GET', '/api/community/posts', { cookie: bob.cookie });
  const p1ForBob = r.json.posts.find((p) => p.id === p1.id);
  check('liked_by_me true for liker', p1ForBob.liked_by_me === true && p1ForBob.like_count === 2);
  r = await request('GET', '/api/community/posts');
  check('liked_by_me false when logged out', r.json.posts.find((p) => p.id === p1.id).liked_by_me === false);
  r = await request('GET', '/community', { cookie: bob.cookie });
  check('liked state rendered on page', new RegExp(`class="cm-like is-liked" data-like="${p1.id}" aria-pressed="true"`).test(r.text));
  r = await like(null, p1.id);
  check('logged-out like → 401', r.status === 401);
  r = await like(noName.cookie, p1.id);
  check('no-username like → 403', r.status === 403);
  r = await like(bob.cookie, crypto.randomUUID());
  check('like nonexistent post → 404', r.status === 404);
  r = await request('POST', `/api/community/posts/${p1.id}/like`, { cookie: bob.cookie, rawBody: '', contentType: 'text/plain' });
  check('like requires JSON content type', r.status === 400);

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nProfile links');
  const approved = { id: crypto.randomUUID(), name: 'Alice Aces', nickname: 'Ace', slug: 'ace-alice-1a2b3c', status: 'approved', email: 'alice.private@example.com', edit_token: 'EDITTOKEN_SHOULD_NEVER_LEAK_123', admin_notes: 'ADMIN_NOTE_SHOULD_NEVER_LEAK' };
  const pending = { id: crypto.randomUUID(), name: 'Carol', nickname: 'Pending', slug: 'carol-pending-9f9f9f', status: 'pending', email: 'carol@example.com', edit_token: 'EDITTOKEN_PENDING_SECRET_456', admin_notes: 'PENDING_ADMIN_NOTE' };
  db.prepare('INSERT INTO player_submissions (id, data) VALUES (?, ?)').run(approved.id, JSON.stringify(approved));
  db.prepare('INSERT INTO player_submissions (id, data) VALUES (?, ?)').run(pending.id, JSON.stringify(pending));
  await app.createUserProfileLink(alice.user.id, approved.id);
  await app.createUserProfileLink(carol.user.id, pending.id);
  const carolPost = (await post(carol.cookie, { channel: 'general', body: 'Pending profile, still posting.' })).json.post;
  r = await request('GET', '/api/community/posts');
  const byUser = (u) => r.json.posts.find((p) => p.author.username === u);
  check('approved linked profile → /players/<slug>', byUser('AceAlice').author.profile_url === '/players/ace-alice-1a2b3c');
  check('user without profile → profile_url null', byUser('bob_nuts').author.profile_url === null);
  check('pending profile not linked', carolPost.author.profile_url === null && byUser('carol_pending').author.profile_url === null);
  r = await request('GET', '/community');
  check('page links approved author', r.text.includes('<a class="cm-author" href="/players/ace-alice-1a2b3c">'));
  check('page renders plain handle without profile', r.text.includes('<span class="cm-author"><span class="cm-handle">@bob_nuts</span></span>'));
  check('page never links pending profile', !r.text.includes('carol-pending-9f9f9f') && r.text.includes('@carol_pending'));
  r = await request('GET', '/players/ace-alice-1a2b3c');
  check('existing /players/<slug> still works', r.status === 200 && r.text.includes('<title>Ace | ATMNOPIN™ Community</title>'), String(r.status));
  r = await request('GET', '/players/carol-pending-9f9f9f');
  check('pending profile page still 404', r.status === 404);


  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nAvatars (Sprint 1C.2)');
  const setAvatar = (cookie, body) => request('POST', '/api/account/avatar', { cookie, body });
  const psData = (id) => JSON.parse(db.prepare('SELECT data FROM player_submissions WHERE id = ?').get(id).data);
  const userAv = (u) => db.prepare('SELECT avatar_type, avatar_wildlife_slug FROM users WHERE id = ?').get(u.user.id);
  const feedAuthor = async (username) => (await request('GET', '/api/community/posts')).json.posts.find((p) => p.author.username === username).author;
  const addSpecies = (sp) => db.prepare('INSERT INTO wildlife_species (id, data) VALUES (?, ?)').run(sp.id, JSON.stringify(sp));
  const SHARK_IMG = 'https://res.cloudinary.com/demo/image/upload/v1/wildlife/shark.jpg';
  const shark = { id: crypto.randomUUID(), slug: 'avatar-shark', name: 'The Test Shark', status: 'published', image_url: SHARK_IMG, display_order: 1 };
  const noImg = { id: crypto.randomUUID(), slug: 'avatar-whale', name: 'The Imageless Whale', status: 'published', image_url: '', display_order: 2 };
  const draft = { id: crypto.randomUUID(), slug: 'avatar-draft-fish', name: 'The Draft Fish', status: 'draft', image_url: 'https://res.cloudinary.com/demo/image/upload/v1/wildlife/fish.jpg', display_order: 3 };
  const evil = { id: crypto.randomUUID(), slug: 'avatar-evil', name: 'The <b>Evil</b> Owl', status: 'published', image_url: 'javascript:alert(1)', display_order: 4 };
  const local = { id: crypto.randomUUID(), slug: 'avatar-local-cat', name: 'The Local Cat', status: 'published', image_url: '/uploads/local-cat.png', display_order: 5 };
  [shark, noImg, draft, evil, local].forEach(addSpecies);

  // Resolver (pure).
  const res0 = app.resolveAtmAvatar(null, { displayName: 'alice aces', username: 'x' });
  check('resolver: default → initial from display name', res0.type === 'default' && res0.url === null && res0.initial === 'A');
  check('resolver: initial falls back to username, then "A"', app.resolveAtmAvatar({}, { displayName: '  ', username: 'zed' }).initial === 'Z' && app.resolveAtmAvatar({}, {}).initial === 'A');
  check('resolver: profile_photo without photo → default', app.resolveAtmAvatar({ avatar_type: 'profile_photo', avatar_photo_url: '' }).type === 'default');
  check('resolver: unsafe URLs → default', ['javascript:alert(1)', 'http://x.test/a.jpg', 'https://x.test/a".jpg', '//evil.test/a.jpg', 'data:image/png;base64,AA'].every((u) => app.resolveAtmAvatar({ avatar_type: 'profile_photo', avatar_photo_url: u }).type === 'default'));
  check('resolver: unknown type → default', app.resolveAtmAvatar({ avatar_type: 'url', avatar_photo_url: SHARK_IMG, avatar_wildlife_image_url: SHARK_IMG }).type === 'default');

  // Defaults.
  const fresh = await makeUser('fresh.avatar@example.com', { username: 'fresh_face', display_name: 'Fresh Face' });
  check('new user defaults to avatar default / null slug', userAv(fresh).avatar_type === 'default' && userAv(fresh).avatar_wildlife_slug === null);
  r = await post(fresh.cookie, { channel: 'general', body: 'Default avatar here.' });
  check('user with no Poker Profile can still post (default avatar)', r.status === 201 && r.json.post.author.avatar.type === 'default' && r.json.post.author.avatar.initial === 'F' && r.json.post.author.profile_url === null);
  r = await request('GET', '/api/community/posts');
  const bobAuthor0 = r.json.posts.find((p) => p.author.username === 'bob_nuts').author;
  check('default avatar in feed API (no url, initial)', bobAuthor0.avatar.type === 'default' && bobAuthor0.avatar.url === null && bobAuthor0.avatar.initial === 'B');

  // Auth / validation.
  r = await setAvatar(null, { avatar_type: 'default' });
  check('unauthenticated avatar update → 401', r.status === 401 && r.headers['cache-control'] === 'no-store');
  r = await request('POST', '/api/account/avatar', { cookie: bob.cookie, rawBody: 'avatar_type=default', contentType: 'application/x-www-form-urlencoded' });
  check('avatar update requires JSON', r.status === 400);
  r = await setAvatar(suspended.cookie, { avatar_type: 'default' });
  check('suspended user cannot update avatar', r.status === 401);
  r = await setAvatar(bob.cookie, { avatar_type: 'url', avatar_url: 'https://evil.test/me.jpg' });
  check('invalid avatar_type rejected', r.status === 400);
  r = await setAvatar(bob.cookie, { avatar_type: 'custom', url: 'https://evil.test/me.jpg' });
  check('arbitrary custom-URL avatar rejected', r.status === 400);
  r = await setAvatar(bob.cookie, { avatar_type: 'profile_photo' });
  check('profile_photo without a linked profile → 400', r.status === 400 && userAv(bob).avatar_type === 'default');
  r = await setAvatar(alice.cookie, { avatar_type: 'profile_photo' });
  check('profile_photo with linked profile but no photo → 400', r.status === 400 && userAv(alice).avatar_type === 'default');
  for (const [label, slug] of [['draft', draft.slug], ['no-image', noImg.slug], ['unsafe-image', evil.slug], ['nonexistent', 'avatar-nope'], ['malformed', '../../etc'], ['non-string', 42]]) {
    r = await setAvatar(bob.cookie, { avatar_type: 'wildlife', wildlife_slug: slug });
    check(`wildlife ${label} species rejected`, r.status === 400 && userAv(bob).avatar_type === 'default', `${r.status}`);
  }

  // Profile photo.
  const ALICE_PHOTO = 'https://res.cloudinary.com/demo/image/upload/v1/profiles/alice.jpg';
  db.prepare('UPDATE player_submissions SET data = ? WHERE id = ?').run(JSON.stringify({ ...psData(approved.id), photo_url: ALICE_PHOTO }), approved.id);
  r = await setAvatar(alice.cookie, { avatar_type: 'profile_photo', avatar_url: 'https://evil.test/x.jpg', user_id: bob.user.id });
  check('profile_photo with linked photo → 200', r.status === 200 && r.json.avatar.type === 'profile_photo' && r.json.avatar.url === ALICE_PHOTO, r.text);
  check('response avatar shape is public-only', Object.keys(r.json).sort().join() === 'avatar,ok' && Object.keys(r.json.avatar).sort().join() === 'initial,species_name,type,url');
  check('browser-supplied user_id ignored (bob unchanged)', userAv(bob).avatar_type === 'default' && userAv(alice).avatar_type === 'profile_photo');
  check('feed resolves profile photo', (await feedAuthor('AceAlice')).avatar.url === ALICE_PHOTO);
  const alicePhotoRow = db.prepare('SELECT avatar_type, avatar_wildlife_slug FROM users WHERE id = ?').get(alice.user.id);
  check('users row stores preference only, no URL', alicePhotoRow.avatar_type === 'profile_photo' && alicePhotoRow.avatar_wildlife_slug === null && !JSON.stringify(db.prepare('SELECT * FROM users WHERE id = ?').get(alice.user.id)).includes('cloudinary'));

  // Wildlife.
  r = await setAvatar(bob.cookie, { avatar_type: 'wildlife', wildlife_slug: shark.slug, image_url: 'https://evil.test/x.jpg' });
  check('published Wildlife species with image → 200', r.status === 200 && r.json.avatar.type === 'wildlife' && r.json.avatar.url === SHARK_IMG && r.json.avatar.species_name === 'The Test Shark', r.text);
  check('stores avatar_type=wildlife + slug only', JSON.stringify(userAv(bob)) === JSON.stringify({ avatar_type: 'wildlife', avatar_wildlife_slug: 'avatar-shark' }) && !JSON.stringify(db.prepare('SELECT * FROM users WHERE id = ?').get(bob.user.id)).includes('cloudinary'));
  check('feed resolves Wildlife image dynamically', (await feedAuthor('bob_nuts')).avatar.url === SHARK_IMG);
  r = await setAvatar(carol.cookie, { avatar_type: 'wildlife', wildlife_slug: local.slug });
  check('local /uploads Wildlife image allowed in dev', r.status === 200 && r.json.avatar.url === '/uploads/local-cat.png');

  // Replies carry avatars too (API + page), same resolver.
  r = await reply(bob.cookie, p1.id, { body: 'shark reply' });
  check('new reply returns author avatar', r.status === 201 && r.json.reply.author.avatar.type === 'wildlife' && r.json.reply.author.avatar.url === SHARK_IMG);
  const sharkReplyId = r.json.reply.id;
  r = await request('GET', `/api/community/posts/${p1.id}`);
  check('post detail API: post + reply avatars', r.json.post.author.avatar.url === ALICE_PHOTO && r.json.replies.find((x) => x.id === sharkReplyId).author.avatar.url === SHARK_IMG && r.json.replies.find((x) => x.author.username === 'AceAlice').author.avatar.type === 'profile_photo');
  r = await request('GET', `/community/post/${p1.id}`);
  check('post page renders post + reply avatars (circular, cover)', r.text.includes(`<img class="atm-av" src="${ALICE_PHOTO}" alt="" width="40" height="40"`) && r.text.includes(`<img class="atm-av" src="${SHARK_IMG}"`) && /\.atm-av \{[^}]*border-radius: 50%;[^}]*object-fit: cover;/.test(r.text));
  check('post page wraps cards with avatar column', r.text.includes('class="cm-post cm-with-av"') && r.text.includes('class="cm-post cm-reply cm-with-av"'));
  r = await request('GET', '/community');
  check('feed page renders image avatars', r.text.includes(`src="${SHARK_IMG}"`) && r.text.includes(`src="${ALICE_PHOTO}"`));
  check('feed page renders default initial avatar', r.text.includes('<span class="atm-av atm-av-default" aria-hidden="true" style="width:40px;height:40px;font-size:20px;">'));
  check('approved author avatar links to profile (hidden from AT)', r.text.includes('<a class="cm-av-link" href="/players/ace-alice-1a2b3c" tabindex="-1" aria-hidden="true">'));

  // Switching never touches photo_url.
  const photoBefore = psData(approved.id).photo_url;
  await setAvatar(alice.cookie, { avatar_type: 'wildlife', wildlife_slug: shark.slug });
  check('switch to Wildlife keeps photo_url', psData(approved.id).photo_url === photoBefore && (await feedAuthor('AceAlice')).avatar.url === SHARK_IMG);
  await setAvatar(alice.cookie, { avatar_type: 'default' });
  check('switch to default keeps photo_url + clears slug', psData(approved.id).photo_url === photoBefore && userAv(alice).avatar_wildlife_slug === null && (await feedAuthor('AceAlice')).avatar.type === 'default');
  r = await setAvatar(alice.cookie, { avatar_type: 'profile_photo' });
  check('switch back to profile photo works', r.status === 200 && psData(approved.id).photo_url === photoBefore && (await feedAuthor('AceAlice')).avatar.url === ALICE_PHOTO);

  // Wildlife lifecycle fallbacks (bob selected the shark).
  const setShark = (patch) => db.prepare('UPDATE wildlife_species SET data = ? WHERE id = ?').run(JSON.stringify({ ...shark, ...patch }), shark.id);
  setShark({ status: 'draft' });
  check('unpublished species → default fallback', (await feedAuthor('bob_nuts')).avatar.type === 'default');
  setShark({ status: 'published', image_url: '' });
  check('species loses image → default fallback', (await feedAuthor('bob_nuts')).avatar.type === 'default');
  setShark({ status: 'published', image_url: 'javascript:alert(1)' });
  check('species image becomes unsafe → default fallback', (await feedAuthor('bob_nuts')).avatar.type === 'default');
  setShark({});
  check('republished with image → Wildlife avatar returns', (await feedAuthor('bob_nuts')).avatar.url === SHARK_IMG);
  db.prepare('DELETE FROM wildlife_species WHERE id = ?').run(shark.id);
  const bobDeleted = await feedAuthor('bob_nuts');
  check('deleted species → default fallback (preference kept)', bobDeleted.avatar.type === 'default' && bobDeleted.avatar.url === null && userAv(bob).avatar_type === 'wildlife');
  r = await request('GET', `/community/post/${p1.id}`);
  check('reply by fallen-back user renders default', r.status === 200 && !r.text.includes(SHARK_IMG));
  addSpecies(shark);

  // Profile-photo fallbacks.
  db.prepare('UPDATE player_submissions SET data = ? WHERE id = ?').run(JSON.stringify({ ...psData(approved.id), status: 'rejected' }), approved.id);
  check('rejected profile photo → default fallback', (await feedAuthor('AceAlice')).avatar.type === 'default');
  db.prepare('UPDATE player_submissions SET data = ? WHERE id = ?').run(JSON.stringify({ ...psData(approved.id), status: 'approved', photo_url: '' }), approved.id);
  check('photo removed → default fallback', (await feedAuthor('AceAlice')).avatar.type === 'default');
  db.prepare('UPDATE player_submissions SET data = ? WHERE id = ?').run(JSON.stringify({ ...psData(approved.id), photo_url: ALICE_PHOTO }), approved.id);

  // My ATM page.
  r = await request('GET', '/account', { cookie: bob.cookie });
  check('My ATM shows YOUR ATM AVATAR section', r.status === 200 && r.text.includes('<h2>YOUR ATM AVATAR</h2>') && r.text.includes('ATM Default') && r.text.includes('Poker Wildlife'));
  check('My ATM shows current Wildlife avatar + pressed option', r.text.includes('Poker Wildlife: The Test Shark') && r.text.includes(`data-wildlife-slug="avatar-shark" aria-pressed="true"`));
  check('selector lists only published species with valid images', r.text.includes('The Test Shark') && r.text.includes('The Local Cat') && !r.text.includes('The Draft Fish') && !r.text.includes('The Imageless Whale') && !r.text.includes('Evil') && !r.text.includes('javascript:'));
  check('no profile → no photo option, link to create profile', !r.text.includes('data-avatar-type="profile_photo"') && r.text.includes('href="/ai-profile-generator">Poker Profile</a>'));
  check('My ATM never renders an edit_token', !r.text.includes('EDITTOKEN_') && !r.text.includes('/profile/setup/'));
  r = await request('GET', '/account', { cookie: carol.cookie });
  check('profile without photo → link to existing photo uploader', r.text.includes('href="/account/profile-photo">Add a profile photo</a>') && !r.text.includes('data-avatar-type="profile_photo"') && !r.text.includes('EDITTOKEN_PENDING'));
  r = await request('GET', '/account', { cookie: alice.cookie });
  check('profile with photo → selectable + pressed', r.text.includes('data-avatar-type="profile_photo" aria-pressed="true"') && r.text.includes(`src="${ALICE_PHOTO}"`));
  r = await request('GET', '/account/profile-photo', { cookie: carol.cookie });
  check('/account/profile-photo → owner\'s existing setup page', r.status === 302 && r.headers.location === '/profile/setup/EDITTOKEN_PENDING_SECRET_456' && r.headers['cache-control'] === 'no-store', `${r.status} ${r.headers.location}`);
  r = await request('GET', '/account/profile-photo', { cookie: bob.cookie });
  check('/account/profile-photo without profile → /account', r.status === 302 && r.headers.location === '/account');
  r = await request('GET', '/account/profile-photo');
  check('/account/profile-photo logged out → login', r.status === 302 && r.headers.location.startsWith('/login'));

  // Existing photo upload flow is untouched and doesn't reset the avatar pref.
  const photoToken = crypto.randomUUID();
  const dave = await makeUser('dave@example.com', { username: 'dave_d', display_name: 'Dave' });
  const daveProfile = { id: crypto.randomUUID(), name: 'Dave', nickname: 'D', slug: 'dave-d-777777', status: 'approved', email: 'dave@example.com', edit_token: photoToken, photo_url: '' };
  db.prepare('INSERT INTO player_submissions (id, data) VALUES (?, ?)').run(daveProfile.id, JSON.stringify(daveProfile));
  await app.createUserProfileLink(dave.user.id, daveProfile.id);
  r = await request('GET', '/account/profile-photo', { cookie: dave.cookie });
  check('/account/profile-photo redirects owner to their setup page', r.status === 302 && r.headers.location === `/profile/setup/${photoToken}`);
  r = await request('GET', `/profile/setup/${photoToken}`);
  check('existing /profile/setup page + photo section still render', r.status === 200 && r.text.includes('3 — Profile Photo') && r.text.includes('id="sectionPhoto"'));
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
  const boundary = '----avatarSmoke' + Date.now();
  const multipart = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="d.png"\r\nContent-Type: image/png\r\n\r\n`),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const up = await new Promise((resolve, reject) => {
    const q = http.request(BASE + `/api/profile/${photoToken}/photo`, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': multipart.length } }, (res2) => {
      let t = ''; res2.on('data', (c) => t += c); res2.on('end', () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res2.statusCode, json: j, text: t }); });
    });
    q.on('error', reject); q.end(multipart);
  });
  const uploadedUrl = up.json && up.json.photo_url;
  check('existing profile photo upload still works', up.status === 200 && typeof uploadedUrl === 'string' && uploadedUrl.startsWith('/uploads/'), up.text.slice(0, 200));
  check('photo upload does not change avatar preference', userAv(dave).avatar_type === 'default');
  r = await setAvatar(dave.cookie, { avatar_type: 'profile_photo' });
  check('freshly uploaded photo selectable as avatar', r.status === 200 && r.json.avatar.url === uploadedUrl);
  if (uploadedUrl) { try { fs.unlinkSync(path.join(__dirname, '..', uploadedUrl)); } catch {} }

  r = await request('GET', '/stories/poker-wildlife');
  check('Wildlife landing still works', r.status === 200 && r.text.includes('The Test Shark') && !r.text.includes('The Draft Fish'));
  r = await request('GET', '/api/auth/me', { cookie: bob.cookie });
  check('/api/auth/me shape unchanged (no avatar internals)', r.status === 200 && Object.keys(r.json.user).sort().join() === 'display_name,email,email_verified,trust_level,username');

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nPrivacy');
  const surfaces = [
    await request('GET', '/api/community/posts', { cookie: alice.cookie }),
    await request('GET', `/api/community/posts/${p1.id}`, { cookie: alice.cookie }),
    await request('GET', '/api/community/channels'),
    await request('GET', '/community', { cookie: alice.cookie }),
    await request('GET', `/community/post/${p1.id}`, { cookie: alice.cookie }),
    await post(alice.cookie, { channel: 'general', body: 'privacy probe' }),
    await reply(alice.cookie, p1.id, { body: 'privacy probe reply' }),
    await like(alice.cookie, p1.id),
    await request('POST', '/api/account/avatar', { cookie: alice.cookie, body: { avatar_type: 'profile_photo' } }),
    await request('POST', '/api/account/avatar', { cookie: bob.cookie, body: { avatar_type: 'wildlife', wildlife_slug: 'avatar-shark' } }),
  ];
  const all = surfaces.map((s) => s.text).join('\n');
  check('emails not exposed', !/alice\.private@example\.com|bob\.secret@example\.com|carol@example\.com/i.test(all));
  check('edit_token not exposed', !all.includes('EDITTOKEN_') && !/edit_token/.test(all));
  check('session token/hash not exposed', ![alice.token, alice.tokenHash, bob.token, bob.tokenHash].some((t) => all.includes(t)));
  check('admin_notes not exposed', !all.includes('ADMIN_NOTE') && !/admin_notes/.test(all));
  check('internal user ids not exposed', ![alice.user.id, bob.user.id, carol.user.id].some((id) => all.includes(id)));
  check('player_submission ids not exposed', !all.includes(approved.id) && !all.includes(pending.id));
  check('Wildlife species ids not exposed', !all.includes(shark.id) && !all.includes(local.id));
  check('avatar internals not exposed', !/avatar_type|avatar_wildlife_slug|avatar_photo_url|linked_profile_id/.test(all));
  check('channel ids not exposed', !db.prepare('SELECT id FROM community_channels').all().some((c) => all.includes(c.id)));
  check('all community API responses are no-store JSON', surfaces.filter((s) => /json/.test(s.headers['content-type'] || '')).every((s) => s.headers['cache-control'] === 'no-store'));

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nLegacy');
  r = await request('GET', '/community-wall');
  check('/community-wall still works', r.status === 200 && r.text.includes('/players/ace-alice-1a2b3c'));
  r = await request('GET', '/community-guidelines');
  check('/community-guidelines still works', r.status === 200);
  r = await request('GET', '/api/community/nope');
  check('unknown community API → 404 JSON', r.status === 404 && r.json && r.json.error);
  const idx = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const shop = fs.readFileSync(path.join(__dirname, '..', 'shop.html'), 'utf8');
  check('index.html nav Community → /community', idx.includes('<li><a href="/community">Community</a></li>') && !idx.includes('<li><a href="/community-wall">Community</a></li>'));
  check('shop.html nav Community → /community', shop.includes('<li><a href="/community">Community</a></li>') && !shop.includes('<li><a href="/community-wall">Community</a></li>'));
  check('index.html keeps player-directory link to /community-wall', idx.includes('href="/community-wall"'));
  r = await request('GET', '/api/auth/me', { cookie: alice.cookie });
  check('/api/auth/me unaffected', r.status === 200 && r.json.authenticated === true);

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
