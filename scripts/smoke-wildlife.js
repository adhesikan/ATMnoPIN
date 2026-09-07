#!/usr/bin/env node
/*
 * Poker Wildlife smoke test.
 *
 * Self-contained: spawns its own server instance against a throwaway SQLite
 * database, exercises the public + admin surface, then restarts to prove the
 * seed is idempotent and admin edits survive. No test framework, no deps.
 *
 * Usage:  node scripts/smoke-wildlife.js
 * Exit code 0 = all checks passed, 1 = at least one failure.
 */

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.SMOKE_PORT ? Number(process.env.SMOKE_PORT) : 3987;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(os.tmpdir(), `pw-smoke-${Date.now()}.sqlite`);
const ADMIN_EMAIL = 'smoke@atmwithnopin.com';
const ADMIN_PASSWORD = 'smoke-pass-123';

const SEED_SLUGS = ['shark', 'whale', 'howler-monkey', 'tanking-turtle', 'parrot', 'peacock', 'chipmunk', 'fox', 'elephant', 'slow-roll-sloth'];

// Must match POKER_SATIRE_DISCLAIMER in server.js exactly (contains no HTML-escaped chars).
const EXACT_DISCLAIMER = 'ATMwithNoPIN Poker Stories is satire. Characters, dialogue, poker hands and incidents appearing in this story are fictional, exaggerated or composites created for entertainment. They are not intended to depict any particular individual. Any resemblance to an actual person or event is coincidental.';

let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`  ✓ ${name}`); }
function bad(name, detail) { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
function check(name, cond, detail) { cond ? ok(name) : bad(name, detail); }

function request(method, urlPath, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(BASE + urlPath, {
      method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => chunks += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: chunks }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function startServer(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        SQLITE_DB_FILE: DB_FILE,
        DATABASE_URL: '',
        ADMIN_EMAIL,
        ADMIN_PASSWORD,
        ADMIN_PASSWORD_HASH: '',
        CLOUDINARY_CLOUD_NAME: '',
        CLOUDINARY_UPLOAD_PRESET: '',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (d) => { out += d; if (/ATM is open on port/.test(out)) { cleanup(); resolve(child); } };
    const onErr = (d) => { out += d; };
    const timer = setTimeout(() => { cleanup(); reject(new Error('server did not start:\n' + out)); }, 15000);
    function cleanup() { clearTimeout(timer); child.stdout.off('data', onData); child.stderr.off('data', onErr); }
    child.stdout.on('data', onData);
    child.stderr.on('data', onErr);
    child.on('exit', (code) => { if (code !== 0 && code !== null) reject(new Error('server exited ' + code + '\n' + out)); });
  });
}

function stop(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.on('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 3000);
  });
}

