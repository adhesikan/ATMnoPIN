const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { Pool } = require('pg');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'blog-posts.json');
const SQLITE_DB_FILE = path.join(__dirname, 'data', 'blog-posts.sqlite');
const DATABASE_URL = process.env.DATABASE_URL || '';

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(path.join(__dirname, '.env'));
loadEnvFile(path.join(__dirname, '.env.example'));
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';

const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(path.dirname(DATA_FILE))) fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');

const sessions = new Map();
const pgPool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
}) : null;
const sqliteDb = !DATABASE_URL ? new Database(SQLITE_DB_FILE) : null;

async function initializeDatabase() {
  if (sqliteDb) {
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS blog_posts (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS chronicles (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS player_submissions (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    return;
  }

  if (pgPool) {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS blog_posts (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS chronicles (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS player_submissions (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }
}

async function migrateLegacyPosts() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const legacyPosts = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!Array.isArray(legacyPosts) || !legacyPosts.length) return;
    const existing = await loadPosts();
    if (!existing.length) await savePosts(legacyPosts);
  } catch {
    // Ignore legacy migration failures and fall back to the live DB store.
  }
}

const SEED_POSTS = [
  {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    title: 'From ATM with No PIN... to ATM with $45,703',
    slug: 'from-atm-with-no-pin-to-atm-with-45703',
    excerpt: 'After a string of tournament bust-outs, I finally made a deep WSOP run, finished 8th for $45,703, and even made PokerNews wearing my ATMwithNoPIN hat. A reminder that poker is a roller coaster—and sometimes the ATM finally pays out.',
    content: `# From ATM with No PIN... to ATM with $45,703

For the past few weeks, I've been donating chips to the poker community like it was a charitable organization.

Monster Stack? Busted.

Bracelet event? Busted.

Circuit event? Also busted.

At one point I was convinced the dealers were just using my chips to make the stacks look prettier.

Then something strange happened...

I stopped busting.

I survived Day 1.

Then Day 2.

Then Day 3.

People actually started asking me how many chips I had instead of, "So... what are you playing next?"

Even PokerNews decided I was worth writing about.

Unfortunately, they only interviewed me after I was eliminated.

The final hand?

I had K♦Q♠ against 10♥10♦.

I shoved.

He called.

The poker gods looked down, shrugged, and produced exactly zero kings and zero queens.

Standard procedure.

Still...

**8th place.**

**$45,703.**

Not exactly the bracelet, but definitely enough to convince myself I'm a world-class player... at least until the next tournament starts.

The best part?

My ATMwithNoPIN hat made it into the PokerNews photos.

Mission accomplished.

People always ask what ATMwithNoPIN means.

Simple.

Sometimes you withdraw money from poker.

Sometimes poker withdraws money from you.

This week...

The ATM actually paid out.

See you at the Main Event.

Let's see if we can make the ATM dispense six figures next time.`,
    tags: ['WSOP', 'Poker', 'Tournament', 'Deep Run', 'Cash', 'PokerNews', 'ATMwithNoPIN', 'Texas Hold\'em'],
    status: 'published',
    featured_image_url: '',
    featured_image_alt: 'Dhesikan Ananchaperumal at the WSOP wearing an ATMwithNoPIN hat.',
    gallery_images: [],
    video_urls: [],
    created_at: '2026-06-27T12:00:00.000Z',
    updated_at: '2026-06-27T12:00:00.000Z',
    published_at: '2026-06-27T12:00:00.000Z',
  },
];

async function seedDefaultPosts() {
  try {
    const existing = await loadPosts();
    const existingSlugs = new Set(existing.map((p) => p.slug));
    const toAdd = SEED_POSTS.filter((p) => !existingSlugs.has(p.slug));
    if (!toAdd.length) return;
    await savePosts([...toAdd, ...existing]);
  } catch {
    // Seed failures are non-fatal.
  }
}

const SEED_CHRONICLES = [
  {
    id: 'c001-terrell-atm-biggest-fan-wsop-2026',
    title: 'Dealer Spotlight: Terrell — My Biggest Fan at the WSOP',
    slug: 'dealer-spotlight-terrell-my-biggest-fan-at-the-wsop',
    excerpt: 'Some players have lucky socks. I have Terrell cheering for me from the rail every chance he gets.',
    category: 'Meet the Crew',
    tags: ['WSOP', 'Horseshoe', 'Hall of Fame Poker Room', 'Dealer Spotlight', 'Terrell', 'ATMwithNoPIN'],
    content: `Every poker player dreams of having a rail.

Mine usually consists of one very enthusiastic dealer named Terrell.

Whenever I'm playing a tournament, Terrell somehow finds time to stop by before work, after work, or during breaks to wish me luck.

Sometimes he even comes and stands on the rail while I'm playing.

At this point, I think he's more confident I'll win a bracelet than I am.

Unfortunately, the poker gods haven't gotten the memo yet.

Terrell keeps believing.

I keep trying.

One of these years we're going to have a very expensive celebration.

**ATMwithNoPIN Rating:**

- Rail Support: 5/5
- Positive Energy: 5/5
- Bracelet Belief Level: Dangerously High
- Luck Transfer Status: Still loading...`,
    status: 'published',
    featured_on_home: true,
    featured_image_url: '',
    featured_image_alt: 'Terrell, dealer at the Horseshoe Hall of Fame Poker Room',
    gallery_images: [],
    video_urls: [],
    crew_nickname: '',
    crew_role: 'Dealer',
    crew_quote: '',
    created_at: '2026-06-27T13:00:00.000Z',
    updated_at: '2026-06-27T13:00:00.000Z',
    published_at: '2026-06-27T13:00:00.000Z',
  },
  {
    id: 'c002-dominick-poker-jesus-tournament-blessings-2026',
    title: 'Dealer Spotlight: Poker Jesus — Dominick\'s Tournament Blessings',
    slug: 'dealer-spotlight-poker-jesus-dominicks-tournament-blessings',
    excerpt: 'Before every tournament, I seek blessings from Poker Jesus himself.',
    category: 'Meet the Crew',
    tags: ['WSOP', 'Horseshoe', 'Hall of Fame Poker Room', 'Dealer Spotlight', 'Dominick', 'Poker Jesus', 'ATMwithNoPIN'],
    content: `Every poker player has a routine before a tournament.

Mine?

Finding Dominick.

Around the Horseshoe poker room, I call him Poker Jesus.

The long hair.

The beard.

The calm smile.

It just fits.

Before every tournament, I ask him for a blessing.

Sometimes it works.

Sometimes apparently the poker gods tell him, "Sorry... pocket aces cracked again."

Regardless of the outcome, the blessing tradition continues.

I'm convinced one day it will finally result in a bracelet.

**ATMwithNoPIN Rating:**

- Blessing Power: 5/5
- Poker Jesus Energy: 5/5
- Beard Game: Championship Level
- Bracelet Miracle Status: Pending`,
    status: 'published',
    featured_on_home: true,
    featured_image_url: '',
    featured_image_alt: 'Dominick, dealer at the Horseshoe Hall of Fame Poker Room',
    gallery_images: [],
    video_urls: [],
    crew_nickname: 'Poker Jesus',
    crew_role: 'Dealer',
    crew_quote: '',
    created_at: '2026-06-27T13:10:00.000Z',
    updated_at: '2026-06-27T13:10:00.000Z',
    published_at: '2026-06-27T13:10:00.000Z',
  },
  {
    id: 'c003-crazy-mike-river-card-fault-2026',
    title: 'Dealer Spotlight: Crazy Mike — The River Card Is Always His Fault',
    slug: 'dealer-spotlight-crazy-mike-the-river-card-is-always-his-fault',
    excerpt: 'The funniest dealer in the room... until he deals me another terrible river.',
    category: 'Meet the Crew',
    tags: ['WSOP', 'Horseshoe', 'Hall of Fame Poker Room', 'Dealer Spotlight', 'Crazy Mike', 'Poker Humor', 'ATMwithNoPIN'],
    content: `Every poker room has one dealer who can make the entire table laugh.

For me, that's Crazy Mike.

His dry sense of humor is legendary.

Whenever he deals me a flop, turn, or river that destroys my hand...

I immediately blame him.

Completely his fault.

Pocket aces cracked?

Mike.

Rivered?

Mike.

Runner-runner straight?

Definitely Mike.

Of course, he reminds me he only deals the cards.

I remind him he could try dealing me better ones.

Our ongoing "argument" has become part of the entertainment every time I sit at one of his tables.

**ATMwithNoPIN Rating:**

- Dry Humor: 5/5
- Bad River Delivery: 5/5
- Ability to Take Blame: Professional Grade
- Dealing Me Winners: Needs Improvement`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'Crazy Mike, dealer at the Horseshoe Hall of Fame Poker Room',
    gallery_images: [],
    video_urls: [],
    crew_nickname: 'Crazy Mike',
    crew_role: 'Dealer',
    crew_quote: '',
    created_at: '2026-06-27T13:20:00.000Z',
    updated_at: '2026-06-27T13:20:00.000Z',
    published_at: '2026-06-27T13:20:00.000Z',
  },
  {
    id: 'c004-frank-keeps-poker-room-running-2026',
    title: 'Floor Spotlight: Frank — The Man Who Keeps the Poker Room Running',
    slug: 'floor-spotlight-frank-the-man-who-keeps-the-poker-room-running',
    excerpt: 'Every great poker room has someone quietly making sure everything works. At the Horseshoe Hall of Fame Poker Room, that\'s Frank.',
    category: 'Meet the Crew',
    tags: ['WSOP', 'Horseshoe', 'Hall of Fame Poker Room', 'Floor Manager', 'Frank', 'Poker Room', 'ATMwithNoPIN'],
    content: `Most players only notice the floor when something goes wrong.

I notice Frank because he's everywhere.

Need a table balanced?

Frank is already on it.

Player has a question?

Frank is there.

Dealer needs help?

Frank is there too.

He's constantly walking the room, solving problems before most people even realize they exist.

The impressive part isn't just how hard he works.

It's that he somehow manages to take care of both the staff and the players while keeping everything moving.

During the WSOP, that's no small task.

Thousands of players.

Hundreds of dealers.

Long days.

Endless decisions.

Yet Frank somehow keeps the poker room running with professionalism and a smile.

The next time you have a smooth experience at the Hall of Fame Poker Room, there's a good chance Frank had something to do with it, even if you never noticed.

Some heroes wear capes.

Some carry a seating list and a radio.

**ATMwithNoPIN Rating:**

- Keeps Games Moving: 5/5
- Staff Support: 5/5
- Player Support: 5/5
- Room Control: Final Table Level`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'Frank, floor manager at the Horseshoe Hall of Fame Poker Room',
    gallery_images: [],
    video_urls: [],
    crew_nickname: '',
    crew_role: 'Floor Manager',
    crew_quote: '',
    created_at: '2026-06-27T13:30:00.000Z',
    updated_at: '2026-06-27T13:30:00.000Z',
    published_at: '2026-06-27T13:30:00.000Z',
  },
];

async function seedDefaultChronicles() {
  try {
    const existing = await loadChronicles();
    const existingSlugs = new Set(existing.map((c) => c.slug));
    const toAdd = SEED_CHRONICLES.filter((c) => !existingSlugs.has(c.slug));
    if (!toAdd.length) return;
    await saveChronicles([...toAdd, ...existing]);
  } catch {
    // Seed failures are non-fatal.
  }
}

async function loadChronicles() {
  if (pgPool) {
    const { rows } = await pgPool.query('SELECT id, data FROM chronicles ORDER BY created_at DESC');
    return rows.map((row) => row.data);
  }
  if (sqliteDb) {
    const rows = sqliteDb.prepare('SELECT id, data FROM chronicles ORDER BY created_at DESC').all();
    return rows.map((row) => JSON.parse(row.data));
  }
  return [];
}

async function saveChronicles(chronicles) {
  if (pgPool) {
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM chronicles');
      for (const c of chronicles) {
        await client.query(
          'INSERT INTO chronicles (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data',
          [c.id, c]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return;
  }
  if (sqliteDb) {
    const stmt = sqliteDb.prepare('INSERT INTO chronicles (id, data) VALUES (?, ?)');
    sqliteDb.exec('BEGIN IMMEDIATE');
    sqliteDb.exec('DELETE FROM chronicles');
    for (const c of chronicles) {
      stmt.run(c.id, JSON.stringify(c));
    }
    sqliteDb.exec('COMMIT');
    return;
  }
}

function estimateReadingTime(content) {
  const words = String(content || '').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 200));
}

const PLAYER_BADGES = ['Final Table Hero', 'Bad Beat Champion', 'River Victim', 'Poker Storyteller', 'Bubble Survivor', 'ATMwithNoPIN Legend'];

const submissionRateLimit = new Map();
function checkSubmissionRateLimit(ip) {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const times = (submissionRateLimit.get(ip) || []).filter((t) => now - t < hour);
  if (times.length >= 3) return false;
  times.push(now);
  submissionRateLimit.set(ip, times);
  return true;
}

function parseMultipartForm(bodyBuffer, boundary) {
  const result = { fields: {}, files: {} };
  const bodyStr = bodyBuffer.toString('binary');
  const sep = `--${boundary}`;
  const parts = bodyStr.split(sep);
  for (const part of parts) {
    if (!part.includes('Content-Disposition:')) continue;
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headers = part.slice(0, headerEnd);
    const rawContent = part.slice(headerEnd + 4);
    const content = rawContent.endsWith('\r\n') ? rawContent.slice(0, -2) : rawContent;
    const nameMatch = headers.match(/name="([^"]+)"/);
    if (!nameMatch) continue;
    const fieldName = nameMatch[1];
    const filenameMatch = headers.match(/filename="([^"]+)"/);
    if (filenameMatch && filenameMatch[1]) {
      result.files[fieldName] = { filename: filenameMatch[1], data: Buffer.from(content, 'binary') };
    } else {
      result.fields[fieldName] = Buffer.from(content, 'binary').toString('utf8');
    }
  }
  return result;
}

function readBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function playerProfileSlug(name, nickname) {
  const base = slugify(nickname || name || 'player');
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${base}-${suffix}`;
}

async function loadSubmissions() {
  if (pgPool) {
    const { rows } = await pgPool.query('SELECT id, data FROM player_submissions ORDER BY created_at DESC');
    return rows.map((row) => row.data);
  }
  if (sqliteDb) {
    const rows = sqliteDb.prepare('SELECT id, data FROM player_submissions ORDER BY created_at DESC').all();
    return rows.map((row) => JSON.parse(row.data));
  }
  return [];
}

async function saveSubmissions(submissions) {
  if (pgPool) {
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM player_submissions');
      for (const s of submissions) {
        await client.query(
          'INSERT INTO player_submissions (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data',
          [s.id, s]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return;
  }
  if (sqliteDb) {
    const stmt = sqliteDb.prepare('INSERT INTO player_submissions (id, data) VALUES (?, ?)');
    sqliteDb.exec('BEGIN IMMEDIATE');
    sqliteDb.exec('DELETE FROM player_submissions');
    for (const s of submissions) {
      stmt.run(s.id, JSON.stringify(s));
    }
    sqliteDb.exec('COMMIT');
    return;
  }
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function sanitizeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .trim()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function loadPostsSync() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function savePostsSync(posts) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(posts, null, 2));
}

async function loadPosts() {
  if (pgPool) {
    const { rows } = await pgPool.query('SELECT id, data FROM blog_posts ORDER BY created_at DESC');
    return rows.map((row) => row.data);
  }

  if (sqliteDb) {
    const rows = sqliteDb.prepare('SELECT id, data FROM blog_posts ORDER BY created_at DESC').all();
    return rows.map((row) => JSON.parse(row.data));
  }

  return loadPostsSync();
}

async function savePosts(posts) {
  if (pgPool) {
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM blog_posts');
      for (const post of posts) {
        await client.query('INSERT INTO blog_posts (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data', [post.id, post]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return;
  }

  if (sqliteDb) {
    const stmt = sqliteDb.prepare('INSERT INTO blog_posts (id, data) VALUES (?, ?)');
    sqliteDb.exec('BEGIN IMMEDIATE');
    sqliteDb.exec('DELETE FROM blog_posts');
    for (const post of posts) {
      stmt.run(post.id, JSON.stringify(post));
    }
    sqliteDb.exec('COMMIT');
    return;
  }

  savePostsSync(posts);
}

function escapeHtml(value) {
  return sanitizeHtml(value);
}

function renderMarkdown(text) {
  const lines = String(text || '').split('\n');
  let html = '';
  let inList = false;

  const flushList = () => {
    if (inList) {
      html += '</ul>';
      inList = false;
    }
  };

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      flushList();
      html += '<br />';
      return;
    }
    if (/^#{1,3}\s+/.test(trimmed)) {
      flushList();
      const level = trimmed.match(/^#+/)[0].length;
      const content = trimmed.replace(/^#{1,3}\s+/, '');
      html += `<h${level}>${escapeHtml(content)}</h${level}>`;
      return;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      if (!inList) {
        html += '<ul>';
        inList = true;
      }
      html += `<li>${escapeHtml(trimmed.replace(/^[-*]\s+/, ''))}</li>`;
      return;
    }
    flushList();
    html += `<p>${escapeHtml(trimmed).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/__(.+?)__/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>').replace(/\[(.+?)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')}</p>`;
  });

  flushList();
  return html;
}

function renderVideoEmbed(videoUrl) {
  if (!videoUrl) return '';
  const url = String(videoUrl).trim();
  if (url.includes('youtube.com/watch?v=')) {
    const id = url.split('v=')[1]?.split('&')[0];
    return `<div class="video-frame"><iframe src="https://www.youtube.com/embed/${id}" title="YouTube video" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>`;
  }
  if (url.includes('youtu.be/')) {
    const id = url.split('youtu.be/')[1]?.split('?')[0];
    return `<div class="video-frame"><iframe src="https://www.youtube.com/embed/${id}" title="YouTube video" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>`;
  }
  if (url.includes('vimeo.com/')) {
    const id = url.split('vimeo.com/')[1]?.split('?')[0];
    return `<div class="video-frame"><iframe src="https://player.vimeo.com/video/${id}" title="Vimeo video" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe></div>`;
  }
  return `<p class="body-text">Video URL: <a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a></p>`;
}

function renderLayout(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="ATMwithNoPIN™ Poker blog and admin publishing system for table stories, updates, and bad beats." />
  <style>
    :root { --black:#0a0a0a; --green:#00c853; --green-dim:#007a33; --gold:#c9a84c; --offwhite:#f0ece0; --gray:#999; }
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family: 'DM Mono', monospace; background: var(--black); color: var(--offwhite); line-height:1.7; }
    a { color: var(--green); text-decoration: none; }
    .shell { max-width: 1200px; margin: 0 auto; padding: 0 1rem 3rem; }
    nav { display:flex; justify-content:space-between; align-items:center; gap:1rem; padding:1rem 0; border-bottom:1px solid #1e1e1e; }
    .nav-links { display:flex; gap:1rem; list-style:none; flex-wrap:wrap; }
    .nav-links a { color: #c6c6c6; font-size: .75rem; text-transform: uppercase; letter-spacing: .12em; }
    .pill { display:inline-block; padding: .35rem .65rem; border:1px solid #2a2a2a; border-radius:999px; color: var(--green); font-size:.68rem; text-transform:uppercase; letter-spacing:.12em; }
    .hero { padding: 2rem 0 1rem; }
    .eyebrow { text-transform:uppercase; letter-spacing:.25em; color: var(--green); font-size:.68rem; }
    h1, h2, h3 { font-family: 'DM Serif Display', serif; color: var(--offwhite); }
    h1 { font-size: clamp(2.6rem, 6vw, 4.8rem); line-height:1; margin-top:.5rem; }
    h2 { font-size: clamp(1.6rem, 4vw, 2.2rem); margin: 1rem 0; }
    .grid { display:grid; grid-template-columns:1.2fr .8fr; gap:1rem; }
    .card { border:1px solid #1e1e1e; background:#0c0c0c; padding:1rem; border-radius:14px; }
    .card p, .body-text { color: var(--gray); font-size:.88rem; }
    .tag { display:inline-block; background: rgba(0,200,83,.12); color: var(--green); border:1px solid rgba(0,200,83,.18); border-radius:999px; padding:.25rem .5rem; font-size:.65rem; text-transform:uppercase; letter-spacing:.12em; margin-right:.35rem; }
    .posts { display:grid; gap:1rem; margin-top:1rem; }
    .post-card { border:1px solid #1e1e1e; background:#101010; padding:1rem; border-radius:14px; }
    .post-card img, .gallery img { width:100%; border-radius:12px; border:1px solid #222; display:block; }
    .meta, .small { color: var(--gray); font-size:.72rem; text-transform: uppercase; letter-spacing:.12em; }
    .video-frame { position:relative; padding-bottom:56.25%; height:0; overflow:hidden; border-radius:14px; border:1px solid #242424; margin-top:.75rem; }
    .video-frame iframe { position:absolute; inset:0; width:100%; height:100%; border:0; }
    .gallery { display:grid; grid-template-columns:repeat(2,1fr); gap:.75rem; }
    .form-grid { display:grid; gap:.75rem; }
    label { display:grid; gap:.35rem; font-size:.78rem; color: var(--gray); text-transform:uppercase; letter-spacing:.12em; }
    input, textarea, select { width:100%; border:1px solid #242424; background:#121212; color: var(--offwhite); padding:.8rem .9rem; border-radius:10px; font: inherit; }
    textarea { min-height: 120px; }
    button { border:1px solid #243b2e; background: linear-gradient(180deg, #0f3a1d, #072213); color: var(--offwhite); border-radius:10px; padding:.75rem 1rem; cursor:pointer; font:inherit; text-transform:uppercase; letter-spacing:.12em; }
    button.secondary { background:#111; border-color:#242424; }
    .row { display:flex; gap:.75rem; flex-wrap:wrap; }
    .notice { border:1px solid #1e1e1e; background:#111; padding:.8rem; color: var(--offwhite); border-radius:12px; font-size:.82rem; }
    .preview { border:1px dashed #2e2e2e; background:#0b0b0b; padding:1rem; border-radius:12px; color: var(--gray); }
    .footer { border-top:1px solid #1e1e1e; padding:1rem 0; color:#555; font-size:.7rem; text-transform:uppercase; letter-spacing:.12em; }
    @media (max-width: 980px) { .grid { grid-template-columns:1fr; } .gallery { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <div class="shell">
    <nav>
      <a href="/" style="color:var(--green); font-weight:700; text-transform:uppercase; letter-spacing:.18em;">ATMwithNoPIN™</a>
      <ul class="nav-links">
        <li><a href="/blog">Blog</a></li>
        <li><a href="/chronicles">Chronicles</a></li>
        <li><a href="/community-wall">Community</a></li>
        <li><a href="/">Home</a></li>
      </ul>
    </nav>
    ${body}
    <div class="footer">ATMwithNoPIN™ poker entertainment brand operated by Sunfish Technologies LLC. All rights reserved.</div>
  </div>
</body>
</html>`;
}

