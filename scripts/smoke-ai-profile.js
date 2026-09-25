#!/usr/bin/env node
/*
 * AI-first Poker Profile smoke test (Sprint 1B.2 + 1B.3 instant activation).
 *
 * Self-contained: loads server.js as a module against a throwaway SQLite
 * database, listens on an ephemeral port, and drives /ai-profile-generator and
 * the /api/account/{generate-poker-profile,wildlife-alter-ego,save-poker-profile}
 * routes over HTTP. OpenAI is never called: global fetch is stubbed with a
 * queue of canned chat completions. Never touches data/blog-posts.sqlite.
 *
 * Usage:  node scripts/smoke-ai-profile.js
 * Exit code 0 = all checks passed, 1 = at least one failure.
 */

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_FILE = path.join(os.tmpdir(), `ai-profile-smoke-${Date.now()}.sqlite`);

process.env.SQLITE_DB_FILE = DB_FILE;
delete process.env.DATABASE_URL;
delete process.env.RAILWAY_ENVIRONMENT;
delete process.env.RAILWAY_PROJECT_ID;
delete process.env.RAILWAY_SERVICE_ID;
delete process.env.NODE_ENV;
process.env.OPENAI_API_KEY = 'sk-test-SUPERSECRET';
process.env.ADMIN_EMAIL = 'smoke-admin@example.com';
process.env.ADMIN_PASSWORD = 'smoke-admin-pw';
delete process.env.ADMIN_PASSWORD_HASH;

const Database = require('better-sqlite3');
const app = require(path.join(__dirname, '..', 'server.js'));

