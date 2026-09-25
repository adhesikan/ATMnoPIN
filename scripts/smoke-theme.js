#!/usr/bin/env node
// Smoke test for the site-wide Dark / Light theme (Sprint 1C.3).
// Spawns its own server against a temp SQLite DB; no network, no real data touched.
// Usage: node scripts/smoke-theme.js
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.SMOKE_PORT ? Number(process.env.SMOKE_PORT) : 3989;
const DB_FILE = path.join(os.tmpdir(), `theme-smoke-${Date.now()}.sqlite`);
const BASE = `http://localhost:${PORT}`;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        SQLITE_DB_FILE: DB_FILE,
        DATABASE_URL: '',
        ADMIN_EMAIL: 'theme-smoke@example.com',
        ADMIN_PASSWORD: 'theme-smoke-pw',
        ADMIN_PASSWORD_HASH: '',
        CLOUDINARY_CLOUD_NAME: '',
        CLOUDINARY_UPLOAD_PRESET: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    const onData = (d) => { out += d; if (/ATM is open on port/.test(out)) { clearTimeout(timer); resolve(child); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
}

async function get(p) {
  const res = await fetch(BASE + p, { redirect: 'manual' });
  return { status: res.status, text: await res.text() };
}

// The early script must run in <head> before <body>, and accept only the exact value 'light'.
function checkEarlyScript(label, html) {
  const head = html.split('</head>')[0] || '';
  const bodyStart = html.indexOf('<body');
  const idx = html.indexOf("localStorage.getItem('atm_theme')==='light'");
  check(`${label}: early theme script in <head>`, idx !== -1 && idx < head.length && idx < bodyStart);
  const firstStyle = head.indexOf('<style');
  check(`${label}: early theme script precedes stylesheet`, idx !== -1 && (firstStyle === -1 || idx < firstStyle));
  check(`${label}: only exact 'light' activates light mode`, /getItem\('atm_theme'\)===\s*'light'\)document\.documentElement\.setAttribute\('data-theme','light'\)/.test(head));
  check(`${label}: early script is try/catch guarded`, /<script>try\{if\(localStorage\.getItem\('atm_theme'\)/.test(head) && /\}catch\(_\)\{\}<\/script>/.test(head));
}

function checkToggle(label, html) {
  const btn = html.match(/<button[^>]*data-theme-toggle[^>]*>/);
  check(`${label}: nav has a theme toggle`, !!btn);
  check(`${label}: toggle is a real type="button"`, !!btn && /type="button"/.test(btn[0]));
  check(`${label}: toggle aria-label describes the action`, !!btn && /aria-label="Use light theme"/.test(btn[0]));
  check(`${label}: toggle icons are decorative`, /<span class="theme-icon-sun" aria-hidden="true">/.test(html) && /<span class="theme-icon-moon" aria-hidden="true">/.test(html));
  check(`${label}: toggle persists via localStorage atm_theme`, /localStorage\.setItem\('atm_theme', next\)/.test(html));
  check(`${label}: toggle updates aria-label`, /'Use dark theme' : 'Use light theme'/.test(html));
  check(`${label}: light tokens defined`, /:root\[data-theme="light"\]/.test(html));
  check(`${label}: hamburger still present`, /id="navToggle"/.test(html) && /id="navMoreBtn"/.test(html));
}

(async () => {
  let server;
  try {
    server = await startServer();

    const layoutPages = ['/community', '/stories/poker-wildlife', '/blog', '/chronicles', '/rail', '/player-cards', '/community-wall', '/terms', '/login'];
    for (const p of layoutPages) {
      const r = await get(p);
      check(`${p} renders`, r.status === 200, `status ${r.status}`);
      if (r.status === 200) { checkEarlyScript(p, r.text); checkToggle(p, r.text); }
    }

    // Signed-out /account redirects to sign-in (theme work must not change auth behaviour).
    const acct = await get('/account');
    check('/account (signed out) still redirects', acct.status === 302 || acct.status === 303, `status ${acct.status}`);

    const home = await get('/');
    check('homepage renders', home.status === 200);
    checkEarlyScript('homepage', home.text);
    checkToggle('homepage', home.text);

    const shop = await get('/shop.html');
    check('shop renders', shop.status === 200);
    checkEarlyScript('shop', shop.text);
    checkToggle('shop', shop.text);

    const admin = await get('/admin');
    check('admin renders', admin.status === 200);
    check('admin stays dark (no early script, no toggle)', !/atm_theme/.test(admin.text) && !/data-theme-toggle/.test(admin.text) && /<html lang="en" data-theme="dark">/.test(admin.text));

    // Static: no schema changes, and localStorage is never interpolated into HTML.
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    check('no theme-related schema/DB code', !/CREATE TABLE[^;]*theme/i.test(src) && !/atm_theme[^\n]*(INSERT|UPDATE|SELECT)/i.test(src));
    for (const [name, text] of [['server.js', src], ['index.html', fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')], ['shop.html', fs.readFileSync(path.join(ROOT, 'shop.html'), 'utf8')]]) {
      check(`${name}: stored theme never written into HTML`, !/innerHTML[^\n]*atm_theme|atm_theme[^\n]*innerHTML|document\.write/.test(text));
    }
  } catch (err) {
    console.error(err);
    failures += 1;
  } finally {
    if (server) server.kill();
    for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) { try { fs.unlinkSync(f); } catch (_) {} }
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll theme checks passed');
  process.exit(failures ? 1 : 0);
})();