function renderBlogListPage(posts) {
  const items = posts
    .filter((post) => post.status === 'published')
    .sort((a, b) => new Date(b.published_at || b.created_at) - new Date(a.published_at || a.created_at));

  const cards = items.map((post) => `
    <article class="post-card">
      ${post.featured_image_url ? `<img src="${escapeHtml(post.featured_image_url)}" alt="${escapeHtml(post.featured_image_alt || post.title)}" />` : ''}
      <p class="meta">${escapeHtml(post.published_at ? new Date(post.published_at).toLocaleDateString() : new Date(post.created_at).toLocaleDateString())}</p>
      <h2><a href="/blog/${escapeHtml(post.slug)}">${escapeHtml(post.title)}</a></h2>
      <p class="body-text">${escapeHtml(post.excerpt || '')}</p>
      <div style="margin-top:.5rem;">${(post.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>
    </article>`).join('');

  return renderLayout('ATMwithNoPIN™ Blog | Table Stories', `
    <section class="hero">
      <p class="eyebrow">Latest from the ATM</p>
      <h1>Table Stories &amp; Bad Beats</h1>
      <p class="body-text" style="max-width:60ch;">A simple admin-friendly blog for tournament updates, Foxwoods sessions, funny hands, and the stories that make the ATMwithNoPIN™ brand feel like a real poker entertainment table.</p>
    </section>
    <section class="posts">${cards || '<div class="notice">No published posts yet. Create one in the admin area.</div>'}</section>`);
}

function renderBlogPostPage(post) {
  const gallery = (post.gallery_images || []).map((img) => `
    <figure class="card">
      <img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.alt || post.title)}" />
      ${img.alt ? `<p class="small" style="margin-top:.5rem;">${escapeHtml(img.alt)}</p>` : ''}
    </figure>`).join('');

  return renderLayout(`${post.title} | ATMwithNoPIN™ Poker`, `
    <section class="hero">
      <p class="eyebrow">${escapeHtml(post.status || 'Published')}</p>
      <h1>${escapeHtml(post.title)}</h1>
      <p class="meta">${escapeHtml(post.published_at ? new Date(post.published_at).toLocaleDateString() : new Date(post.created_at).toLocaleDateString())}</p>
      <div style="margin-top:.5rem;">${(post.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>
    </section>
    <section class="grid" style="margin-top:1rem;">
      <article class="card">
        ${post.featured_image_url ? `<img src="${escapeHtml(post.featured_image_url)}" alt="${escapeHtml(post.featured_image_alt || post.title)}" style="margin-bottom:.75rem;" />` : ''}
        <p class="body-text">${escapeHtml(post.excerpt || '')}</p>
        <div style="margin-top:.8rem;">${renderMarkdown(post.content || '')}</div>
        ${(post.video_urls || []).map((url) => renderVideoEmbed(url)).join('')}
      </article>
      ${gallery ? `<aside class="card"><h2>Table Notes</h2><div class="gallery" style="margin-top:1rem;">${gallery}</div></aside>` : ''}
    </section>`);
}