let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`  ✓ ${name}`); }
function bad(name, detail) { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
function check(name, cond, detail) { cond ? ok(name) : bad(name, detail); }

// ── OpenAI stub: each call shifts one canned reply (object → JSON, string → raw, Error → HTTP 500) ──
const openaiCalls = [];
const openaiQueue = [];
let geoHook = null; // runs during geoLookup (between the save's link check and its insert)
global.fetch = async (url, opts = {}) => {
  if (String(url).startsWith('https://ipapi.co/')) {
    if (geoHook) await geoHook();
    return { ok: false, status: 404, json: async () => ({}) };
  }
  if (String(url).startsWith('https://api.openai.com/')) {
    openaiCalls.push(JSON.parse(opts.body));
    const next = openaiQueue.length ? openaiQueue.shift() : new Error('queue empty');
    if (next instanceof Error) return { ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) };
    const content = typeof next === 'string' ? next : JSON.stringify(next);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const GOOD_PROFILE = {
  nickname: 'River Blamer',
  tagline: 'Never met a river card he could forgive.',
  playing_style: 'Loose-aggressive with a <b>flair</b> for drama',
  biggest_strength: 'Fearless when the pot gets big.',
  biggest_weakness: 'Physically unable to fold a pair.',
  funniest_habit: 'Stares at the dealer after every river like it was personal.',
  table_reputation: 'The guy everyone hopes sits on their left.',
  bio: 'River Blamer plays poker like a man with a grudge against the fifth card. '.repeat(4).trim(),
};

let BASE = '';
function request(method, urlPath, { cookie, body, rawBody, contentType, ip } = {}) {
  return new Promise((resolve, reject) => {
    const data = rawBody != null ? rawBody : body !== undefined ? JSON.stringify(body) : null;
    const headers = { 'X-Forwarded-For': ip || '10.1.2.3' };
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

async function makeUser(email, { verified = true, username = null, display_name = '' } = {}) {
  const user = await app.createUser({ email, username, display_name, trust_level: verified ? 'verified' : 'new', email_verified_at: verified ? new Date().toISOString() : null });
  const token = app.createSessionToken();
  await app.createUserSession({ userId: user.id, tokenHash: app.hashAuthToken(token) });
  return { user, cookie: `${app.USER_SESSION_COOKIE}=${token}` };
}

const CLUES = { nickname: '', game_type: 'cash', playing_style: 'aggressive', player_clue: 'I bluff too much and blame the river.', permission: true };

async function main() {
  console.log(`AI profile smoke — temp DB ${DB_FILE}`);
  await app.initializeDatabase();
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  BASE = `http://127.0.0.1:${app.server.address().port}`;
  const db = new Database(DB_FILE);
  const subCount = () => db.prepare('SELECT COUNT(*) AS n FROM player_submissions').get().n;
  const subById = (id) => JSON.parse(db.prepare('SELECT data FROM player_submissions WHERE id = ?').get(id).data);
  const putSpecies = (s) => db.prepare('INSERT INTO wildlife_species (id, data) VALUES (?, ?)').run(s.id, JSON.stringify(s));
  putSpecies({ id: crypto.randomUUID(), slug: 'test-shark', name: 'The Test Shark', status: 'published', display_order: 1, short_description: 'Quiet. Deadly.', image_url: 'https://res.cloudinary.com/demo/shark.jpg', image_alt: 'A shark' });
  putSpecies({ id: crypto.randomUUID(), slug: 'test-owl', name: 'The Test Owl', status: 'published', display_order: 2, tagline: 'Watches every street.', image_url: 'javascript:alert(1)' });
  putSpecies({ id: crypto.randomUUID(), slug: 'secret-draft', name: 'The Secret Draftling', status: 'draft', display_order: 3, tagline: 'Not ready.' });

  const main = await makeUser('Main.Player@Example.com', { username: 'mainplayer', display_name: 'Main Player' });
  const noName = await makeUser('nousername@example.com', { display_name: '' });
  const unverified = await makeUser('unverified@example.com', { verified: false, username: 'unverified1', display_name: 'Unverified' });

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nGenerator page');
  let r = await request('GET', '/ai-profile-generator');
  check('signed-out → 302 /login?next=/ai-profile-generator', r.status === 302 && r.headers.location === '/login?next=/ai-profile-generator');
  check('signed-out → no legacy generator, no AI-first form', !r.text.includes('Start My Poker Profile') && !r.text.includes('CREATE YOUR POKER IDENTITY'));
  r = await request('GET', '/ai-profile-generator', { cookie: unverified.cookie });
  check('unverified session → /login?next=/ai-profile-generator', r.status === 302 && r.headers.location === '/login?next=/ai-profile-generator');
  r = await request('GET', '/ai-profile-generator', { cookie: noName.cookie });
  check('verified user without username → /account/setup (next preserved)', r.status === 302 && r.headers.location === '/account/setup?next=/ai-profile-generator');
  r = await request('GET', '/ai-profile-generator', { cookie: main.cookie });
  const page = r.text;
  check('authenticated verified user → AI-first page', r.status === 200 && page.includes('CREATE YOUR POKER IDENTITY') && page.includes("Give AI a few clues. We'll do the rest."));
  check('AI-first page is no-store', r.headers['cache-control'] === 'no-store');
  check('does not ask for email', !/name="email"|type="email"/.test(page));
  check('does not ask for full name', !/name="name"/.test(page));
  check('has optional nickname', page.includes('name="nickname"') && page.includes('What they call you at the table — or let AI invent one'));
  check('has CASH / TOURNAMENTS / BOTH', ['value="cash"', 'value="tournaments"', 'value="both"', '>CASH<', '>TOURNAMENTS<', '>BOTH<'].every((s) => page.includes(s)));
  check('has style choices', ['AGGRESSIVE', 'TIGHT', 'LOOSE', 'TRICKY', 'NO IDEA 😂'].every((s) => page.includes(`>${s}<`)));
  check('has optional 500-char clue', page.includes('name="player_clue" maxlength="500"') && page.includes('A habit, story, strength, weakness, bad beat, accomplishment — anything.'));
  check('has consent checkbox', page.includes('type="checkbox" id="aipConsent"') && page.includes('I can review it before anything is published.'));
  check('has ✨ CREATE MY POKER PROFILE', page.includes('✨ CREATE MY POKER PROFILE'));
  check('no photo / social / casino / hometown fields', !/type="file"|name="(photo|social_link|favorite_casino|city|bad_beat_story|biggest_goal)"/.test(page));
  check('preview has KEEP IT / REGENERATE / EDIT', ['>KEEP IT<', '>REGENERATE<', '>EDIT<'].every((s) => page.includes(s)));
  check('Wildlife step: SURPRISE ME / LET ME CHOOSE / SKIP', ['YOUR POKER WILDLIFE ALTER EGO', '>SURPRISE ME<', '>LET ME CHOOSE<', '>SKIP<'].every((s) => page.includes(s)));
  check('Let Me Choose lists published species', page.includes('data-species-slug="test-shark"') && page.includes('The Test Owl'));
  check('draft species never on page', !page.includes('Secret Draftling') && !page.includes('secret-draft'));
  check('success copy: profile is live', page.includes('Your Poker Profile is live.') && page.includes('VIEW MY POKER PROFILE') && !page.includes('hit Submit for Review'));
  check('no review/pending copy on AI-first page', !/sent for review|while it is pending|until an admin approves/i.test(page));
  check('only safe species images rendered', page.includes('src="https://res.cloudinary.com/demo/shark.jpg"') && !page.includes('javascript:alert'));

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nGeneration auth');
  r = await request('POST', '/api/account/generate-poker-profile', { body: CLUES });
  check('signed-out → 401', r.status === 401);
  r = await request('POST', '/api/account/generate-poker-profile', { cookie: unverified.cookie, body: CLUES });
  check('unverified → 403', r.status === 403);
  r = await request('POST', '/api/account/generate-poker-profile', { cookie: noName.cookie, body: CLUES });
  check('no username → 403', r.status === 403);
  r = await request('POST', '/api/account/generate-poker-profile', { cookie: main.cookie, rawBody: 'nickname=x', contentType: 'application/x-www-form-urlencoded' });
  check('non-JSON → 400', r.status === 400);
  r = await request('POST', '/api/account/generate-poker-profile', { cookie: main.cookie, body: { ...CLUES, permission: false } });
  check('no consent → 400', r.status === 400);
  r = await request('POST', '/api/account/generate-poker-profile', { cookie: main.cookie, body: { ...CLUES, game_type: 'bingo' } });
  check('invalid game_type → 400', r.status === 400);
  r = await request('POST', '/api/account/generate-poker-profile', { cookie: main.cookie, body: { ...CLUES, playing_style: 'wild' } });
  check('invalid style → 400', r.status === 400);
  r = await request('POST', '/api/account/generate-poker-profile', { cookie: main.cookie, body: { ...CLUES, player_clue: 'x'.repeat(501) } });
  check('clue > 500 chars → 400', r.status === 400);
  check('validation failures made no AI calls', openaiCalls.length === 0);

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nGeneration');
  app.resetAuthRateLimits();
  const before = subCount();
  openaiQueue.push({ ...GOOD_PROFILE, bio: GOOD_PROFILE.bio + ' <script>alert(1)</script>', favorite_casino: 'Foxwoods', biggest_accomplishment: 'Won the WSOP' });
  r = await request('POST', '/api/account/generate-poker-profile', {
    cookie: main.cookie,
    body: { ...CLUES, email: 'attacker@evil.test', name: 'Mallory', user_id: 'x', edit_token: 'y', status: 'approved' },
  });
  check('valid AI response → 200 + profile', r.status === 200 && r.json && r.json.ok && r.json.profile && r.json.profile.nickname === 'River Blamer', r.text);
  check('generate response is no-store', r.headers['cache-control'] === 'no-store');
  const gen = r.json.profile;
  check('only the 8 profile fields returned (no casino/accomplishment passthrough)', Object.keys(gen).sort().join() === 'biggest_strength,biggest_weakness,bio,funniest_habit,nickname,playing_style,table_reputation,tagline');
  check('AI HTML stripped', !/[<>]/.test(JSON.stringify(gen)) && gen.playing_style.includes('flair'));
  const prompt = JSON.stringify(openaiCalls[openaiCalls.length - 1]);
  check('prompt excludes emails and browser-supplied name', !/@example\.com|attacker@evil|Mallory/i.test(prompt));
  check('prompt forbids fabricated wins/casinos/money', /Do NOT invent achievements, tournament wins, cashes, money won or lost, specific casinos/.test(prompt));
  check('prompt carries the clues', prompt.includes('Cash Games') && prompt.includes('Aggressive') && prompt.includes('blame the river'));
  check('generation does not create a player_submission', subCount() === before);
  check('no secrets in response', !r.text.includes('sk-test') && !r.text.includes('SUPERSECRET'));

  openaiQueue.push({ ...GOOD_PROFILE, bio: 'word '.repeat(600) });
  r = await request('POST', '/api/account/generate-poker-profile', { cookie: main.cookie, body: CLUES });
  check('over-long AI field clamped', r.status === 200 && r.json.profile.bio.length <= 1500 && r.json.profile.bio.endsWith('…'));
  openaiQueue.push('this is not json');
  r = await request('POST', '/api/account/generate-poker-profile', { cookie: main.cookie, body: CLUES });
  check('malformed AI JSON → controlled 502', r.status === 502 && r.json && typeof r.json.error === 'string' && !r.text.includes('this is not json'));
  openaiQueue.push({ nickname: 'Only Nick' });
  r = await request('POST', '/api/account/generate-poker-profile', { cookie: main.cookie, body: CLUES });
  check('incomplete AI JSON → controlled 502', r.status === 502);
  openaiQueue.push(new Error('down'));
  r = await request('POST', '/api/account/generate-poker-profile', { cookie: main.cookie, body: CLUES });
  check('OpenAI failure → controlled 502 (no internals)', r.status === 502 && !r.text.includes('boom'));
  // So far: 4 successful OpenAI calls (good, clamp, malformed, incomplete); the failure was released.
  openaiQueue.push(GOOD_PROFILE);
  r = await request('POST', '/api/account/generate-poker-profile', { cookie: main.cookie, body: CLUES });
  check('regenerate works (5th generation)', r.status === 200);
  const callsBefore = openaiCalls.length;
  openaiQueue.push(GOOD_PROFILE);
  r = await request('POST', '/api/account/generate-poker-profile', { cookie: main.cookie, body: CLUES });
  check('6th generation in an hour → 429 (regenerations count)', r.status === 429 && r.json && r.json.error && !/limit\s*[:=]|bucket|count/i.test(r.json.error));
  check('rate-limited request made no AI call', openaiCalls.length === callsBefore);
  openaiQueue.length = 0;
  const other = await makeUser('other@example.com', { username: 'otherplayer', display_name: 'Other Player' });
  openaiQueue.push(GOOD_PROFILE);
  r = await request('POST', '/api/account/generate-poker-profile', { cookie: other.cookie, body: CLUES });
  check('limit is per user, not global', r.status === 200);
  delete process.env.OPENAI_API_KEY;
  app.resetAuthRateLimits();
  r = await request('POST', '/api/account/generate-poker-profile', { cookie: main.cookie, body: CLUES });
  check('missing OPENAI_API_KEY → 503', r.status === 503);
  process.env.OPENAI_API_KEY = 'sk-test-SUPERSECRET';

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nWildlife alter ego');
  app.resetAuthRateLimits();
  const wBody = { ...CLUES, profile: gen };
  openaiQueue.push({ species_slug: 'test-owl', explanation: 'You watch every street like it owes you money.' });
  r = await request('POST', '/api/account/wildlife-alter-ego', { cookie: main.cookie, body: { ...wBody, mode: 'surprise' } });
  check('Surprise Me → published species', r.status === 200 && r.json.alter_ego.species_slug === 'test-owl' && r.json.alter_ego.species_name === 'The Test Owl');
  const wPrompt = JSON.stringify(openaiCalls[openaiCalls.length - 1]);
  check('Surprise Me prompt lists only published species', wPrompt.includes('test-shark') && wPrompt.includes('test-owl') && !wPrompt.includes('secret-draft'));
  openaiQueue.push({ species_slug: 'secret-draft', explanation: 'Sneaky.' });
  r = await request('POST', '/api/account/wildlife-alter-ego', { cookie: main.cookie, body: { ...wBody, mode: 'surprise' } });
  check('AI picks a draft slug → rejected (502)', r.status === 502 && !r.text.includes('Draftling'));
  openaiQueue.push({ species_slug: 'unicorn', explanation: 'Magic.' });
  r = await request('POST', '/api/account/wildlife-alter-ego', { cookie: main.cookie, body: { ...wBody, mode: 'surprise' } });
  check('AI picks a nonexistent slug → rejected (502)', r.status === 502);
  openaiQueue.push({ explanation: 'You bite first and ask questions on the river.' });
  r = await request('POST', '/api/account/wildlife-alter-ego', { cookie: main.cookie, body: { ...wBody, mode: 'choose', species_slug: 'test-shark' } });
  check('Let Me Choose → chosen species + explanation', r.status === 200 && r.json.alter_ego.species_slug === 'test-shark' && r.json.alter_ego.explanation.includes('bite first'));
  const chosenAlter = r.json.alter_ego;
  r = await request('POST', '/api/account/wildlife-alter-ego', { cookie: main.cookie, body: { ...wBody, mode: 'choose', species_slug: 'secret-draft' } });
  check('Let Me Choose draft species → 400', r.status === 400);
  openaiQueue.push(new Error('down'));
  r = await request('POST', '/api/account/wildlife-alter-ego', { cookie: main.cookie, body: { ...wBody, mode: 'choose', species_slug: 'test-owl' } });
  check('Let Me Choose AI failure → controlled fallback line', r.status === 200 && r.json.alter_ego.species_slug === 'test-owl' && r.json.alter_ego.explanation.length > 0);
  r = await request('POST', '/api/account/wildlife-alter-ego', { cookie: unverified.cookie, body: { ...wBody, mode: 'surprise' } });
  check('Wildlife endpoint requires verified user', r.status === 403);

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nSave');
  const saveBody = { profile: { ...gen, nickname: 'Edited Blamer', tagline: 'Edited <i>tagline</i>' }, game_type: 'both', permission: true, wildlife: { species_slug: chosenAlter.species_slug, explanation: chosenAlter.explanation } };
  r = await request('POST', '/api/account/save-poker-profile', { cookie: unverified.cookie, body: saveBody });
  check('unverified → 403', r.status === 403);
  r = await request('POST', '/api/account/save-poker-profile', { cookie: noName.cookie, body: saveBody });
  check('no username → 403', r.status === 403);
  r = await request('POST', '/api/account/save-poker-profile', { cookie: main.cookie, body: { ...saveBody, permission: false } });
  check('no consent → 400', r.status === 400);
  r = await request('POST', '/api/account/save-poker-profile', { cookie: main.cookie, body: { ...saveBody, wildlife: { species_slug: 'secret-draft', explanation: 'x' } } });
  check('draft species at save → 400', r.status === 400);
  r = await request('POST', '/api/account/save-poker-profile', { cookie: main.cookie, body: { ...saveBody, wildlife: { species_slug: 'nope' } } });
  check('nonexistent species at save → 400', r.status === 400);
  r = await request('POST', '/api/account/save-poker-profile', { cookie: main.cookie, body: { ...saveBody, profile: { ...gen, bio: 'x'.repeat(1501) } } });
  check('over-long edited field → 400', r.status === 400);
  r = await request('POST', '/api/account/save-poker-profile', { cookie: main.cookie, body: { ...saveBody, profile: { ...gen, nickname: '' } } });
  check('missing nickname → 400', r.status === 400);
  check('rejected saves created nothing', subCount() === before);

  r = await request('POST', '/api/account/save-poker-profile', {
    cookie: main.cookie,
    body: { ...saveBody, email: 'attacker@evil.test', name: 'Mallory', status: 'approved', edit_token: 'mine', id: 'forced-id', user_id: other.user.id },
  });
  check('save → 200 with profile_url + public_url only', r.status === 200 && r.json.ok === true && /^\/profile\/setup\/[0-9a-f-]{36}$/.test(r.json.profile_url) && /^\/players\/[a-z0-9-]+$/.test(r.json.public_url) && Object.keys(r.json).sort().join() === 'ok,profile_url,public_url', r.text);
  const saveTime = Date.now();
  check('save response is no-store', r.headers['cache-control'] === 'no-store');
  check('exactly one submission created', subCount() === before + 1);
  const link = await app.getUserProfileLink(main.user.id);
  check('user_profile_links entry created', !!link);
  const sub = subById(link.player_submission_id);
  const token = r.json.profile_url.split('/').pop();
  check('name/email derived from session', sub.name === 'Main Player' && sub.email === 'Main.Player@Example.com');
  check('browser identity/status/id ignored', sub.id !== 'forced-id' && sub.edit_token === token && r.json.public_url === `/players/${sub.slug}`);
  check('edited fields persisted + sanitized', sub.nickname === 'Edited Blamer' && sub.tagline === 'Edited tagline' && sub.bio === gen.bio);
  check('legacy fields mapped', sub.favorite_game === 'Cash Games & Tournaments' && sub.playing_style === gen.playing_style && sub.biggest_strength === gen.biggest_strength && sub.funniest_habit === gen.funniest_habit);
  check('consent recorded in existing format', sub.permission_granted === true && !!sub.consent_at && sub.consent_ip === '10.1.2.3' && sub.consent_city === 'unknown');
  check('no fabricated legacy facts', ['biggest_accomplishment', 'biggest_goal', 'funny_story', 'bad_beat_story', 'favorite_casino', 'social_link', 'city', 'photo_url'].every((k) => sub[k] === ''));
  check('legacy shape intact', Array.isArray(sub.badges) && Array.isArray(sub.ai_chronicles) && sub.ai_personality === null && typeof sub.completion_score === 'number' && !!sub.slug);
  check('AI-first profile is submitted_for_review === true', sub.submitted_for_review === true && !!sub.submitted_at);
  check('AI-first profile is instantly status === approved', sub.status === 'approved');
  check('approved_at populated by server (not browser)', typeof sub.approved_at === 'string' && Math.abs(Date.parse(sub.approved_at) - saveTime) < 60000);
  check('profile linked to the authenticated user', link.player_submission_id === sub.id && (await app.getProfileOwnerLink(sub.id)).user_id === main.user.id);
  r = await request('GET', `/players/${sub.slug}`);
  check('approved AI-first profile publicly visible at /players/<slug>', r.status === 200 && r.text.includes('Edited Blamer'));
  r = await request('GET', '/community-wall');
  check('approved AI-first profile on Community Wall', r.status === 200 && r.text.includes('Edited Blamer') && r.text.includes(`/players/${sub.slug}`));
  check('Wildlife alter ego persisted', sub.wildlife_alter_ego && sub.wildlife_alter_ego.species_slug === 'test-shark' && sub.wildlife_alter_ego.species_name === 'The Test Shark' && sub.wildlife_alter_ego.explanation.includes('bite first'));
  check('user id not stored on submission', !JSON.stringify(sub).includes(main.user.id));

  r = await request('POST', '/api/account/save-poker-profile', { cookie: main.cookie, body: saveBody });
  check('duplicate save → 409', r.status === 409 && subCount() === before + 1);
  r = await request('POST', '/api/account/generate-poker-profile', { cookie: main.cookie, body: CLUES });
  check('generation with existing profile → 409', r.status === 409);
  r = await request('GET', '/ai-profile-generator', { cookie: main.cookie });
  check('page with existing profile → YOU ALREADY HAVE A POKER PROFILE', r.text.includes('YOU ALREADY HAVE A POKER PROFILE') && r.text.includes('href="/account"') && !r.text.includes('CREATE YOUR POKER IDENTITY'));
  r = await request('GET', '/account', { cookie: main.cookie });
  check('/account shows linked profile as live', r.status === 200 && r.text.includes('Main Player') && r.text.includes('Your Poker Profile is live.') && !r.text.includes('stays private until an admin approves'));
  check('/account links to /players/<slug>', r.text.includes(`href="/players/${sub.slug}"`) && r.text.includes('VIEW MY POKER PROFILE'));

  // Concurrent saves: only one profile.
  const racer = await makeUser('racer@example.com', { username: 'racer', display_name: 'Racer' });
  const n0 = subCount();
  const results = await Promise.all([1, 2, 3].map(() => request('POST', '/api/account/save-poker-profile', { cookie: racer.cookie, body: { ...saveBody, wildlife: null } })));
  check('concurrent saves → exactly one 200', results.filter((x) => x.status === 200).length === 1 && results.filter((x) => x.status === 409).length === 2, results.map((x) => x.status).join());
  check('concurrent saves → exactly one submission', subCount() === n0 + 1);
  const racerSub = subById((await app.getUserProfileLink(racer.user.id)).player_submission_id);
  check('Skip: no Wildlife data stored', !('wildlife_alter_ego' in racerSub));

  // Lost race (e.g. another process links first, after our ownership check) → our row is removed.
  const loser = await makeUser('loser@example.com', { username: 'loser', display_name: 'Loser' });
  const n1 = subCount();
  geoHook = async () => {
    db.prepare('INSERT INTO user_profile_links (user_id, player_submission_id, created_at) VALUES (?, ?, ?)').run(loser.user.id, 'won-elsewhere', new Date().toISOString());
  };
  r = await request('POST', '/api/account/save-poker-profile', { cookie: loser.cookie, body: saveBody, ip: '8.8.8.8' });
  geoHook = null;
  check('lost link race → 409, no second usable profile', r.status === 409 && subCount() === n1, `${r.status} ${subCount() - n1}`);

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nExisting edit_token workflow');
  r = await request('GET', `/profile/setup/${token}`);
  check('/profile/setup/:token renders', r.status === 200);
  r = await request('GET', `/api/profile/${token}`);
  check('/api/profile/:token hides consent metadata', r.status === 200 && !r.text.includes('consent_ip') && !r.text.includes('10.1.2.3'));
  r = await request('POST', `/api/profile/${token}`, { body: { favorite_casino: 'Added Later Casino' } });
  const enriched = subById(sub.id);
  check('optional enrichment saves and keeps AI fields + Wildlife', r.status === 200 && enriched.favorite_casino === 'Added Later Casino' && enriched.bio === sub.bio && enriched.wildlife_alter_ego && enriched.tagline === 'Edited tagline');
  r = await request('GET', `/profile/setup/${token}`);
  check('setup page shows approved AI-first profile as live (no submit button)', r.text.includes('Live ✓') && !r.text.includes('id="submitFinalBtn"'));
  // The legacy /submit endpoint is still reachable by token; it must not demote an already-live profile.
  r = await request('POST', `/api/profile/${token}/submit`);
  const afterSetup = subById(sub.id);
  check('re-submit on a live profile is harmless', r.status === 200 && afterSetup.status === 'approved' && afterSetup.approved_at === sub.approved_at);
  check('setup edits keep it approved + linked + Wildlife', afterSetup.status === 'approved' && !!afterSetup.wildlife_alter_ego && (await app.getUserProfileLink(main.user.id)).player_submission_id === sub.id);
  r = await request('GET', `/players/${sub.slug}`);
  check('still public after setup enrichment', r.status === 200 && r.text.includes('Edited Blamer'));

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nLegacy /request-feature (unchanged)');
  const boundary = `----smoke${crypto.randomBytes(8).toString('hex')}`;
  const fields = { name: 'Legacy Larry', email: 'legacy@example.com', nickname: 'Old School', permission: 'yes', favorite_casino: 'Legacy Casino' };
  let mp = '';
  for (const [k, v] of Object.entries(fields)) mp += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  mp += `--${boundary}--\r\n`;
  const nLegacy = subCount();
  r = await request('POST', '/request-feature', { rawBody: mp, contentType: `multipart/form-data; boundary=${boundary}` });
  const legacy = db.prepare("SELECT data FROM player_submissions WHERE json_extract(data, '$.email') = 'legacy@example.com'").get();
  const legacySub = legacy && JSON.parse(legacy.data);
  check('legacy submit → 200 + profile_url', r.status === 200 && /^\/profile\/setup\//.test(r.json && r.json.profile_url) && subCount() === nLegacy + 1, r.text);
  check('legacy profile pending, NOT auto-submitted for review', legacySub && legacySub.status === 'pending' && !legacySub.submitted_for_review && !('submitted_at' in legacySub));
  check('legacy keeps browser-supplied fields', legacySub && legacySub.name === 'Legacy Larry' && legacySub.favorite_casino === 'Legacy Casino' && !('wildlife_alter_ego' in legacySub));
  check('legacy profile NOT auto-approved', legacySub && legacySub.status !== 'approved' && !legacySub.approved_at);
  r = await request('GET', `/players/${legacySub.slug}`);
  check('pending legacy profile not publicly visible', r.status === 404 && !r.text.includes('Old School'));
  r = await request('POST', `/api/profile/${legacySub.edit_token}/submit`);
  const legacySubmitted = subById(legacySub.id);
  check('legacy Submit for Review still works (stays pending)', r.status === 200 && legacySubmitted.submitted_for_review === true && legacySubmitted.status === 'pending');

  // Claimed legacy profile still pending → /account keeps the pending/private copy.
  const legacyOwner = await makeUser('legacy@example.com', { username: 'legacylarry', display_name: 'Legacy Larry' });
  r = await request('POST', '/api/account/claim-profile', { cookie: legacyOwner.cookie, body: { player_submission_id: legacySub.id } });
  check('legacy profile claimable', r.status === 200, r.text);
  r = await request('GET', '/account', { cookie: legacyOwner.cookie });
  check('/account keeps pending copy for pending legacy profile', r.text.includes('stays private until an admin approves') && !r.text.includes('Your Poker Profile is live.'));

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nAdmin review (unchanged)');
  r = await request('POST', '/api/admin/login', { body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD } });
  const adminCookie = (r.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  if (r.status === 200 && adminCookie) {
    r = await request('PUT', `/api/admin/submissions/${legacySub.id}`, { cookie: adminCookie, body: { status: 'approved' } });
    const adminApproved = subById(legacySub.id);
    check('admin approve still publishes a legacy profile', r.status === 200 && adminApproved.status === 'approved' && !!adminApproved.approved_at);
    r = await request('GET', `/players/${legacySub.slug}`);
    check('admin-approved legacy profile publicly visible', r.status === 200 && r.text.includes('Old School'));
    r = await request('GET', '/admin', { cookie: adminCookie });
    check('admin page lists AI-first profile as approved, not Ready for Review', r.status === 200 && r.text.includes(`id="sc-${sub.id}" data-status="approved" data-ready="false"`));
    check('admin page keeps the Ready for Review filter', r.text.includes('Ready for Review'));
  } else {
    bad('admin login for review checks', `${r.status} ${r.text.slice(0, 120)}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\nRate limiter cleanup');
  app.resetAuthRateLimits();
  const HOUR = 60 * 60 * 1000;
  const t0 = Date.now() - 2 * HOUR;
  for (let i = 0; i < 49999; i++) app.authRateBuckets.set(`verify_ip:stale-${i}`, [t0]);
  app.authRateRecord('send_email', 'recent@example.com', Date.now() - 5 * 60 * 1000);
  check('no cleanup at 50000 buckets', app.authRateBuckets.size === 50000 && app.authRateBuckets.has('verify_ip:stale-0'));
  const now = Date.now();
  const stamp = app.authRateRecord('send_cooldown', 'live@example.com', now);
  check('authRateRecord still returns its timestamp', stamp === now);
  check('stale buckets removed once over 50000', !app.authRateBuckets.has('verify_ip:stale-0') && !app.authRateBuckets.has('verify_ip:stale-49998') && app.authRateBuckets.size === 2, String(app.authRateBuckets.size));
  check('recent buckets kept', app.authRateBuckets.has('send_email:recent@example.com') && app.authRateBuckets.has('send_cooldown:live@example.com'));
  check('limit still enforced after cleanup', app.authRateAllowed('send_cooldown', 'live@example.com') === false);
  app.authRateRelease('send_cooldown', 'live@example.com', stamp);
  check('timestamp release still undoes the hit', app.authRateAllowed('send_cooldown', 'live@example.com') === true && !app.authRateBuckets.has('send_cooldown:live@example.com'));
  app.resetAuthRateLimits();

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