async function login() {
  const res = await request('POST', '/api/admin/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  const setCookie = (res.headers['set-cookie'] || [])[0] || '';
  return setCookie.split(';')[0];
}

async function main() {
  console.log(`Poker Wildlife smoke test\n  db: ${DB_FILE}\n`);
  let child = await startServer();
  try {
    // ---- Phase A: default (dev) environment ----
    console.log('Phase A — dev environment');
    const cookie = await login();
    check('admin login returns session cookie', /admin_session=/.test(cookie), cookie);

    let list = JSON.parse((await request('GET', '/api/admin/wildlife', { cookie })).text);
    const bySlug = Object.fromEntries(list.species.map((s) => [s.slug, s]));
    check('all 10 seed species exist', SEED_SLUGS.every((s) => bySlug[s]), SEED_SLUGS.filter((s) => !bySlug[s]).join(','));
    check('seed species are drafts', SEED_SLUGS.every((s) => bySlug[s] && bySlug[s].status === 'draft'));
    check('seed species have no content/image/publish date', SEED_SLUGS.every((s) => !bySlug[s].content && !bySlug[s].image_url && !bySlug[s].published_at));
    check('env reports non-production', list.env && list.env.production === false, JSON.stringify(list.env));

    const landing1 = await request('GET', '/stories/poker-wildlife');
    check('landing page 200', landing1.status === 200, String(landing1.status));
    check('landing hides all drafts', !SEED_SLUGS.some((s) => landing1.text.includes(`/stories/poker-wildlife/${s}"`)));
    check('landing shows no species-count while none published', !/Species Discovered:/.test(landing1.text));

    const draftDirect = await request('GET', '/stories/poker-wildlife/shark');
    check('draft species direct URL 404s', draftDirect.status === 404, String(draftDirect.status));
    const previewNoAuth = await request('GET', '/stories/poker-wildlife/shark?preview=1');
    check('preview without session 404s', previewNoAuth.status === 404, String(previewNoAuth.status));
    const previewAuth = await request('GET', '/stories/poker-wildlife/shark?preview=1', { cookie });
    check('preview with session 200 + ribbon', previewAuth.status === 200 && /Preview — status/.test(previewAuth.text), String(previewAuth.status));
    check('draft preview carries exact satire disclaimer', previewAuth.text.includes(EXACT_DISCLAIMER) && /Satire Disclaimer/.test(previewAuth.text));

    // Publish the Shark with a Cloudinary URL
    const shark = bySlug['shark'];
    let pub = await request('PUT', '/api/admin/wildlife/' + shark.id, { cookie, body: {
      ...shark, status: 'published', featured: true, display_order: 10,
      image_url: 'https://res.cloudinary.com/demo/image/upload/shark.webp', image_alt: 'A shark',
      short_description: 'Quiet. Watching. Your chips are in danger.',
    } });
    check('publish Shark with Cloudinary image succeeds', pub.status === 200, pub.text);

    // Publish the Whale — PUBLISHED but NOT featured (must not appear in the homepage grid)
    const whale = bySlug['whale'];
    let pubLocal = await request('PUT', '/api/admin/wildlife/' + whale.id, { cookie, body: {
      ...whale, status: 'published', featured: false, display_order: 20, image_url: '/uploads/whale-123.png', image_alt: 'A whale',
    } });
    check('publish with local /uploads image allowed in dev', pubLocal.status === 200, pubLocal.text);

    // Publish the Howler Monkey — published + featured (second homepage card)
    const howler = bySlug['howler-monkey'];
    const pubHowler = await request('PUT', '/api/admin/wildlife/' + howler.id, { cookie, body: {
      ...howler, status: 'published', featured: true, display_order: 30,
      image_url: 'https://res.cloudinary.com/demo/image/upload/howler.webp', image_alt: 'A howler monkey',
    } });
    check('publish Howler Monkey (published + featured) succeeds', pubHowler.status === 200, pubHowler.text);

    const landing2 = await request('GET', '/stories/poker-wildlife');
    check('published Shark now on landing', landing2.text.includes('/stories/poker-wildlife/shark"'));
    check('species count = 3', /Species Discovered:\s*3/.test(landing2.text));
    const sharkPage = await request('GET', '/stories/poker-wildlife/shark');
    check('published species page 200 + OG tags', sharkPage.status === 200 && /property="og:title"/.test(sharkPage.text) && /rel="canonical"/.test(sharkPage.text));
    check('published species page carries exact satire disclaimer', sharkPage.text.includes(EXACT_DISCLAIMER) && /Satire Disclaimer/.test(sharkPage.text));
    check('disclaimer renders before the Explore All Species CTA', sharkPage.text.indexOf(EXACT_DISCLAIMER) < sharkPage.text.indexOf('Explore All Species'));

    // ── Homepage Poker Wildlife feature section (replaces former Community Wall promo) ──
    const home = await request('GET', '/');
    const idxHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    check('homepage returns 200', home.status === 200, String(home.status));
    check('homepage contains "POKER WILDLIFE"', home.text.includes('POKER WILDLIFE'));
    check('homepage contains "EVERY POKER TABLE HAS ITS WILDLIFE."', home.text.includes('EVERY POKER TABLE HAS ITS WILDLIFE.'));
    check('homepage links to /stories/poker-wildlife', home.text.includes('href="/stories/poker-wildlife"'));
    check('homepage has the Poker Wildlife feature section', /id="poker-wildlife"/.test(home.text));
    check('homepage has MEET THE SPECIES CTA', /MEET THE SPECIES/.test(home.text));
    check('homepage bottom CTA shows dynamic species count', /EXPLORE ALL 3 SPECIES/.test(home.text));
    check('homepage teaser: "Which Poker Wildlife species are you?"', home.text.includes('Which Poker Wildlife species are you?') && /Field identification test coming soon/.test(home.text));
    check('teaser is NOT a link', !/<a[^>]*>\s*Which Poker Wildlife species are you\?/.test(home.text));
    check('featured+published Shark card on homepage', home.text.includes('href="/stories/poker-wildlife/shark"'));
    check('featured+published Howler Monkey card on homepage', home.text.includes('href="/stories/poker-wildlife/howler-monkey"'));
    check('published-but-NOT-featured Whale absent from homepage grid', !home.text.includes('href="/stories/poker-wildlife/whale"'));
    check('draft species absent from homepage', !['tanking-turtle', 'parrot', 'peacock', 'chipmunk', 'fox', 'elephant', 'slow-roll-sloth'].some((s) => home.text.includes('/stories/poker-wildlife/' + s + '"')));
    check('old mid-page "Community Wall" promo section removed', !/id="community-preview"/.test(home.text) && !/their stories, bad beats, and moments of glory/.test(home.text) && !/class="cw-track"/.test(home.text));
    check('homepage did not break: hero + follow still present', /id="home"/.test(home.text) && /id="follow"/.test(home.text));

    // ── Hero-right promo panel: "Get on the Community Wall" replaced by Poker Wildlife ──
    check('hero-right panel no longer promotes "Get on the Community Wall"', !/Get on the <em>Community Wall<\/em>/.test(home.text) && !/Community profiles carousel/.test(home.text));
    check('hero-right panel promotes Poker Wildlife', /class="hc-panel"/.test(home.text) && /class="hc-heading">Poker <em>Wildlife<\/em>/.test(home.text) && /class="hc-eyebrow">\/\/ ATM Field Guide/.test(home.text));
    check('hero-right "Meet the Species" CTA links to the field guide', /<a href="\/stories\/poker-wildlife" class="hc-cta-btn">Meet the Species/.test(home.text));
    check('hero carousel mechanics still present (viewport/track/dots)', /id="hcViewport"/.test(home.text) && /id="hcTrack"/.test(home.text) && /id="hcDots"/.test(home.text));
    const heroTrack = (home.text.split('id="hcTrack">')[1] || '').split('hc-carousel-footer')[0] || '';
    check('hero carousel rotates featured Poker Wildlife species', /href="\/stories\/poker-wildlife\/shark"/.test(heroTrack) && /href="\/stories\/poker-wildlife\/howler-monkey"/.test(heroTrack));
    check('non-featured species NOT in the hero carousel', !/href="\/stories\/poker-wildlife\/whale"/.test(heroTrack));
    check('old hero Community profile slides removed', !/\/players\/manny-the-machine/.test(home.text) && !/Fellow Fish/.test(heroTrack) && !/submit your story and get featured/.test(home.text) && !/Generate your AI poker profile and get featured on the community wall/.test(home.text));
    check('hero carousel inline script still intact in index.html', /COMMUNITY CAROUSEL/.test(idxHtml) && /getElementById\('hcTrack'\)/.test(idxHtml));

    // ── Flash / stale-overwrite bug: the homepage must never be cached ──
    const cc = String(home.headers['cache-control'] || '');
    check('homepage sent with Cache-Control: no-store (no stale/prerender overwrite)', /no-store/.test(cc), cc || '(none)');
    const scriptBlocks = (idxHtml.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || []).join('\n');
    // strip the one known-safe innerHTML (hero carousel dots), then assert nothing else assigns innerHTML
    const scriptsMinusKnown = scriptBlocks.replace(/dotsEl\.innerHTML\s*=\s*'';/g, '');
    check('no homepage inline script injects markup into a content section',
      !/insertAdjacentHTML/.test(scriptBlocks) &&
      !/COMMUNITY_PREVIEW|community-preview|renderCommunity|loadCommunity/.test(scriptBlocks) &&
      !/\.innerHTML\s*=/.test(scriptsMinusKnown) &&
      !/getElementById\(['"](poker-wildlife|community-preview)['"]\)/.test(scriptBlocks));
    check('raw index.html carries no old Community Wall promo markup', !/id="community-preview"|class="cw-track"|their stories, bad beats, and moments of glory/.test(idxHtml));

    // Create species #11 entirely via API
    const create11 = await request('POST', '/api/admin/wildlife', { cookie, body: {
      name: 'The Rock', slug: 'the-rock', animal: 'Rock Crab', tagline: 'Folds for three hours, wins one pot, leaves.',
      status: 'published', display_order: 15, image_url: 'https://res.cloudinary.com/demo/image/upload/rock.webp', image_alt: 'A rock',
    } });
    check('create species #11 via admin API (no code change)', create11.status === 200, create11.text);
    const elevenSlug = JSON.parse(create11.text).slug;
    check('species #11 slug normalized to "the-rock" stays as given', elevenSlug === 'the-rock', elevenSlug);
    const landing3 = await request('GET', '/stories/poker-wildlife');
    check('species count = 4 after #11', /Species Discovered:\s*4/.test(landing3.text));

    // Unpublish #11
    const eleven = JSON.parse(create11.text);
    const unpub = await request('PUT', '/api/admin/wildlife/' + eleven.id, { cookie, body: { ...eleven, status: 'draft' } });
    check('unpublish #11 succeeds', unpub.status === 200, unpub.text);
    const after = await request('GET', '/stories/poker-wildlife/the-rock');
    check('unpublished #11 direct URL 404s', after.status === 404, String(after.status));

    // Edit a seed species, then restart
    const parrot = bySlug['parrot'];
    await request('PUT', '/api/admin/wildlife/' + parrot.id, { cookie, body: { ...parrot, tagline: 'EDITED BY SMOKE TEST' } });

    // Regression: other content types still serve
    for (const [name, p] of [['blog', '/blog'], ['chronicles', '/chronicles'], ['rail', '/rail'], ['community wall', '/community-wall'], ['get featured', '/ai-profile-generator'], ['admin', '/admin'], ['player cards', '/player-cards']]) {
      const r = await request('GET', p);
      check(`${name} still 200`, r.status === 200, `${p} -> ${r.status}`);
    }

    // Regression: Community Wall functionality untouched
    const cwPage = await request('GET', '/community-wall');
    check('Community Wall public page still renders players', cwPage.status === 200 && /community/i.test(cwPage.text));
    const subsApi = await request('GET', '/api/admin/submissions', { cookie });
    check('Community submissions admin API still 200 + array', subsApi.status === 200 && Array.isArray(JSON.parse(subsApi.text)));
    const adminPage = await request('GET', '/admin', { cookie });
    check('Community admin tab still present', /data-panel="communityPanel"/.test(adminPage.text));
    check('Poker Wildlife admin tab also present', /data-panel="wildlifePanel"/.test(adminPage.text));
    const homeNav = await request('GET', '/');
    check('homepage nav keeps Community + Get Featured links', homeNav.text.includes('href="/community-wall"') && homeNav.text.includes('>Get Featured<'));

    await stop(child);

    // ---- Restart: idempotent seed + edits survive ----
    console.log('\nPhase B — restart (idempotency + persistence)');
    child = await startServer();
    const cookie2 = await login();
    list = JSON.parse((await request('GET', '/api/admin/wildlife', { cookie: cookie2 })).text);
    const seedCount = list.species.filter((s) => SEED_SLUGS.includes(s.slug)).length;
    check('restart did NOT duplicate seed species (exactly 10)', seedCount === 10, 'found ' + seedCount);
    const parrot2 = list.species.find((s) => s.slug === 'parrot');
    check('admin edit to seeded species survived restart', parrot2 && parrot2.tagline === 'EDITED BY SMOKE TEST', parrot2 && parrot2.tagline);
    const shark2 = list.species.find((s) => s.slug === 'shark');
    check('published Shark still published after restart', shark2 && shark2.status === 'published');

    await stop(child);

    // ---- Phase C: production environment simulation ----
    console.log('\nPhase C — production simulation (image storage guard)');
    child = await startServer({ NODE_ENV: 'production' });
    const cookie3 = await login();
    list = JSON.parse((await request('GET', '/api/admin/wildlife', { cookie: cookie3 })).text);
    check('env now reports production', list.env && list.env.production === true, JSON.stringify(list.env));

    const turtle = list.species.find((s) => s.slug === 'tanking-turtle');
    const blocked = await request('PUT', '/api/admin/wildlife/' + turtle.id, { cookie: cookie3, body: {
      ...turtle, status: 'published', image_url: '/uploads/turtle-9.png', image_alt: 'A turtle',
    } });
    check('publishing local /uploads image BLOCKED in production (400)', blocked.status === 400, String(blocked.status));
    check('block message mentions persistent storage', /persistent storage/.test(blocked.text), blocked.text);

    const allowed = await request('PUT', '/api/admin/wildlife/' + turtle.id, { cookie: cookie3, body: {
      ...turtle, status: 'published', image_url: 'https://res.cloudinary.com/demo/image/upload/turtle.webp', image_alt: 'A turtle',
    } });
    check('publishing Cloudinary image ALLOWED in production (200)', allowed.status === 200, allowed.text);

    const draftLocalOk = await request('PUT', '/api/admin/wildlife/' + turtle.id, { cookie: cookie3, body: {
      ...turtle, status: 'draft', image_url: '/uploads/turtle-9.png', image_alt: 'A turtle',
    } });
    check('saving DRAFT with local image still allowed in production', draftLocalOk.status === 200, draftLocalOk.text);
  } finally {
    await stop(child);
    try { fs.unlinkSync(DB_FILE); } catch {}
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