function renderAdminPage() {
  const chronCatOptions = CHRON_CATEGORIES.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  return renderLayout('ATMwithNoPIN™ Admin', `
    <style>
      .admin-tabs{display:flex;gap:.5rem;margin-top:1.5rem;margin-bottom:1rem;border-bottom:1px solid #1e1e1e;padding-bottom:.75rem;}
      .admin-tab{border:1px solid #242424;background:#111;color:#888;border-radius:8px;padding:.4rem .9rem;font:.72rem 'DM Mono',monospace;text-transform:uppercase;letter-spacing:.1em;cursor:pointer;transition:all .2s;}
      .admin-tab.active{background:rgba(0,200,83,.1);border-color:rgba(0,200,83,.35);color:var(--green);}
    </style>
    <section class="hero">
      <p class="eyebrow">Admin</p>
      <h1>Publishing Dashboard</h1>
      <p class="body-text" style="max-width:60ch;">Manage blog posts and Hall of Fame Chronicles.</p>
    </section>
    <div class="admin-tabs">
      <button class="admin-tab active" data-panel="blogPanel">Blog Posts</button>
      <button class="admin-tab" data-panel="chronPanel">Chronicles</button>
      <button class="admin-tab" data-panel="communityPanel">Community</button>
    </div>
    <div id="blogPanel">
    <section class="grid">
      <article class="card">
        <h2>Create / Edit Post</h2>
        <div class="form-grid">
          <div class="notice">Required fields: Title, Excerpt, Body, and Status.</div>
          <label>Title *<input id="title" type="text" required placeholder="The river call nobody saw coming" /></label>
          <label>Slug *<input id="slug" type="text" required placeholder="river-call-nobody-saw-coming" /></label>
          <label>Excerpt *<textarea id="excerpt" required placeholder="A short summary for the blog list and social preview."></textarea></label>
          <label>Body (Markdown supported) *<textarea id="content" required placeholder="# Big hand recap\n\n- one line\n- another line"></textarea></label>
          <label>Tags<input id="tags" type="text" placeholder="Foxwoods, Bad Beat, Funny Hand" /></label>
          <label>Status *<select id="status" required><option value="draft">Draft</option><option value="published">Published</option></select></label>
          <label>Featured image URL<input id="featured_image_url" type="text" placeholder="https://..." /></label>
          <label>Featured image alt<input id="featured_image_alt" type="text" placeholder="Dhezz at the table" /></label>
          <label>Video URLs (one per line)<textarea id="video_urls" placeholder="https://www.youtube.com/watch?v=..."></textarea></label>
          <label>Featured image upload<input id="featuredFile" type="file" accept="image/png,image/jpeg,image/webp" /></label>
          <label>Gallery image uploads<input id="galleryFiles" type="file" accept="image/png,image/jpeg,image/webp" multiple /></label>
          <div class="row">
            <button id="saveBtn" type="button">Save Post</button>
            <button id="previewBtn" class="secondary" type="button">Preview</button>
            <button id="newBtn" class="secondary" type="button">New Post</button>
            <button id="logoutBtn" class="secondary" type="button">Logout</button>
          </div>
          <div class="notice" id="statusBox">Ready to publish.</div>
          <div class="preview" id="previewBox"></div>
        </div>
      </article>
      <aside class="card">
        <h2>Existing Posts</h2>
        <div id="postList" class="form-grid"></div>
      </aside>
    </section>
    <script>
      const state = { id: null };
      const statusBox = document.getElementById('statusBox');
      const previewBox = document.getElementById('previewBox');
      function setStatus(msg, tone='info') { statusBox.textContent = msg; statusBox.style.borderColor = tone === 'ok' ? '#1f5c31' : tone === 'bad' ? '#5c1f1f' : '#1e1e1e'; }
      async function loadPosts() {
        const res = await fetch('/api/admin/posts');
        const posts = await res.json();
        const list = document.getElementById('postList');
        list.innerHTML = posts.map(function(post) {
          return '<div class="card"><strong>' + post.title + '</strong><p class="small">' + post.status + ' · ' + post.slug + '</p><div class="row"><button class="secondary" data-action="edit" data-id="' + post.id + '">Edit</button><button class="secondary" data-action="delete" data-id="' + post.id + '">Delete</button></div></div>';
        }).join('');
      }
      async function uploadFile(file, kind) {
        const form = new FormData();
        form.append('file', file);
        form.append('kind', kind);
        const res = await fetch('/api/admin/upload', { method: 'POST', body: form });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        return data;
      }
      async function savePost() {
        try {
          setStatus('Saving post…');
          const title = document.getElementById('title').value.trim();
          const slug = document.getElementById('slug').value.trim() || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
          const excerpt = document.getElementById('excerpt').value.trim();
          const content = document.getElementById('content').value.trim();
          const tags = document.getElementById('tags').value.split(',').map(t => t.trim()).filter(Boolean);
          const status = document.getElementById('status').value;
          if (!title || !excerpt || !content || !status) {
            setStatus('Please fill in Title, Excerpt, Body, and Status before saving.', 'bad');
            return;
          }
          const featured_image_url = document.getElementById('featured_image_url').value.trim();
          const featured_image_alt = document.getElementById('featured_image_alt').value.trim();
          const video_urls = document.getElementById('video_urls').value.split('\\n').map(v => v.trim()).filter(Boolean);
          const featuredFile = document.getElementById('featuredFile').files[0];
          const galleryFiles = Array.from(document.getElementById('galleryFiles').files);
          let featuredImage = featured_image_url ? { url: featured_image_url, alt: featured_image_alt } : null;
          if (featuredFile) {
            const uploaded = await uploadFile(featuredFile, 'featured');
            featuredImage = { url: uploaded.url, alt: featured_image_alt || uploaded.alt || title };
          }
          const galleryImages = [];
          for (const file of galleryFiles) {
            const uploaded = await uploadFile(file, 'gallery');
            galleryImages.push({ url: uploaded.url, alt: uploaded.alt || title });
          }
          const body = { id: state.id, title, slug, excerpt, content, tags, status, featured_image_url: featuredImage?.url || '', featured_image_alt: featuredImage?.alt || '', gallery_images: galleryImages, video_urls: video_urls };
          const res = await fetch('/api/admin/posts' + (state.id ? '/' + state.id : ''), { method: state.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Save failed');
          state.id = data.id;
          await loadPosts();
          setStatus('Post saved successfully.', 'ok');
        } catch (error) {
          setStatus(error.message, 'bad');
        }
      }
      function renderPreview() {
        const title = document.getElementById('title').value || 'Post preview';
        const excerpt = document.getElementById('excerpt').value || 'Preview excerpt';
        const content = document.getElementById('content').value || 'Preview body';
        previewBox.innerHTML = '<h3>' + title + '</h3><p class="small">Preview</p><p>' + excerpt + '</p><pre style="white-space:pre-wrap;color:#ddd;">' + content + '</pre>';
      }
      document.getElementById('saveBtn').addEventListener('click', savePost);
      document.getElementById('previewBtn').addEventListener('click', renderPreview);
      document.getElementById('newBtn').addEventListener('click', () => { state.id = null; document.querySelectorAll('input, textarea, select').forEach(el => { if (el.id !== 'status') el.value=''; }); document.getElementById('status').value='draft'; setStatus('New post form ready.'); });
      document.getElementById('logoutBtn').addEventListener('click', async () => { await fetch('/api/admin/logout',{method:'POST'}); window.location.href='/admin'; });
      document.getElementById('postList').addEventListener('click', async (event) => {
        const btn = event.target.closest('button');
        if (!btn) return;
        const id = btn.getAttribute('data-id');
        if (btn.getAttribute('data-action') === 'delete') {
          const res = await fetch('/api/admin/posts/' + id, { method: 'DELETE' });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Delete failed');
          await loadPosts();
          setStatus('Post deleted.', 'ok');
          return;
        }
        const res = await fetch('/api/admin/posts/' + id);
        const post = await res.json();
        state.id = post.id;
        document.getElementById('title').value = post.title || '';
        document.getElementById('slug').value = post.slug || '';
        document.getElementById('excerpt').value = post.excerpt || '';
        document.getElementById('content').value = post.content || '';
        document.getElementById('tags').value = (post.tags || []).join(', ');
        document.getElementById('status').value = post.status || 'draft';
        document.getElementById('featured_image_url').value = post.featured_image_url || '';
        document.getElementById('featured_image_alt').value = post.featured_image_alt || '';
        document.getElementById('video_urls').value = (post.video_urls || []).join('\\n');
        setStatus('Post loaded for editing.', 'ok');
      });
      loadPosts();
    </script>
    </div><!-- end blogPanel -->
    <div id="chronPanel" style="display:none;">
    <section class="grid">
      <article class="card">
        <h2>Create / Edit Chronicle</h2>
        <div class="form-grid">
          <div class="notice">Required: Title, Category, Excerpt, Body, Status.</div>
          <label>Title *<input id="cTitle" type="text" required placeholder="Dealer Spotlight: ..." /></label>
          <label>Slug<input id="cSlug" type="text" placeholder="auto-generated from title" /></label>
          <label>Category *<select id="cCategory"><option value="">-- Select Category --</option>${chronCatOptions}</select></label>
          <label>Excerpt *<textarea id="cExcerpt" required placeholder="One-line teaser..."></textarea></label>
          <label>Body (Markdown) *<textarea id="cContent" required style="min-height:180px;" placeholder="Every poker room has one dealer..."></textarea></label>
          <label>Tags<input id="cTags" type="text" placeholder="WSOP, Horseshoe, Dealer Spotlight" /></label>
          <label>Status *<select id="cStatus"><option value="draft">Draft</option><option value="published">Published</option></select></label>
          <label><input id="cFeaturedHome" type="checkbox" style="width:auto;margin-right:.4rem;" /> Feature on Homepage</label>
          <label>Featured image URL<input id="cFeatImgUrl" type="text" placeholder="https://..." /></label>
          <label>Featured image alt<input id="cFeatImgAlt" type="text" placeholder="Descriptive alt text" /></label>
          <label>Featured image upload<input id="cFeatFile" type="file" accept="image/png,image/jpeg,image/webp" /></label>
          <label>Gallery uploads<input id="cGallFiles" type="file" accept="image/png,image/jpeg,image/webp" multiple /></label>
          <label>Video URLs (one per line)<textarea id="cVideoUrls" placeholder="https://youtube.com/watch?v=..."></textarea></label>
          <label>Nickname (Meet the Crew)<input id="cNickname" type="text" placeholder="Poker Jesus" /></label>
          <label>Role (Meet the Crew)<input id="cRole" type="text" placeholder="Dealer" /></label>
          <label>Favorite Quote<input id="cQuote" type="text" placeholder="\"Patience.\"" /></label>
          <div class="row">
            <button id="cSaveBtn" type="button">Save Chronicle</button>
            <button id="cNewBtn" class="secondary" type="button">New Chronicle</button>
            <button id="cLogoutBtn" class="secondary" type="button">Logout</button>
          </div>
          <div class="notice" id="cStatusBox">Ready to publish.</div>
        </div>
      </article>
      <aside class="card">
        <h2>Existing Chronicles</h2>
        <div id="cList" class="form-grid"></div>
      </aside>
    </section>
    <script>
      var cState = { id: null };
      var cStatusBox = document.getElementById('cStatusBox');
      function cSetStatus(msg, tone) { cStatusBox.textContent = msg; cStatusBox.style.borderColor = tone === 'ok' ? '#1f5c31' : tone === 'bad' ? '#5c1f1f' : '#1e1e1e'; }
      async function cLoadList() {
        var res = await fetch('/api/admin/chronicles');
        var items = await res.json();
        var list = document.getElementById('cList');
        list.innerHTML = items.map(function(c) {
          return '<div class="card"><strong>' + c.title + '</strong><p class="small">' + (c.status || 'draft') + ' · ' + (c.category || '') + ' · ' + c.slug + '</p><div class="row"><button class="secondary" data-caction="edit" data-cid="' + c.id + '">Edit</button><button class="secondary" data-caction="delete" data-cid="' + c.id + '">Delete</button></div></div>';
        }).join('');
      }
      async function cUploadFile(file, kind) {
        var form = new FormData(); form.append('file', file); form.append('kind', kind);
        var res = await fetch('/api/admin/upload', { method: 'POST', body: form });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        return data;
      }
      async function cSave() {
        try {
          cSetStatus('Saving…');
          var title = document.getElementById('cTitle').value.trim();
          var slug = document.getElementById('cSlug').value.trim() || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
          var category = document.getElementById('cCategory').value;
          var excerpt = document.getElementById('cExcerpt').value.trim();
          var content = document.getElementById('cContent').value.trim();
          var tags = document.getElementById('cTags').value.split(',').map(function(t) { return t.trim(); }).filter(Boolean);
          var status = document.getElementById('cStatus').value;
          var featured_on_home = document.getElementById('cFeaturedHome').checked;
          if (!title || !category || !excerpt || !content || !status) { cSetStatus('Fill in Title, Category, Excerpt, Body, and Status.', 'bad'); return; }
          var featUrl = document.getElementById('cFeatImgUrl').value.trim();
          var featAlt = document.getElementById('cFeatImgAlt').value.trim();
          var featFile = document.getElementById('cFeatFile').files[0];
          var gallFiles = Array.from(document.getElementById('cGallFiles').files);
          var videoUrls = document.getElementById('cVideoUrls').value.split('\\n').map(function(v) { return v.trim(); }).filter(Boolean);
          var crew_nickname = document.getElementById('cNickname').value.trim();
          var crew_role = document.getElementById('cRole').value.trim();
          var crew_quote = document.getElementById('cQuote').value.trim();
          if (featFile) { var up = await cUploadFile(featFile, 'featured'); featUrl = up.url; if (!featAlt) featAlt = up.alt || title; }
          var galleryImages = [];
          for (var gf of gallFiles) { var gu = await cUploadFile(gf, 'gallery'); galleryImages.push({ url: gu.url, alt: gu.alt || title }); }
          var payload = { id: cState.id, title, slug, category, excerpt, content, tags, status, featured_on_home, featured_image_url: featUrl, featured_image_alt: featAlt, gallery_images: galleryImages, video_urls: videoUrls, crew_nickname, crew_role, crew_quote };
          var res2 = await fetch('/api/admin/chronicles' + (cState.id ? '/' + cState.id : ''), { method: cState.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          var data2 = await res2.json();
          if (!res2.ok) throw new Error(data2.error || 'Save failed');
          cState.id = data2.id;
          await cLoadList();
          cSetStatus('Chronicle saved.', 'ok');
        } catch(e) { cSetStatus(e.message, 'bad'); }
      }
      document.getElementById('cSaveBtn').addEventListener('click', cSave);
      document.getElementById('cNewBtn').addEventListener('click', function() {
        cState.id = null;
        ['cTitle','cSlug','cExcerpt','cContent','cTags','cFeatImgUrl','cFeatImgAlt','cVideoUrls','cNickname','cRole','cQuote'].forEach(function(id) { document.getElementById(id).value = ''; });
        document.getElementById('cCategory').value = '';
        document.getElementById('cStatus').value = 'draft';
        document.getElementById('cFeaturedHome').checked = false;
        cSetStatus('New chronicle form ready.');
      });
      document.getElementById('cLogoutBtn').addEventListener('click', async function() { await fetch('/api/admin/logout',{method:'POST'}); window.location.href='/admin'; });
      document.getElementById('cList').addEventListener('click', async function(ev) {
        var btn = ev.target.closest('button'); if (!btn) return;
        var id = btn.getAttribute('data-cid'); var action = btn.getAttribute('data-caction');
        if (action === 'delete') {
          var dr = await fetch('/api/admin/chronicles/' + id, { method: 'DELETE' });
          var dd = await dr.json(); if (!dr.ok) throw new Error(dd.error || 'Delete failed');
          await cLoadList(); cSetStatus('Deleted.', 'ok'); return;
        }
        var er = await fetch('/api/admin/chronicles/' + id); var c = await er.json();
        cState.id = c.id;
        document.getElementById('cTitle').value = c.title || '';
        document.getElementById('cSlug').value = c.slug || '';
        document.getElementById('cCategory').value = c.category || '';
        document.getElementById('cExcerpt').value = c.excerpt || '';
        document.getElementById('cContent').value = c.content || '';
        document.getElementById('cTags').value = (c.tags || []).join(', ');
        document.getElementById('cStatus').value = c.status || 'draft';
        document.getElementById('cFeaturedHome').checked = !!c.featured_on_home;
        document.getElementById('cFeatImgUrl').value = c.featured_image_url || '';
        document.getElementById('cFeatImgAlt').value = c.featured_image_alt || '';
        document.getElementById('cVideoUrls').value = (c.video_urls || []).join('\\n');
        document.getElementById('cNickname').value = c.crew_nickname || '';
        document.getElementById('cRole').value = c.crew_role || '';
        document.getElementById('cQuote').value = c.crew_quote || '';
        cSetStatus('Chronicle loaded.', 'ok');
      });
      cLoadList();
    </script>
    </div><!-- end chronPanel -->
    <div id="communityPanel" style="display:none;">
    <section class="grid">
      <article class="card" style="grid-column:1/-1;">
        <h2>Community Submissions</h2>
        <div id="subStats" class="row" style="margin:.75rem 0;gap:.5rem;flex-wrap:wrap;"></div>
        <div class="row" style="margin-bottom:.75rem;gap:.5rem;">
          <button class="secondary" data-subfilter="all" id="sfAll">All</button>
          <button class="secondary" data-subfilter="pending" id="sfPending">Pending</button>
          <button class="secondary" data-subfilter="approved" id="sfApproved">Approved</button>
          <button class="secondary" data-subfilter="rejected" id="sfRejected">Rejected</button>
        </div>
        <div id="subList" class="form-grid"></div>
      </article>
    </section>
    <style>
      .sub-card{border:1px solid #1e1e1e;background:#0c0c0c;border-radius:12px;overflow:hidden;margin-bottom:.5rem;}
      .sub-header{display:flex;align-items:center;gap:.75rem;padding:.75rem 1rem;cursor:pointer;}
      .sub-thumb{width:44px;height:44px;border-radius:50%;object-fit:cover;border:1px solid #2a2a2a;flex-shrink:0;}
      .sub-thumb-ph{width:44px;height:44px;border-radius:50%;border:1px solid #2a2a2a;background:#0d2e1a;display:flex;align-items:center;justify-content:center;font-family:'Bebas Neue',sans-serif;font-size:1.4rem;color:var(--green);flex-shrink:0;}
      .sub-info{flex:1;min-width:0;}
      .sub-info strong{display:block;font-size:.88rem;}
      .sub-info em{font-size:.78rem;color:var(--gold);}
      .sub-pill{border-radius:999px;padding:.2rem .5rem;font-size:.6rem;text-transform:uppercase;letter-spacing:.1em;}
      .sub-pending{background:rgba(201,168,76,.1);color:var(--gold);border:1px solid rgba(201,168,76,.3);}
      .sub-approved{background:rgba(0,200,83,.1);color:var(--green);border:1px solid rgba(0,200,83,.3);}
      .sub-rejected{background:rgba(200,50,50,.1);color:#e06060;border:1px solid rgba(200,50,50,.3);}
      .sub-detail{padding:.75rem 1rem;border-top:1px solid #1a1a1a;display:none;}
      .sub-field{margin-bottom:.5rem;}
      .sub-field-lbl{font-size:.6rem;text-transform:uppercase;letter-spacing:.15em;color:var(--gray);margin-bottom:.15rem;}
      .sub-field-val{font-size:.82rem;color:var(--offwhite);}
      .sub-actions{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.75rem;padding-top:.75rem;border-top:1px solid #1a1a1a;}
    </style>
    <script>
    var subFilter = 'all';
    var allSubs = [];
    async function loadSubList() {
      var res = await fetch('/api/admin/submissions');
      allSubs = await res.json();
      renderSubList();
    }
    function renderSubList() {
      var filtered = subFilter === 'all' ? allSubs : allSubs.filter(function(s) { return s.status === subFilter; });
      var pending = allSubs.filter(function(s) { return s.status === 'pending'; }).length;
      var approved = allSubs.filter(function(s) { return s.status === 'approved'; }).length;
      document.getElementById('subStats').innerHTML =
        '<span class="sub-pill sub-pending">Pending: ' + pending + '</span>' +
        '<span class="sub-pill sub-approved">Approved: ' + approved + '</span>' +
        '<span class="sub-pill sub-rejected">Rejected: ' + (allSubs.length - pending - approved) + '</span>';
      var badgeOptions = ${JSON.stringify(PLAYER_BADGES)}.map(function(b) { return '<option value="' + b + '">' + b + '</option>'; }).join('');
      document.getElementById('subList').innerHTML = filtered.length ? filtered.map(function(s) {
        var thumb = s.photo_url
          ? '<img class="sub-thumb" src="' + s.photo_url + '" alt="" />'
          : '<div class="sub-thumb-ph">' + ((s.nickname||s.name||'?')[0]||'?').toUpperCase() + '</div>';
        var pill = '<span class="sub-pill sub-' + s.status + '">' + s.status + '</span>';
        return '<div class="sub-card" id="sc-' + s.id + '">'
          + '<div class="sub-header" data-subid="' + s.id + '" onclick="toggleSubDetail(\'' + s.id + '\')">'
          + thumb + '<div class="sub-info"><strong>' + (s.name||'Unnamed') + '</strong>' + (s.nickname ? '<em>&quot;' + s.nickname + '&quot;</em>' : '') + '<p class="small">' + (s.city||'') + ' · ' + new Date(s.created_at).toLocaleDateString() + '</p></div>' + pill
          + '</div>'
          + '<div class="sub-detail" id="sd-' + s.id + '">'
          + (s.email ? '<div class="sub-field"><div class="sub-field-lbl">Email</div><div class="sub-field-val">' + s.email + '</div></div>' : '')
          + (s.favorite_game ? '<div class="sub-field"><div class="sub-field-lbl">Favorite Game</div><div class="sub-field-val">' + s.favorite_game + '</div></div>' : '')
          + (s.biggest_accomplishment ? '<div class="sub-field"><div class="sub-field-lbl">Biggest Accomplishment</div><div class="sub-field-val">' + s.biggest_accomplishment + '</div></div>' : '')
          + (s.funny_story ? '<div class="sub-field"><div class="sub-field-lbl">Funny Story</div><div class="sub-field-val">' + s.funny_story + '</div></div>' : '')
          + (s.bad_beat_story ? '<div class="sub-field"><div class="sub-field-lbl">Bad Beat Story</div><div class="sub-field-val">' + s.bad_beat_story + '</div></div>' : '')
          + (s.social_link ? '<div class="sub-field"><div class="sub-field-lbl">Social Link</div><div class="sub-field-val"><a href="' + s.social_link + '" target="_blank" rel="noopener">' + s.social_link + '</a></div></div>' : '')
          + (s.admin_notes ? '<div class="sub-field"><div class="sub-field-lbl">Admin Notes</div><div class="sub-field-val">' + s.admin_notes + '</div></div>' : '')
          + '<div class="sub-actions">'
          + (s.status !== 'approved' ? '<select id="badge-' + s.id + '" style="width:auto;padding:.4rem .6rem;font-size:.72rem;"><option value="">No Badge</option>' + badgeOptions + '</select>' : '')
          + (s.status !== 'approved' ? '<button class="secondary" onclick="subApprove(\'' + s.id + '\')">Approve</button>' : '')
          + (s.status !== 'rejected' ? '<button class="secondary" onclick="subReject(\'' + s.id + '\')">Reject</button>' : '')
          + '<button class="secondary" onclick="subToggleHome(\'' + s.id + '\')">' + (s.featured_on_home ? 'Unfeature Home' : 'Feature Home') + '</button>'
          + '<input id="notes-' + s.id + '" type="text" style="width:auto;flex:1;min-width:120px;padding:.4rem .6rem;font-size:.72rem;" placeholder="Add note..." value="' + (s.admin_notes||'').replace(/"/g,'&quot;') + '" />'
          + '<button class="secondary" onclick="subSaveNotes(\'' + s.id + '\')">Save Note</button>'
          + '<button class="secondary" onclick="subDelete(\'' + s.id + '\')">Delete</button>'
          + '</div>'
          + '</div>'
          + '</div>';
      }).join('') : '<div class="notice">No submissions in this category.</div>';
    }
    function toggleSubDetail(id) {
      var el = document.getElementById('sd-' + id);
      if (el) el.style.display = el.style.display === 'none' || !el.style.display ? '' : 'none';
    }
    async function subApprove(id) {
      var badge = document.getElementById('badge-' + id);
      var payload = { status: 'approved' };
      if (badge && badge.value) payload.badge = badge.value;
      await subUpdate(id, payload);
    }
    async function subReject(id) { await subUpdate(id, { status: 'rejected' }); }
    async function subToggleHome(id) {
      var s = allSubs.find(function(x) { return x.id === id; });
      if (s) await subUpdate(id, { featured_on_home: !s.featured_on_home });
    }
    async function subSaveNotes(id) {
      var el = document.getElementById('notes-' + id);
      if (el) await subUpdate(id, { admin_notes: el.value });
    }
    async function subDelete(id) {
      if (!confirm('Delete this submission?')) return;
      var res = await fetch('/api/admin/submissions/' + id, { method: 'DELETE' });
      if (res.ok) { allSubs = allSubs.filter(function(s) { return s.id !== id; }); renderSubList(); }
    }
    async function subUpdate(id, patch) {
      var res = await fetch('/api/admin/submissions/' + id, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(patch) });
      var data = await res.json();
      if (res.ok) {
        var idx = allSubs.findIndex(function(s) { return s.id === id; });
        if (idx !== -1) allSubs[idx] = data;
        renderSubList();
      } else { alert(data.error || 'Update failed'); }
    }
    ['sfAll','sfPending','sfApproved','sfRejected'].forEach(function(btnId) {
      var el = document.getElementById(btnId);
      if (el) el.addEventListener('click', function() { subFilter = btnId.replace('sf','').toLowerCase(); renderSubList(); });
    });
    loadSubList();
    </script>
    </div><!-- end communityPanel -->
    <script>
      document.querySelectorAll('.admin-tab').forEach(function(btn) {
        btn.addEventListener('click', function() {
          document.querySelectorAll('.admin-tab').forEach(function(b) { b.classList.remove('active'); });
          btn.classList.add('active');
          document.getElementById('blogPanel').style.display = btn.dataset.panel === 'blogPanel' ? '' : 'none';
          document.getElementById('chronPanel').style.display = btn.dataset.panel === 'chronPanel' ? '' : 'none';
          document.getElementById('communityPanel').style.display = btn.dataset.panel === 'communityPanel' ? '' : 'none';
        });
      });
    </script>
    <section class="card" style="margin-top:1.5rem;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.75rem;flex-wrap:wrap;gap:.5rem;">
        <h2 style="margin:0;">Visitor Log</h2>
        <div class="row">
          <button id="refreshVisitors" class="secondary" type="button">Refresh</button>
          <button id="exportVisitors" class="secondary" type="button">Export CSV</button>
        </div>
      </div>
      <div class="row" style="margin-bottom:1rem;">
        <div class="card" style="flex:1;min-width:80px;text-align:center;padding:.75rem;">
          <div style="font-size:1.8rem;color:var(--green);line-height:1;" id="v-total">—</div>
          <div class="small" style="margin-top:.3rem;">Total Visits</div>
        </div>
        <div class="card" style="flex:1;min-width:80px;text-align:center;padding:.75rem;">
          <div style="font-size:1.8rem;color:var(--green);line-height:1;" id="v-countries">—</div>
          <div class="small" style="margin-top:.3rem;">Countries</div>
        </div>
        <div class="card" style="flex:1;min-width:80px;text-align:center;padding:.75rem;">
          <div style="font-size:1.8rem;color:var(--green);line-height:1;" id="v-unique-ips">—</div>
          <div class="small" style="margin-top:.3rem;">Unique IPs</div>
        </div>
      </div>
      <div id="visitor-log"><div class="notice">Loading...</div></div>
    </section>
    <script>
    (async function() {
      function showErr(msg) {
        console.error('[visitor-log]', msg);
        var el = document.getElementById('visitor-log');
        if (el) el.innerHTML = '<div class="notice" style="border-color:#5c1f1f;">' + String(msg).replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</div>';
      }
      console.log('[visitor-log] script starting');
      var visitData = [];
      function vesc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
      var _app, _fs;
      try {
        console.log('[visitor-log] importing firebase-app');
        _app = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js');
        console.log('[visitor-log] importing firebase-firestore');
        _fs = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
        console.log('[visitor-log] imports ok');
      } catch(e) {
        showErr('Firebase import failed: ' + (e.message || e));
        return;
      }
      var cfg = {
        apiKey: 'AIzaSyAzlx4DVWbSkB4aM-njR55IT5qSPv4CFuk',
        authDomain: 'atmwithnopin-c5bd7.firebaseapp.com',
        projectId: 'atmwithnopin-c5bd7',
        storageBucket: 'atmwithnopin-c5bd7.firebasestorage.app',
        messagingSenderId: '404706016435',
        appId: '1:404706016435:web:b5e3cf34ccc9b669bd04c6'
      };
      var fbApp, db;
      try {
        fbApp = _app.getApps().length ? _app.getApps()[0] : _app.initializeApp(cfg);
        db = _fs.getFirestore(fbApp);
        console.log('[visitor-log] firebase ready');
      } catch(e) {
        showErr('Firebase init failed: ' + (e.message || e));
        return;
      }
      function showLog(html) {
        var el = document.getElementById('visitor-log');
        if (el) el.innerHTML = html;
      }
      async function loadVisitors() {
        showLog('<div class="notice">Loading visitor log...</div>');
        try {
          var snap = await _fs.getDocs(_fs.query(_fs.collection(db, 'visits'), _fs.orderBy('timestamp', 'desc'), _fs.limit(500)));
          visitData = [];
          snap.forEach(function(d) { visitData.push(Object.assign({ id: d.id }, d.data())); });
          console.log('[visitor-log] loaded ' + visitData.length + ' visits');
          var countries = new Set(visitData.map(function(v) { return v.country; }).filter(function(c) { return c && c !== 'unknown'; }));
          var ips = new Set(visitData.map(function(v) { return v.ip; }).filter(function(ip) { return ip && ip !== 'unknown'; }));
          document.getElementById('v-total').textContent = visitData.length;
          document.getElementById('v-countries').textContent = countries.size;
          document.getElementById('v-unique-ips').textContent = ips.size;
          if (!visitData.length) { showLog('<div class="notice">No visits logged yet.</div>'); return; }
          var hdr = '<div style="display:grid;grid-template-columns:148px 110px 160px 90px 80px 70px 70px 1fr;gap:.5rem;padding:.4rem 0;border-bottom:1px solid #1a1a1a;font-size:.57rem;letter-spacing:.15em;text-transform:uppercase;color:var(--green);">'
            + '<span>Timestamp</span><span>IP</span><span>City, State</span><span>Country</span><span>Browser</span><span>OS</span><span>Device</span><span>Page / Referrer</span></div>';
          var rowsHtml = visitData.map(function(v) {
            var ts = (v.timestamp && v.timestamp.toDate) ? v.timestamp.toDate() : new Date();
            var city  = (v.city  && v.city  !== 'unknown') ? v.city  : '';
            var state = (v.state && v.state !== 'unknown') ? v.state : ((v.region && v.region !== 'unknown') ? v.region : '');
            var location = city && state ? city + ', ' + state : city || state || '—';
            var ip = v.ip || 'unknown';
            var ipShort = ip.length > 20 ? ip.substring(0, 18) + '…' : ip;
            return '<div style="display:grid;grid-template-columns:148px 110px 160px 90px 80px 70px 70px 1fr;gap:.5rem;padding:.35rem 0;border-bottom:1px solid #111;font-size:.67rem;">'
              + '<span style="color:#888;font-size:.6rem;">' + ts.toLocaleString() + '</span>'
              + '<span style="color:var(--gold);font-size:.6rem;word-break:break-all;" title="' + vesc(ip) + '">' + vesc(ipShort) + '</span>'
              + '<span style="color:var(--offwhite);font-size:.65rem;">' + vesc(location) + '</span>'
              + '<span style="color:var(--offwhite);font-size:.65rem;">' + vesc(v.country || '—') + '</span>'
              + '<span style="color:#888;">' + vesc(v.browser || '—') + '</span>'
              + '<span style="color:#888;">' + vesc(v.os || '—') + '</span>'
              + '<span style="color:#888;">' + vesc(v.device || '—') + '</span>'
              + '<span style="font-size:.6rem;color:#555;">' + vesc(v.page || '/') + ' \xb7 ' + vesc(v.referrer || 'direct') + '</span>'
              + '</div>';
          }).join('');
          showLog('<div style="overflow-x:auto;">' + hdr + rowsHtml + '</div>');
        } catch(e) {
          console.error('[visitor-log] query error', e);
          showLog('<div class="notice" style="border-color:#5c1f1f;">Query error: ' + vesc(e.message || String(e)) + '</div>');
        }
      }
      function exportVisitorsCSV() {
        if (!visitData.length) return;
        var headers = ['Timestamp','IP','City','Region','Country','Org/ISP','Browser','OS','Device','Language','Screen','Timezone','Page','Referrer','Latitude','Longitude'];
        var rows = [headers].concat(visitData.map(function(v) {
          var ts = (v.timestamp && v.timestamp.toDate) ? v.timestamp.toDate().toISOString() : '';
          return [ts, v.ip, v.city, v.region, v.country, v.org, v.browser, v.os, v.device, v.language,
                  (v.screenWidth || '') + 'x' + (v.screenHeight || ''), v.timezone, v.page, v.referrer, v.latitude || '', v.longitude || ''];
        }));
        var csv = rows.map(function(r) { return r.map(function(c) { return '"' + String(c || '').replace(/"/g, '""') + '"'; }).join(','); }).join('\n');
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
        a.download = 'atm-visitors-' + new Date().toISOString().split('T')[0] + '.csv';
        a.click();
      }
      document.getElementById('refreshVisitors').addEventListener('click', loadVisitors);
      document.getElementById('exportVisitors').addEventListener('click', exportVisitorsCSV);
      console.log('[visitor-log] calling loadVisitors');
      await loadVisitors();
    })();
    </script>`);
}

const CHRON_CATEGORIES = ['Meet the Crew', 'Dealers', 'Floor Staff', 'Tournament Reports', 'Bad Beats', 'WSOP Life', 'Vegas Adventures', 'Poker Humor'];

function renderChronicleCard(c) {
  const dateStr = new Date(c.published_at || c.created_at).toLocaleDateString();
  const rt = estimateReadingTime(c.content);
  return `<article class="chron-card" data-category="${escapeHtml(c.category || '')}" data-tags="${escapeHtml((c.tags || []).join(' ').toLowerCase())}" data-title="${escapeHtml(c.title.toLowerCase())}">
    ${c.featured_image_url
      ? `<div class="chron-img"><img src="${escapeHtml(c.featured_image_url)}" alt="${escapeHtml(c.featured_image_alt || c.title)}" loading="lazy" /></div>`
      : `<div class="chron-img chron-img-ph">📖</div>`}
    <div class="chron-body">
      <div class="chron-meta"><span class="chron-cat">${escapeHtml(c.category || 'General')}</span><span class="meta">${escapeHtml(dateStr)} · ${rt} min read</span></div>
      <h3 class="chron-title"><a href="/chronicles/${escapeHtml(c.slug)}">${escapeHtml(c.title)}</a></h3>
      <p class="chron-excerpt">${escapeHtml(c.excerpt || '')}</p>
      <div class="chron-tags">${(c.tags || []).slice(0, 4).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
      <a href="/chronicles/${escapeHtml(c.slug)}" class="chron-cta">Read Story →</a>
    </div>
  </article>`;
}

function renderChroniclesListPage(chronicles) {
  const published = chronicles
    .filter((c) => c.status === 'published')
    .sort((a, b) => new Date(b.published_at || b.created_at) - new Date(a.published_at || a.created_at));
  const catBtns = ['All', ...CHRON_CATEGORIES].map((cat) =>
    `<button class="chron-filter-btn${cat === 'All' ? ' active' : ''}" data-cat="${cat === 'All' ? '' : escapeHtml(cat)}">${escapeHtml(cat)}</button>`
  ).join('');
  const cards = published.map(renderChronicleCard).join('');
  return renderLayout('Hall of Fame Chronicles | ATMwithNoPIN™', `
    <style>
      .chron-controls{display:flex;flex-direction:column;gap:.75rem;margin:1.5rem 0 1rem;}
      .chron-search{width:100%;max-width:480px;border:1px solid #242424;background:#121212;color:var(--offwhite);padding:.75rem 1rem;border-radius:10px;font:inherit;font-size:.85rem;}
      .chron-search::placeholder{color:#555;}
      .chron-filter-wrap{display:flex;flex-wrap:wrap;gap:.4rem;}
      .chron-filter-btn{border:1px solid #242424;background:#111;color:#888;border-radius:999px;padding:.3rem .7rem;font:.68rem 'DM Mono',monospace;text-transform:uppercase;letter-spacing:.1em;cursor:pointer;transition:all .2s;}
      .chron-filter-btn:hover,.chron-filter-btn.active{border-color:rgba(0,200,83,.4);background:rgba(0,200,83,.08);color:var(--green);}
      .chron-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;margin-top:.5rem;}
      @media(max-width:980px){.chron-grid{grid-template-columns:1fr;}}
      @media(min-width:600px) and (max-width:980px){.chron-grid{grid-template-columns:repeat(2,1fr);}}
      .chron-card{border:1px solid #1e1e1e;background:#101010;border-radius:14px;overflow:hidden;display:flex;flex-direction:column;transition:border-color .2s;}
      .chron-card:hover{border-color:#2e2e2e;}
      .chron-img img{width:100%;height:190px;object-fit:cover;display:block;}
      .chron-img-ph{height:150px;background:linear-gradient(135deg,#0d2e1a 0%,#0a1a0f 100%);display:flex;align-items:center;justify-content:center;font-size:2.8rem;border-bottom:1px solid #1a1a1a;}
      .chron-body{padding:1rem;display:flex;flex-direction:column;gap:.4rem;flex:1;}
      .chron-meta{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;}
      .chron-cat{background:rgba(0,200,83,.1);color:var(--green);border:1px solid rgba(0,200,83,.2);border-radius:999px;padding:.2rem .55rem;font-size:.6rem;text-transform:uppercase;letter-spacing:.12em;}
      .chron-title{font-family:'DM Serif Display',serif;font-size:1rem;line-height:1.3;margin:.15rem 0 0;}
      .chron-title a{color:var(--offwhite);text-decoration:none;}
      .chron-title a:hover{color:var(--green);}
      .chron-excerpt{color:#888;font-size:.8rem;line-height:1.55;flex:1;}
      .chron-tags{display:flex;flex-wrap:wrap;gap:.3rem;margin-top:.2rem;}
      .chron-cta{display:inline-block;color:var(--green);font-size:.7rem;text-transform:uppercase;letter-spacing:.12em;text-decoration:none;margin-top:.4rem;}
      .chron-cta:hover{color:#00ff6a;}
      .chron-load-wrap{text-align:center;margin:2rem 0;}
      .chron-load-btn{border:1px solid #242424;background:#111;color:var(--offwhite);border-radius:10px;padding:.75rem 2rem;font:.78rem 'DM Mono',monospace;text-transform:uppercase;letter-spacing:.12em;cursor:pointer;}
      .chron-load-btn:hover{border-color:var(--green);color:var(--green);}
      .chron-no-results{grid-column:1/-1;text-align:center;padding:3rem;color:#555;font-size:.85rem;}
    </style>
    <section class="hero">
      <p class="eyebrow">Horseshoe WSOP · Hall of Fame Poker Room</p>
      <h1>Chronicles</h1>
      <p class="body-text" style="max-width:60ch;">Stories from dealers, floor staff, tournament runs, bad beats, and Vegas poker life at the Hall of Fame Poker Room.</p>
    </section>
    <div class="chron-controls">
      <input type="search" id="chronSearch" class="chron-search" placeholder="Search stories by title or tag…" />
      <div class="chron-filter-wrap">${catBtns}</div>
    </div>
    <div class="chron-grid" id="chronGrid">
      ${cards || '<p class="chron-no-results">No chronicles published yet.</p>'}
    </div>
    <div class="chron-load-wrap" id="chronLoadWrap" style="display:none;">
      <button type="button" class="chron-load-btn" id="chronLoadBtn">Load More Stories</button>
    </div>
    <script>
    (function() {
      var PAGE = 12;
      var all = Array.from(document.querySelectorAll('.chron-card'));
      var cat = '', q = '', shown = PAGE;
      function match(c) {
        return (!cat || c.dataset.category === cat) && (!q || c.dataset.title.includes(q) || c.dataset.tags.includes(q));
      }
      function paint() {
        var vis = all.filter(match);
        all.forEach(function(c) { c.style.display = 'none'; });
        vis.slice(0, shown).forEach(function(c) { c.style.display = ''; });
        var nr = document.getElementById('chronNoRes');
        if (!vis.length) {
          if (!nr) { nr = Object.assign(document.createElement('p'), {id:'chronNoRes',className:'chron-no-results',textContent:'No stories found.'}); document.getElementById('chronGrid').appendChild(nr); }
        } else if (nr) nr.remove();
        document.getElementById('chronLoadWrap').style.display = vis.length > shown ? '' : 'none';
      }
      document.querySelectorAll('.chron-filter-btn').forEach(function(b) {
        b.addEventListener('click', function() {
          document.querySelectorAll('.chron-filter-btn').forEach(function(x) { x.classList.remove('active'); });
          b.classList.add('active'); cat = b.dataset.cat || ''; shown = PAGE; paint();
        });
      });
      document.getElementById('chronSearch').addEventListener('input', function() { q = this.value.trim().toLowerCase(); shown = PAGE; paint(); });
      document.getElementById('chronLoadBtn').addEventListener('click', function() { shown += PAGE; paint(); });
      paint();
    })();
    </script>`);
}

function renderChroniclePage(chronicle, allChronicles) {
  const rt = estimateReadingTime(chronicle.content);
  const dateStr = new Date(chronicle.published_at || chronicle.created_at).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
  const related = allChronicles
    .filter((c) => c.id !== chronicle.id && c.status === 'published' && c.category === chronicle.category)
    .sort((a, b) => new Date(b.published_at || b.created_at) - new Date(a.published_at || a.created_at))
    .slice(0, 3);
  const pub = allChronicles.filter((c) => c.status === 'published')
    .sort((a, b) => new Date(b.published_at || b.created_at) - new Date(a.published_at || a.created_at));
  const idx = pub.findIndex((c) => c.id === chronicle.id);
  const prev = idx < pub.length - 1 ? pub[idx + 1] : null;
  const next = idx > 0 ? pub[idx - 1] : null;
  const gallery = (chronicle.gallery_images || []).map((img) =>
    `<figure class="card"><img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.alt || chronicle.title)}" />${img.alt ? `<p class="small" style="margin-top:.5rem;">${escapeHtml(img.alt)}</p>` : ''}</figure>`
  ).join('');
  const crewBox = (chronicle.crew_nickname || chronicle.crew_role || chronicle.crew_quote) ? `
    <div class="crew-profile-box">
      ${chronicle.crew_nickname ? `<div class="crew-nick">"${escapeHtml(chronicle.crew_nickname)}"</div>` : ''}
      ${chronicle.crew_role ? `<div class="crew-role-label">Role: ${escapeHtml(chronicle.crew_role)}</div>` : ''}
      ${chronicle.crew_quote ? `<blockquote class="crew-quote-box">"${escapeHtml(chronicle.crew_quote)}"</blockquote>` : ''}
    </div>` : '';
  const relatedHtml = related.map((c) =>
    `<article class="rel-card"><p class="meta">${escapeHtml(new Date(c.published_at || c.created_at).toLocaleDateString())}</p><h4><a href="/chronicles/${escapeHtml(c.slug)}">${escapeHtml(c.title)}</a></h4><p class="small" style="margin-top:.25rem;color:#888;">${escapeHtml((c.excerpt || '').slice(0, 100))}${(c.excerpt || '').length > 100 ? '…' : ''}</p></article>`
  ).join('');
  return renderLayout(`${chronicle.title} | ATMwithNoPIN™ Chronicles`, `
    <style>
      .chron-hero-img{width:100%;max-height:420px;object-fit:cover;border-radius:14px;border:1px solid #1e1e1e;display:block;margin-bottom:1.25rem;}
      .chron-hero-ph{height:260px;background:linear-gradient(135deg,#0d2e1a 0%,#0a1a0f 100%);border-radius:14px;border:1px solid #1e1e1e;display:flex;align-items:center;justify-content:center;font-size:4rem;margin-bottom:1.25rem;}
      .chron-pg-meta{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;margin-bottom:.75rem;}
      .chron-pg-cat{background:rgba(0,200,83,.1);color:var(--green);border:1px solid rgba(0,200,83,.2);border-radius:999px;padding:.25rem .6rem;font-size:.6rem;text-transform:uppercase;letter-spacing:.12em;}
      .crew-profile-box{background:#0c1a10;border:1px solid #1e3a28;border-radius:12px;padding:1rem 1.25rem;margin:1rem 0;}
      .crew-nick{font-family:'DM Serif Display',serif;font-style:italic;font-size:1.4rem;color:var(--gold);margin-bottom:.3rem;}
      .crew-role-label{font-size:.68rem;text-transform:uppercase;letter-spacing:.15em;color:var(--gray);}
      .crew-quote-box{border-left:3px solid var(--green);padding-left:.8rem;color:var(--offwhite);font-style:italic;font-size:.9rem;margin-top:.6rem;}
      .chron-body-content{margin-top:1rem;}
      .share-row{margin-top:1.5rem;padding-top:1rem;border-top:1px solid #1e1e1e;}
      .share-btns{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.4rem;}
      .share-btn{border:1px solid #242424;background:#111;color:var(--offwhite);border-radius:8px;padding:.4rem .8rem;font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;cursor:pointer;transition:all .2s;text-decoration:none;display:inline-block;}
      .share-btn:hover{border-color:var(--green);color:var(--green);}
      .chron-pg-nav{display:flex;justify-content:space-between;gap:1rem;margin-top:2rem;padding-top:1rem;border-top:1px solid #1e1e1e;flex-wrap:wrap;}
      .chron-pg-nav-link{border:1px solid #242424;background:#111;border-radius:10px;padding:.6rem .9rem;text-decoration:none;color:var(--offwhite);font-size:.73rem;max-width:46%;transition:border-color .2s;}
      .chron-pg-nav-link:hover{border-color:var(--green);}
      .nav-lbl{font-size:.58rem;text-transform:uppercase;letter-spacing:.15em;color:var(--gray);display:block;margin-bottom:.15rem;}
      .rel-section{margin-top:1.5rem;}
      .rel-card{border:1px solid #1e1e1e;background:#0c0c0c;border-radius:12px;padding:.85rem;margin-bottom:.6rem;}
      .rel-card h4{font-family:'DM Serif Display',serif;font-size:.93rem;margin:.2rem 0;}
      .rel-card h4 a{color:var(--offwhite);text-decoration:none;}
      .rel-card h4 a:hover{color:var(--green);}
    </style>
    <section class="hero">
      <p class="eyebrow"><a href="/chronicles" style="color:var(--green);">Chronicles</a> › ${escapeHtml(chronicle.category || 'Story')}</p>
      <h1>${escapeHtml(chronicle.title)}</h1>
      <div class="chron-pg-meta">
        <span class="chron-pg-cat">${escapeHtml(chronicle.category || 'General')}</span>
        <span class="meta">${escapeHtml(dateStr)} · ${rt} min read</span>
      </div>
      <div>${(chronicle.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
    </section>
    <section class="grid" style="margin-top:1rem;">
      <article class="card">
        ${chronicle.featured_image_url
          ? `<img class="chron-hero-img" src="${escapeHtml(chronicle.featured_image_url)}" alt="${escapeHtml(chronicle.featured_image_alt || chronicle.title)}" />`
          : '<div class="chron-hero-ph">📖</div>'}
        ${crewBox}
        <p class="body-text">${escapeHtml(chronicle.excerpt || '')}</p>
        <div class="chron-body-content">${renderMarkdown(chronicle.content || '')}</div>
        ${(chronicle.video_urls || []).map(renderVideoEmbed).join('')}
        <div class="share-row">
          <p class="meta">Share this story</p>
          <div class="share-btns">
            <a class="share-btn" href="https://twitter.com/intent/tweet?text=${encodeURIComponent(chronicle.title + ' — ATMwithNoPIN™ Chronicles')}&url=${encodeURIComponent('https://atmwithnopin.com/chronicles/' + chronicle.slug)}" target="_blank" rel="noopener">𝕏 Share</a>
            <button class="share-btn" onclick="navigator.clipboard.writeText('https://atmwithnopin.com/chronicles/${escapeHtml(chronicle.slug)}').then(function(){this.textContent='Copied!';var b=this;setTimeout(function(){b.textContent='Copy Link';},2000);}.bind(this))">Copy Link</button>
          </div>
        </div>
        <nav class="chron-pg-nav">
          ${prev ? `<a href="/chronicles/${escapeHtml(prev.slug)}" class="chron-pg-nav-link"><span class="nav-lbl">← Older Story</span>${escapeHtml(prev.title)}</a>` : '<span></span>'}
          ${next ? `<a href="/chronicles/${escapeHtml(next.slug)}" class="chron-pg-nav-link" style="text-align:right;margin-left:auto;"><span class="nav-lbl">Newer Story →</span>${escapeHtml(next.title)}</a>` : ''}
        </nav>
      </article>
      ${gallery || relatedHtml ? `<aside class="card">
        ${gallery ? `<h2>Gallery</h2><div class="gallery" style="margin-top:1rem;">${gallery}</div>` : ''}
        ${relatedHtml ? `<div class="rel-section"><h2>More ${escapeHtml(chronicle.category || 'Stories')}</h2><div style="margin-top:.75rem;">${relatedHtml}</div></div>` : ''}
      </aside>` : ''}
    </section>`);
}

function badgeSlug(badge) {
  return slugify(badge || '');
}

const BADGE_COLORS = {
  'final-table-hero':     'rgba(0,200,83,.12);color:var(--green);border-color:rgba(0,200,83,.3)',
  'bad-beat-champion':    'rgba(200,60,60,.1);color:#e06060;border-color:rgba(200,60,60,.3)',
  'river-victim':         'rgba(60,120,220,.1);color:#6699ee;border-color:rgba(60,120,220,.3)',
  'poker-storyteller':    'rgba(201,168,76,.12);color:var(--gold);border-color:rgba(201,168,76,.3)',
  'bubble-survivor':      'rgba(200,140,50,.1);color:#e09040;border-color:rgba(200,140,50,.3)',
  'atmwithnopin-legend':  'rgba(160,60,220,.1);color:#cc77ff;border-color:rgba(160,60,220,.3)',
};
function badgeStyle(badge) {
  return BADGE_COLORS[badgeSlug(badge)] || 'rgba(0,200,83,.08);color:var(--green);border-color:rgba(0,200,83,.2)';
}
function renderBadge(badge) {
  if (!badge) return '';
  return `<span style="display:inline-block;background:${badgeStyle(badge)};border:1px solid;border-radius:999px;padding:.2rem .6rem;font-size:.6rem;text-transform:uppercase;letter-spacing:.12em;">${escapeHtml(badge)}</span>`;
}

function renderPlayerCard(p) {
  const initials = ((p.nickname || p.name || '?')[0] || '?').toUpperCase();
  return `<article class="player-card" data-badge="${escapeHtml(p.badge || '')}">
    ${p.photo_url
      ? `<div class="player-photo-wrap"><img src="${escapeHtml(p.photo_url)}" alt="${escapeHtml(p.nickname || p.name)}" loading="lazy" /></div>`
      : `<div class="player-photo-ph">${escapeHtml(initials)}</div>`}
    <div class="player-card-body">
      ${renderBadge(p.badge)}
      <h3 class="player-card-name">${escapeHtml(p.nickname || p.name)}</h3>
      ${p.nickname && p.name ? `<p class="small">${escapeHtml(p.name)}</p>` : ''}
      ${p.city ? `<p class="small" style="margin-top:.15rem;">${escapeHtml(p.city)}</p>` : ''}
      <p class="player-card-excerpt">${escapeHtml((p.biggest_accomplishment || p.funny_story || '').slice(0, 110))}${(p.biggest_accomplishment || '').length > 110 ? '…' : ''}</p>
      <a href="/players/${escapeHtml(p.slug)}" class="player-view-cta">View Profile →</a>
    </div>
  </article>`;
}

function renderCommunityWallPage(submissions) {
  const approved = submissions
    .filter((s) => s.status === 'approved')
    .sort((a, b) => new Date(b.approved_at || b.created_at) - new Date(a.approved_at || a.created_at));
  const badgeBtns = ['All', ...PLAYER_BADGES].map((b) =>
    `<button class="pw-filter-btn${b === 'All' ? ' active' : ''}" data-badge="${b === 'All' ? '' : escapeHtml(b)}">${escapeHtml(b)}</button>`
  ).join('');
  const cards = approved.map(renderPlayerCard).join('');
  return renderLayout('Community Wall | ATMwithNoPIN™', `
    <style>
      .pw-controls{display:flex;flex-direction:column;gap:.75rem;margin:1.5rem 0 1rem;}
      .pw-filter-wrap{display:flex;flex-wrap:wrap;gap:.4rem;}
      .pw-filter-btn{border:1px solid #242424;background:#111;color:#888;border-radius:999px;padding:.3rem .7rem;font:.68rem 'DM Mono',monospace;text-transform:uppercase;letter-spacing:.1em;cursor:pointer;transition:all .2s;}
      .pw-filter-btn:hover,.pw-filter-btn.active{border-color:rgba(0,200,83,.4);background:rgba(0,200,83,.08);color:var(--green);}
      .pw-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;margin-top:.5rem;}
      @media(max-width:980px){.pw-grid{grid-template-columns:1fr;}}
      @media(min-width:600px) and (max-width:980px){.pw-grid{grid-template-columns:repeat(2,1fr);}}
      .player-card{border:1px solid #1e1e1e;background:#101010;border-radius:14px;overflow:hidden;display:flex;flex-direction:column;transition:border-color .2s;}
      .player-card:hover{border-color:#2e2e2e;}
      .player-photo-wrap img{width:100%;height:200px;object-fit:cover;display:block;}
      .player-photo-ph{height:160px;background:linear-gradient(135deg,#0d2e1a,#0a1a0f);display:flex;align-items:center;justify-content:center;font-family:'Bebas Neue',sans-serif;font-size:3.5rem;color:var(--green);border-bottom:1px solid #1a1a1a;}
      .player-card-body{padding:1rem;display:flex;flex-direction:column;gap:.35rem;flex:1;}
      .player-card-name{font-family:'DM Serif Display',serif;font-size:1.05rem;margin:.2rem 0 0;}
      .player-card-excerpt{color:#888;font-size:.78rem;line-height:1.55;flex:1;margin-top:.25rem;}
      .player-view-cta{display:inline-block;margin-top:.4rem;color:var(--green);font-size:.7rem;text-transform:uppercase;letter-spacing:.12em;text-decoration:none;}
      .player-view-cta:hover{color:#00ff6a;}
      .pw-no-results{grid-column:1/-1;text-align:center;padding:3rem;color:#555;font-size:.85rem;}
      .pw-cta-row{text-align:center;margin-top:1.5rem;}
    </style>
    <section class="hero">
      <p class="eyebrow">ATMwithNoPIN™ Community</p>
      <h1>Community Wall</h1>
      <p class="body-text" style="max-width:60ch;">Players from across the poker world who've shared their stories, bad beats, and moments with the ATMwithNoPIN™ community.</p>
      <p style="margin-top:.75rem;"><a href="/request-feature" class="pill">Share Your Story →</a></p>
    </section>
    <div class="pw-controls">
      <div class="pw-filter-wrap">${badgeBtns}</div>
    </div>
    <div class="pw-grid" id="pwGrid">
      ${cards || '<p class="pw-no-results">No players featured yet. <a href="/request-feature">Be the first →</a></p>'}
    </div>
    <script>
    (function() {
      var all = Array.from(document.querySelectorAll('.player-card'));
      var active = '';
      function paint() {
        all.forEach(function(c) { c.style.display = (!active || c.dataset.badge === active) ? '' : 'none'; });
        var nr = document.getElementById('pwNoRes');
        var vis = all.filter(function(c) { return c.style.display !== 'none'; });
        if (!vis.length && all.length) {
          if (!nr) { nr = Object.assign(document.createElement('p'), {id:'pwNoRes',className:'pw-no-results',textContent:'No players with this badge yet.'}); document.getElementById('pwGrid').appendChild(nr); }
        } else if (nr) nr.remove();
      }
      document.querySelectorAll('.pw-filter-btn').forEach(function(b) {
        b.addEventListener('click', function() {
          document.querySelectorAll('.pw-filter-btn').forEach(function(x) { x.classList.remove('active'); });
          b.classList.add('active'); active = b.dataset.badge || ''; paint();
        });
      });
    })();
    </script>`);
}

function renderPlayerProfilePage(player, allPlayers) {
  const others = allPlayers
    .filter((p) => p.id !== player.id && p.status === 'approved' && p.badge === player.badge)
    .slice(0, 3);
  const shareUrl = `https://atmwithnopin.com/players/${escapeHtml(player.slug)}`;
  return renderLayout(`${player.nickname || player.name} | ATMwithNoPIN™ Community`, `
    <meta name="description" content="${escapeHtml((player.biggest_accomplishment || player.funny_story || '').slice(0, 155))}" />
    <meta property="og:title" content="${escapeHtml((player.nickname || player.name) + ' — ATMwithNoPIN™ Community')}" />
    <meta property="og:description" content="${escapeHtml((player.biggest_accomplishment || player.funny_story || '').slice(0, 155))}" />
    ${player.photo_url ? `<meta property="og:image" content="${escapeHtml(player.photo_url)}" />` : ''}
    <style>
      .pp-photo{width:100%;max-height:420px;object-fit:cover;border-radius:14px;border:1px solid #1e1e1e;display:block;margin-bottom:1.25rem;}
      .pp-photo-ph{height:260px;background:linear-gradient(135deg,#0d2e1a,#0a1a0f);border-radius:14px;border:1px solid #1e1e1e;display:flex;align-items:center;justify-content:center;font-family:'Bebas Neue',sans-serif;font-size:5rem;color:var(--green);margin-bottom:1.25rem;}
      .pp-section{margin-top:1.25rem;padding-top:1rem;border-top:1px solid #1a1a1a;}
      .pp-section-label{font-size:.62rem;text-transform:uppercase;letter-spacing:.2em;color:var(--green);margin-bottom:.4rem;}
      .pp-social-link{display:inline-flex;align-items:center;gap:.4rem;color:var(--green);font-size:.78rem;word-break:break-all;}
      .share-row{margin-top:1.5rem;padding-top:1rem;border-top:1px solid #1e1e1e;}
      .share-btns{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.4rem;}
      .share-btn{border:1px solid #242424;background:#111;color:var(--offwhite);border-radius:8px;padding:.4rem .8rem;font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;cursor:pointer;transition:all .2s;text-decoration:none;display:inline-block;}
      .share-btn:hover{border-color:var(--green);color:var(--green);}
      .others-section{margin-top:1.5rem;}
      .other-card{border:1px solid #1e1e1e;background:#0c0c0c;border-radius:12px;padding:.85rem;margin-bottom:.6rem;}
      .other-card h4{font-family:'DM Serif Display',serif;font-size:.93rem;margin:.2rem 0;}
      .other-card h4 a{color:var(--offwhite);text-decoration:none;}
      .other-card h4 a:hover{color:var(--green);}
    </style>
    <section class="hero">
      <p class="eyebrow"><a href="/community-wall" style="color:var(--green);">Community Wall</a> › Player Profile</p>
      <h1>${escapeHtml(player.nickname || player.name)}</h1>
      <div style="display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;margin-top:.5rem;">
        ${renderBadge(player.badge)}
        ${player.city ? `<span class="meta">${escapeHtml(player.city)}</span>` : ''}
        ${player.favorite_game ? `<span class="meta">${escapeHtml(player.favorite_game)}</span>` : ''}
      </div>
    </section>
    <section class="grid" style="margin-top:1rem;">
      <article class="card">
        ${player.photo_url
          ? `<img class="pp-photo" src="${escapeHtml(player.photo_url)}" alt="${escapeHtml(player.nickname || player.name)}" />`
          : `<div class="pp-photo-ph">${escapeHtml(((player.nickname || player.name || '?')[0] || '?').toUpperCase())}</div>`}
        ${player.biggest_accomplishment ? `<div class="pp-section"><p class="pp-section-label">Biggest Accomplishment</p><p class="body-text">${escapeHtml(player.biggest_accomplishment)}</p></div>` : ''}
        ${player.funny_story ? `<div class="pp-section"><p class="pp-section-label">Funniest Poker Story</p><div>${renderMarkdown(player.funny_story)}</div></div>` : ''}
        ${player.bad_beat_story ? `<div class="pp-section"><p class="pp-section-label">Bad Beat Story</p><div>${renderMarkdown(player.bad_beat_story)}</div></div>` : ''}
        ${player.social_link ? `<div class="pp-section"><p class="pp-section-label">Find Me Online</p><a class="pp-social-link" href="${escapeHtml(player.social_link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(player.social_link)}</a></div>` : ''}
        <div class="share-row">
          <p class="meta">Share this profile</p>
          <div class="share-btns">
            <a class="share-btn" href="https://twitter.com/intent/tweet?text=${encodeURIComponent((player.nickname || player.name) + ' on ATMwithNoPIN™')}&url=${encodeURIComponent(shareUrl)}" target="_blank" rel="noopener">𝕏 Share</a>
            <button class="share-btn" onclick="navigator.clipboard.writeText('${escapeHtml(shareUrl)}').then(function(){this.textContent='Copied!';var b=this;setTimeout(function(){b.textContent='Copy Link';},2000);}.bind(this))">Copy Link</button>
          </div>
        </div>
      </article>
      ${others.length ? `<aside class="card">
        <h2>More Players</h2>
        <div class="others-section">
          ${others.map((p) => `<article class="other-card">${renderBadge(p.badge)}<h4><a href="/players/${escapeHtml(p.slug)}">${escapeHtml(p.nickname || p.name)}</a></h4>${p.city ? `<p class="small">${escapeHtml(p.city)}</p>` : ''}</article>`).join('')}
        </div>
        <div style="margin-top:1rem;"><a href="/community-wall" style="font-size:.78rem;text-transform:uppercase;letter-spacing:.12em;">View All Players →</a></div>
      </aside>` : ''}
    </section>`);
}

function renderRequestFeaturePage(error) {
  return renderLayout('Request to be Featured | ATMwithNoPIN™', `
    <style>
      .rf-form label{display:grid;gap:.35rem;font-size:.78rem;color:var(--gray);text-transform:uppercase;letter-spacing:.12em;}
      .rf-form input,.rf-form textarea,.rf-form select{width:100%;border:1px solid #242424;background:#121212;color:var(--offwhite);padding:.8rem .9rem;border-radius:10px;font:inherit;}
      .rf-form textarea{min-height:100px;}
      .rf-perm{display:flex;align-items:flex-start;gap:.6rem;padding:.75rem;border:1px solid #1e3a28;background:#0c1a10;border-radius:10px;}
      .rf-perm input{width:auto;flex-shrink:0;margin-top:.15rem;}
      .rf-perm span{font-size:.78rem;color:var(--gray);line-height:1.5;}
      .hp-field{position:absolute;left:-9999px;opacity:0;pointer-events:none;}
    </style>
    <section class="hero">
      <p class="eyebrow">ATMwithNoPIN™ Community</p>
      <h1>Share Your Story</h1>
      <p class="body-text" style="max-width:58ch;">Are you a poker player with a story to tell? Fill out the form and you might be featured on the ATMwithNoPIN™ community wall.</p>
    </section>
    ${error ? `<div class="notice" style="border-color:#5c1f1f;margin-bottom:1rem;">${escapeHtml(error)}</div>` : ''}
    <section class="card" style="max-width:680px;margin-top:1rem;">
      <form id="rfForm" class="rf-form form-grid" method="POST" action="/request-feature" enctype="multipart/form-data">
        <input class="hp-field" type="text" name="hp_url" tabindex="-1" autocomplete="off" aria-hidden="true" />
        <label>Full Name *<input name="name" type="text" required maxlength="100" placeholder="Your real name" /></label>
        <label>Poker Nickname<input name="nickname" type="text" maxlength="80" placeholder="What they call you at the table" /></label>
        <label>Email *<input name="email" type="email" required maxlength="200" placeholder="you@example.com" /></label>
        <label>City / Hometown<input name="city" type="text" maxlength="100" placeholder="Las Vegas, NV" /></label>
        <label>Favorite Poker Game<input name="favorite_game" type="text" maxlength="100" placeholder="$2/$5 NLH, PLO, etc." /></label>
        <label>Biggest Poker Accomplishment<textarea name="biggest_accomplishment" maxlength="800" placeholder="Final tabled the WSOP Main, ran good once..."></textarea></label>
        <label>Funniest Poker Story<textarea name="funny_story" maxlength="2000" placeholder="The story you always tell at the table..."></textarea></label>
        <label>Bad Beat Story<textarea name="bad_beat_story" maxlength="2000" placeholder="Aces cracked. Again."></textarea></label>
        <label>Social Media Link<input name="social_link" type="url" maxlength="300" placeholder="https://twitter.com/yourhandle" /></label>
        <label>Photo (JPG/PNG/WEBP, max 5MB)<input name="photo" type="file" accept="image/jpeg,image/png,image/webp" /></label>
        <div class="rf-perm">
          <input name="permission" type="checkbox" id="rfPerm" required />
          <label for="rfPerm" style="text-transform:none;letter-spacing:0;font-size:.82rem;color:var(--offwhite);cursor:pointer;">I give ATMwithNoPIN™ permission to publish my name, photo, and stories on their website and social media.</label>
        </div>
        <button type="submit">Submit My Story →</button>
        <div class="notice" id="rfStatus" style="display:none;"></div>
      </form>
    </section>
    <script>
    (function() {
      var form = document.getElementById('rfForm');
      var statusEl = document.getElementById('rfStatus');
      if (!form) return;
      form.addEventListener('submit', async function(e) {
        e.preventDefault();
        statusEl.style.display = '';
        statusEl.style.borderColor = '#1e1e1e';
        statusEl.textContent = 'Submitting your story...';
        try {
          var fd = new FormData(form);
          var res = await fetch('/request-feature', { method: 'POST', body: fd });
          var data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Submission failed.');
          statusEl.textContent = data.message || 'Thanks! Your story has been submitted for review.';
          statusEl.style.borderColor = '#1f5c31';
          form.reset();
          form.style.opacity = '.5';
          form.style.pointerEvents = 'none';
        } catch(err) {
          statusEl.textContent = err.message;
          statusEl.style.borderColor = '#5c1f1f';
        }
      });
    })();
    </script>`);
}

function verifyAdmin(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/admin_session=([^;]+)/);
  if (!match) return null;
  const session = sessions.get(match[1]);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(match[1]);
    return null;
  }
  return session;
}

function checkPassword(password) {
  if (ADMIN_PASSWORD_HASH) return hash(password) === ADMIN_PASSWORD_HASH;
  if (ADMIN_PASSWORD) return password === ADMIN_PASSWORD;
  return false;
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => data += chunk);
    req.on('end', () => {
      if (!data) resolve({});
      else {
        try { resolve(JSON.parse(data)); } catch (err) { reject(new Error('Invalid JSON body')); }
      }
    });
  });
}

function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

async function uploadImageToCloudinary(fileBuffer, filename, kind) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET;
  if (!cloudName || !uploadPreset) return null;

  const body = new FormData();
  body.append('file', new Blob([fileBuffer], { type: 'image/webp' }), filename);
  body.append('upload_preset', uploadPreset);
  body.append('folder', 'atmwithnopin');

  const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, { method: 'POST', body });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error?.message || 'Cloudinary upload failed');
  return { url: data.secure_url || data.url, alt: kind === 'featured' ? 'Featured image' : 'Gallery image' };
}

function uploadImageLocally(fileBuffer, filename) {
  ensureUploadDir();
  const ext = path.extname(filename).toLowerCase() || '.png';
  const safeName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  const filePath = path.join(UPLOAD_DIR, safeName);
  fs.writeFileSync(filePath, fileBuffer);
  return { url: `/uploads/${safeName}`, alt: 'Uploaded image' };
}

function isSafeImage(fileName) {
  return /\.(jpg|jpeg|png|webp)$/i.test(fileName);
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsed.pathname;

  if (pathname === '/api/admin/login' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      if (!body.email || !body.password) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Email and password are required.' }));
        return;
      }
      if (body.email !== ADMIN_EMAIL || !checkPassword(body.password)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid admin credentials.' }));
        return;
      }
      const token = crypto.randomUUID();
      sessions.set(token, { email: body.email, expiresAt: Date.now() + 1000 * 60 * 60 * 8 });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `admin_session=${token}; HttpOnly; Path=/; Max-Age=28800; SameSite=Lax` });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (pathname === '/api/admin/logout' && req.method === 'POST') {
    const cookie = req.headers.cookie || '';
    const match = cookie.match(/admin_session=([^;]+)/);
    if (match) sessions.delete(match[1]);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'admin_session=; Path=/; Max-Age=0' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const adminSession = verifyAdmin(req);
  const isAdminRoute = pathname.startsWith('/api/admin/') || pathname === '/admin';
  if (isAdminRoute && !adminSession) {
    if (pathname === '/admin') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderLayout('ATMwithNoPIN™ Admin Login', `
        <section class="hero">
          <p class="eyebrow">Secure admin</p>
          <h1>Admin login</h1>
          <p class="body-text" style="max-width:52ch;">Use the credentials from your environment to access the ATMwithNoPIN™ blog and publishing dashboard.</p>
        </section>
        <section class="card" style="max-width:480px; margin-top:1rem;">
          <div class="form-grid">
            <label>Email<input id="email" type="email" placeholder="admin@atmwithnopin.com" /></label>
            <label>Password<input id="password" type="password" /></label>
            <button id="loginBtn">Sign in</button>
            <div class="notice" id="loginStatus">Set ADMIN_EMAIL and ADMIN_PASSWORD_HASH (or ADMIN_PASSWORD) before logging in.</div>
          </div>
          <script>
            document.getElementById('loginBtn').addEventListener('click', async () => {
              const email = document.getElementById('email').value;
              const password = document.getElementById('password').value;
              const res = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
              const data = await res.json();
              if (!res.ok) { document.getElementById('loginStatus').textContent = data.error || 'Login failed'; return; }
              window.location.href = '/admin';
            });
          </script>
        </section>`));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Admin access required.' }));
      }
      return;
    }

  if (pathname === '/admin' && adminSession) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderAdminPage());
    return;
  }

  if (pathname === '/api/admin/posts' && req.method === 'GET') {
    const posts = await loadPosts();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(posts.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))));
    return;
  }

  if (pathname === '/api/admin/posts' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const post = {
        id: crypto.randomUUID(),
        title: String(body.title || '').trim(),
        slug: String(body.slug || slugify(body.title || '')).trim(),
        excerpt: String(body.excerpt || '').trim(),
        content: String(body.content || '').trim(),
        featured_image_url: String(body.featured_image_url || '').trim(),
        featured_image_alt: String(body.featured_image_alt || '').trim(),
        gallery_images: Array.isArray(body.gallery_images) ? body.gallery_images : [],
        video_urls: Array.isArray(body.video_urls) ? body.video_urls : [],
        tags: Array.isArray(body.tags) ? body.tags : [],
        status: body.status || 'draft',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        published_at: body.status === 'published' ? new Date().toISOString() : null,
      };
      if (!post.title || !post.slug || !post.excerpt || !post.content || !post.status) {
        throw new Error('Title, slug, excerpt, body, and status are required.');
      }
      const posts = await loadPosts();
      posts.push(post);
      await savePosts(posts);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(post));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (pathname.startsWith('/api/admin/posts/') && req.method === 'GET') {
    const id = pathname.split('/').pop();
    const posts = await loadPosts();
    const post = posts.find((item) => item.id === id);
    if (!post) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Post not found.' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(post));
    return;
  }

  if (pathname.startsWith('/api/admin/posts/') && req.method === 'PUT') {
    try {
      const id = pathname.split('/').pop();
      const body = await parseJsonBody(req);
      const posts = await loadPosts();
      const index = posts.findIndex((item) => item.id === id);
      if (index === -1) throw new Error('Post not found.');
      if (!body.title || !body.slug || !body.excerpt || !body.content || !body.status) {
        throw new Error('Title, slug, excerpt, body, and status are required.');
      }
      const updated = {
        ...posts[index],
        title: String(body.title || posts[index].title || '').trim(),
        slug: String(body.slug || slugify(body.title || posts[index].title) || posts[index].slug).trim(),
        excerpt: String(body.excerpt || posts[index].excerpt || '').trim(),
        content: String(body.content || posts[index].content || '').trim(),
        featured_image_url: String(body.featured_image_url || posts[index].featured_image_url || '').trim(),
        featured_image_alt: String(body.featured_image_alt || posts[index].featured_image_alt || '').trim(),
        gallery_images: Array.isArray(body.gallery_images) ? body.gallery_images : posts[index].gallery_images || [],
        video_urls: Array.isArray(body.video_urls) ? body.video_urls : posts[index].video_urls || [],
        tags: Array.isArray(body.tags) ? body.tags : posts[index].tags || [],
        status: body.status || posts[index].status || 'draft',
        updated_at: new Date().toISOString(),
        published_at: body.status === 'published' ? (posts[index].published_at || new Date().toISOString()) : (body.status === 'draft' ? null : posts[index].published_at || null),
      };
      posts[index] = updated;
      await savePosts(posts);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(updated));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (pathname.startsWith('/api/admin/posts/') && req.method === 'DELETE') {
    try {
      const id = pathname.split('/').pop();
      const currentPosts = await loadPosts();
      const posts = currentPosts.filter((item) => item.id !== id);
      if (posts.length === currentPosts.length) throw new Error('Post not found.');
      await savePosts(posts);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (pathname === '/api/admin/upload' && req.method === 'POST') {
    try {
      const boundary = req.headers['content-type']?.split('boundary=')[1];
      if (!boundary) throw new Error('Multipart upload required.');
      const chunks = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', async () => {
        try {
          const bodyBuffer = Buffer.concat(chunks);
          const boundaryMarker = `--${boundary}`;
          const parts = bodyBuffer.toString('binary').split(boundaryMarker);
          let fileBuffer = null;
          let fileName = '';
          let kind = 'gallery';
          for (const part of parts) {
            if (!part.includes('Content-Disposition')) continue;
            const headerEnd = part.indexOf('\r\n\r\n');
            const headers = part.slice(0, headerEnd);
            const content = part.slice(headerEnd + 4, -2);
            if (headers.includes('name="file"')) {
              const match = headers.match(/filename="([^"]+)"/);
              if (match) fileName = match[1];
              fileBuffer = Buffer.from(content, 'binary');
            }
            if (headers.includes('name="kind"')) {
              kind = content.replace(/\r\n/g, '').trim();
            }
          }
          if (!fileBuffer || !fileName) throw new Error('No image file uploaded.');
          if (!isSafeImage(fileName)) throw new Error('Only JPG, PNG, and WEBP images are allowed.');
          if (fileBuffer.length > 5 * 1024 * 1024) throw new Error('Image is too large. Max 5MB.');
          let uploadResult = null;
          try { uploadResult = await uploadImageToCloudinary(fileBuffer, fileName, kind); }
          catch (cloudErr) { uploadResult = null; }
          const fallback = uploadImageLocally(fileBuffer, fileName);
          const result = uploadResult || fallback;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, url: result.url, alt: result.alt }));
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
      });
      return;
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (pathname === '/blog') {
    const posts = await loadPosts();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderBlogListPage(posts));
    return;
  }

  if (pathname.startsWith('/blog/')) {
    const slug = pathname.split('/').filter(Boolean).slice(1).join('/');
    const posts = await loadPosts();
    const post = posts.find((item) => item.slug === slug && item.status === 'published');
    if (!post) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderLayout('Post not found', `<section class="card"><h1>Post not found</h1><p class="body-text">That story is not available yet, or the slug is wrong.</p></section>`));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderBlogPostPage(post));
    return;
  }

  if (pathname === '/chronicles') {
    const all = await loadChronicles();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderChroniclesListPage(all));
    return;
  }

  if (pathname.startsWith('/chronicles/')) {
    const slug = pathname.split('/').filter(Boolean).slice(1).join('/');
    const all = await loadChronicles();
    const chronicle = all.find((c) => c.slug === slug && c.status === 'published');
    if (!chronicle) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderLayout('Chronicle not found', `<section class="card"><h1>Story not found</h1><p class="body-text">That chronicle is not available yet, or the slug is wrong.</p><p style="margin-top:.75rem;"><a href="/chronicles">← Back to Chronicles</a></p></section>`));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderChroniclePage(chronicle, all));
    return;
  }

  if (pathname === '/api/admin/chronicles' && req.method === 'GET') {
    const all = await loadChronicles();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))));
    return;
  }

  if (pathname === '/api/admin/chronicles' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const c = {
        id: crypto.randomUUID(),
        title: String(body.title || '').trim(),
        slug: String(body.slug || slugify(body.title || '')).trim(),
        excerpt: String(body.excerpt || '').trim(),
        content: String(body.content || '').trim(),
        category: String(body.category || '').trim(),
        tags: Array.isArray(body.tags) ? body.tags : [],
        status: body.status || 'draft',
        featured_on_home: !!body.featured_on_home,
        featured_image_url: String(body.featured_image_url || '').trim(),
        featured_image_alt: String(body.featured_image_alt || '').trim(),
        gallery_images: Array.isArray(body.gallery_images) ? body.gallery_images : [],
        video_urls: Array.isArray(body.video_urls) ? body.video_urls : [],
        crew_nickname: String(body.crew_nickname || '').trim(),
        crew_role: String(body.crew_role || '').trim(),
        crew_quote: String(body.crew_quote || '').trim(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        published_at: body.status === 'published' ? new Date().toISOString() : null,
      };
      if (!c.title || !c.slug || !c.excerpt || !c.content || !c.category || !c.status) {
        throw new Error('Title, slug, excerpt, body, category, and status are required.');
      }
      const all = await loadChronicles();
      all.push(c);
      await saveChronicles(all);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(c));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (pathname.startsWith('/api/admin/chronicles/') && req.method === 'GET') {
    const id = pathname.split('/').pop();
    const all = await loadChronicles();
    const c = all.find((x) => x.id === id);
    if (!c) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Chronicle not found.' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(c));
    return;
  }

  if (pathname.startsWith('/api/admin/chronicles/') && req.method === 'PUT') {
    try {
      const id = pathname.split('/').pop();
      const body = await parseJsonBody(req);
      const all = await loadChronicles();
      const idx = all.findIndex((x) => x.id === id);
      if (idx === -1) throw new Error('Chronicle not found.');
      const old = all[idx];
      const updated = {
        ...old,
        title: String(body.title || old.title || '').trim(),
        slug: String(body.slug || slugify(body.title || old.title) || old.slug).trim(),
        excerpt: String(body.excerpt || old.excerpt || '').trim(),
        content: String(body.content || old.content || '').trim(),
        category: String(body.category || old.category || '').trim(),
        tags: Array.isArray(body.tags) ? body.tags : old.tags || [],
        status: body.status || old.status || 'draft',
        featured_on_home: body.featured_on_home !== undefined ? !!body.featured_on_home : !!old.featured_on_home,
        featured_image_url: String(body.featured_image_url !== undefined ? body.featured_image_url : old.featured_image_url || '').trim(),
        featured_image_alt: String(body.featured_image_alt !== undefined ? body.featured_image_alt : old.featured_image_alt || '').trim(),
        gallery_images: Array.isArray(body.gallery_images) ? body.gallery_images : old.gallery_images || [],
        video_urls: Array.isArray(body.video_urls) ? body.video_urls : old.video_urls || [],
        crew_nickname: String(body.crew_nickname !== undefined ? body.crew_nickname : old.crew_nickname || '').trim(),
        crew_role: String(body.crew_role !== undefined ? body.crew_role : old.crew_role || '').trim(),
        crew_quote: String(body.crew_quote !== undefined ? body.crew_quote : old.crew_quote || '').trim(),
        updated_at: new Date().toISOString(),
        published_at: body.status === 'published' ? (old.published_at || new Date().toISOString()) : (body.status === 'draft' ? null : old.published_at || null),
      };
      all[idx] = updated;
      await saveChronicles(all);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(updated));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (pathname.startsWith('/api/admin/chronicles/') && req.method === 'DELETE') {
    try {
      const id = pathname.split('/').pop();
      const all = await loadChronicles();
      const filtered = all.filter((x) => x.id !== id);
      if (filtered.length === all.length) throw new Error('Chronicle not found.');
      await saveChronicles(filtered);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (pathname === '/request-feature' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderRequestFeaturePage());
    return;
  }

  if (pathname === '/request-feature' && req.method === 'POST') {
    try {
      const contentType = req.headers['content-type'] || '';
      const boundary = contentType.split('boundary=')[1];
      if (!boundary) throw new Error('Multipart form required.');
      const bodyBuffer = await readBodyBuffer(req);
      const form = parseMultipartForm(bodyBuffer, boundary);
      const f = form.fields;
      if (f.hp_url && f.hp_url.trim()) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Thanks! Your submission is under review.' }));
        return;
      }
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
      if (!checkSubmissionRateLimit(ip)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Too many submissions. Please try again in an hour.' }));
        return;
      }
      const name = String(f.name || '').trim();
      const email = String(f.email || '').trim();
      const permission = String(f.permission || '').trim();
      if (!name) throw new Error('Name is required.');
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Valid email is required.');
      if (!permission) throw new Error('You must grant permission to submit.');
      let photo_url = '';
      if (form.files.photo && form.files.photo.filename && isSafeImage(form.files.photo.filename)) {
        const photoFile = form.files.photo;
        if (photoFile.data.length > 5 * 1024 * 1024) throw new Error('Photo is too large. Max 5MB.');
        let uploadResult = null;
        try { uploadResult = await uploadImageToCloudinary(photoFile.data, photoFile.filename, 'featured'); } catch { uploadResult = null; }
        if (!uploadResult) uploadResult = uploadImageLocally(photoFile.data, photoFile.filename);
        photo_url = uploadResult.url;
      }
      const id = crypto.randomUUID();
      const submission = {
        id,
        slug: playerProfileSlug(name, String(f.nickname || '').trim()),
        name,
        nickname: String(f.nickname || '').trim(),
        email,
        city: String(f.city || '').trim(),
        favorite_game: String(f.favorite_game || '').trim(),
        biggest_accomplishment: String(f.biggest_accomplishment || '').trim().slice(0, 800),
        funny_story: String(f.funny_story || '').trim().slice(0, 2000),
        bad_beat_story: String(f.bad_beat_story || '').trim().slice(0, 2000),
        social_link: String(f.social_link || '').trim().slice(0, 300),
        photo_url,
        permission_granted: true,
        status: 'pending',
        badge: '',
        featured_on_home: false,
        admin_notes: '',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        approved_at: null,
      };
      const all = await loadSubmissions();
      all.unshift(submission);
      await saveSubmissions(all);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Thanks for sharing your story! We\'ll review your submission and reach out if you\'re featured.' }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (pathname === '/community-wall') {
    const all = await loadSubmissions();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderCommunityWallPage(all));
    return;
  }

  if (pathname.startsWith('/players/')) {
    const slug = pathname.split('/').filter(Boolean).slice(1).join('/');
    const all = await loadSubmissions();
    const player = all.find((p) => p.slug === slug && p.status === 'approved');
    if (!player) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderLayout('Player not found', `<section class="card"><h1>Player not found</h1><p class="body-text">This profile doesn't exist or hasn't been approved yet.</p><p style="margin-top:.75rem;"><a href="/community-wall">← Back to Community Wall</a></p></section>`));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderPlayerProfilePage(player, all));
    return;
  }

  if (pathname === '/api/admin/submissions' && req.method === 'GET') {
    const all = await loadSubmissions();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(all));
    return;
  }

  if (pathname.startsWith('/api/admin/submissions/') && req.method === 'GET') {
    const id = pathname.split('/').pop();
    const all = await loadSubmissions();
    const s = all.find((x) => x.id === id);
    if (!s) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found.' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(s));
    return;
  }

  if (pathname.startsWith('/api/admin/submissions/') && req.method === 'PUT') {
    try {
      const id = pathname.split('/').pop();
      const body = await parseJsonBody(req);
      const all = await loadSubmissions();
      const idx = all.findIndex((x) => x.id === id);
      if (idx === -1) throw new Error('Submission not found.');
      const old = all[idx];
      const updated = {
        ...old,
        status: body.status !== undefined ? body.status : old.status,
        badge: body.badge !== undefined ? String(body.badge || '') : old.badge,
        featured_on_home: body.featured_on_home !== undefined ? !!body.featured_on_home : !!old.featured_on_home,
        admin_notes: body.admin_notes !== undefined ? String(body.admin_notes || '') : old.admin_notes,
        updated_at: new Date().toISOString(),
        approved_at: body.status === 'approved' && !old.approved_at ? new Date().toISOString() : old.approved_at || null,
      };
      all[idx] = updated;
      await saveSubmissions(all);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(updated));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (pathname.startsWith('/api/admin/submissions/') && req.method === 'DELETE') {
    try {
      const id = pathname.split('/').pop();
      const all = await loadSubmissions();
      const filtered = all.filter((x) => x.id !== id);
      if (filtered.length === all.length) throw new Error('Submission not found.');
      await saveSubmissions(filtered);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    const [allPosts, allChron, allSubs] = await Promise.all([loadPosts(), loadChronicles(), loadSubmissions()]);
    const pubPosts = allPosts
      .filter((post) => post.status === 'published')
      .sort((a, b) => new Date(b.published_at || b.created_at) - new Date(a.published_at || a.created_at));
    const heroPosts = pubPosts.slice(0, 5);
    const pubChron = allChron
      .filter((c) => c.status === 'published')
      .sort((a, b) => new Date(b.published_at || b.created_at) - new Date(a.published_at || a.created_at));
    const featChron = pubChron.slice(0, 4);
    fs.readFile(path.join(__dirname, 'index.html'), 'utf8', (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('Homepage not found');
        return;
      }
      const recentPostsHtml = heroPosts.map((post) => `
        <article class="recent-post-tile">
          <p class="meta">${escapeHtml(new Date(post.published_at || post.created_at).toLocaleDateString())}</p>
          <h4>${escapeHtml(post.title)}</h4>
          <p>${escapeHtml(post.excerpt || 'Fresh table story coming soon.')}</p>
          <a href="/blog/${escapeHtml(post.slug)}">Read story →</a>
        </article>`).join('');
      const allPostsHtml = pubPosts.map((post) => `
          <article class="post-card" style="margin-top:.75rem;">
            ${post.featured_image_url ? `<img src="${escapeHtml(post.featured_image_url)}" alt="${escapeHtml(post.featured_image_alt || post.title)}" />` : ''}
            <p class="meta">${escapeHtml(new Date(post.published_at || post.created_at).toLocaleDateString())}</p>
            <h3 style="font-size:1.1rem; margin:.25rem 0;">${escapeHtml(post.title)}</h3>
            <p class="body-text">${escapeHtml(post.excerpt || '')}</p>
            <a href="/blog/${escapeHtml(post.slug)}" style="display:inline-block; margin-top:.5rem;">Read story →</a>
          </article>`).join('');
      const chronPreviewHtml = featChron.length ? featChron.map((c) => `
          <article class="hof-preview-card">
            <div class="hof-preview-cat">${escapeHtml(c.category || 'Chronicles')}</div>
            <h3><a href="/chronicles/${escapeHtml(c.slug)}">${escapeHtml(c.title)}</a></h3>
            <p>${escapeHtml((c.excerpt || '').slice(0, 120))}${(c.excerpt || '').length > 120 ? '…' : ''}</p>
            <a href="/chronicles/${escapeHtml(c.slug)}" class="hof-preview-cta">Read Story →</a>
          </article>`).join('') : '<div class="notice">No chronicles published yet.</div>';
      const chronSection = `<section class="schedule" id="chronicles-preview" style="border-top:1px solid #1a1a1a;">
        <style>
          .hof-preview-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:1rem;margin-top:1rem;}
          @media(max-width:900px){.hof-preview-grid{grid-template-columns:1fr;}}
          .hof-preview-card{border:1px solid #1e1e1e;background:#0c0c0c;border-radius:14px;padding:1rem;}
          .hof-preview-cat{font-size:.62rem;text-transform:uppercase;letter-spacing:.14em;color:var(--green);margin-bottom:.4rem;}
          .hof-preview-card h3{font-family:'DM Serif Display',serif;font-size:1.05rem;line-height:1.3;margin-bottom:.4rem;}
          .hof-preview-card h3 a{color:var(--offwhite);text-decoration:none;}
          .hof-preview-card h3 a:hover{color:var(--green);}
          .hof-preview-card p{color:#888;font-size:.8rem;line-height:1.55;}
          .hof-preview-cta{display:inline-block;margin-top:.5rem;color:var(--green);font-size:.7rem;text-transform:uppercase;letter-spacing:.12em;text-decoration:none;}
        </style>
        <p class="section-label">// Hall of Fame Poker Room</p>
        <h2>Latest Hall of Fame Chronicles</h2>
        <p class="body-text" style="max-width:60ch;">Stories from dealers, floor staff, and Vegas poker life at the Horseshoe WSOP Hall of Fame Poker Room.</p>
        <div class="hof-preview-grid">${chronPreviewHtml}</div>
        <div style="margin-top:1.5rem;"><a href="/chronicles" style="display:inline-block;color:var(--green);font-size:.78rem;text-transform:uppercase;letter-spacing:.12em;">View All Chronicles →</a></div>
      </section>`;
      const featuredPlayers = allSubs
        .filter((s) => s.status === 'approved')
        .sort((a, b) => (b.featured_on_home ? 1 : 0) - (a.featured_on_home ? 1 : 0))
        .slice(0, 4);
      const communityCardsHtml = featuredPlayers.length
        ? featuredPlayers.map((p) => {
            const initials = ((p.name || 'P').split(' ').map((w) => w[0]).join('').slice(0, 2)).toUpperCase();
            const badgeHtml = p.badge ? `<span style="display:inline-block;padding:.2rem .5rem;border-radius:20px;font-size:.6rem;text-transform:uppercase;letter-spacing:.1em;background:var(--green);color:#000;margin-bottom:.4rem;">${escapeHtml(p.badge)}</span>` : '';
            const photoHtml = p.photo_url
              ? `<img src="${escapeHtml(p.photo_url)}" alt="${escapeHtml(p.name)}" style="width:56px;height:56px;border-radius:50%;object-fit:cover;border:2px solid var(--green);margin-right:.75rem;">`
              : `<div style="width:56px;height:56px;border-radius:50%;background:var(--felt);display:flex;align-items:center;justify-content:center;color:var(--green);font-family:'Bebas Neue',sans-serif;font-size:1.1rem;border:2px solid var(--green-dim);margin-right:.75rem;">${escapeHtml(initials)}</div>`;
            return `<article style="border:1px solid #1e1e1e;background:#0c0c0c;border-radius:14px;padding:1rem;">
              <div style="display:flex;align-items:center;margin-bottom:.75rem;">${photoHtml}<div><div style="font-family:'Bebas Neue',sans-serif;font-size:1rem;color:var(--offwhite);">${escapeHtml(p.name)}${p.nickname ? ` <span style="color:var(--green);font-size:.85rem;">"${escapeHtml(p.nickname)}"</span>` : ''}</div>${p.city ? `<div style="color:var(--gray);font-size:.72rem;">${escapeHtml(p.city)}</div>` : ''}</div></div>
              ${badgeHtml}
              ${p.accomplishment ? `<p style="color:#888;font-size:.78rem;line-height:1.5;margin-bottom:.5rem;">${escapeHtml(p.accomplishment.slice(0, 100))}${p.accomplishment.length > 100 ? '…' : ''}</p>` : ''}
              <a href="/players/${escapeHtml(p.slug)}" style="color:var(--green);font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;text-decoration:none;">View Profile →</a>
            </article>`;
          }).join('')
        : '<div style="color:var(--gray);font-size:.9rem;">No community profiles yet. <a href="/request-feature" style="color:var(--green);">Be the first →</a></div>';
      const communitySection = `<section class="schedule" id="community-preview" style="border-top:1px solid #1a1a1a;">
        <p class="section-label">// ATMwithNoPIN Community</p>
        <h2>Community Wall</h2>
        <p class="body-text" style="max-width:60ch;">Poker players from the ATMwithNoPIN universe — their stories, bad beats, and moments of glory.</p>
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:1rem;margin-top:1rem;">${communityCardsHtml}</div>
        <div style="margin-top:1.5rem;display:flex;gap:1rem;flex-wrap:wrap;">
          <a href="/community-wall" style="display:inline-block;color:var(--green);font-size:.78rem;text-transform:uppercase;letter-spacing:.12em;">View Community Wall →</a>
          <a href="/request-feature" style="display:inline-block;color:var(--gold);font-size:.78rem;text-transform:uppercase;letter-spacing:.12em;">Get Featured →</a>
        </div>
      </section>`;
      const html = data
        .replace('<!-- BLOG_PREVIEW -->', `<section class="schedule" id="latest" style="border-top:1px solid #1a1a1a;"><p class="section-label">// Latest from the ATM</p><h2>Latest from the ATM</h2><p class="body-text" style="max-width:60ch;">Fresh table stories, tournament notes, and bad beats from the ATMwithNoPIN™ world.</p><div class="posts">${allPostsHtml || '<div class="notice">No published posts yet. Publish your first story in the admin area.</div>'}</div><div style="margin-top:1.5rem;"><a href="/blog" style="display:inline-block;color:var(--green);font-size:.78rem;text-transform:uppercase;letter-spacing:.12em;">View all stories on the blog →</a></div></section>`)
        .replace('<!-- RECENT_POSTS -->', recentPostsHtml || '<div class="notice">No published posts yet.</div>')
        .replace('<!-- CHRONICLES_PREVIEW -->', chronSection)
        .replace('<!-- COMMUNITY_PREVIEW -->', communitySection)
        .replace(/ATM With No PIN — Dhezz/g, 'ATMwithNoPIN™ Poker | Official Site')
        .replace(/<title>ATM With No PIN — Dhezz<\/title>/, '<title>ATMwithNoPIN™ Poker | Official Site</title>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    return;
  }

  const urlPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(__dirname, urlPath);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (pathname.startsWith('/uploads/')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Image not found.' }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderLayout('Not found', `<section class="card"><h1>Not found</h1><p class="body-text">The page you requested is not available.</p></section>`));
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

async function start() {
  await initializeDatabase();
  await migrateLegacyPosts();
  await seedDefaultPosts();
  await seedDefaultChronicles();
  server.listen(PORT, () => {
    console.log(`ATM is open on port ${PORT} 🏧`);
  });
}

start().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
