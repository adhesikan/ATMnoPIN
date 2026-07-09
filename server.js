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
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 10,
}) : null;
if (pgPool) pgPool.on('error', (err) => console.error('pg pool error:', err.message));
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
      CREATE TABLE IF NOT EXISTS visitor_log (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS consent_log (
        id TEXT PRIMARY KEY,
        email_address TEXT NOT NULL DEFAULT '',
        consent_type TEXT NOT NULL,
        consent_version TEXT NOT NULL DEFAULT '1.0',
        accepted INTEGER NOT NULL DEFAULT 1,
        accepted_at TEXT NOT NULL,
        source_feature TEXT DEFAULT '',
        ip_address TEXT DEFAULT '',
        location TEXT DEFAULT '',
        user_agent TEXT DEFAULT '',
        page_url TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS _consent_log_v2_done (id INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO _consent_log_v2_done VALUES (1);
    `);
    try { sqliteDb.exec(`ALTER TABLE consent_log ADD COLUMN location TEXT DEFAULT ''`); } catch {}
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS rail_posts (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending',
        like_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rail_likes (
        id TEXT PRIMARY KEY,
        post_id TEXT NOT NULL,
        liker_ip TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(post_id, liker_ip)
      );
      CREATE TABLE IF NOT EXISTS rail_reports (
        id TEXT PRIMARY KEY,
        post_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        data TEXT NOT NULL
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
      CREATE TABLE IF NOT EXISTS visitor_log (
        id TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        data JSONB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS consent_log (
        id TEXT PRIMARY KEY,
        email_address TEXT NOT NULL DEFAULT '',
        consent_type TEXT NOT NULL,
        consent_version TEXT NOT NULL DEFAULT '1.0',
        accepted BOOLEAN NOT NULL DEFAULT TRUE,
        accepted_at TIMESTAMPTZ NOT NULL,
        source_feature TEXT DEFAULT '',
        ip_address TEXT DEFAULT '',
        location TEXT DEFAULT '',
        user_agent TEXT DEFAULT '',
        page_url TEXT DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE consent_log ADD COLUMN IF NOT EXISTS location TEXT DEFAULT '';
      CREATE TABLE IF NOT EXISTS rail_posts (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending',
        like_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        data JSONB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rail_likes (
        id TEXT PRIMARY KEY,
        post_id TEXT NOT NULL,
        liker_ip TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(post_id, liker_ip)
      );
      CREATE TABLE IF NOT EXISTS rail_reports (
        id TEXT PRIMARY KEY,
        post_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        data JSONB NOT NULL
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
    title: 'From ATMNOPIN... to ATM with $45,703',
    slug: 'from-atm-with-no-pin-to-atm-with-45703',
    excerpt: 'After a string of tournament bust-outs, I finally made a deep WSOP run, finished 8th for $45,703, and even made PokerNews wearing my ATMNOPIN hat. A reminder that poker is a roller coaster—and sometimes the ATM finally pays out.',
    content: `# From ATMNOPIN... to ATM with $45,703

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

My ATMNOPIN hat made it into the PokerNews photos.

Mission accomplished.

People always ask what ATMNOPIN means.

Simple.

Sometimes you withdraw money from poker.

Sometimes poker withdraws money from you.

This week...

The ATM actually paid out.

See you at the Main Event.

Let's see if we can make the ATM dispense six figures next time.`,
    tags: ['WSOP', 'Poker', 'Tournament', 'Deep Run', 'Cash', 'PokerNews', 'ATMNOPIN', 'Texas Hold\'em'],
    status: 'published',
    featured_image_url: '',
    featured_image_alt: 'Dhesikan Ananchaperumal at the WSOP wearing an ATMNOPIN hat.',
    gallery_images: [],
    video_urls: [],
    created_at: '2026-06-27T12:00:00.000Z',
    updated_at: '2026-06-27T12:00:00.000Z',
    published_at: '2026-06-27T12:00:00.000Z',
  },
];

// ── Tournament Journey config ─────────────────────────────────────────────────
// Edit this array to update homepage Tournament Journey cards without touching HTML.
// Fields: label, value, valueClass ('gold'|''), valueStyle (inline CSS string|''),
//         desc (plain text, \n\n becomes <br><br>), badge (string|null)
const TOURNAMENT_RESULTS = [
  {
    label: '// WSOP 2026 Deep Run',
    value: '$45,703',
    valueClass: 'gold',
    valueStyle: '',
    desc: '$1,000 WSOP No-Limit Hold\'em Event\n\nFinished 8th out of 3,323 entries.\n\nThe deepest tournament run in ATMNOPIN history and the first major WSOP final table.',
    badge: 'Career Best WSOP Finish',
  },
  {
    label: '// Current Game',
    value: '$2/$5',
    valueClass: '',
    valueStyle: '',
    desc: 'The daily grind. NLH cash games at Foxwoods Resort Casino and select tournament stops across the Northeast.',
    badge: null,
  },
  {
    label: '// Next Mission',
    value: 'TBD',
    valueClass: '',
    valueStyle: 'font-size:1.8rem;padding-top:.2rem;',
    desc: 'Follow on social for the next stop. The ATM goes where the action is.',
    badge: null,
  },
];

async function seedDefaultPosts() {
  try {
    const existing = await loadPosts();
    const existingById = new Map(existing.map((p) => [p.id, p]));
    const existingSlugs = new Set(existing.map((p) => p.slug));
    const seedById = new Map(SEED_POSTS.map((p) => [p.id, p]));
    const idsToUpdate = new Set();
    const toAdd = [];
    for (const seed of SEED_POSTS) {
      if (existingById.has(seed.id)) { idsToUpdate.add(seed.id); }
      else if (!existingSlugs.has(seed.slug)) { toAdd.push(seed); }
    }
    if (!toAdd.length && !idsToUpdate.size) return;
    const updated = existing.map((p) =>
      idsToUpdate.has(p.id) ? { ...p, ...seedById.get(p.id) } : p
    );
    await savePosts([...toAdd, ...updated]);
  } catch {
    // non-fatal
  }
}

const SEED_CHRONICLES = [
  // ─── HORSESHOE / WSOP ───
  {
    id: 'c001-terrell-atm-biggest-fan-wsop-2026',
    title: 'Dealer Spotlight: Terrell — The Railbird',
    slug: 'dealer-spotlight-terrell-my-biggest-fan-at-the-wsop',
    excerpt: 'Dealer by day, tournament supporter by night. Terrell has stood on the rail for Dhezz more times than most friends would.',
    category: 'Dealer Spotlight',
    person_type: 'dealer',
    poker_room: 'Horseshoe / WSOP',
    specialty: 'Rail support',
    tell: 'Shows up after shift to cheer',
    threat_level: 'Good vibes guaranteed',
    icon_type: '♦',
    tags: ['WSOP', 'Horseshoe', 'Hall of Fame Poker Room', 'Dealer Spotlight', 'Terrell', 'Rail Support', 'Community Story', 'ATMNOPIN'],
    content: `Every poker player dreams of having a rail.

Mine usually consists of one very enthusiastic dealer named Terrell.

Whenever I'm playing a tournament, Terrell somehow finds time to stop by before work, after work, or during breaks to wish me luck.

Sometimes he even comes and stands on the rail while I'm playing.

At this point, I think he's more confident I'll win a bracelet than I am.

Unfortunately, the poker gods haven't gotten the memo yet.

Terrell keeps believing.

I keep trying.

One of these years we're going to have a very expensive celebration.

**ATMNOPIN Rating:**

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
    crew_nickname: 'The Railbird',
    crew_role: 'Dealer',
    crew_quote: '',
    created_at: '2026-06-27T13:00:00.000Z',
    updated_at: '2026-06-27T13:00:00.000Z',
    published_at: '2026-06-27T13:00:00.000Z',
  },
  {
    id: 'c002-dominick-poker-jesus-tournament-blessings-2026',
    title: 'Dealer Spotlight: Dominick — Poker Jesus',
    slug: 'dealer-spotlight-poker-jesus-dominicks-tournament-blessings',
    excerpt: 'Tournament blessings available before every event. Results may vary.',
    category: 'Dealer Spotlight',
    person_type: 'dealer',
    poker_room: 'Horseshoe / WSOP',
    specialty: 'Tournament blessings',
    tell: 'The hair and beard give it away',
    threat_level: 'Faith-based run good',
    icon_type: '♦',
    tags: ['WSOP', 'Horseshoe', 'Hall of Fame Poker Room', 'Dealer Spotlight', 'Dominick', 'Poker Jesus', 'Tournament Blessings', 'Poker Humor', 'Community Story', 'ATMNOPIN'],
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

**ATMNOPIN Rating:**

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
    title: 'Dealer Spotlight: Crazy Mike — River Card Specialist',
    slug: 'dealer-spotlight-crazy-mike-the-river-card-is-always-his-fault',
    excerpt: 'Every bad river is somehow his fault. At least according to Dhezz.',
    category: 'Dealer Spotlight',
    person_type: 'dealer',
    poker_room: 'Horseshoe / WSOP',
    specialty: 'Suspicious runouts',
    tell: 'Dry smile after the bad river',
    threat_level: 'Emotionally expensive',
    icon_type: '♦',
    tags: ['WSOP', 'Horseshoe', 'Hall of Fame Poker Room', 'Dealer Spotlight', 'Crazy Mike', 'Bad Beats', 'Poker Humor', 'River Cards', 'Community Story', 'ATMNOPIN'],
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

**ATMNOPIN Rating:**

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
    crew_nickname: 'River Card Specialist',
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
    category: 'Floor Spotlight',
    person_type: 'floor',
    poker_room: 'Horseshoe / WSOP',
    specialty: 'Keeping the room running',
    tell: 'Already solving the next problem',
    threat_level: 'Final Table Level management',
    icon_type: '♣',
    tags: ['WSOP', 'Horseshoe', 'Hall of Fame Poker Room', 'Floor Spotlight', 'Floor Staff', 'Frank', 'Behind the Scenes', 'Community Story', 'ATMNOPIN'],
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

**ATMNOPIN Rating:**

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
    crew_nickname: 'The Man Who Keeps the Poker Room Running',
    crew_role: 'Floor Manager',
    crew_quote: '',
    created_at: '2026-06-27T13:30:00.000Z',
    updated_at: '2026-06-27T13:30:00.000Z',
    published_at: '2026-06-27T13:30:00.000Z',
  },
  // ─── FOXWOODS PLAYERS ───
  {
    id: 'c005-manny-the-machine-foxwoods-2026',
    title: 'Player Spotlight: Manny — The Machine',
    slug: 'player-spotlight-manny-the-machine',
    excerpt: 'Deposits chips like clockwork. Consistent. Reliable. Somehow always confident.',
    category: 'Player Spotlight',
    person_type: 'player',
    poker_room: 'Foxwoods',
    specialty: 'Mechanical chip donations',
    tell: 'Always looks confident',
    threat_level: 'Bring extra buy-ins',
    icon_type: '♠',
    tags: ['Foxwoods', 'Player Spotlight', 'Fellow Fish', 'Poker Friends', '$2/$5 NLH', 'Cash Games', 'Community Story', 'ATMNOPIN'],
    content: `Manny earned his nickname at the $2/$5 NLH tables at Foxwoods.

Not because he plays like a computer.

Because he deposits chips with the mechanical reliability of a well-maintained ATM.

Clock him in. Stack up. Shove the river with second pair.

Specialty: Mechanical chip donations.

Tell: Always looks confident, regardless of what he's holding.

The unsettling part is that sometimes he actually is holding something.

**ATMNOPIN Rating:**

- Consistency: 5/5
- Chip Deposit Reliability: 5/5
- Fold Frequency: Not observed
- Threat Level: Bring extra buy-ins`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'Manny, The Machine, at Foxwoods',
    gallery_images: [],
    video_urls: [],
    crew_nickname: 'The Machine',
    crew_role: 'Player',
    crew_quote: '',
    created_at: '2026-06-27T14:00:00.000Z',
    updated_at: '2026-06-27T14:00:00.000Z',
    published_at: '2026-06-27T14:00:00.000Z',
  },
  {
    id: 'c006-jamie-the-tuna-foxwoods-2026',
    title: 'Player Spotlight: Jamie — The Tuna',
    slug: 'player-spotlight-jamie-the-tuna',
    excerpt: 'Never sees it coming — not the bluff, not the set, not the straight on the board.',
    category: 'Player Spotlight',
    person_type: 'player',
    poker_room: 'Foxwoods',
    specialty: 'Calling with nothing',
    tell: 'Looks at chips before calling',
    threat_level: 'Occasionally dangerous',
    icon_type: '♠',
    tags: ['Foxwoods', 'Player Spotlight', 'Fellow Fish', 'Poker Friends', '$2/$5 NLH', 'Cash Games', 'Poker Humor', 'Community Story', 'ATMNOPIN'],
    content: `The Tuna doesn't just call.

The Tuna *believes*.

Jamie has a gift for eternal optimism at the poker table. No matter the board texture, the betting pattern, or the obvious danger, Jamie believes every hand might still be the one.

Sometimes it is.

More often it isn't.

But the optimism never fades.

Specialty: Calling with nothing.

Tell: Looks at chips before calling. A tell that helps nobody, because the call is happening regardless.

**ATMNOPIN Rating:**

- Calling Ability: 5/5
- Hand Selection: Freestyle
- Board Reading: Optional
- Threat Level: Occasionally dangerous`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'Jamie, The Tuna, at Foxwoods',
    gallery_images: [],
    video_urls: [],
    crew_nickname: 'The Tuna',
    crew_role: 'Player',
    crew_quote: '',
    created_at: '2026-06-27T14:10:00.000Z',
    updated_at: '2026-06-27T14:10:00.000Z',
    published_at: '2026-06-27T14:10:00.000Z',
  },
  {
    id: 'c007-jay-ducky-jay-foxwoods-2026',
    title: 'Player Spotlight: Jay — Ducky Jay',
    slug: 'player-spotlight-jay-ducky-jay',
    excerpt: 'The duck may be the real decision maker. Jay just brings the chips.',
    category: 'Player Spotlight',
    person_type: 'player',
    poker_room: 'Foxwoods',
    specialty: 'Letting the duck decide',
    tell: 'Always has a rubber duck on his stack',
    threat_level: 'The duck is scarier',
    icon_type: '♠',
    tags: ['Foxwoods', 'Player Spotlight', 'Fellow Fish', 'Poker Friends', '$2/$5 NLH', 'Cash Games', 'Poker Humor', 'Community Story', 'ATMNOPIN'],
    content: `The rubber duck sits on the stack.

It always has.

At some point, Jay decided that the duck would serve as his card protector, his spiritual guide, and possibly his poker coach.

The duck watches the action.

The duck sees the flop.

The duck does not fold.

Nobody knows for certain whether Jay makes the final calls or delegates to the duck. The results are inconclusive.

What we do know: the duck has never been rattled by a bad beat.

Specialty: Letting the duck decide.

Tell: Rubber duck visible on stack from any seat at the table.

**ATMNOPIN Rating:**

- Player Threat: Moderate
- Duck Threat: Unknown and possibly higher
- Bluffing Consistency: Both Jay and the duck play it straight
- Threat Level: The duck is scarier`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'Jay (Ducky Jay) and his rubber duck, at Foxwoods',
    gallery_images: [],
    video_urls: [],
    crew_nickname: 'Ducky Jay',
    crew_role: 'Player',
    crew_quote: '',
    created_at: '2026-06-27T14:20:00.000Z',
    updated_at: '2026-06-27T14:20:00.000Z',
    published_at: '2026-06-27T14:20:00.000Z',
  },
  {
    id: 'c008-you-open-seat-community-2026',
    title: 'Community Story: You? — One Seat Is Open',
    slug: 'community-story-you-one-seat-is-open',
    excerpt: 'One seat is open. Submit your story and earn your nickname.',
    category: 'Community Story',
    person_type: 'community',
    poker_room: 'Any Poker Room',
    specialty: 'Unknown — yet',
    tell: 'To be discovered',
    threat_level: 'Unrated',
    icon_type: '♥',
    cta_label: 'Get Featured',
    cta_href: '/ai-profile-generator',
    tags: ['Community', 'Player Spotlight', 'Get Featured', 'Table Characters', 'Foxwoods', '$2/$5 NLH', 'Community Story', 'ATMNOPIN'],
    content: `The ATMNOPIN universe is not a closed table.

There is always one more seat.

Maybe you're a regular at Foxwoods. Maybe you've sat across from Dhezz and remember the hand differently. Maybe you're a dealer who has watched the action from a unique angle.

Maybe you have a nickname already.

Maybe you're about to earn one.

Every great poker community has characters. The ATM table has a few openings.

Come sit down. Make some questionable decisions. Survive a bad beat. Tell a story.

Submit your profile and you might be the next Chronicle.

**ATMNOPIN Rating:**

- Potential: Unknown (High)
- Table History: TBD
- Specialty: To be discovered
- Threat Level: Unrated`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'Open seat — Community Wall invitation',
    gallery_images: [],
    video_urls: [],
    crew_nickname: 'TBD',
    crew_role: 'Future Community Member',
    crew_quote: '',
    created_at: '2026-06-27T14:30:00.000Z',
    updated_at: '2026-06-27T14:30:00.000Z',
    published_at: '2026-06-27T14:30:00.000Z',
  },
  // ─── FOXWOODS FLOOR STAFF ───
  {
    id: 'c009-bhavin-the-connector-foxwoods-2026',
    title: 'Floor Spotlight: Bhavin — The Connector',
    slug: 'floor-spotlight-bhavin-the-connector',
    excerpt: 'Gets players seated, keeps the room moving, and somehow handles everything at once.',
    category: 'Floor Spotlight',
    person_type: 'floor',
    poker_room: 'Foxwoods',
    specialty: 'Keeping the room moving',
    tell: 'Already knows what table you need',
    threat_level: 'Professionally dangerous',
    icon_type: '♣',
    tags: ['Foxwoods', 'Floor Spotlight', 'Floor Staff', 'Behind the Scenes', 'Poker Room', 'Community Story', 'ATMNOPIN'],
    content: `The floor at Foxwoods moves because people like Bhavin make it move.

He gets players to tables. He resolves disputes. He handles the list when it's backed up, answers questions before they've been asked, and keeps track of details that most people haven't noticed.

He does it with a calm that suggests he has seen everything — and has already figured out the solution.

Specialty: Keeping the room moving.

Tell: Already knows what table you need before you ask.

**ATMNOPIN Rating:**

- Room Management: 5/5
- Player Support: 5/5
- Problem Resolution: Pre-emptive
- Threat Level: Professionally dangerous`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'Bhavin, floor staff at Foxwoods',
    gallery_images: [],
    video_urls: [],
    crew_nickname: 'The Connector',
    crew_role: 'Floor Staff',
    crew_quote: '',
    created_at: '2026-06-27T15:00:00.000Z',
    updated_at: '2026-06-27T15:00:00.000Z',
    published_at: '2026-06-27T15:00:00.000Z',
  },
  {
    id: 'c010-charlie-still-standing-foxwoods-2026',
    title: 'Floor Spotlight: Charlie — Still Standing',
    slug: 'floor-spotlight-charlie-still-standing',
    excerpt: 'Keeps the chaos under control and shows up again tomorrow.',
    category: 'Floor Spotlight',
    person_type: 'floor',
    poker_room: 'Foxwoods',
    specialty: 'Surviving the room',
    tell: 'Unfazed by chaos',
    threat_level: 'Untouchable',
    icon_type: '♣',
    tags: ['Foxwoods', 'Floor Spotlight', 'Floor Staff', 'Behind the Scenes', 'Poker Room', 'Community Story', 'ATMNOPIN'],
    content: `Charlie has been there.

The floor at Foxwoods on a busy Friday night is not a calm environment.

Long lists. Impatient players. Disputes at three tables simultaneously. A dealer who needs a break. A player who wants a seat change. Someone asking about the bad beat jackpot.

Charlie handles all of it.

And then shows up and does it again tomorrow.

That alone deserves a Chronicle.

**ATMNOPIN Rating:**

- Endurance: 5/5
- Calm Under Pressure: 5/5
- "I've Seen Everything" Energy: High
- Threat Level: Untouchable`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'Charlie, floor staff at Foxwoods',
    gallery_images: [],
    video_urls: [],
    crew_nickname: 'Still Standing',
    crew_role: 'Floor Staff',
    crew_quote: '',
    created_at: '2026-06-27T15:10:00.000Z',
    updated_at: '2026-06-27T15:10:00.000Z',
    published_at: '2026-06-27T15:10:00.000Z',
  },
  {
    id: 'c011-steve-birthday-variance-foxwoods-2026',
    title: 'Floor Spotlight: Steve — Birthday Variance',
    slug: 'floor-spotlight-steve-birthday-variance',
    excerpt: 'Same birthday as Dhezz. Results still under investigation.',
    category: 'Floor Spotlight',
    person_type: 'floor',
    poker_room: 'Foxwoods',
    specialty: 'Suspicious coincidence',
    tell: 'Same birthday as Dhezz',
    threat_level: 'Cosmic variance',
    icon_type: '♣',
    tags: ['Foxwoods', 'Floor Spotlight', 'Floor Staff', 'Poker Humor', 'Behind the Scenes', 'Community Story', 'ATMNOPIN'],
    content: `Steve shares the same birthday as Dhezz.

This should, theoretically, mean something.

Shared birthdays usually imply cosmic alignment. Sympathetic variance. Perhaps a transfer of good luck.

So far, the evidence is inconclusive.

Dhezz has run bad on Steve's birthday.

Steve has presumably had a normal day.

The universe may be playing a very long con.

**ATMNOPIN Rating:**

- Birthday Significance: Theoretical
- Variance Alignment: Unknown
- Cosmic Coincidence Level: Very High
- Investigation Status: Ongoing`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'Steve, floor staff at Foxwoods',
    gallery_images: [],
    video_urls: [],
    crew_nickname: 'Birthday Variance',
    crew_role: 'Floor Staff',
    crew_quote: '',
    created_at: '2026-06-27T15:20:00.000Z',
    updated_at: '2026-06-27T15:20:00.000Z',
    published_at: '2026-06-27T15:20:00.000Z',
  },
  // ─── FOXWOODS DEALERS ───
  {
    id: 'c012-felix-the-setup-artist-foxwoods-2026',
    title: 'Dealer Spotlight: Felix — The Setup Artist',
    slug: 'dealer-spotlight-felix-the-setup-artist',
    excerpt: 'Smiles politely while delivering the river card nobody asked for.',
    category: 'Dealer Spotlight',
    person_type: 'dealer',
    poker_room: 'Foxwoods',
    specialty: 'Delivering drama',
    tell: 'Too calm before the river',
    threat_level: 'Board texture expert',
    icon_type: '♦',
    tags: ['Foxwoods', 'Dealer Spotlight', 'Bad Beats', 'River Cards', 'Poker Room', 'Community Story', 'ATMNOPIN'],
    content: `Felix has professional poker dealer calm.

He has seen every board texture. Every bad beat. Every river suckout.

He delivers them all with the same expression: focused, composed, and entirely without judgment.

When the river comes and ruins everything, Felix keeps the game moving.

His specialty is not the delivery of good cards.

His specialty is the delivery of drama, handled with absolute professionalism.

**ATMNOPIN Rating:**

- Calm Under Pressure: 5/5
- River Card Drama: 5/5
- Warning Signs: Too calm before the river
- Threat Level: Board texture expert`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'Felix, dealer at Foxwoods',
    gallery_images: [],
    video_urls: [],
    crew_nickname: 'The Setup Artist',
    crew_role: 'Dealer',
    crew_quote: '',
    created_at: '2026-06-27T15:30:00.000Z',
    updated_at: '2026-06-27T15:30:00.000Z',
    published_at: '2026-06-27T15:30:00.000Z',
  },
  {
    id: 'c013-ray-master-of-timing-foxwoods-2026',
    title: 'Dealer Spotlight: Ray — Master of Timing',
    slug: 'dealer-spotlight-ray-master-of-timing',
    excerpt: 'Always knows exactly when to announce, "All in and a call."',
    category: 'Dealer Spotlight',
    person_type: 'dealer',
    poker_room: 'Foxwoods',
    specialty: 'All-in announcements',
    tell: 'Voice gets serious',
    threat_level: 'Stack movement imminent',
    icon_type: '♦',
    tags: ['Foxwoods', 'Dealer Spotlight', 'Poker Room', 'All In', 'Cash Games', 'Community Story', 'ATMNOPIN'],
    content: `Ray has perfect timing.

Not comedy timing.

Poker timing.

The kind where the action stalls, the chips go in, and the table holds its breath.

That's when Ray's voice gets slightly more serious.

"All in and a call."

The room stands up.

Ray has dealt this hand a thousand times.

He keeps dealing.

**ATMNOPIN Rating:**

- All-In Announcements: 5/5
- Voice Calibration: Clinical
- Table Atmosphere: Pre-combustion
- Threat Level: Stack movement imminent`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'Ray, dealer at Foxwoods',
    gallery_images: [],
    video_urls: [],
    crew_nickname: 'Master of Timing',
    crew_role: 'Dealer',
    crew_quote: '',
    created_at: '2026-06-27T15:40:00.000Z',
    updated_at: '2026-06-27T15:40:00.000Z',
    published_at: '2026-06-27T15:40:00.000Z',
  },
  {
    id: 'c014-jenny-queen-of-rotation-foxwoods-2026',
    title: 'Dealer Spotlight: Jenny — Queen of the Rotation',
    slug: 'dealer-spotlight-jenny-queen-of-the-rotation',
    excerpt: 'Professional, friendly, and somehow always arrives before the biggest pot of the night.',
    category: 'Dealer Spotlight',
    person_type: 'dealer',
    poker_room: 'Foxwoods',
    specialty: 'Arriving before chaos',
    tell: 'The game suddenly gets expensive',
    threat_level: 'Pot inflation specialist',
    icon_type: '♦',
    tags: ['Foxwoods', 'Dealer Spotlight', 'Poker Room', 'Cash Games', 'Poker Humor', 'Community Story', 'ATMNOPIN'],
    content: `Jenny enters the rotation with calm confidence.

Then, almost immediately, someone puts too many chips in the middle.

This has happened enough times that players have started noticing.

Jenny sits down. Someone raises. Someone calls. Things escalate.

Coincidence?

Maybe.

Chronicle-worthy?

Absolutely.

**ATMNOPIN Rating:**

- Arrival Timing: Suspiciously Precise
- Pot Size Impact: Statistically Significant
- Professional Demeanor: Excellent
- Threat Level: Pot inflation specialist`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'Jenny, dealer at Foxwoods',
    gallery_images: [],
    video_urls: [],
    crew_nickname: 'Queen of the Rotation',
    crew_role: 'Dealer',
    crew_quote: '',
    created_at: '2026-06-27T15:50:00.000Z',
    updated_at: '2026-06-27T15:50:00.000Z',
    published_at: '2026-06-27T15:50:00.000Z',
  },
  {
    id: 'c015-eric-sugar-stacker-foxwoods-2026',
    title: 'Player Spotlight: Eric — The Sugar Stacker',
    slug: 'player-spotlight-eric-the-sugar-stacker',
    excerpt: 'His chip stacks look like they survived an earthquake, his ranges are tighter than airport security, and his beverage intake continues to rise — now with zero sugar and a reserve supply nearby.',
    category: 'Player Spotlight',
    person_type: 'player',
    poker_room: 'Foxwoods',
    specialty: 'Building chip stacks that shouldn\'t exist while maintaining a zero-sugar drink reserve',
    tell: 'Checks the side table before checking the river',
    threat_level: 'Very low... until the beverage reserve is fully stocked',
    icon_type: '♠',
    tags: ['Foxwoods', 'Player Spotlight', 'Fellow Fish', 'Poker Friends', '$2/$5 NLH', 'Poker Humor', 'Table Characters', 'Sugar Stacker', 'Zero Sugar', 'Drink Reserve', 'Ducky Jay', 'Community Story', 'ATMNOPIN'],
    content: `Every poker room has one player whose chip stacks make the dealers slightly uncomfortable.

At Foxwoods, that player is Eric.

Nobody knows whether he's intentionally stacking his chips that way or whether gravity simply gives up when it reaches his seat. Towers lean in every direction. Half-stacks become quarter-stacks. Somewhere inside the pile is probably the actual amount he's playing.

Despite the architectural challenges happening in front of him, Eric isn't hard to read.

He plays tighter than airport security.

If Eric voluntarily puts a lot of chips into the pot, everyone at the table quietly starts reconsidering their own hand.

Now, every once in a while, Eric decides today is the day he's going to become a fearless poker bluffer.

It usually lasts about fifteen seconds.

He'll fire one bet...

Look around the table...

Receive one call...

Then suddenly remember he had somewhere else to be.

Mission aborted.

The bluff has officially entered witness protection.

What Eric lacks in bluff frequency, he makes up for in beverage logistics.

To be clear, the volume has not decreased.

If anything, the operation has expanded.

Eric is now focused on zero sugar drinks, which means the table no longer has to worry about calories — only container count.

At any given moment, there may be one drink in front of him, one backup drink nearby, and possibly a strategic reserve on a side table in case the session goes deep.

This is not casual hydration.

This is bankroll management, but for beverages.

Foxwoods may want to consider assigning him a dedicated beverage rack.

Between hands, Eric has another favorite hobby:

Interviewing Ducky Jay.

Not about poker.

Not about strategy.

Dating.

Every session eventually reaches the same conversation.

"So... how's that girl?"

Poor Jay can barely finish stacking his chips before Eric launches into another relationship update.

The rest of the table gets free entertainment while Jay wonders how a poker session somehow turned into a dating podcast.

There is one more thing Eric has quietly become famous for.

Breakfast.

More specifically...

Buying breakfast for Jamie "The Tuna."

Whether it's generosity, encouragement, or simply making sure Jamie has enough energy to call another river with absolutely nothing, nobody is entirely sure.

Jamie certainly doesn't complain.

If breakfast is involved, Eric somehow finds himself reaching for the bill before anyone else can.

At this point, there are rumors that Jamie's breakfast budget is directly tied to Eric's poker bankroll.

It's one of the few investments at the table that everyone agrees has a guaranteed return...

...for Jamie.

Yet somehow, despite the leaning chip towers, conservative play, abandoned bluffs, zero-sugar reserve logistics, relentless curiosity about Jay's love life, and a standing breakfast tab with The Tuna...

Eric remains one of the easiest guys to root for.

The poker may be tight.

The chip stacks may violate several engineering principles.

The drink reserve may require its own table.

Jamie's breakfast is apparently covered.

But the laughs are always +EV.

**ATMNOPIN Rating:**

- Chip Stack Engineering: Impressively Unstable
- Bluff Completion Rate: 0%
- Beverage Volume: Increasing
- Sugar Content: Zero
- Drink Reserve Depth: Strategic
- Dating Podcast Interruptions Per Session: 3-5
- Breakfast Tabs Covered: Ongoing
- Threat Level: Very low... until the beverage reserve is fully stocked

**Fun Fact:** Eric's beverage operation continues to expand (now entirely zero sugar), he keeps a strategic drink reserve on a nearby table, and Jamie "The Tuna" has become suspiciously accustomed to Eric picking up the breakfast tab.`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'Eric, The Sugar Stacker, at Foxwoods',
    gallery_images: [],
    video_urls: [],
    crew_nickname: 'The Sugar Stacker',
    crew_role: 'Player',
    crew_quote: '',
    created_at: '2026-06-29T10:00:00.000Z',
    updated_at: '2026-06-29T10:00:00.000Z',
    published_at: '2026-06-29T10:00:00.000Z',
  },

  {
    id: 'c042-luke-lucky-horseshoe-foxwoods-2026',
    title: 'Player Spotlight: Luke — Lucky Horseshoe Luke',
    slug: 'player-spotlight-lucky-horseshoe-luke',
    excerpt: 'Luke is rarely seen without his lucky horseshoe tucked somewhere nearby. Whether it actually brings him luck or simply gives the poker gods something to smile about is still up for debate. He\'s always ready for another session, another story, and another chance to prove that faith, patience, and a little superstition can go a long way.',
    category: 'Player Spotlight',
    person_type: 'player',
    poker_room: 'Foxwoods Resort Casino',
    specialty: 'Keeping the horseshoe close and the chip stack growing while everyone else wonders if luck really is a strategy.',
    tell: 'Quietly gives the lucky horseshoe a reassuring tap before the biggest hands.',
    threat_level: 'Looks harmless... until the horseshoe starts running hot.',
    lucky_charm: 'A horseshoe that\'s logged almost as many hours at the poker table as Luke.',
    known_for: 'Never leaving home without his lucky horseshoe and always believing the next session could be the one.',
    table_reputation: 'Friendly, patient, and impossible to convince that the horseshoe is "just a decoration."',
    icon_type: '♠',
    tags: ['Foxwoods', 'Player Spotlight', 'Fellow Fish', 'Poker Friends', '$2/$5 NLH', 'Poker Humor', 'Table Characters', 'Lucky Horseshoe', 'Lucky Charm', 'Superstition', 'Community Story', 'ATMNOPIN'],
    content: `Every poker room has a player who brings something extra to the table.

At Foxwoods, that player is Luke.

Luke doesn't just sit down, stack chips, and play cards.

Luke arrives with backup.

Somewhere within reach — in a pocket, on the rail, near the chip stack — there is a horseshoe.

Not decorative. Not ironic. Fully operational.

Whether it belongs there is not a debate Luke is willing to have.

The horseshoe stays.

The theory behind it is straightforward enough: some players bring superstitions to the table and abandon them the moment things go sideways. Luke brings his and doubles down.

If the horseshoe runs hot, Luke runs hot.

If the horseshoe runs cold, Luke is already planning the next session.

Between hands, Luke is patient.

Not the kind of patient where someone is quietly frustrated and barely holding it together.

The kind of patient where someone genuinely believes that things work out for people who stay ready.

The horseshoe helps.

Ask Luke if the horseshoe actually changes anything.

He'll smile, give it a quiet tap, and let the next hand answer for him.

The poker gods haven't delivered a definitive ruling yet.

But they do seem to be enjoying the show.

At the table, Luke is exactly who you think he is: friendly, unbothered, and completely at peace with the variance.

Bad beats don't shake him.

Cold runs don't shake him.

The horseshoe is there. The next session is coming. That's enough.

Whether the horseshoe is the reason things eventually go his way or simply a reminder to stay the course, nobody at the table has been able to convince Luke it doesn't matter.

And at this point, nobody is really trying.

**ATMNOPIN Rating:**

- Lucky Charm Status: Fully operational
- Horseshoe Placement: Within reach at all times
- Pre-hand Ritual Consistency: Reliable
- Session Readiness: Always
- Patience Level: Genuine
- Threat Level: Looks harmless... until the horseshoe starts running hot
- Belief in the Next Session: Unwavering
- Superstition Commitment: Total

**Fun Fact:** Luke never leaves home without the horseshoe. At this point, it has logged almost as many table hours as he has.`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'Luke, Lucky Horseshoe Luke, at Foxwoods',
    gallery_images: [],
    video_urls: [],
    crew_nickname: 'Lucky Horseshoe Luke',
    crew_role: 'Player',
    crew_quote: '',
    created_at: '2026-07-08T10:00:00.000Z',
    updated_at: '2026-07-08T10:00:00.000Z',
    published_at: '2026-07-08T10:00:00.000Z',
  },

  // ─── TOURNAMENT REPORTS ───
  {
    id: 'c016-atm-45703-wsop-2025',
    title: 'Tournament Report: From ATMNOPIN to ATM with $45,703',
    slug: 'tournament-report-atm-45703-wsop-8th-place',
    excerpt: 'After a string of bust-outs, the ATM finally paid out. 8th place. $45,703. PokerNews. One very expensive hand of K-Q vs pocket tens.',
    category: 'Tournament Reports',
    person_type: 'player',
    poker_room: 'Horseshoe / WSOP',
    specialty: 'Deep runs and dramatic exits',
    tell: 'Still shoves K-Q on the river',
    threat_level: 'Proven final table capable',
    icon_type: '♠',
    cta_label: 'Read Full Story →',
    cta_href: '/blog/from-atm-with-no-pin-to-atm-with-45703',
    tags: ['Tournament Reports', 'WSOP', 'Deep Run', 'Final Table', 'Best Cash', '$45703', 'Horseshoe', 'Community Story', 'ATMNOPIN'],
    content: `The Monster Stack had already been cruel. Multiple bracelet events had already claimed chips. Then something strange happened.

The chips stopped leaving.

Day 1 survived.

Day 2 survived.

Day 3 survived.

PokerNews actually wanted an interview — which they scheduled, reasonably, right after elimination.

The final hand: K♦Q♠ vs 10♥10♦. Shoved. Called. The board produced zero kings and zero queens.

Standard procedure.

8th place. $45,703.

Not the bracelet. But enough to confirm the dream is not completely ridiculous.

The full story is in the blog.`,
    status: 'published',
    featured_on_home: true,
    featured_image_url: '',
    featured_image_alt: 'Dhezz, 8th place at WSOP, $45,703',
    gallery_images: [],
    video_urls: [],
    crew_nickname: 'ATM with $45,703',
    crew_role: 'Player',
    crew_quote: '',
    created_at: '2025-07-15T12:00:00.000Z',
    updated_at: '2025-07-15T12:00:00.000Z',
    published_at: '2025-07-15T12:00:00.000Z',
  },
  {
    id: 'c017-monster-stack-four-bullets-wsop-2026',
    title: 'Tournament Report: Monster Stack 2026 — Four Bullets and a Receipt',
    slug: 'tournament-report-monster-stack-2026-four-bullets',
    excerpt: 'Four bullets, four dreams, and one very expensive education in tournament poker.',
    category: 'Tournament Reports',
    person_type: 'player',
    poker_room: 'Horseshoe / WSOP',
    specialty: 'Firing multiple bullets with maximum confidence',
    tell: 'Orders chips before the previous entry fee clears',
    threat_level: 'Dangerous to the bankroll',
    icon_type: '♠',
    tags: ['Tournament Reports', 'WSOP', 'Monster Stack', 'Re-Entry', 'Poker Lessons', 'Horseshoe', 'Community Story', 'ATMNOPIN'],
    content: `The Monster Stack sounded simple.

Big field.

Big prize pool.

Big opportunity.

Naturally, that meant firing multiple bullets and learning that "one more try" is the most expensive phrase in tournament poker.

Every entry began with confidence.

Every exit came with a slightly different explanation.

Bullet one: Running good until not.

Bullet two: A cooler that felt personal.

Bullet three: Better position, same result.

Bullet four: The one that was definitely going to be different.

By the end, the only thing truly stacked was the receipt.

**Lesson learned:** The Monster Stack has a monster appetite.

**ATMNOPIN Rating:**

- Entry 1: Full confidence
- Entry 2: Adjusted confidence
- Entry 3: Cautious confidence
- Entry 4: Pure spite
- Total lessons: 4
- Total bracelets: 0`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'Monster Stack WSOP 2026',
    gallery_images: [],
    video_urls: [],
    crew_nickname: 'Four Bullets',
    crew_role: 'Player',
    crew_quote: '',
    created_at: '2026-06-10T10:00:00.000Z',
    updated_at: '2026-06-10T10:00:00.000Z',
    published_at: '2026-06-10T10:00:00.000Z',
  },
  {
    id: 'c018-bracelet-event-500-nut-flush-wsop-2026',
    title: 'Tournament Report: The $500 Bracelet Event — Nut Flush Draw, No Bracelet',
    slug: 'tournament-report-500-bracelet-event-nut-flush-draw',
    excerpt: 'The draw was beautiful. The board was not. Another bracelet event ends on the flop.',
    category: 'Tournament Reports',
    person_type: 'player',
    poker_room: 'Horseshoe / WSOP',
    specialty: 'Maximum equity exits',
    tell: 'Still believes flush draws are destiny',
    threat_level: 'Correctly valued draws, wrong outcomes',
    icon_type: '♠',
    tags: ['Tournament Reports', 'WSOP', 'Bracelet Event', 'Bust Out', 'Bad Beats', 'Flush Draw', 'Horseshoe', 'Community Story', 'ATMNOPIN'],
    content: `There are moments in poker when the hand looks too good to fold.

Nut flush draw.

Plenty of outs.

Maximum confidence.

Possibly a short speech about equity.

Then the board refuses to cooperate and suddenly the $500 bracelet event is over.

The dream was alive on the flop.

Technically alive on the turn.

By the river, it was available only in memory.

**Hand breakdown:**

- Preflop: Beautiful.
- Flop: Nut flush draw acquired. Confidence: Maximum.
- Turn: Still drawing. Confidence: Sustained.
- River: Board brick. Confidence: Elsewhere.

The bracelet remains unowned.

The draw remains justified.

**ATMNOPIN Rating:**

- Draw Quality: Nut level
- Board Cooperation: 0/5
- Tournament Duration: Too short
- Bracelet Status: Still pending`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: '$500 WSOP Bracelet Event 2026',
    gallery_images: [],
    video_urls: [],
    crew_nickname: 'Nut Flush Dhezz',
    crew_role: 'Player',
    crew_quote: '',
    created_at: '2026-06-05T10:00:00.000Z',
    updated_at: '2026-06-05T10:00:00.000Z',
    published_at: '2026-06-05T10:00:00.000Z',
  },
  {
    id: 'c019-circuit-event-1700-another-story-2026',
    title: 'Tournament Report: The $1,700 Circuit Event — Another Attempt, Another Story',
    slug: 'tournament-report-1700-circuit-event-another-story',
    excerpt: 'Not every tournament ends with chips. Some end with content.',
    category: 'Tournament Reports',
    person_type: 'player',
    poker_room: 'Horseshoe / WSOP',
    specialty: 'Converting bust-outs into content',
    tell: 'Already thinking about what to write on the walk out',
    threat_level: 'Poker storyteller threat level: high',
    icon_type: '♠',
    tags: ['Tournament Reports', 'Circuit Event', 'Bust Out', 'Poker Journey', 'Community Story', 'ATMNOPIN'],
    content: `The $1,700 Circuit event had all the ingredients.

Buy-in paid.

Seat assigned.

Hope restored.

Then poker did what poker does.

No dramatic winner photo.

No trophy.

Just another reminder that sometimes the best thing you take from a tournament is the story you get to write on the way out.

The entry fee was not wasted.

It became content.

In the ATMNOPIN economy, that counts as a return on investment.

**ATMNOPIN Rating:**

- Tournament Result: Content
- Buy-In ROI: Narrative
- Next Event Confidence: Fully restored
- Content Quality: Improving`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: '$1,700 Circuit Event',
    gallery_images: [],
    video_urls: [],
    crew_nickname: 'The Content Creator',
    crew_role: 'Player',
    crew_quote: '',
    created_at: '2026-04-15T10:00:00.000Z',
    updated_at: '2026-04-15T10:00:00.000Z',
    published_at: '2026-04-15T10:00:00.000Z',
  },
  {
    id: 'c020-23rd-place-deep-run-wsop-2025',
    title: 'Tournament Report: 23rd Out of 3,300+ — The Run That Made the Next One Possible',
    slug: 'tournament-report-23rd-place-3300-field-deep-run',
    excerpt: 'Close enough to believe. Painful enough to remember. Good enough to come back and try again.',
    category: 'Tournament Reports',
    person_type: 'player',
    poker_room: 'Horseshoe / WSOP',
    specialty: 'Deep run pain tolerance',
    tell: 'Signs up for the next event before the last one settles',
    threat_level: 'Proven deep run capability',
    icon_type: '♠',
    tags: ['Tournament Reports', 'Deep Run', 'WSOP', 'Poker Journey', 'Horseshoe', 'Community Story', 'ATMNOPIN'],
    content: `Before the $45,703 cash.

Before the final table energy.

Before the ATM finally paid out.

There was this.

23rd out of more than 3,300 entries.

Close enough to believe.

Painful enough to remember.

Good enough to come back.

That is how tournament poker gets you.

It gives you just enough proof that the dream is not ridiculous.

Then it charges another buy-in.

The finish line was visible from 23rd place.

22 players were between it and this seat.

Next time, the distance closes.

**ATMNOPIN Rating:**

- Field Size: Massive
- Finish: 23rd
- Pain Level: Significant
- Motivation Generated: Maximum`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'Deep run, 23rd place, WSOP',
    gallery_images: [],
    video_urls: [],
    crew_nickname: 'The 23rd',
    crew_role: 'Player',
    crew_quote: '',
    created_at: '2025-06-20T10:00:00.000Z',
    updated_at: '2025-06-20T10:00:00.000Z',
    published_at: '2025-06-20T10:00:00.000Z',
  },
  {
    id: 'c021-main-event-watch-big-one-wsop-2026',
    title: 'Tournament Report: Main Event Watch — The Big One',
    slug: 'tournament-report-main-event-watch-wsop-2026',
    excerpt: 'Every poker player says they are ready for the Main Event. The cards will decide how funny that statement is.',
    category: 'Tournament Reports',
    person_type: 'player',
    poker_room: 'Horseshoe / WSOP',
    specialty: 'Patience and avoiding punts',
    tell: 'Extra careful before every decision. Then shoves turn.',
    threat_level: 'World Series ready',
    icon_type: '♠',
    tags: ['Tournament Reports', 'WSOP', 'Main Event', 'Poker Journey', 'Horseshoe', 'Community Story', 'ATMNOPIN'],
    content: `The Main Event is different.

The room feels bigger.

The stacks feel deeper.

The decisions feel heavier.

The dream feels slightly less ridiculous.

For ATMNOPIN, the mission is simple:

Show up.

Stay patient.

Avoid punting.

Maybe bluff once.

Probably regret it.

But show up.

Every player who has ever held a chip has thought about this tournament.

The $10,000 buy-in is the most expensive reminder that the dream exists.

Updates will continue as the journey unfolds.

**ATMNOPIN Rating:**

- Readiness: Optimistic
- Patience: Work in progress
- Bluff frequency target: One (1)
- Bracelet timeline: Under negotiation`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'WSOP Main Event 2026',
    gallery_images: [],
    video_urls: [],
    crew_nickname: 'Main Event Dhezz',
    crew_role: 'Player',
    crew_quote: '',
    created_at: '2026-06-27T08:00:00.000Z',
    updated_at: '2026-06-27T08:00:00.000Z',
    published_at: '2026-06-27T08:00:00.000Z',
  },
  // ─── POKER HUMOR ───
  {
    id: 'c022-atm-temporarily-out-of-service-2026',
    title: 'The ATM Is Temporarily Out of Service',
    slug: 'poker-humor-atm-temporarily-out-of-service',
    excerpt: 'Some days the ATM pays out. Some days it just displays an error message and asks you to try again later.',
    category: 'Poker Humor',
    person_type: '',
    poker_room: '',
    specialty: 'Error messages and existential poker variance',
    tell: 'Mutters "try again later" after each hand',
    threat_level: 'On tilt. Handle with care.',
    icon_type: '♠',
    tags: ['Poker Humor', 'Tournament Life', 'Bad Beats', 'Variance', 'ATMwithNoPIN', 'ATMNOPIN'],
    content: `Poker players love to say they are "due."

Due for a hand.

Due for a run.

Due for a double-up.

Due for the dealer to stop personally attacking them.

But poker has a cruel sense of humor.

Sometimes you arrive confident, caffeinated, and emotionally prepared to become the main character.

Then three hours later you are walking through the casino wondering if a sandwich counts as bankroll management.

That is when the ATM is temporarily out of service.

No cash available.

No PIN accepted.

Please contact customer support.

Unfortunately, customer support is also on break.

The good news: ATMs eventually restock.

The bad news: The fee to try again is another buy-in.`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'The ATM is temporarily out of service',
    gallery_images: [],
    video_urls: [],
    crew_nickname: '',
    crew_role: '',
    crew_quote: '',
    created_at: '2026-05-20T10:00:00.000Z',
    updated_at: '2026-05-20T10:00:00.000Z',
    published_at: '2026-05-20T10:00:00.000Z',
  },
  {
    id: 'c023-poker-job-14-hours-paid-2026',
    title: 'Poker Is the Only Job Where Getting Paid Means You Were Miserable for 14 Hours',
    slug: 'poker-humor-only-job-14-hours-miserable',
    excerpt: 'Tournament poker: where success means sitting in one chair long enough to question every life decision.',
    category: 'Poker Humor',
    person_type: '',
    poker_room: '',
    specialty: 'Productive suffering',
    tell: 'Still negotiating with lower back by Level 8',
    threat_level: 'Dangerous to spines',
    icon_type: '♠',
    tags: ['Poker Humor', 'Tournament Reports', 'WSOP', 'Long Days', 'Tournament Life', 'ATMNOPIN'],
    content: `In most jobs, if you work 14 hours, someone thanks you.

In poker, if you work 14 hours, someone rivers a straight and asks if you had ace-king.

Tournament poker is strange because the better you do, the longer you suffer.

You start the day excited.

By dinner break, you are negotiating with your lower back.

By Level 12, you are emotionally attached to a bottle of water and two granola bars from the gift shop.

And if you finally make the money, everyone says congratulations — which is poker language for "enjoy another seven hours."

The prize pool sounds generous until you divide it by the number of hours you spent in a chair developing an opinion on every seat cushion in the casino.

Still worth it.

Probably.`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'Tournament poker: 14 hours, one chair',
    gallery_images: [],
    video_urls: [],
    crew_nickname: '',
    crew_role: '',
    crew_quote: '',
    created_at: '2026-05-25T10:00:00.000Z',
    updated_at: '2026-05-25T10:00:00.000Z',
    published_at: '2026-05-25T10:00:00.000Z',
  },
  {
    id: 'c024-genius-until-the-river-2026',
    title: 'Every Poker Player Is a Genius Until the River',
    slug: 'poker-humor-genius-until-the-river',
    excerpt: 'Before the river, everyone has a plan. After the river, everyone has a story.',
    category: 'Poker Humor',
    person_type: '',
    poker_room: '',
    specialty: 'Post-river analysis and victim statements',
    tell: '"How does he get there?" heard after every bad river',
    threat_level: 'Lethal to egos',
    icon_type: '♠',
    tags: ['Poker Humor', 'River Cards', 'Table Talk', 'Bad Beats', 'Cash Games', 'ATMNOPIN'],
    content: `The flop is where poker players become analysts.

The turn is where they become mathematicians.

The river is where they become victims.

Before the last card comes, everyone understands ranges, blockers, equity, and table image.

After the river, the analysis gets considerably simpler:

"How does he get there?"

That question has powered more poker conversations than electricity.

It implies that the other player made an error. That calling with 7-4 suited was somehow wrong, even though it resulted in a win.

It implies the universe made a mistake.

It implies the river personally targeted someone.

None of this is true.

The river is indifferent.

The genius theory, however, is eternal.`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'Genius until the river',
    gallery_images: [],
    video_urls: [],
    crew_nickname: '',
    crew_role: '',
    crew_quote: '',
    created_at: '2026-05-28T10:00:00.000Z',
    updated_at: '2026-05-28T10:00:00.000Z',
    published_at: '2026-05-28T10:00:00.000Z',
  },
  {
    id: 'c025-things-poker-players-say-every-session-2026',
    title: 'Things Poker Players Say Every Session',
    slug: 'poker-humor-things-poker-players-say-every-session',
    excerpt: '"I\'m leaving after one orbit" and other lies told under casino lighting.',
    category: 'Poker Humor',
    person_type: '',
    poker_room: '',
    specialty: 'Cataloguing poker table mythology',
    tell: 'Says "I knew you had it" regardless of what was held',
    threat_level: 'Psychologically accurate',
    icon_type: '♠',
    tags: ['Poker Humor', 'Table Talk', 'Cash Games', 'One Orbit', 'ATMNOPIN'],
    content: `Every poker session has a soundtrack.

"I knew you had it."

"I almost folded."

"I put you exactly on that."

"I'm leaving after one orbit."

"I was priced in."

"That's my favorite hand."

"Nice hand."

The last one is often delivered with the emotional warmth of a parking ticket.

"I knew you had it" is the most popular phrase in poker, spoken by people who absolutely did not know what the opponent had and are recalibrating history in real time.

"I'm leaving after one orbit" is a promise made sincerely and forgotten completely by the time the button arrives.

"Nice hand" requires no translation.

Every player knows what it means.

Every player has said it.

Every player will say it again.`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'Things poker players say every session',
    gallery_images: [],
    video_urls: [],
    crew_nickname: '',
    crew_role: '',
    crew_quote: '',
    created_at: '2026-06-01T10:00:00.000Z',
    updated_at: '2026-06-01T10:00:00.000Z',
    published_at: '2026-06-01T10:00:00.000Z',
  },
  {
    id: 'c026-suspicious-river-bets-anonymous-2026',
    title: 'Suspicious River Bets Anonymous',
    slug: 'poker-humor-suspicious-river-bets-anonymous',
    excerpt: 'A support group for players who knew they were beat but paid anyway for the story.',
    category: 'Poker Humor',
    person_type: '',
    poker_room: '',
    specialty: 'Hero calls and expensive decisions',
    tell: 'Calls suspicious river bets "research"',
    threat_level: 'Bankroll-managed curiosity',
    icon_type: '♠',
    tags: ['Poker Humor', 'River Bets', 'Hero Calls', 'Bad Beats', 'Cash Games', 'ATMNOPIN'],
    content: `Welcome to Suspicious River Bets Anonymous.

We are here because we saw the river bet, felt the danger, heard the alarms, processed the warning signs, and still said, "I have to see it."

No, we did not have to see it.

Yes, we saw it anyway.

The river bet was large.

The sizing communicated value.

The opponent's posture communicated value.

The entire betting sequence communicated value.

We called anyway.

The first step is admitting the river bet was never suspicious.

It was value.

It was always value.

We knew it was value.

We paid to confirm what we already knew.

The second step is deciding whether the information gained was worth the price.

We are still working on the second step.

Meeting adjourned.`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'Suspicious River Bets Anonymous',
    gallery_images: [],
    video_urls: [],
    crew_nickname: '',
    crew_role: '',
    crew_quote: '',
    created_at: '2026-06-03T10:00:00.000Z',
    updated_at: '2026-06-03T10:00:00.000Z',
    published_at: '2026-06-03T10:00:00.000Z',
  },
  // ─── CASH GAMES ───
  {
    id: 'c027-guy-raises-every-button-foxwoods-2026',
    title: 'The Guy Who Raises Every Button',
    slug: 'cash-games-the-guy-who-raises-every-button',
    excerpt: 'Every table has one. Every orbit confirms it.',
    category: 'Cash Games',
    person_type: '',
    poker_room: 'Foxwoods',
    specialty: 'Button raise frequency',
    tell: 'Reaches for chips the moment the button arrives',
    threat_level: 'Exploitable. Eventually.',
    icon_type: '♠',
    tags: ['Cash Games', 'Foxwoods', '$2/$5 NLH', 'Aggressive Players', 'Button Raises', 'Table Reads', 'ATMNOPIN'],
    content: `Every table has one player who treats the button like a legal obligation to raise.

Folded to him in position?

Raise.

Three limpers ahead?

Raise.

93 offsuit, everyone already in, bad texture coming?

Raise. With conviction.

The tells are consistent. The frequency is clockwork. The adjustments require patience.

Stop complaining about the raises.

Start trapping.

Let him hang himself with the rope he brings to every orbit.

The correct adjustment is simple in theory and emotionally difficult in practice because it requires:

1. Letting him take the pot now
2. Waiting for a real hand
3. Not tilting when he shows 93o and wins anyway

Step 3 is the hardest part.

**ATMNOPIN Rating:**

- Button Raise Frequency: Maximum
- Hand Quality: Variable
- Exploitability: Confirmed
- Patience Required: Significant`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'The button raise specialist at Foxwoods',
    gallery_images: [],
    video_urls: [],
    crew_nickname: '',
    crew_role: '',
    crew_quote: '',
    created_at: '2026-04-10T10:00:00.000Z',
    updated_at: '2026-04-10T10:00:00.000Z',
    published_at: '2026-04-10T10:00:00.000Z',
  },
  {
    id: 'c028-human-slot-machines-foxwoods-2026',
    title: 'Playing Against Human Slot Machines',
    slug: 'cash-games-playing-against-human-slot-machines',
    excerpt: 'Some players do not have ranges. They have weather patterns.',
    category: 'Cash Games',
    person_type: '',
    poker_room: 'Foxwoods',
    specialty: 'Loose-passive table reads',
    tell: 'Chips go in regardless of action',
    threat_level: 'Profitable with patience',
    icon_type: '♠',
    tags: ['Cash Games', 'Foxwoods', '$2/$5 NLH', 'Loose Players', 'Poker Humor', 'Table Selection', 'ATMNOPIN'],
    content: `At some tables, you are not playing poker.

You are playing against human slot machines.

Chips go in.

Lights flash.

Nobody knows what is happening.

Every hand has jackpot energy.

These players are dangerous because they can have anything. The range is genuinely everything. A semi-bluff doesn't exist. A value bet doesn't exist. There is only chips in the middle and hope.

They are also profitable because of the same reason.

The trick is surviving the noise long enough to get paid.

You will lose some pots you "should" win.

You will win some pots that make no logical sense.

The math is still in your favor.

The emotional experience is not always.

**ATMNOPIN Rating:**

- Opponent Predictability: 0/5
- Profitability Over Time: High
- Short-Term Sanity: Variable
- Table Selection Grade: A+`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'Loose players at Foxwoods cash games',
    gallery_images: [],
    video_urls: [],
    crew_nickname: '',
    crew_role: '',
    crew_quote: '',
    created_at: '2026-04-20T10:00:00.000Z',
    updated_at: '2026-04-20T10:00:00.000Z',
    published_at: '2026-04-20T10:00:00.000Z',
  },
  {
    id: 'c029-when-the-nit-finally-raises-foxwoods-2026',
    title: 'When the Nit Finally Raises',
    slug: 'cash-games-when-the-nit-finally-raises',
    excerpt: 'The whole table suddenly remembers they have errands.',
    category: 'Cash Games',
    person_type: '',
    poker_room: 'Foxwoods',
    specialty: 'Tight range recognition',
    tell: 'Whole table folds or reconsiders their hand',
    threat_level: 'Maximum credibility',
    icon_type: '♠',
    tags: ['Cash Games', 'Foxwoods', '$2/$5 NLH', 'Tight Players', 'Poker Humor', 'Table Reads', 'ATMNOPIN'],
    content: `A loose player raises and everyone debates.

A nit raises and everyone becomes slightly religious.

Suddenly ace-queen looks suspicious.

Pocket tens feel like a trap.

Even pocket kings start checking the exits.

The player who has folded seventeen hands in a row, who has shown exactly one hand in two hours and it was aces, who has not entered a pot voluntarily since the restaurant shift changed — that player raises.

And now everyone is very interested in folding.

The correct strategy is usually respect, caution, and acknowledgment that this particular player is not raising with a hand that needs help from the board.

The incorrect strategy is calling with second pair because you "had a read."

Nobody has a read.

The nit has aces.

**ATMNOPIN Rating:**

- Nit Raise Frequency: Rare
- Hand Quality When Raising: Extreme
- Fold Equity: Substantial
- Table Response: Universal caution`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'The nit finally raises at the cash game',
    gallery_images: [],
    video_urls: [],
    crew_nickname: '',
    crew_role: '',
    crew_quote: '',
    created_at: '2026-05-01T10:00:00.000Z',
    updated_at: '2026-05-01T10:00:00.000Z',
    published_at: '2026-05-01T10:00:00.000Z',
  },
  {
    id: 'c030-why-25-is-never-just-25-foxwoods-2026',
    title: 'Why $2/$5 Is Never Just $2/$5',
    slug: 'cash-games-why-25-is-never-just-25',
    excerpt: 'The blinds say $2/$5. The pot says emotional damage.',
    category: 'Cash Games',
    person_type: '',
    poker_room: 'Foxwoods',
    specialty: 'Blind level reality distortion',
    tell: '"It\'s just $2/$5" said before a $600 pot',
    threat_level: 'Financially significant',
    icon_type: '♠',
    tags: ['Cash Games', 'Foxwoods', '$2/$5 NLH', 'Poker Humor', 'Table Dynamics', 'ATMNOPIN'],
    content: `New players see $2/$5 and think the game sounds reasonable.

Two dollars.

Five dollars.

Manageable stakes. A relaxing evening.

Then someone straddles.

Someone raises to $30 over the straddle.

Three people call.

Someone three-bets to $95.

Two calls.

The flop comes with two flush draws and a pair on board.

The first check is a trap.

The second check is also a trap.

Someone bets $200.

Someone raises to $500.

Now there is a used car in the middle of the table and everyone is very focused.

That is when you realize $2/$5 is not a number.

It is a warning label.

**ATMNOPIN Rating:**

- Starting Stakes: $2/$5
- Average Pot Size: Your imagination
- Emotional Volatility: High
- "Just $2/$5" Accuracy: 0%`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'The $2/$5 NLH cash game at Foxwoods',
    gallery_images: [],
    video_urls: [],
    crew_nickname: '',
    crew_role: '',
    crew_quote: '',
    created_at: '2026-05-10T10:00:00.000Z',
    updated_at: '2026-05-10T10:00:00.000Z',
    published_at: '2026-05-10T10:00:00.000Z',
  },
  // ─── BAD BEATS ───
  {
    id: 'c031-ak-vs-99-coin-flip-personal-2026',
    title: 'AK vs 99: The Classic Coin Flip That Feels Personal',
    slug: 'bad-beats-ak-vs-99-coin-flip-feels-personal',
    excerpt: 'It\'s called a flip, but somehow losing it always feels like a personal attack.',
    category: 'Bad Beats',
    person_type: '',
    poker_room: '',
    specialty: 'Losing mathematically neutral spots',
    tell: 'Explains the exact percentages immediately after',
    threat_level: 'Variance is the actual opponent',
    icon_type: '♠',
    tags: ['Bad Beats', 'Tournament Reports', 'AK', 'Coin Flip', 'Variance', 'Tournament Life', 'ATMNOPIN'],
    content: `Ace-king against pocket nines.

Everyone knows the math.

It's a flip.

47% vs 53%.

Standard.

Everyone says "standard" because it is.

Then the board runs out nine-high and pocket nines win and suddenly "standard" feels like something the universe chose specifically.

Tournament poker has a special way of making mathematically fair outcomes feel personally targeted.

The chips go in ahead.

The chips come out behind.

The nine had no idea this was a big moment.

The nine was simply being a nine.

The nine will never understand what it has taken from you.

**ATMNOPIN Rating:**

- Mathematical Fairness: Confirmed
- Emotional Experience: Contested
- "Standard" Comfort Level: Minimal
- Next tournament registered: Immediately`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'AK vs 99 coin flip',
    gallery_images: [],
    video_urls: [],
    crew_nickname: '',
    crew_role: '',
    crew_quote: '',
    created_at: '2026-06-15T10:00:00.000Z',
    updated_at: '2026-06-15T10:00:00.000Z',
    published_at: '2026-06-15T10:00:00.000Z',
  },
  {
    id: 'c032-nut-flush-draw-maximum-equity-minimum-joy-2026',
    title: 'Nut Flush Draw: Maximum Equity, Minimum Joy',
    slug: 'bad-beats-nut-flush-draw-maximum-equity-minimum-joy',
    excerpt: 'Sometimes the prettiest draw becomes the ugliest walk to the exit.',
    category: 'Bad Beats',
    person_type: '',
    poker_room: 'Horseshoe / WSOP',
    specialty: 'Drawing dead with maximum outs',
    tell: 'Still believes the next flush will hit',
    threat_level: 'Psychologically expensive',
    icon_type: '♠',
    tags: ['Bad Beats', 'WSOP', 'Horseshoe', 'Flush Draw', 'Bust Out', 'Tournament Reports', 'ATMNOPIN'],
    content: `The nut flush draw is dangerous because it looks like destiny.

Nine outs.

Two cards to come.

Sometimes two cards to come at once.

You can see the card.

You can feel the double-up.

You can already imagine stacking chips and making a brief speech about running good.

Then the dealer finishes the board and none of those imaginary chips arrive.

The flop was beautiful.

The turn kept hope alive.

The river checked every box except the one that contained the flush card.

The draw was real.

The confidence was real.

The exit was also real.

There is nothing wrong with getting it in ahead or as a draw with equity.

There is also nothing right about how it feels when the board misses.

**ATMNOPIN Rating:**

- Draw Quality: Nut level
- Outs: Nine (9)
- Board Cooperation: 0%
- Recovery Time: 48 hours minimum`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'Nut flush draw, WSOP',
    gallery_images: [],
    video_urls: [],
    crew_nickname: '',
    crew_role: '',
    crew_quote: '',
    created_at: '2026-06-08T10:00:00.000Z',
    updated_at: '2026-06-08T10:00:00.000Z',
    published_at: '2026-06-08T10:00:00.000Z',
  },
  {
    id: 'c033-pocket-kings-are-temporary-2026',
    title: 'Pocket Kings Are Temporary',
    slug: 'bad-beats-pocket-kings-are-temporary',
    excerpt: 'Kings feel powerful until the board starts making other plans.',
    category: 'Bad Beats',
    person_type: '',
    poker_room: '',
    specialty: 'Managing second-best hands',
    tell: 'Stares at the ace on the flop for three full seconds',
    threat_level: 'Emotionally volatile before the flop',
    icon_type: '♠',
    tags: ['Bad Beats', 'Cash Games', 'Pocket Kings', 'Coolers', 'Variance', 'ATMNOPIN'],
    content: `Pocket kings look beautiful before the flop.

The best hand most players will ever be dealt.

Second only to aces, which you never have when you want them.

Then the flop arrives.

Sometimes the ace arrives with it.

Or the set appears somewhere across the table.

Or someone with a hand that should have been folded two streets ago stays in long enough to become a genius by the river.

That is the life cycle of pocket kings:

Excitement.

Concern.

A brief period of mathematical denial.

Pain.

The grief passes.

Usually.

**ATMNOPIN Rating:**

- Pre-flop Beauty: Maximum
- Post-ace-flop Beauty: Significantly reduced
- Set-under-set Survival Rate: Not great
- Recovery: One session minimum`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'Pocket kings — the second-best starting hand',
    gallery_images: [],
    video_urls: [],
    crew_nickname: '',
    crew_role: '',
    crew_quote: '',
    created_at: '2026-05-15T10:00:00.000Z',
    updated_at: '2026-05-15T10:00:00.000Z',
    published_at: '2026-05-15T10:00:00.000Z',
  },
  // ─── VEGAS ADVENTURES ───
  {
    id: 'c034-walking-18-miles-wsop-2026',
    title: 'Walking 18 Miles Between Tournaments',
    slug: 'vegas-adventures-walking-18-miles-between-tournaments',
    excerpt: 'In Las Vegas, every poker trip secretly includes a fitness program.',
    category: 'Vegas Adventures',
    person_type: '',
    poker_room: 'Horseshoe / WSOP',
    specialty: 'Unplanned cardio',
    tell: 'Checking step count between every level',
    threat_level: 'Calves are dangerous',
    icon_type: '♠',
    tags: ['Vegas Adventures', 'WSOP', 'Horseshoe', 'Poker Travel', 'Tournament Life', 'ATMNOPIN'],
    content: `Nobody tells you that WSOP preparation includes cardio.

You think the challenge is the tournament.

You prepare for the poker.

Then you realize the real opponent is the walk from your room to registration, then to the poker room, then to the food court that somehow relocated since yesterday, then back to your room because you forgot your card protector, then back to the poker room because the tournament starts in four minutes.

By end of Day 1, your step count is elite.

By Day 2, you have developed strong opinions about every elevator in the building.

By Day 3, if you make it, you have earned the chips and the posture.

The fitness side effect of tournament poker is never mentioned in the buy-in process.

It should be in the footnotes somewhere.

**ATMNOPIN Rating:**

- Distance Walked Per WSOP Day: Significant
- Poker Fitness Side Effects: Unplanned
- Step Count: Championship Level
- Return on Investment: Variable`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'Walking between tournaments at WSOP Las Vegas',
    gallery_images: [],
    video_urls: [],
    crew_nickname: '',
    crew_role: '',
    crew_quote: '',
    created_at: '2026-06-20T10:00:00.000Z',
    updated_at: '2026-06-20T10:00:00.000Z',
    published_at: '2026-06-20T10:00:00.000Z',
  },
  {
    id: 'c035-casino-food-is-a-bluff-2026',
    title: 'Casino Food Is a Bluff',
    slug: 'vegas-adventures-casino-food-is-a-bluff',
    excerpt: 'It looks convenient. That is how they get you.',
    category: 'Vegas Adventures',
    person_type: '',
    poker_room: '',
    specialty: 'Overpriced convenience theory',
    tell: 'Orders the $22 sandwich because time is running out',
    threat_level: 'Dangerous to the food budget',
    icon_type: '♠',
    tags: ['Vegas Adventures', 'Casino Food', 'Poker Travel', 'WSOP', 'Poker Humor', 'ATMNOPIN'],
    content: `Casino food understands position.

It waits until you are tired, hungry, tilted from three straight bad beats, and running low on tournament break time.

Then it charges you like it has the nuts.

The sandwich costs what a buy-in should cost.

The bottled water costs more than the sandwich should cost.

The coffee has premium pricing because it is not just coffee, it is casino coffee, and the casino has leverage.

You pay anyway because the next level starts in twelve minutes and apparently bankroll management does not apply to food decisions made between poker hands.

The irony is that you would fold a bad hand in the poker room without blinking.

But here you are paying $22 for a turkey wrap.

Casino food has position.

Casino food wins.

**ATMNOPIN Rating:**

- Convenience: Confirmed
- Value: Contested
- Necessity: Tournament break driven
- Fold Frequency: Zero`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'Casino food during WSOP',
    gallery_images: [],
    video_urls: [],
    crew_nickname: '',
    crew_role: '',
    crew_quote: '',
    created_at: '2026-06-22T10:00:00.000Z',
    updated_at: '2026-06-22T10:00:00.000Z',
    published_at: '2026-06-22T10:00:00.000Z',
  },
  {
    id: 'c036-registration-line-wsop-2026',
    title: 'The Longest Registration Line in Poker History',
    slug: 'vegas-adventures-longest-registration-line-wsop',
    excerpt: 'Before you can bust out of the tournament, you must first survive the line.',
    category: 'Vegas Adventures',
    person_type: '',
    poker_room: 'Horseshoe / WSOP',
    specialty: 'Patience before the patience tournament begins',
    tell: 'Phone battery at 12% by the time they reach the desk',
    threat_level: 'Tests composure before cards are dealt',
    icon_type: '♠',
    tags: ['Vegas Adventures', 'WSOP', 'Horseshoe', 'Registration', 'Tournament Life', 'ATMNOPIN'],
    content: `WSOP registration is its own tournament.

The blinds do not go up.

But your patience definitely goes down.

Everyone in line believes today is the event where things change.

Some have prepared.

Some have read solver work.

Some are just confident in a way that cannot be supported by evidence.

All of them are checking their phones every thirty seconds because maybe the line has somehow moved while they looked away.

The line has not moved.

The line is long.

The line is patient.

The line has more experience with this than any of the players in it.

The tournament has not started yet and already the event is testing something.

**ATMNOPIN Rating:**

- Line Management: Extensive experience
- Phone Battery Drain: Significant
- Pre-tournament Composure: Negotiated
- Tables Reached: Eventually`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'WSOP registration line',
    gallery_images: [],
    video_urls: [],
    crew_nickname: '',
    crew_role: '',
    crew_quote: '',
    created_at: '2026-06-18T10:00:00.000Z',
    updated_at: '2026-06-18T10:00:00.000Z',
    published_at: '2026-06-18T10:00:00.000Z',
  },
  {
    id: 'c037-horseshoe-hall-of-fame-poker-room-2026',
    title: 'The Horseshoe Hall of Fame Poker Room',
    slug: 'vegas-adventures-horseshoe-hall-of-fame-poker-room',
    excerpt: 'Where legends are made, fortunes are lost, and Dhezz asks Poker Jesus for blessings.',
    category: 'Vegas Adventures',
    person_type: '',
    poker_room: 'Horseshoe / WSOP',
    specialty: 'Poker room reverence',
    tell: 'Arrives early to secure pre-tournament Poker Jesus blessing',
    threat_level: 'The room itself is the threat',
    icon_type: '♠',
    tags: ['Vegas Adventures', 'Horseshoe', 'WSOP', 'Hall of Fame Poker Room', 'Poker Room', 'Dominick', 'Poker Jesus', 'ATMNOPIN'],
    content: `The Horseshoe Hall of Fame Poker Room has history.

Bracelets.

Legends.

Deep runs.

Bad beats.

Moments where the cards lined up perfectly.

Moments where they absolutely did not.

For ATMNOPIN, the pre-tournament ritual begins before a single card is dealt.

Find Dominick.

Receive blessing.

Hope the poker gods are listening.

Then sit down and play poker.

The room is different from other poker rooms. The history is embedded in the carpet, the lighting, the posture of the dealers, the quiet confidence of players who have made final tables here before.

Walking in with a rack of chips and a goal is the easy part.

Walking out with more than you arrived with is the project.

The Hall of Fame Poker Room has seen both outcomes.

It continues either way.

**ATMNOPIN Rating:**

- History: Abundant
- Atmosphere: Championship level
- Pre-tournament Blessing Success Rate: Under review
- Bracelet Count: Pending`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'Horseshoe Hall of Fame Poker Room, WSOP',
    gallery_images: [],
    video_urls: [],
    crew_nickname: '',
    crew_role: '',
    crew_quote: '',
    created_at: '2026-06-17T10:00:00.000Z',
    updated_at: '2026-06-17T10:00:00.000Z',
    published_at: '2026-06-17T10:00:00.000Z',
  },
  // ─── BEHIND THE SCENES ───
  {
    id: 'c038-why-i-started-atmnopin-2026',
    title: 'Why I Started ATMNOPIN',
    slug: 'behind-the-scenes-why-i-started-atmnopin',
    excerpt: 'Because poker gave me too many stories to keep losing quietly.',
    category: 'Behind the Scenes',
    person_type: '',
    poker_room: '',
    specialty: 'Poker pain converted to content',
    tell: 'Takes notes after bad beats',
    threat_level: 'Content creator activated',
    icon_type: '♠',
    tags: ['Behind the Scenes', 'ATMwithNoPIN', 'ATMNOPIN', 'Creator Journey', 'Poker Humor', 'ATMNOPIN'],
    content: `ATMNOPIN started because poker is too funny to suffer through alone.

Every session has a character.

Every tournament has a plot twist.

Every bad beat deserves a witness.

The name came from the truth: sometimes you go to the ATM and there is no PIN. No access. No cash. Nothing works and you are standing there wondering how you got here.

That is also what poker feels like after a long bust-out streak.

But ATMs also pay out.

Sometimes in large amounts.

With interest.

The goal is simple:

Turn poker pain into entertainment.

If the chips do not come back, at least the stories should.

The brand is built on the idea that losing a hand can be worth something if you write it down honestly.

ATMNOPIN is the collection of all of it — the wins, the coolers, the characters, the dealers, the floor staff, and the people who make the game worth playing.

**ATMNOPIN Rating:**

- Origin Story: Authentic
- Content Strategy: Chaos-informed
- Bankroll Status: Improving
- Brand Vision: Clear`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'Why ATMNOPIN started',
    gallery_images: [],
    video_urls: [],
    crew_nickname: '',
    crew_role: '',
    crew_quote: '',
    created_at: '2026-01-15T10:00:00.000Z',
    updated_at: '2026-01-15T10:00:00.000Z',
    published_at: '2026-01-15T10:00:00.000Z',
  },
  {
    id: 'c039-story-behind-the-hat-2026',
    title: 'The Story Behind the Hat',
    slug: 'behind-the-scenes-story-behind-the-hat',
    excerpt: 'A poker brand is not official until it appears on a hat.',
    category: 'Behind the Scenes',
    person_type: '',
    poker_room: '',
    specialty: 'Branding via headwear',
    tell: 'Wearing the hat everywhere, including bad beat situations',
    threat_level: 'Branding fully operational',
    icon_type: '♠',
    tags: ['Behind the Scenes', 'Poker Hat', 'ATMwithNoPIN', 'ATMNOPIN', 'Branding', 'Creator Journey'],
    content: `Every poker player needs a table image.

Some choose sunglasses.

Some choose silence.

Some choose a very specific hooded sweatshirt they believe has superpowers.

ATMNOPIN chose a hat.

Not just any hat.

The hat.

Because when the cards are not cooperating, at least the branding can still be sharp.

The hat has been to Foxwoods.

The hat has been to the Horseshoe.

The hat has been in WSOP poker rooms, at cash game tables, and in at least one PokerNews photo.

The hat was present for the $45,703 run.

The hat has seen things.

The hat remains professional even when the player behind it is questioning life decisions.

Every brand needs a symbol.

ATMNOPIN found its hat.

**ATMNOPIN Rating:**

- Hat Quality: Premium
- Table Image Contribution: Significant
- Luck Transfer Properties: Pending investigation
- Available in the shop: Yes`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'The ATMNOPIN hat — branding via headwear',
    gallery_images: [],
    video_urls: [],
    crew_nickname: '',
    crew_role: '',
    crew_quote: '',
    created_at: '2026-02-10T10:00:00.000Z',
    updated_at: '2026-02-10T10:00:00.000Z',
    published_at: '2026-02-10T10:00:00.000Z',
  },
  {
    id: 'c040-writing-chronicles-at-2am-2026',
    title: 'Writing Chronicles at 2 AM',
    slug: 'behind-the-scenes-writing-chronicles-at-2am',
    excerpt: 'The best poker stories usually arrive after the worst poker sessions.',
    category: 'Behind the Scenes',
    person_type: '',
    poker_room: '',
    specialty: 'Turning tilt into prose',
    tell: 'Opens notes app immediately after exiting tournament',
    threat_level: 'Content quality highest under distress',
    icon_type: '♠',
    tags: ['Behind the Scenes', 'Chronicles', 'Poker Writing', 'Creator Journey', 'ATMNOPIN'],
    content: `There is a special kind of creativity that appears after midnight.

Usually after losing a pot.

Sometimes after firing too many bullets in a re-entry tournament.

Always after asking, "How did he call with that?"

That is when Chronicles get written.

Not from peace.

From the specific emotional state that comes after a poker session has made clear that the universe is testing something.

The best story ideas arrive in the parking structure.

The best opening lines arrive somewhere between the poker room exit and the car.

By the time home is reached, the first draft exists in some form.

By 2 AM, it has been typed.

By morning, it will probably be edited.

Or it will be published exactly as written at 2 AM because sometimes emotional accuracy is more important than editorial polish.

Chronicles are the archive of all of it.

**ATMNOPIN Rating:**

- Writing Inspiration Source: Emotional damage
- Best Writing Hours: Late night, post-session
- Editing Frequency: Variable
- Chronicle Quality: Inversely correlated with session results`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'Writing poker chronicles late at night',
    gallery_images: [],
    video_urls: [],
    crew_nickname: '',
    crew_role: '',
    crew_quote: '',
    created_at: '2026-03-05T10:00:00.000Z',
    updated_at: '2026-03-05T10:00:00.000Z',
    published_at: '2026-03-05T10:00:00.000Z',
  },
  {
    id: 'c041-turning-poker-into-entertainment-2026',
    title: 'Turning Poker Into Entertainment',
    slug: 'behind-the-scenes-turning-poker-into-entertainment',
    excerpt: 'The cards decide the money. The stories decide the brand.',
    category: 'Behind the Scenes',
    person_type: '',
    poker_room: '',
    specialty: 'Loss-to-content conversion',
    tell: 'Finds the angle in every hand, good or bad',
    threat_level: 'Narrative value: Maximum',
    icon_type: '♠',
    tags: ['Behind the Scenes', 'Poker Entertainment', 'ATMwithNoPIN', 'ATMNOPIN', 'Creator Journey', 'Branding'],
    content: `Poker results are hard to control.

The stories are not.

ATMNOPIN is built on that idea.

Win or lose, the table always provides material.

A strange call.

A suspicious river.

A dealer with perfect timing.

A player with a rubber duck on his chip stack.

A floor manager who somehow handles everything at once.

A fellow fish who deposits chips with mechanical reliability.

The game becomes content.

The content becomes the community.

The community becomes the brand.

Every poker player experiences the same swings, the same coolers, the same moments of genius and the same moments of questionable judgment.

Most players go through it silently.

ATMNOPIN documents it.

So that the next time someone says "you won't believe what happened," there is already a Chronicle for it.

**ATMNOPIN Rating:**

- Story Mining Efficiency: Maximum
- Entertainment per Bust-Out: High
- Brand Building Method: Session by session
- Community Size: Growing`,
    status: 'published',
    featured_on_home: false,
    featured_image_url: '',
    featured_image_alt: 'Turning poker into entertainment — the ATMNOPIN brand',
    gallery_images: [],
    video_urls: [],
    crew_nickname: '',
    crew_role: '',
    crew_quote: '',
    created_at: '2026-03-20T10:00:00.000Z',
    updated_at: '2026-03-20T10:00:00.000Z',
    published_at: '2026-03-20T10:00:00.000Z',
  },
];

async function seedDefaultChronicles() {
  try {
    const existing = await loadChronicles();
    const existingById = new Map(existing.map((c) => [c.id, c]));
    const existingSlugs = new Set(existing.map((c) => c.slug));
    const seedById = new Map(SEED_CHRONICLES.map((c) => [c.id, c]));

    const idsToUpdate = new Set();
    const toAdd = [];
    for (const seed of SEED_CHRONICLES) {
      if (existingById.has(seed.id)) {
        idsToUpdate.add(seed.id);
      } else if (!existingSlugs.has(seed.slug)) {
        toAdd.push(seed);
      }
    }
    if (!toAdd.length && !idsToUpdate.size) return;
    const updated = existing.map((c) =>
      idsToUpdate.has(c.id) ? { ...c, ...seedById.get(c.id) } : c
    );
    await saveChronicles([...toAdd, ...updated]);
  } catch {
    // non-fatal
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

const PLAYER_BADGES = ['Final Table Hero', 'Bad Beat Champion', 'River Victim', 'Poker Storyteller', 'Bubble Survivor', 'ATMNOPIN Legend', 'Fellow Fish', 'Poker Jesus Approved', 'WSOP Warrior', 'Cash Game Character', 'Railbird Favorite'];

const STORY_TYPES = ['Bad Beat', 'Funny Dealer Story', 'Tournament Run', 'Cash Game Story', 'WSOP Moment', 'Vegas Adventure'];
const REWRITE_STYLES = [
  { id: 'funny', label: 'Funny Version' },
  { id: 'dramatic', label: 'Dramatic Version' },
  { id: 'announcer', label: 'Sports Announcer Version' },
  { id: 'roast', label: 'Poker Roast Version' },
  { id: 'documentary', label: 'WSOP Documentary Version' },
];
const POINT_RULES = { approved_profile: 50, approved_funny_story: 25, approved_bad_beat_story: 25, approved_photo: 10, featured_on_home: 100, monthly_winner: 250 };
const aiRateLimiter = new Map(); // token -> { count, resetAt }

function computeCompletionScore(s) {
  const checks = [
    [!!(s.name), 10],
    [!!(s.email), 5],
    [!!(s.nickname), 5],
    [!!(s.city), 5],
    [!!(s.favorite_casino), 5],
    [!!(s.favorite_game), 5],
    [!!(s.biggest_accomplishment || s.playing_style || s.biggest_strength), 10],
    [!!(s.biggest_goal || s.funniest_habit), 5],
    [!!(s.funny_story), 10],
    [!!(s.bad_beat_story), 10],
    [!!(s.social_link), 5],
    [!!(s.photo_url), 15],
    [!!(s.permission_granted || s.permission), 5],
    [!!(s.ai_personality && s.ai_personality.status !== 'rejected'), 5],
  ];
  const total = checks.reduce((sum, [, w]) => sum + w, 0);
  const earned = checks.reduce((sum, [v, w]) => sum + (v ? w : 0), 0);
  return Math.round((earned / total) * 100);
}

function getPlayerBadges(s) {
  if (Array.isArray(s.badges) && s.badges.length) return s.badges;
  if (s.badge) return [s.badge];
  return [];
}

async function callOpenAI(systemPrompt, userContent, maxTokens = 600, jsonMode = false) {
  const key = (process.env.OPENAI_API_KEY || '').trim();
  if (!key) throw new Error('OPENAI_API_KEY not configured. Add it to Railway environment variables.');
  const body = {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: String(userContent).slice(0, 3000) },
    ],
    max_tokens: maxTokens,
    temperature: 0.85,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error?.message || `OpenAI HTTP ${r.status}`); }
  const d = await r.json();
  return d.choices[0].message.content.trim();
}

function checkAIRateLimit(token) {
  const now = Date.now();
  const s = aiRateLimiter.get(token) || { count: 0, resetAt: now + 86400000 };
  if (now > s.resetAt) { s.count = 0; s.resetAt = now + 86400000; }
  if (s.count >= 5) return false;
  s.count++;
  aiRateLimiter.set(token, s);
  return true;
}

const SEED_SUBMISSIONS = [
  {
    id: 'crew-manny-the-machine-001',
    name: 'Manny',
    nickname: 'The Machine',
    email: '',
    city: 'Foxwoods, CT',
    favorite_game: '$2/$5 NLH',
    bio: 'Deposits chips like clockwork. Consistent. Reliable. Unstoppable. You could set your watch to the moment he shoves the river with second pair.',
    biggest_accomplishment: 'Mechanical chip donations executed with clockwork precision.',
    funny_story: '',
    bad_beat_story: '',
    social_link: '',
    photo_url: '',
    permission: true,
    status: 'approved',
    badge: 'Fellow Fish',
    featured_on_home: false,
    admin_notes: 'Original crew member.',
    slug: 'manny-the-machine',
    player_type: 'crew',
    suit: '♣',
    tags: ['Players', 'Fellow Fish', 'Poker Friends', 'Foxwoods', '$2/$5 NLH', 'Table Characters'],
    specialty: 'Mechanical chip donations',
    tell: 'Always looks confident',
    threat_level: 'Bring extra buy-ins',
    poker_room: 'Foxwoods Resort Casino',
    created_at: '2026-01-01T00:00:00.000Z',
    submitted_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'crew-jamie-the-tuna-001',
    name: 'Jamie',
    nickname: 'The Tuna',
    email: '',
    city: 'Foxwoods, CT',
    favorite_game: '$2/$5 NLH',
    bio: 'A classic fish. Never sees it coming — not the bluff, not the set, not the straight on the board. An eternal optimist who believes every hand is the one.',
    biggest_accomplishment: 'Called every bet, folded none, won somehow.',
    funny_story: '',
    bad_beat_story: '',
    social_link: '',
    photo_url: '',
    permission: true,
    status: 'approved',
    badge: 'Fellow Fish',
    featured_on_home: false,
    admin_notes: 'Original crew member.',
    slug: 'jamie-the-tuna',
    player_type: 'crew',
    suit: '♦',
    tags: ['Players', 'Fellow Fish', 'Poker Friends', 'Foxwoods', '$2/$5 NLH', 'Table Characters'],
    specialty: 'Calling with nothing',
    tell: 'Looks at chips before calling',
    threat_level: 'Occasionally dangerous',
    poker_room: 'Foxwoods Resort Casino',
    created_at: '2026-01-01T00:00:00.000Z',
    submitted_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'crew-jay-ducky-jay-001',
    name: 'Jay',
    nickname: 'Ducky Jay',
    email: '',
    city: 'Foxwoods, CT',
    favorite_game: '$2/$5 NLH',
    bio: 'The only player whose card protector has better poker instincts than he does. Jay shows up, stacks his chips, places the duck on top — and then gets out of the way.',
    biggest_accomplishment: 'Delegated all major decisions to a rubber duck. Still better EV than most.',
    funny_story: '',
    bad_beat_story: '',
    social_link: '',
    photo_url: '',
    permission: true,
    status: 'approved',
    badge: 'Fellow Fish',
    featured_on_home: false,
    admin_notes: 'Original crew member.',
    slug: 'jay-ducky-jay',
    player_type: 'crew',
    suit: '♠',
    tags: ['Players', 'Fellow Fish', 'Poker Friends', 'Foxwoods', '$2/$5 NLH', 'Table Characters'],
    specialty: 'Letting the duck decide',
    tell: 'Always has a rubber duck on his stack',
    threat_level: 'The duck is scarier',
    poker_room: 'Foxwoods Resort Casino',
    created_at: '2026-01-01T00:00:00.000Z',
    submitted_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'crew-eric-sugar-stacker-001',
    name: 'Eric',
    nickname: 'The Sugar Stacker',
    email: '',
    city: 'Foxwoods, CT',
    favorite_game: '$2/$5 NLH',
    bio: 'Messy chip stacks, ultra-tight ranges, a zero-sugar drink reserve, unofficial breakfast sponsor of Jamie "The Tuna," and endlessly curious about Ducky Jay\'s dating adventures.',
    biggest_accomplishment: 'Survived a session without completing a single bluff. Stacks still standing.',
    funny_story: '',
    bad_beat_story: '',
    social_link: '/chronicles/player-spotlight-eric-the-sugar-stacker',
    photo_url: '',
    permission: true,
    status: 'approved',
    badge: 'Fellow Fish',
    featured_on_home: false,
    admin_notes: 'Foxwoods player personality.',
    slug: 'eric-the-sugar-stacker',
    player_type: 'crew',
    suit: '♠',
    tags: ['Players', 'Fellow Fish', 'Poker Friends', 'Foxwoods', '$2/$5 NLH', 'Table Characters', 'Player Spotlight', 'Zero Sugar', 'Drink Reserve'],
    specialty: 'Building chip stacks that shouldn\'t exist while maintaining a zero-sugar drink reserve',
    tell: 'Checks the side table before checking the river',
    threat_level: 'Very low... until the beverage reserve is fully stocked',
    poker_room: 'Foxwoods Resort Casino',
    created_at: '2026-06-29T10:00:00.000Z',
    submitted_at: '2026-06-29T10:00:00.000Z',
  },
  {
    id: 'crew-luke-lucky-horseshoe-001',
    name: 'Luke',
    nickname: 'Lucky Horseshoe Luke',
    email: '',
    city: '',
    favorite_game: '$2/$5 NLH',
    bio: 'Never seen without the lucky horseshoe. Always ready for another session, another story, and another chance to prove that faith, patience, and a little superstition go a long way.',
    biggest_accomplishment: 'Keeping the horseshoe close and the chip stack growing while everyone else wonders if luck really is a strategy.',
    funny_story: '',
    bad_beat_story: '',
    social_link: '/chronicles/player-spotlight-lucky-horseshoe-luke',
    photo_url: '',
    permission: true,
    status: 'approved',
    badge: 'Fellow Fish',
    featured_on_home: false,
    admin_notes: 'Foxwoods player personality.',
    slug: 'luke-lucky-horseshoe',
    player_type: 'crew',
    suit: '♠',
    tags: ['Players', 'Fellow Fish', 'Poker Friends', 'Foxwoods', '$2/$5 NLH', 'Table Characters', 'Player Spotlight', 'Lucky Horseshoe', 'Lucky Charm'],
    specialty: 'Keeping the horseshoe close and the chip stack growing while everyone else wonders if luck really is a strategy.',
    tell: 'Quietly gives the lucky horseshoe a reassuring tap before the biggest hands.',
    threat_level: 'Looks harmless... until the horseshoe starts running hot.',
    poker_room: 'Foxwoods Resort Casino',
    created_at: '2026-07-08T10:00:00.000Z',
    submitted_at: '2026-07-08T10:00:00.000Z',
  },
  {
    id: 'crew-seat-open-001',
    name: 'You?',
    nickname: 'TBD',
    email: '',
    city: 'Foxwoods, CT',
    favorite_game: '$2/$5 NLH',
    bio: 'The crew has one seat open. Foxwoods. $2/$5. Come sit down, make some bad decisions, and earn your nickname.',
    biggest_accomplishment: 'Unknown — yet.',
    funny_story: '',
    bad_beat_story: '',
    social_link: '/ai-profile-generator',
    photo_url: '',
    permission: true,
    status: 'approved',
    badge: '',
    featured_on_home: false,
    admin_notes: 'Open seat placeholder.',
    slug: 'open-seat-tbd',
    player_type: 'crew',
    suit: '?',
    tags: ['Players', 'Foxwoods', '$2/$5 NLH'],
    specialty: 'Unknown — yet',
    tell: 'To be discovered',
    threat_level: 'Unrated',
    poker_room: 'Foxwoods Resort Casino',
    created_at: '2026-01-01T00:00:00.000Z',
    submitted_at: '2026-01-01T00:00:00.000Z',
  },
];

const HERO_PROFILES = [
  { id:'hp-manny', name:'Manny', nickname:'The Machine', type:'player',
    summary:'Deposits chips like clockwork. Consistent. Reliable. Somehow always confident.',
    location:'Foxwoods', badge:'Fellow Fish', badgeClass:'hc-badge-fish', icon:'♠', href:'/players/manny-the-machine', cta:null },
  { id:'hp-jamie', name:'Jamie', nickname:'The Tuna', type:'player',
    summary:"Never sees it coming — not the bluff, not the set, not the straight on the board.",
    location:'Foxwoods', badge:'Fellow Fish', badgeClass:'hc-badge-fish', icon:'♠', href:'/players/jamie-the-tuna', cta:null },
  { id:'hp-jay', name:'Jay', nickname:'Ducky Jay', type:'player',
    summary:'The duck may be the real decision maker. Jay just brings the chips.',
    location:'Foxwoods', badge:'Fellow Fish', badgeClass:'hc-badge-fish', icon:'♠', href:'/players/jay-ducky-jay', cta:null },
  { id:'hp-eric', name:'Eric', nickname:'The Sugar Stacker', type:'player',
    summary:'Messy stacks. Tight poker. Zero-sugar logistics. Breakfast sponsor of Jamie. Dating investigator of Ducky Jay.',
    location:'Foxwoods', badge:'Fellow Fish', badgeClass:'hc-badge-fish', icon:'♠', href:'/chronicles/player-spotlight-eric-the-sugar-stacker', cta:'View Profile →' },
  { id:'hp-luke', name:'Luke', nickname:'Lucky Horseshoe Luke', type:'player',
    summary:'Never sits down without the horseshoe. Patient, friendly, and firmly convinced that luck is absolutely a strategy.',
    location:'Foxwoods', badge:'Fellow Fish', badgeClass:'hc-badge-fish', icon:'♠', href:'/chronicles/player-spotlight-lucky-horseshoe-luke', cta:'View Profile →' },
  { id:'hp-bhavin', name:'Bhavin', nickname:'The Connector', type:'floor',
    summary:'Gets players seated, keeps the room moving, and somehow handles everything at once.',
    location:'Foxwoods', badge:'Floor Staff', badgeClass:'hc-badge-floor', icon:'♣', href:'/community-wall', cta:'View Community →' },
  { id:'hp-charlie', name:'Charlie', nickname:'Still Standing', type:'floor',
    summary:'Keeps the chaos under control and shows up again tomorrow.',
    location:'Foxwoods', badge:'Floor Staff', badgeClass:'hc-badge-floor', icon:'♣', href:'/community-wall', cta:'View Community →' },
  { id:'hp-steve', name:'Steve', nickname:'Birthday Variance', type:'floor',
    summary:"Same birthday as Dhezz. Results still under investigation.",
    location:'Foxwoods', badge:'Floor Staff', badgeClass:'hc-badge-floor', icon:'♣', href:'/community-wall', cta:'View Community →' },
  { id:'hp-terrell', name:'Terrell', nickname:'The Railbird', type:'dealer',
    summary:'Dealer by day, tournament supporter by night.',
    location:'Horseshoe / WSOP', badge:'Dealer Spotlight', badgeClass:'hc-badge-dealer', icon:'♦', href:'/chronicles', cta:'Read Chronicles →' },
  { id:'hp-dominick', name:'Dominick', nickname:'Poker Jesus', type:'dealer',
    summary:'Tournament blessings available before every event. Results may vary.',
    location:'Horseshoe / WSOP', badge:'Dealer Spotlight', badgeClass:'hc-badge-dealer', icon:'♦', href:'/chronicles', cta:'Read Chronicles →' },
  { id:'hp-crazymike', name:'Crazy Mike', nickname:'River Card Specialist', type:'dealer',
    summary:"Every bad river is somehow his fault. At least according to Dhezz.",
    location:'Horseshoe / WSOP', badge:'Dealer Spotlight', badgeClass:'hc-badge-dealer', icon:'♦', href:'/chronicles', cta:'Read Chronicles →' },
  { id:'hp-you', name:'You?', nickname:'TBD', type:'you',
    summary:'One seat is open. Submit your story and earn your nickname.',
    location:'Any Poker Room', badge:'Get Featured', badgeClass:'hc-badge-you', icon:'?', href:'/ai-profile-generator', cta:'Get Featured →' },
];

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
    console.log('[loadSubmissions] pg rows:', rows.length, rows[0] ? 'first id=' + rows[0].id : '(empty)');
    return rows.map((row) => (typeof row.data === 'string' ? JSON.parse(row.data) : row.data));
  }
  if (sqliteDb) {
    const rows = sqliteDb.prepare('SELECT id, data FROM player_submissions ORDER BY created_at DESC').all();
    return rows.map((row) => JSON.parse(row.data));
  }
  return [];
}

async function saveSubmissions(submissions) {
  if (pgPool) {
    console.log('[saveSubmissions] pg: saving', submissions.length, 'records...');
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM player_submissions');
      for (const s of submissions) {
        await client.query(
          'INSERT INTO player_submissions (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data',
          [s.id, JSON.stringify(s)]
        );
      }
      await client.query('COMMIT');
      console.log('[saveSubmissions] pg: committed', submissions.length, 'records');
    } catch (error) {
      console.error('[saveSubmissions] pg error:', error.message);
      await client.query('ROLLBACK').catch(() => {});
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

// ─── VISITOR LOG ───────────────────────────────────────────────────────────────

function parseUABrowser(ua) {
  if (!ua) return 'Unknown';
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) return 'Chrome';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Safari\//.test(ua) && !/Chrome/.test(ua)) return 'Safari';
  if (/MSIE|Trident/.test(ua)) return 'IE';
  return 'Other';
}
function parseUAOS(ua) {
  if (!ua) return 'Unknown';
  if (/Windows NT 10/.test(ua)) return 'Windows 10/11';
  if (/Windows NT 6\.3/.test(ua)) return 'Windows 8.1';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/iPhone/.test(ua)) return 'iOS';
  if (/iPad/.test(ua)) return 'iPadOS';
  if (/Android/.test(ua)) return 'Android';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Other';
}
function parseUADevice(ua) {
  if (!ua) return 'Unknown';
  if (/Mobi|Android|iPhone|iPad/.test(ua)) return 'Mobile';
  if (/Tablet/.test(ua)) return 'Tablet';
  return 'Desktop';
}

async function geoLookup(ip) {
  if (!ip || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|localhost)/.test(ip)) return {};
  try {
    const r = await fetch(`https://ipapi.co/${ip}/json/`, {
      signal: AbortSignal.timeout(4000),
      headers: { 'User-Agent': 'ATMNOPIN-server/1.0' },
    });
    if (!r.ok) return {};
    const d = await r.json();
    if (d.error) return {};
    return {
      city: d.city || 'unknown',
      region: d.region || 'unknown',
      country: d.country_name || 'unknown',
      org: d.org || 'unknown',
      latitude: d.latitude || null,
      longitude: d.longitude || null,
    };
  } catch { return {}; }
}

async function insertVisitLog(entry) {
  try {
    if (pgPool) {
      await pgPool.query(
        'INSERT INTO visitor_log (id, created_at, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
        [entry.id, entry.timestamp, entry]
      );
    } else if (sqliteDb) {
      sqliteDb.prepare('INSERT OR IGNORE INTO visitor_log (id, created_at, data) VALUES (?, ?, ?)').run(
        entry.id, entry.timestamp, JSON.stringify(entry)
      );
    }
  } catch { /* non-fatal */ }
}

async function loadVisitorLog(limit = 500) {
  try {
    if (pgPool) {
      const [{ rows }, { rows: countRows }] = await Promise.all([
        pgPool.query('SELECT data FROM visitor_log ORDER BY created_at DESC LIMIT $1', [limit]),
        pgPool.query('SELECT COUNT(*) AS n FROM visitor_log'),
      ]);
      return { rows: rows.map((r) => r.data), total: parseInt(countRows[0].n, 10) || 0 };
    }
    if (sqliteDb) {
      const rows = sqliteDb.prepare('SELECT data FROM visitor_log ORDER BY created_at DESC LIMIT ?').all(limit);
      const { n } = sqliteDb.prepare('SELECT COUNT(*) AS n FROM visitor_log').get();
      return { rows: rows.map((r) => JSON.parse(r.data)), total: n || 0 };
    }
  } catch { }
  return { rows: [], total: 0 };
}

function logPageVisit(req, pathname) {
  (async () => {
    try {
      const rawIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
      const ip = rawIp.replace(/^::ffff:/, ''); // unwrap IPv4-mapped IPv6
      const ua = req.headers['user-agent'] || '';
      const referrer = req.headers['referer'] || 'direct';
      const geo = await geoLookup(ip);
      await insertVisitLog({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        ip,
        page: pathname,
        referrer,
        browser: parseUABrowser(ua),
        os: parseUAOS(ua),
        device: parseUADevice(ua),
        city: geo.city || 'unknown',
        region: geo.region || 'unknown',
        country: geo.country || 'unknown',
        org: geo.org || 'unknown',
        latitude: geo.latitude || null,
        longitude: geo.longitude || null,
      });
    } catch { /* non-fatal */ }
  })();
}

// ─── END VISITOR LOG ───────────────────────────────────────────────────────────

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
  <meta name="description" content="ATMNOPIN™ Poker blog and admin publishing system for table stories, updates, and bad beats." />
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
    .footer { border-top:1px solid #1e1e1e; padding:1rem 0; color:#777; font-size:.7rem; text-transform:uppercase; letter-spacing:.12em; }
    @media (max-width: 980px) { .grid { grid-template-columns:1fr; } .gallery { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <div class="shell">
    <nav>
      <a href="/" style="color:var(--green); font-weight:700; text-transform:uppercase; letter-spacing:.18em;">ATMNOPIN™</a>
      <ul class="nav-links">
        <li><a href="/blog">Stories</a></li>
        <li><a href="/chronicles">Chronicles</a></li>
        <li><a href="/player-cards">Cards</a></li>
        <li><a href="/rail">The Rail</a></li>
        <li><a href="/community-wall">Community</a></li>
        <li><a href="/inside-the-atm">Inside the ATM</a></li>
        <li><a href="https://www.youtube.com/@ATMwithNoPIN" target="_blank" rel="noopener">Videos</a></li>
        <li><a href="/">Home</a></li>
      </ul>
    </nav>
    ${body}
    <div class="footer">ATMNOPIN™ poker entertainment brand operated by Sunfish Technologies LLC. All rights reserved.</div>
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

  return renderLayout('ATMNOPIN™ Blog | Table Stories', `
    <section class="hero">
      <p class="eyebrow">Latest from the ATM</p>
      <h1>Table Stories &amp; Bad Beats</h1>
      <p class="body-text" style="max-width:60ch;">A simple admin-friendly blog for tournament updates, Foxwoods sessions, funny hands, and the stories that make the ATMNOPIN™ brand feel like a real poker entertainment table.</p>
    </section>
    <section class="posts">${cards || '<div class="notice">No published posts yet. Create one in the admin area.</div>'}</section>`);
}

function renderBlogPostPage(post) {
  const gallery = (post.gallery_images || []).map((img) => `
    <figure class="card">
      <img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.alt || post.title)}" />
      ${img.alt ? `<p class="small" style="margin-top:.5rem;">${escapeHtml(img.alt)}</p>` : ''}
    </figure>`).join('');

  return renderLayout(`${post.title} | ATMNOPIN™ Poker`, `
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

function renderSubmissionCardHtml(s) {
  const esc = sanitizeHtml;
  const id = esc(s.id || '');
  const name = esc(s.name || 'Unnamed');
  const status = s.status || 'pending';
  const isReady = !!(s.submitted_for_review && s.status !== 'approved');
  const city = esc(s.city || '');
  const createdAt = s.created_at ? new Date(s.created_at).toLocaleDateString() : '—';
  const nickname = s.nickname ? `<em>&quot;${esc(s.nickname)}&quot;</em>` : '';
  const score = s.completion_score || 0;
  const scoreColor = score >= 70 ? 'var(--green)' : score >= 40 ? 'var(--gold)' : '#888';
  const thumb = s.photo_url
    ? `<img class="sub-thumb" src="${esc(s.photo_url)}" alt="" />`
    : `<div class="sub-thumb-ph">${esc(((s.nickname||s.name||'?')[0]||'?').toUpperCase())}</div>`;
  const readyBadge = isReady ? '<span class="sub-pill" style="background:rgba(0,200,83,.12);border-color:rgba(0,200,83,.3);color:var(--green);font-size:.55rem;margin-left:.3rem;">Ready</span>' : '';
  const curBadges = Array.isArray(s.badges) && s.badges.length ? s.badges : (s.badge ? [s.badge] : []);
  const badgeBoxes = PLAYER_BADGES.map((b) => `<label style="display:flex;align-items:center;gap:.35rem;font-size:.7rem;cursor:pointer;"><input type="checkbox" value="${esc(b)}"${curBadges.includes(b) ? ' checked' : ''} />${esc(b)}</label>`).join('');
  return `<div class="sub-card" id="sc-${id}" data-status="${esc(status)}" data-ready="${isReady}" data-featured="${!!s.featured_on_home}" data-monthly="${!!s.is_monthly_winner}">
    <div class="sub-header" onclick="toggleSubDetail('${id}')">
      ${thumb}
      <div class="sub-info"><strong>${name}</strong>${nickname}
        <p class="small">${city} &middot; ${createdAt}</p>
        <p class="small" style="color:${scoreColor}">Profile: ${score}%${s.points ? ' &middot; ' + s.points + ' pts' : ''}</p>
      </div>
      <span class="sub-pill sub-${esc(status)}" id="spill-${id}">${esc(status)}</span>${readyBadge}
    </div>
    <div class="sub-detail" id="sd-${id}" style="${isReady ? '' : 'display:none;'}">
      ${s.email ? `<div class="sub-field"><div class="sub-field-lbl">Email</div><div class="sub-field-val">${esc(s.email)}</div></div>` : ''}
      ${s.favorite_game ? `<div class="sub-field"><div class="sub-field-lbl">Favorite Game</div><div class="sub-field-val">${esc(s.favorite_game)}</div></div>` : ''}
      ${s.favorite_casino ? `<div class="sub-field"><div class="sub-field-lbl">Favorite Casino</div><div class="sub-field-val">${esc(s.favorite_casino)}</div></div>` : ''}
      ${s.biggest_accomplishment ? `<div class="sub-field"><div class="sub-field-lbl">Biggest Accomplishment</div><div class="sub-field-val">${esc(s.biggest_accomplishment)}</div></div>` : ''}
      ${s.biggest_goal ? `<div class="sub-field"><div class="sub-field-lbl">Goal</div><div class="sub-field-val">${esc(s.biggest_goal)}</div></div>` : ''}
      ${s.funny_story ? `<div class="sub-field"><div class="sub-field-lbl">Funny Story</div><div class="sub-field-val">${esc(s.funny_story)}</div></div>` : ''}
      ${s.bad_beat_story ? `<div class="sub-field"><div class="sub-field-lbl">Bad Beat Story</div><div class="sub-field-val">${esc(s.bad_beat_story)}</div></div>` : ''}
      ${s.social_link ? `<div class="sub-field"><div class="sub-field-lbl">Social</div><div class="sub-field-val"><a href="${esc(s.social_link)}" target="_blank" rel="noopener">${esc(s.social_link)}</a></div></div>` : ''}
      ${s.consent_at ? `<div class="sub-field"><div class="sub-field-lbl" style="color:var(--green);">Consent</div><div class="sub-field-val" style="font-size:.65rem;color:#888;">${esc(new Date(s.consent_at).toLocaleString())} | IP: ${esc(s.consent_ip||'—')}</div></div>` : ''}
      <div class="sub-actions" style="flex-wrap:wrap;">
        <button class="secondary" id="sapprove-${id}" onclick="subApprove('${id}')">${status === 'approved' ? 'Approved' : 'Approve'}</button>
        ${status !== 'rejected' ? `<button class="secondary" id="sreject-${id}" onclick="subReject('${id}')">Reject</button>` : ''}
        <button class="secondary" id="shome-${id}" onclick="subToggleHome('${id}')">${s.featured_on_home ? 'Unfeature Home' : 'Feature Home'}</button>
        <button class="secondary" id="smonthly-${id}" onclick="subToggleMonthly('${id}')">${s.is_monthly_winner ? 'Monthly Winner' : 'Set Monthly'}</button>
        <button class="secondary" onclick="subDelete('${id}')">Delete</button>
        <button class="gp-btn" onclick="generateProfile('${id}')">✦ Generate Profile</button>
      </div>
      <div class="sub-field" style="margin-top:.5rem;"><div class="sub-field-lbl">Badges</div>
        <div id="badges-${id}" style="display:flex;flex-wrap:wrap;gap:.4rem;margin:.4rem 0;">${badgeBoxes}</div>
        <button class="secondary" style="font-size:.68rem;" onclick="subSaveBadges('${id}')">Save Badges</button>
      </div>
      <div class="sub-actions" style="flex-wrap:wrap;align-items:center;">
        <span style="font-size:.7rem;color:#888;">Points: <strong style="color:var(--gold);" id="spts-${id}">${s.points||0}</strong></span>
        <input id="pts-${id}" type="number" style="width:70px;padding:.4rem .5rem;font-size:.72rem;" placeholder="+/-" />
        <input id="pts-reason-${id}" type="text" style="width:140px;padding:.4rem .5rem;font-size:.72rem;" placeholder="Reason..." />
        <button class="secondary" style="font-size:.68rem;" onclick="subAddPoints('${id}')">Add Points</button>
      </div>
      <div class="sub-actions" style="flex-wrap:wrap;">
        <input id="notes-${id}" type="text" style="flex:1;min-width:120px;padding:.4rem .6rem;font-size:.72rem;" placeholder="Admin note..." value="${esc(s.admin_notes||'')}" />
        <button class="secondary" id="snotes-${id}" onclick="subSaveNotes('${id}')">Save Note</button>
      </div>
    </div>
  </div>`;
}

function renderAdminPage(submissions = []) {
  const chronCatOptions = CHRON_CATEGORIES.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  return renderLayout('ATMNOPIN™ Admin', `
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
      <button class="admin-tab" data-panel="visitorsPanel">Visitors</button>
      <button class="admin-tab" data-panel="consentPanel">Consent Log</button>
      <button class="admin-tab" onclick="window.location='/admin/rail'">The Rail ↗</button>
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
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem;margin-bottom:.5rem;">
          <h2 style="margin:0;">Community Submissions</h2>
          <button class="secondary" id="sfRefresh" type="button">Refresh</button>
        </div>
        <div id="subStats" class="row" style="margin:.75rem 0;gap:.5rem;flex-wrap:wrap;">
          ${(()=>{ const p=submissions.filter(s=>s.status==='pending').length; const a=submissions.filter(s=>s.status==='approved').length; const r=submissions.filter(s=>s.status==='rejected').length; const ready=submissions.filter(s=>s.submitted_for_review&&s.status!=='approved').length; return `<span class="sub-pill sub-pending">Pending: ${p}</span><span class="sub-pill sub-approved">Approved: ${a}</span><span class="sub-pill sub-rejected">Rejected: ${r}</span>${ready?'<span class="sub-pill" style="background:rgba(0,200,83,.15);border-color:rgba(0,200,83,.4);color:var(--green);">Ready: '+ready+'</span>':''}`; })()}
        </div>
        <div class="row" style="margin-bottom:.75rem;gap:.5rem;">
          <button class="secondary" data-subfilter="all" id="sfAll">All</button>
          <button class="secondary" data-subfilter="submitted" id="sfSubmitted">📬 Ready for Review</button>
          <button class="secondary" data-subfilter="pending" id="sfPending">Pending</button>
          <button class="secondary" data-subfilter="approved" id="sfApproved">Approved</button>
          <button class="secondary" data-subfilter="rejected" id="sfRejected">Rejected</button>
        </div>
        <div id="subList" class="form-grid">${submissions.length ? submissions.map(renderSubmissionCardHtml).join('') : '<div class="notice">No submissions yet.</div>'}</div>
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
      .sub-detail{padding:.75rem 1rem;border-top:1px solid #1a1a1a;}
      .sub-field{margin-bottom:.5rem;}
      .sub-field-lbl{font-size:.6rem;text-transform:uppercase;letter-spacing:.15em;color:var(--gray);margin-bottom:.15rem;}
      .sub-field-val{font-size:.82rem;color:var(--offwhite);}
      .sub-actions{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.75rem;padding-top:.75rem;border-top:1px solid #1a1a1a;}
      .gp-btn{border:1px solid rgba(0,200,83,.4);background:rgba(0,200,83,.08);color:var(--green);border-radius:8px;padding:.3rem .75rem;cursor:pointer;font:.68rem 'DM Mono',monospace;text-transform:uppercase;letter-spacing:.1em;transition:all .2s;}
      .gp-btn:hover{background:rgba(0,200,83,.18);}
      #gpModal{position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:9999;overflow-y:auto;padding:2rem 1rem;}
      #gpModal .gp-card{max-width:720px;margin:0 auto;background:#0c0c0c;border:1px solid #1e3a28;border-radius:16px;padding:1.5rem;}
      #gpModal h2{font-family:'DM Serif Display',serif;font-size:1.25rem;color:var(--green);margin:0;}
      #gpModal .gp-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;}
      #gpModal .gp-close{background:none;border:1px solid #333;color:#888;border-radius:8px;padding:.3rem .75rem;cursor:pointer;font:.85rem 'DM Mono',monospace;}
      #gpStatus{display:none;padding:.55rem .9rem;border-radius:8px;font-size:.78rem;margin-bottom:.75rem;}
      #gpModal .gp-row{display:grid;gap:.6rem;}
      #gpModal .gp-2col{grid-template-columns:1fr 1fr;}
      #gpModal .gp-3col{grid-template-columns:1fr 1fr 1fr;}
      #gpModal .gp-row label{display:grid;gap:.25rem;font-size:.63rem;color:var(--gray);text-transform:uppercase;letter-spacing:.12em;}
      #gpModal .gp-row input,#gpModal .gp-row textarea,#gpModal .gp-row select{width:100%;border:1px solid #242424;background:#121212;color:var(--offwhite);padding:.55rem .75rem;border-radius:8px;font:inherit;font-size:.82rem;}
      #gpModal .gp-row textarea{resize:vertical;}
      #gpModal .gp-foot{display:flex;gap:.5rem;flex-wrap:wrap;justify-content:flex-end;margin-top:1.25rem;padding-top:1rem;border-top:1px solid #1e1e1e;}
      #gpModal .gp-sec{border-top:1px solid #1e1e1e;margin-top:1rem;padding-top:1rem;}
      #gpModal .gp-sec-lbl{font-size:.6rem;text-transform:uppercase;letter-spacing:.15em;color:var(--gray);margin-bottom:.5rem;}
      .gp-cancel{border:1px solid #333;background:#111;color:#888;border-radius:8px;padding:.55rem 1.1rem;cursor:pointer;font:.72rem 'DM Mono',monospace;text-transform:uppercase;letter-spacing:.1em;}
      .gp-draft{border:1px solid #444;background:#181818;color:var(--offwhite);border-radius:8px;padding:.55rem 1.1rem;cursor:pointer;font:.72rem 'DM Mono',monospace;text-transform:uppercase;letter-spacing:.1em;}
      .gp-publish{border:none;background:var(--green);color:#000;border-radius:8px;padding:.55rem 1.3rem;cursor:pointer;font:.72rem 'DM Mono',monospace;text-transform:uppercase;letter-spacing:.1em;font-weight:700;}
      .gp-publish:hover{background:#00e060;}
      .gp-regen{border:1px solid rgba(0,200,83,.35);background:rgba(0,200,83,.07);color:var(--green);border-radius:8px;padding:.45rem .9rem;cursor:pointer;font:.68rem 'DM Mono',monospace;text-transform:uppercase;letter-spacing:.1em;}
    </style>

    <div id="gpModal" style="display:none;" role="dialog" aria-modal="true" aria-label="Generate Player Spotlight">
      <div class="gp-card">
        <div class="gp-hdr">
          <h2>✦ Generate Player Spotlight</h2>
          <button class="gp-close" onclick="cancelGP()">✕ Close</button>
        </div>
        <div id="gpStatus"></div>
        <div style="display:flex;gap:.6rem;align-items:flex-end;margin-bottom:1rem;">
          <label style="flex:1;display:grid;gap:.25rem;font-size:.63rem;color:var(--gray);text-transform:uppercase;letter-spacing:.12em;">Style hints (optional)
            <input id="gpHints" type="text" placeholder="e.g. more poker humor, shorter narrative, emphasize the funny story" style="border:1px solid #242424;background:#121212;color:var(--offwhite);padding:.55rem .75rem;border-radius:8px;font:inherit;font-size:.82rem;" />
          </label>
          <button id="gpRegenBtn" class="gp-regen" onclick="gpRegen()">⟳ Regenerate</button>
        </div>

        <div class="gp-sec">
          <div class="gp-sec-lbl">Profile Identity</div>
          <div class="gp-row" style="gap:.6rem;">
            <label>Profile Title *<input id="gpTitle" type="text" /></label>
            <div class="gp-row gp-2col">
              <label>Nickname *<input id="gpNick" type="text" /></label>
              <label>Slug *<input id="gpSlug" type="text" /></label>
            </div>
            <div class="gp-row gp-3col">
              <label>Badge *<input id="gpBadge" type="text" /></label>
              <label>Game<input id="gpGame" type="text" /></label>
              <label>Casino<input id="gpCasino" type="text" /></label>
            </div>
          </div>
        </div>

        <div class="gp-sec">
          <div class="gp-sec-lbl">About</div>
          <div class="gp-row">
            <label>About (excerpt shown on listing pages) *<textarea id="gpAbout" style="min-height:80px;"></textarea></label>
          </div>
        </div>

        <div class="gp-sec">
          <div class="gp-sec-lbl">Player Profile Table</div>
          <div class="gp-row" style="gap:.6rem;">
            <label>Specialty<textarea id="gpSpecialty" style="min-height:55px;"></textarea></label>
            <div class="gp-row gp-2col">
              <label>Tell<textarea id="gpTell" style="min-height:55px;"></textarea></label>
              <label>Threat Level<textarea id="gpThreat" style="min-height:55px;"></textarea></label>
            </div>
            <div class="gp-row gp-3col">
              <label>Lucky Charm<textarea id="gpLucky" style="min-height:55px;"></textarea></label>
              <label>Known For<textarea id="gpKnown" style="min-height:55px;"></textarea></label>
              <label>Table Reputation<textarea id="gpTableRep" style="min-height:55px;"></textarea></label>
            </div>
          </div>
        </div>

        <div class="gp-sec">
          <div class="gp-sec-lbl">Full Story (Markdown)</div>
          <div class="gp-row">
            <label>Story Content *<textarea id="gpContent" style="min-height:220px;font-family:monospace;font-size:.76rem;line-height:1.5;"></textarea></label>
          </div>
        </div>

        <div id="gpSaveConfirm" style="display:none;margin-top:.75rem;padding:.6rem .9rem;border-radius:8px;font-size:.78rem;border:1px solid rgba(0,200,83,.3);background:rgba(0,200,83,.07);color:var(--green);"></div>

        <div class="gp-foot">
          <button class="gp-cancel" onclick="cancelGP()">Cancel</button>
          <button id="gpDraftBtn" class="gp-draft" onclick="gpSave('draft')">Save Draft</button>
          <button id="gpPublishBtn" class="gp-publish" onclick="gpSave('published')">Publish Profile →</button>
        </div>
      </div>
    </div>

    </div><!-- end communityPanel -->
    <script>
    function toggleSubDetail(id) {
      var el = document.getElementById('sd-' + id);
      if (!el) return;
      el.style.display = el.style.display === 'none' ? '' : 'none';
    }
    async function subCRUD(id, method, body) {
      try {
        var res = await fetch('/api/admin/submissions/' + id, { method: method, headers: body ? {'Content-Type':'application/json'} : {}, body: body ? JSON.stringify(body) : undefined });
        if (!res.ok) { var e = await res.json().catch(function(){return{};}); alert(e.error || 'Request failed (' + res.status + ')'); return null; }
        return method === 'DELETE' ? true : await res.json();
      } catch(e) { alert('Network error: ' + String(e.message||e)); return null; }
    }
    function subSetPill(id, status) {
      var pill = document.getElementById('spill-' + id);
      if (!pill) return;
      pill.className = 'sub-pill sub-' + status;
      pill.textContent = status;
      var card = document.getElementById('sc-' + id);
      if (card) card.setAttribute('data-status', status);
    }
    function subFlash(btnId, msg) {
      var btn = document.getElementById(btnId);
      if (!btn) return;
      var orig = btn.textContent;
      btn.textContent = msg;
      setTimeout(function() { btn.textContent = orig; }, 1500);
    }
    async function subApprove(id) {
      var data = await subCRUD(id, 'PUT', {status:'approved'});
      if (data) { subSetPill(id, 'approved'); var b = document.getElementById('sapprove-'+id); if(b) b.textContent='Approved'; var r=document.getElementById('sreject-'+id); if(r) r.style.display='none'; }
    }
    async function subReject(id) {
      var data = await subCRUD(id, 'PUT', {status:'rejected'});
      if (data) subSetPill(id, 'rejected');
    }
    async function subDelete(id) {
      if (!confirm('Delete this submission?')) return;
      var ok = await subCRUD(id, 'DELETE');
      if (ok) { var card = document.getElementById('sc-'+id); if (card) card.remove(); }
    }
    async function subToggleHome(id) {
      var card = document.getElementById('sc-'+id);
      var cur = card && card.getAttribute('data-featured') === 'true';
      var data = await subCRUD(id, 'PUT', {featured_on_home: !cur});
      if (data && card) { card.setAttribute('data-featured', data.featured_on_home?'true':'false'); var b=document.getElementById('shome-'+id); if(b) b.textContent=data.featured_on_home?'Unfeature Home':'Feature Home'; }
    }
    async function subToggleMonthly(id) {
      var card = document.getElementById('sc-'+id);
      var cur = card && card.getAttribute('data-monthly') === 'true';
      var data = await subCRUD(id, 'PUT', {is_monthly_winner: !cur});
      if (data && card) { card.setAttribute('data-monthly', data.is_monthly_winner?'true':'false'); var b=document.getElementById('smonthly-'+id); if(b) b.textContent=data.is_monthly_winner?'Monthly Winner':'Set Monthly'; }
    }
    async function subSaveBadges(id) {
      var container = document.getElementById('badges-'+id);
      if (!container) return;
      var checked = Array.from(container.querySelectorAll('input[type=checkbox]:checked')).map(function(c){return c.value;});
      var data = await subCRUD(id, 'PUT', {badges: checked});
      if (data) subFlash('sbadges-'+id, 'Saved!');
    }
    async function subAddPoints(id) {
      var ptEl = document.getElementById('pts-'+id), reaEl = document.getElementById('pts-reason-'+id);
      var delta = parseInt(ptEl?ptEl.value:0)||0;
      if (!delta) { alert('Enter a points value.'); return; }
      var data = await subCRUD(id, 'PUT', {points_delta:delta, points_reason:reaEl?reaEl.value.trim():''});
      if (data) { var sp=document.getElementById('spts-'+id); if(sp) sp.textContent=data.points||0; if(ptEl)ptEl.value=''; if(reaEl)reaEl.value=''; }
    }
    async function subSaveNotes(id) {
      var el = document.getElementById('notes-'+id);
      if (!el) return;
      var data = await subCRUD(id, 'PUT', {admin_notes: el.value});
      if (data) subFlash('snotes-'+id, 'Saved!');
    }
    async function subAIApprove(id) { if (await subCRUD(id,'PUT',{ai_personality_status:'approved'})) location.reload(); }
    async function subAIReject(id) { if (await subCRUD(id,'PUT',{ai_personality_status:'rejected'})) location.reload(); }
    async function subChronicleApprove(s,c) { if (await subCRUD(s,'PUT',{chronicle_id:c,chronicle_status:'approved'})) location.reload(); }
    async function subChronicleReject(s,c) { if (await subCRUD(s,'PUT',{chronicle_id:c,chronicle_status:'rejected'})) location.reload(); }

    // ── Profile Generator Modal ──────────────────────────────────────────────
    var gpSubId = null;
    var gpChronicleId = null;

    function gpSetStatus(msg, type) {
      var el = document.getElementById('gpStatus');
      if (!el) return;
      if (!msg) { el.style.display = 'none'; return; }
      el.style.display = '';
      el.textContent = msg;
      var colors = {
        ok:   { bg:'rgba(0,200,83,.08)',  border:'rgba(0,200,83,.3)',  color:'var(--green)' },
        bad:  { bg:'rgba(200,50,50,.08)', border:'rgba(200,50,50,.3)', color:'#e06060' },
        info: { bg:'rgba(201,168,76,.06)',border:'rgba(201,168,76,.25)',color:'var(--gold)' },
      };
      var c = colors[type] || colors.info;
      el.style.background = c.bg; el.style.border = '1px solid ' + c.border; el.style.color = c.color;
    }

    function gpFill(p) {
      var map = { gpTitle:'title', gpNick:'nickname', gpSlug:'slug', gpBadge:'badge',
                  gpGame:'game', gpCasino:'casino', gpAbout:'about', gpSpecialty:'specialty',
                  gpTell:'tell', gpThreat:'threatLevel', gpLucky:'luckyCharm',
                  gpKnown:'knownFor', gpTableRep:'tableReputation', gpContent:'content' };
      Object.keys(map).forEach(function(elId) {
        var el = document.getElementById(elId);
        if (el) el.value = p[map[elId]] || '';
      });
    }

    function gpReadForm() {
      function v(id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; }
      var title = v('gpTitle'), nick = v('gpNick'), slug = v('gpSlug'),
          badge = v('gpBadge'), about = v('gpAbout'), content = v('gpContent');
      if (!title) throw new Error('Profile title is required.');
      if (!nick)  throw new Error('Nickname is required.');
      if (!slug)  throw new Error('Slug is required.');
      if (!badge) throw new Error('Badge is required.');
      if (!about) throw new Error('About section is required.');
      if (!content) throw new Error('Story content is required.');
      var game = v('gpGame'), casino = v('gpCasino');
      var tags = ['Player Spotlight', badge, 'Foxwoods', 'Poker Friends', 'Community Story', 'ATMNOPIN'];
      if (game && tags.indexOf(game) === -1) tags.push(game);
      return {
        title: title, slug: slug, excerpt: about, content: content,
        category: 'Player Spotlight', person_type: 'player',
        poker_room: casino, specialty: v('gpSpecialty'), tell: v('gpTell'),
        threat_level: v('gpThreat'), lucky_charm: v('gpLucky'),
        known_for: v('gpKnown'), table_reputation: v('gpTableRep'),
        crew_nickname: nick, crew_role: 'Player', crew_quote: '',
        icon_type: '\\u2660', tags: tags,
        featured_on_home: false, featured_image_url: '',
        featured_image_alt: nick + (casino ? ' at ' + casino : ''),
        gallery_images: [], video_urls: [],
        source_submission_id: gpSubId || '',
      };
    }

    async function gpCallGenerate(subId, hints) {
      var r = await fetch('/api/admin/generate-player-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ submissionId: subId, styleHints: hints || '' }),
      });
      var d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Generation failed.');
      return d.profile;
    }

    async function generateProfile(subId) {
      gpSubId = subId;
      gpChronicleId = null;
      document.getElementById('gpHints').value = '';
      document.getElementById('gpSaveConfirm').style.display = 'none';
      gpFill({});
      document.getElementById('gpModal').style.display = '';
      document.body.style.overflow = 'hidden';
      gpSetStatus('Generating profile with AI...', 'info');
      var btn = document.getElementById('gpRegenBtn');
      if (btn) btn.disabled = true;
      try {
        var p = await gpCallGenerate(subId, '');
        gpFill(p);
        gpSetStatus('Profile generated — review and edit before publishing.', 'ok');
      } catch (e) {
        gpSetStatus('Error: ' + e.message, 'bad');
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    async function gpRegen() {
      if (!gpSubId) return;
      var btn = document.getElementById('gpRegenBtn');
      if (btn) btn.disabled = true;
      gpSetStatus('Regenerating...', 'info');
      document.getElementById('gpSaveConfirm').style.display = 'none';
      try {
        var hints = document.getElementById('gpHints').value.trim();
        var p = await gpCallGenerate(gpSubId, hints);
        gpFill(p);
        gpSetStatus('Regenerated — review edits before publishing.', 'ok');
      } catch (e) {
        gpSetStatus('Error: ' + e.message, 'bad');
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    async function gpSave(status) {
      var draftBtn = document.getElementById('gpDraftBtn');
      var pubBtn = document.getElementById('gpPublishBtn');
      try {
        var payload = gpReadForm();
        payload.status = status;
        if (draftBtn) draftBtn.disabled = true;
        if (pubBtn) pubBtn.disabled = true;
        gpSetStatus('Saving...', 'info');
        var url = gpChronicleId ? '/api/admin/chronicles/' + gpChronicleId : '/api/admin/chronicles';
        var method = gpChronicleId ? 'PUT' : 'POST';
        var r = await fetch(url, {
          method: method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        var d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Save failed.');
        gpChronicleId = d.id;
        gpSetStatus('');
        var confirm = document.getElementById('gpSaveConfirm');
        if (confirm) {
          confirm.style.display = '';
          confirm.innerHTML = status === 'published'
            ? '\\u2713 Published! <a href="/chronicles/' + d.slug + '" target="_blank" style="color:var(--green);text-decoration:underline;">View profile →</a>'
            : '\\u2713 Draft saved. Chronicle ID: ' + d.id;
        }
        if (status === 'published' && pubBtn) pubBtn.textContent = 'Published \\u2713';
      } catch (e) {
        gpSetStatus('Error: ' + e.message, 'bad');
      } finally {
        if (draftBtn) draftBtn.disabled = false;
        if (pubBtn && status !== 'published') pubBtn.disabled = false;
      }
    }

    function cancelGP() {
      document.getElementById('gpModal').style.display = 'none';
      document.body.style.overflow = '';
      gpSubId = null;
      gpChronicleId = null;
    }
    // ── End Profile Generator ────────────────────────────────────────────────

    document.addEventListener('DOMContentLoaded', function() {
      ['sfAll','sfSubmitted','sfPending','sfApproved','sfRejected'].forEach(function(btnId) {
        var btn = document.getElementById(btnId);
        if (!btn) return;
        btn.addEventListener('click', function() {
          var filter = btn.getAttribute('data-subfilter') || 'all';
          document.querySelectorAll('#subList .sub-card').forEach(function(card) {
            if (filter === 'all') { card.style.display = ''; return; }
            if (filter === 'submitted') { card.style.display = card.getAttribute('data-ready') === 'true' ? '' : 'none'; return; }
            card.style.display = card.getAttribute('data-status') === filter ? '' : 'none';
          });
        });
      });
      var sfr = document.getElementById('sfRefresh');
      if (sfr) sfr.addEventListener('click', function() { location.reload(); });
    });
    </script>
    <script>
      document.querySelectorAll('.admin-tab').forEach(function(btn) {
        btn.addEventListener('click', function() {
          document.querySelectorAll('.admin-tab').forEach(function(b) { b.classList.remove('active'); });
          btn.classList.add('active');
          document.getElementById('blogPanel').style.display = btn.dataset.panel === 'blogPanel' ? '' : 'none';
          document.getElementById('chronPanel').style.display = btn.dataset.panel === 'chronPanel' ? '' : 'none';
          document.getElementById('communityPanel').style.display = btn.dataset.panel === 'communityPanel' ? '' : 'none';
          document.getElementById('visitorsPanel').style.display = btn.dataset.panel === 'visitorsPanel' ? '' : 'none';
          document.getElementById('consentPanel').style.display = btn.dataset.panel === 'consentPanel' ? '' : 'none';
          if (btn.dataset.panel === 'communityPanel') { if (allSubs.length > 0) { subFilter = 'all'; renderSubList(); } else { subsLoaded = false; loadSubList(); } }
          if (btn.dataset.panel === 'visitorsPanel' && !visitorsLoaded) { loadVisitors(); }
          if (btn.dataset.panel === 'consentPanel' && !consentLoaded) { loadConsent(); }
        });
      });
    </script>
    <div id="visitorsPanel" style="display:none;">
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
    </div><!-- end visitorsPanel -->
    <div id="consentPanel" style="display:none;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.75rem;flex-wrap:wrap;gap:.5rem;">
        <h2 style="margin:0;">Consent Log</h2>
        <button id="refreshConsent" class="secondary" type="button">Refresh</button>
      </div>
      <p class="small" style="margin-bottom:.75rem;color:#888;">IP and location recorded at time of form submission. Each entry represents a user who checked the consent checkbox and submitted their story.</p>
      <div id="consent-log"><div class="notice">Loading...</div></div>
    </div><!-- end consentPanel -->
    <script>
    var visitData = [];
    var visitorsLoaded = false;
    var consentLoaded = false;
    var visitPage = 1;
    var VISIT_PAGE_SIZE = 50;
    function vesc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function showVisitorLog(html) {
      var el = document.getElementById('visitor-log');
      if (el) el.innerHTML = html;
    }
    function showConsentLog(html) {
      var el = document.getElementById('consent-log');
      if (el) el.innerHTML = html;
    }
    function renderVisitorPage() {
      if (!visitData.length) {
        showVisitorLog('<div class="notice">No page visits logged yet. Visits are recorded server-side after each page load.</div>');
        return;
      }
      var totalPages = Math.ceil(visitData.length / VISIT_PAGE_SIZE);
      if (visitPage < 1) visitPage = 1;
      if (visitPage > totalPages) visitPage = totalPages;
      var start = (visitPage - 1) * VISIT_PAGE_SIZE;
      var slice = visitData.slice(start, start + VISIT_PAGE_SIZE);
      var hdr = '<div style="display:grid;grid-template-columns:148px 110px 160px 90px 80px 70px 70px 1fr;gap:.5rem;padding:.4rem 0;border-bottom:1px solid #1a1a1a;font-size:.57rem;letter-spacing:.15em;text-transform:uppercase;color:var(--green);">'
        + '<span>Timestamp</span><span>IP</span><span>City, Region</span><span>Country</span><span>Browser</span><span>OS</span><span>Device</span><span>Page / Referrer</span></div>';
      var rowsHtml = slice.map(function(v) {
        var city   = (v.city   && v.city   !== 'unknown') ? v.city   : '';
        var region = (v.region && v.region !== 'unknown') ? v.region : '';
        var location = city && region ? city + ', ' + region : city || region || '\u2014';
        var ip = v.ip || 'unknown';
        var ipShort = ip.length > 20 ? ip.substring(0, 18) + '\u2026' : ip;
        var ts = v.timestamp ? new Date(v.timestamp).toLocaleString() : '\u2014';
        return '<div style="display:grid;grid-template-columns:148px 110px 160px 90px 80px 70px 70px 1fr;gap:.5rem;padding:.35rem 0;border-bottom:1px solid #111;font-size:.67rem;">'
          + '<span style="color:#888;font-size:.6rem;">' + vesc(ts) + '</span>'
          + '<span style="color:var(--gold);font-size:.6rem;word-break:break-all;" title="' + vesc(ip) + '">' + vesc(ipShort) + '</span>'
          + '<span style="color:var(--offwhite);font-size:.65rem;">' + vesc(location) + '</span>'
          + '<span style="color:var(--offwhite);font-size:.65rem;">' + vesc(v.country || '\u2014') + '</span>'
          + '<span style="color:#888;">' + vesc(v.browser || '\u2014') + '</span>'
          + '<span style="color:#888;">' + vesc(v.os || '\u2014') + '</span>'
          + '<span style="color:#888;">' + vesc(v.device || '\u2014') + '</span>'
          + '<span style="font-size:.6rem;color:#555;">' + vesc(v.page || '/') + ' \xb7 ' + vesc(v.referrer || 'direct') + '</span>'
          + '</div>';
      }).join('');
      var pagination = '<div style="display:flex;align-items:center;gap:.75rem;margin-top:.75rem;font-size:.7rem;color:#888;">'
        + '<button class="secondary" style="padding:.3rem .7rem;font-size:.7rem;" onclick="visitPage--;renderVisitorPage();" ' + (visitPage <= 1 ? 'disabled' : '') + '>\u2190 Prev</button>'
        + '<span>Page <strong style="color:var(--offwhite);">' + visitPage + '</strong> of <strong style="color:var(--offwhite);">' + totalPages + '</strong> &nbsp;(\u2009' + visitData.length + ' total\u2009)</span>'
        + '<button class="secondary" style="padding:.3rem .7rem;font-size:.7rem;" onclick="visitPage++;renderVisitorPage();" ' + (visitPage >= totalPages ? 'disabled' : '') + '>Next \u2192</button>'
        + '</div>';
      showVisitorLog('<div style="overflow-x:auto;">' + hdr + rowsHtml + '</div>' + pagination);
    }
    async function loadVisitors() {
      visitorsLoaded = true;
      visitPage = 1;
      showVisitorLog('<div class="notice">Loading visitor log...</div>');
      try {
        var r = await fetch('/api/admin/visitor-log');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var data = await r.json();
        visitData = Array.isArray(data) ? data : (data.rows || []);
        var total = Array.isArray(data) ? data.length : (data.total || data.length || visitData.length);
        var countries = new Set(visitData.map(function(v) { return v.country; }).filter(function(c) { return c && c !== 'unknown'; }));
        var ips = new Set(visitData.map(function(v) { return v.ip; }).filter(function(ip) { return ip && ip !== 'unknown'; }));
        document.getElementById('v-total').textContent = total;
        document.getElementById('v-countries').textContent = countries.size;
        document.getElementById('v-unique-ips').textContent = ips.size;
        renderVisitorPage();
      } catch(e) {
        showVisitorLog('<div class="notice" style="border-color:#5c1f1f;">Error loading visitor log: ' + vesc(e.message || String(e)) + '</div>');
      }
    }
    async function loadConsent() {
      consentLoaded = true;
      showConsentLog('<div class="notice">Loading consent records...</div>');
      try {
        var sr = await fetch('/api/admin/submissions');
        var subsData = sr.ok ? await sr.json() : [];
        renderConsentLog(subsData);
      } catch(e) {
        showConsentLog('<div class="notice" style="border-color:#5c1f1f;">Error loading consent log: ' + vesc(e.message || String(e)) + '</div>');
      }
    }
    function renderConsentLog(subsData) {
      var consented = (subsData || (typeof allSubs !== 'undefined' ? allSubs : [])).filter(function(s) { return s.consent_at; });
      if (!consented.length) { showConsentLog('<div class="notice">No consent records yet.</div>'); return; }
      var hdr = '<div style="display:grid;grid-template-columns:148px 120px 110px 160px 1fr;gap:.5rem;padding:.4rem 0;border-bottom:1px solid #1a1a1a;font-size:.57rem;letter-spacing:.15em;text-transform:uppercase;color:var(--green);">'
        + '<span>Consent Time</span><span>Name</span><span>IP</span><span>Location</span><span>Country</span></div>';
      var rowsHtml = consented.map(function(s) {
        var ts = s.consent_at ? new Date(s.consent_at).toLocaleString() : '\u2014';
        var ip = s.consent_ip || 'unknown';
        var ipShort = ip.length > 20 ? ip.substring(0, 18) + '\u2026' : ip;
        var city = (s.consent_city && s.consent_city !== 'unknown') ? s.consent_city : '';
        var region = (s.consent_region && s.consent_region !== 'unknown') ? s.consent_region : '';
        var loc = city && region ? city + ', ' + region : city || region || '\u2014';
        return '<div style="display:grid;grid-template-columns:148px 120px 110px 160px 1fr;gap:.5rem;padding:.35rem 0;border-bottom:1px solid #111;font-size:.67rem;">'
          + '<span style="color:#888;font-size:.6rem;">' + vesc(ts) + '</span>'
          + '<span style="color:var(--offwhite);font-size:.65rem;">' + vesc((s.name||'') + (s.nickname ? ' "' + s.nickname + '"' : '')) + '</span>'
          + '<span style="color:var(--gold);font-size:.6rem;word-break:break-all;" title="' + vesc(ip) + '">' + vesc(ipShort) + '</span>'
          + '<span style="color:var(--offwhite);font-size:.65rem;">' + vesc(loc) + '</span>'
          + '<span style="color:#888;font-size:.65rem;">' + vesc(s.consent_country || '\u2014') + '</span>'
          + '</div>';
      }).join('');
      showConsentLog('<div style="overflow-x:auto;">' + hdr + rowsHtml + '</div>');
    }
    function exportVisitorsCSV() {
      if (!visitData.length) return;
      var headers = ['Timestamp','IP','City','Region','Country','Org/ISP','Browser','OS','Device','Page','Referrer','Latitude','Longitude'];
      var rows = [headers].concat(visitData.map(function(v) {
        return [v.timestamp||'', v.ip||'', v.city||'', v.region||'', v.country||'', v.org||'',
                v.browser||'', v.os||'', v.device||'', v.page||'', v.referrer||'', v.latitude||'', v.longitude||''];
      }));
      var csv = rows.map(function(r) { return r.map(function(c) { return '"' + String(c || '').replace(/"/g, '""') + '"'; }).join(','); }).join('\\n');
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = 'atm-visitors-' + new Date().toISOString().split('T')[0] + '.csv';
      a.click();
    }
    document.getElementById('refreshVisitors').addEventListener('click', loadVisitors);
    document.getElementById('exportVisitors').addEventListener('click', exportVisitorsCSV);
    document.getElementById('refreshConsent').addEventListener('click', function() { consentLoaded = false; loadConsent(); });
    loadVisitors();
    </script>`);
}

const CHRON_CATEGORIES = ['Player Spotlight', 'Dealer Spotlight', 'Floor Spotlight', 'Community Story', 'Meet the Crew', 'Tournament Reports', 'Bad Beats', 'WSOP Life', 'Vegas Adventures', 'Poker Humor', 'Cash Games', 'Behind the Scenes'];

// ─── THE RAIL RENDER FUNCTIONS ───────────────────────────────────────────────

function renderRailPostCard(post) {
  const typeConf = RAIL_POST_TYPES[post.postType] || { label: post.postType || 'Post', color: '#888' };
  const when = new Date(post.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const preview = escapeHtml((post.content || '').slice(0, 260)) + ((post.content || '').length > 260 ? '…' : '');
  const tagsHtml = (post.tags || []).slice(0, 4).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('');
  const metaParts = [post.pokerRoom, post.gameStakes].filter(Boolean);
  return `<article class="rail-card" data-id="${escapeHtml(post.id)}" data-type="${escapeHtml(post.postType||'')}">
  <div class="rail-card-top">
    <span class="rail-type" style="color:${typeConf.color};border-color:${typeConf.color}40">${escapeHtml(typeConf.label)}</span>
    <span class="rail-meta-right">${metaParts.map(escapeHtml).join(' &middot; ')}${metaParts.length ? ' &middot; ' : ''}${when}</span>
  </div>
  ${post.title ? `<h3 class="rail-title">${escapeHtml(post.title)}</h3>` : ''}
  <p class="rail-content">${preview}</p>
  ${tagsHtml ? `<div class="rail-tags">${tagsHtml}</div>` : ''}
  <div class="rail-card-footer">
    <span class="rail-author">&#x2666; ${escapeHtml(post.authorName || 'Anonymous')}</span>
    <div class="rail-actions">
      <button class="rail-like-btn" onclick="railLike(this,'${escapeHtml(post.id)}')" title="Like this post">&#x2665; <span class="rail-lc">${post.likeCount || 0}</span></button>
      <button class="rail-report-btn" onclick="railReport('${escapeHtml(post.id)}')" title="Report this post">&#x2691; Report</button>
    </div>
  </div>
</article>`;
}

function renderRailPage(posts, total, page, filters) {
  const limit = 20;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const cardsHtml = posts.length
    ? posts.map(renderRailPostCard).join('\n')
    : '<div class="rail-empty"><p>No posts yet. Be the first to post on The Rail.</p></div>';

  const typeOpts = Object.entries(RAIL_POST_TYPES).map(([k, v]) =>
    `<button class="rail-filter${filters.type === k ? ' rf-active' : ''}" onclick="railFilter('type','${k}')">${escapeHtml(v.label)}</button>`
  ).join('');

  const prevUrl = page > 1 ? `/rail?page=${page - 1}${filters.type ? '&type=' + filters.type : ''}` : null;
  const nextUrl = page < totalPages ? `/rail?page=${page + 1}${filters.type ? '&type=' + filters.type : ''}` : null;

  const typeSelectOpts = [['', 'Select type…'], ...Object.entries(RAIL_POST_TYPES).map(([k, v]) => [k, v.label])]
    .map(([v, l]) => `<option value="${escapeHtml(v)}">${escapeHtml(l)}</option>`).join('');

  return renderLayout('The Rail | ATMNOPIN™', `
<style>
.rail-hero{padding:2.5rem 0 1.5rem;border-bottom:1px solid #1e1e1e;}
.rail-hero .eyebrow{font-size:.58rem;letter-spacing:.28em;text-transform:uppercase;color:var(--green);margin-bottom:.65rem;}
.rail-h1{font-family:'Bebas Neue',sans-serif;font-size:clamp(3rem,8vw,5rem);line-height:1;color:var(--offwhite);margin-bottom:.5rem;}
.rail-h1 em{color:var(--green);}
.rail-tagline{font-size:.82rem;color:#b0a898;max-width:50ch;line-height:1.85;}
.rail-hero-cta{display:flex;gap:.75rem;flex-wrap:wrap;margin-top:1.1rem;}
.rail-cta-btn{display:inline-block;padding:.65rem 1.2rem;font-size:.72rem;text-transform:uppercase;letter-spacing:.12em;cursor:pointer;font-family:inherit;border:none;}
.rail-cta-primary{background:var(--green);color:#000;}
.rail-cta-primary:hover{background:#00ff6a;color:#000;}
.rail-cta-ghost{background:transparent;border:1px solid #2a2a2a;color:var(--offwhite);}
.rail-cta-ghost:hover{border-color:var(--green);color:var(--green);}
.rail-layout{display:grid;grid-template-columns:220px 1fr;gap:1.5rem;padding:1.25rem 0 3rem;align-items:start;}
@media(max-width:860px){.rail-layout{grid-template-columns:1fr;}}
.rail-sidebar{}
.rail-sidebar-label{font-size:.52rem;letter-spacing:.2em;text-transform:uppercase;color:#555;margin-bottom:.5rem;}
.rail-filter{display:block;width:100%;text-align:left;border:1px solid #1a1a1a;background:transparent;color:#888;padding:.32rem .65rem;font:.64rem 'DM Mono',monospace;text-transform:uppercase;letter-spacing:.08em;cursor:pointer;transition:all .15s;margin-bottom:.22rem;}
.rail-filter:hover,.rf-active{border-color:rgba(0,200,83,.35);background:rgba(0,200,83,.06);color:var(--green);}
.rail-filter-all{margin-bottom:.6rem;}
.rail-feed{display:flex;flex-direction:column;gap:.75rem;}
.rail-card{border:1px solid #1e1e1e;background:#0c0c0c;padding:1rem;transition:border-color .2s;}
.rail-card:hover{border-color:#2a2a2a;}
.rail-card-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:.6rem;flex-wrap:wrap;gap:.35rem;}
.rail-type{font-size:.56rem;letter-spacing:.12em;text-transform:uppercase;border:1px solid;padding:.12rem .45rem;}
.rail-meta-right{font-size:.56rem;color:#555;letter-spacing:.06em;}
.rail-title{font-family:'DM Serif Display',serif;font-size:1rem;color:var(--offwhite);margin-bottom:.45rem;line-height:1.3;}
.rail-content{font-size:.78rem;color:#a0988a;line-height:1.75;margin-bottom:.5rem;}
.rail-tags{margin-bottom:.5rem;}
.rail-card-footer{display:flex;justify-content:space-between;align-items:center;margin-top:.25rem;padding-top:.5rem;border-top:1px solid #141414;}
.rail-author{font-size:.62rem;color:#666;letter-spacing:.06em;}
.rail-actions{display:flex;gap:.5rem;}
.rail-like-btn,.rail-report-btn{background:transparent;border:1px solid #1a1a1a;color:#666;padding:.22rem .55rem;font:.6rem 'DM Mono',monospace;cursor:pointer;transition:all .15s;letter-spacing:.06em;}
.rail-like-btn:hover{border-color:rgba(0,200,83,.35);color:var(--green);}
.rail-report-btn:hover{border-color:rgba(200,80,80,.35);color:#e06060;}
.rail-empty{padding:3rem;text-align:center;border:1px dashed #1a1a1a;color:#555;font-size:.78rem;}
.rail-pagination{display:flex;gap:.75rem;align-items:center;justify-content:center;margin-top:1.5rem;font-size:.72rem;color:#666;}
.rail-page-btn{border:1px solid #2a2a2a;background:#111;color:#888;padding:.3rem .7rem;font:.68rem 'DM Mono',monospace;cursor:pointer;}
.rail-page-btn:hover{border-color:var(--green);color:var(--green);}
.rail-count{font-size:.62rem;color:#555;padding:.3rem 0;}
/* ── Composer Modal ── */
.rail-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;z-index:1000;padding:1rem;box-sizing:border-box;}
.rail-modal-box{background:#0d0d0d;border:1px solid #242424;max-width:600px;width:100%;max-height:90vh;overflow-y:auto;padding:1.75rem;box-sizing:border-box;}
@media(max-width:480px){.rail-modal-box{padding:1.1rem;}}
.rail-modal-h{font-family:'Bebas Neue',sans-serif;font-size:1.8rem;color:var(--offwhite);margin-bottom:.25rem;letter-spacing:.08em;}
.rail-modal-sub{font-size:.72rem;color:#888;margin-bottom:1.25rem;}
.rail-age-notice{border:1px solid rgba(201,168,76,.3);background:rgba(201,168,76,.05);padding:.85rem 1rem;margin-bottom:1rem;}
.rail-age-notice p{font-size:.76rem;color:#b0a898;line-height:1.65;}
.rail-age-notice strong{color:var(--gold);}
.rail-consent-row{display:flex;align-items:flex-start;gap:.6rem;margin-bottom:.6rem;font-size:.72rem;color:#b0a898;line-height:1.5;}
.rail-consent-row input[type=checkbox]{margin-top:.22rem;flex-shrink:0;width:14px;height:14px;accent-color:var(--green);}
.rail-consent-row span{flex:1;min-width:0;}
.rail-consent-row a{color:var(--green);}
.rail-form-grid{display:grid;gap:.65rem;}
.rail-form-row{display:grid;grid-template-columns:1fr 1fr;gap:.65rem;}
@media(max-width:540px){.rail-form-row{grid-template-columns:1fr;}}
.rail-form-section{font-size:.54rem;letter-spacing:.18em;text-transform:uppercase;color:var(--green);padding:.5rem 0 .25rem;border-top:1px solid #1a1a1a;margin-top:.25rem;}
.rail-form-actions{display:flex;gap:.65rem;flex-wrap:wrap;margin-top:.75rem;}
.rail-ai-btn{background:rgba(0,200,83,.08);border:1px solid rgba(0,200,83,.3);color:var(--green);padding:.55rem 1rem;font:.7rem 'DM Mono',monospace;text-transform:uppercase;letter-spacing:.1em;cursor:pointer;transition:all .2s;}
.rail-ai-btn:hover{background:rgba(0,200,83,.15);}
.rail-ai-btn:disabled{opacity:.5;cursor:not-allowed;}
.rail-submit-btn{background:var(--green);border:none;color:#000;padding:.55rem 1.4rem;font:.72rem 'DM Mono',monospace;text-transform:uppercase;letter-spacing:.12em;cursor:pointer;font-weight:700;}
.rail-submit-btn:hover{background:#00ff6a;}
.rail-submit-btn:disabled{opacity:.5;cursor:not-allowed;}
.rail-cancel-btn{background:transparent;border:1px solid #2a2a2a;color:#888;padding:.55rem .9rem;font:.7rem 'DM Mono',monospace;text-transform:uppercase;letter-spacing:.1em;cursor:pointer;}
.rail-cancel-btn:hover{border-color:#444;color:var(--offwhite);}
.rail-success-msg{border:1px solid rgba(0,200,83,.3);background:rgba(0,200,83,.06);padding:1rem;font-size:.78rem;color:var(--green);margin-bottom:1rem;display:none;}
.rail-error-msg{border:1px solid rgba(200,80,80,.3);background:rgba(200,80,80,.06);padding:.7rem;font-size:.72rem;color:#e06060;margin-top:.5rem;display:none;}
</style>

<div class="rail-hero">
  <p class="eyebrow">&#x2756; ATMNOPIN&#x2122; Community</p>
  <h1 class="rail-h1">The <em>Rail</em></h1>
  <p class="rail-tagline">Poker updates from the people actually punting chips.</p>
  <div class="rail-hero-cta">
    <button class="rail-cta-btn rail-cta-primary" onclick="railOpenComposer()">Post to The Rail</button>
    <a href="/community-wall" class="rail-cta-btn rail-cta-ghost">View Community Wall</a>
  </div>
</div>

<div id="railSuccessMsg" class="rail-success-msg">
  &#x2713; Your post has been submitted and is pending review. We&rsquo;ll publish it once it&rsquo;s been checked. Thanks for posting!
</div>

<div class="rail-layout">
  <aside class="rail-sidebar">
    <p class="rail-sidebar-label">// Filter by Type</p>
    <button class="rail-filter rail-filter-all${!filters.type ? ' rf-active' : ''}" onclick="railFilter('type','')">All Posts (${total})</button>
    ${typeOpts}
  </aside>
  <div>
    <p class="rail-count">${total} post${total !== 1 ? 's' : ''}</p>
    <div class="rail-feed" id="railFeed">
      ${cardsHtml}
    </div>
    ${totalPages > 1 ? `<div class="rail-pagination">
      ${prevUrl ? `<a href="${prevUrl}" class="rail-page-btn">&larr; Prev</a>` : ''}
      <span>Page ${page} of ${totalPages}</span>
      ${nextUrl ? `<a href="${nextUrl}" class="rail-page-btn">Next &rarr;</a>` : ''}
    </div>` : ''}
  </div>
</div>

<!-- COMPOSER MODAL -->
<div id="railModal" class="rail-modal-overlay" style="display:none" onclick="if(event.target===this)railCloseComposer()">
  <div class="rail-modal-box">

    <!-- STEP 1: Age Gate -->
    <div id="railStep1">
      <p class="rail-modal-h">Age Verification</p>
      <p class="rail-modal-sub">The Rail is intended for adults 21 years of age and older.</p>
      <div class="rail-age-notice">
        <p>Poker involves gambling. By posting on The Rail, you confirm that you are a legal adult and that gambling is lawful in your jurisdiction. You are responsible for complying with all applicable laws.</p>
      </div>
      <label class="rail-consent-row">
        <input type="checkbox" id="ageCheck">
        <span>I certify that I am at least <strong>21 years old</strong> and that online poker community participation is lawful in my jurisdiction.</span>
      </label>
      <div class="rail-form-actions" style="margin-top:1rem;">
        <button class="rail-submit-btn" onclick="railAgeConfirm()">Continue &rarr;</button>
        <button class="rail-cancel-btn" onclick="railCloseComposer()">Cancel</button>
      </div>
    </div>

    <!-- STEP 2: Post Form -->
    <div id="railStep2" style="display:none">
      <p class="rail-modal-h">Post to The Rail</p>
      <p class="rail-modal-sub">Share your poker story. All posts are reviewed before publishing.</p>
      <form id="railPostForm" onsubmit="railSubmit(event)" class="rail-form-grid">
        <p class="rail-form-section">Your Info</p>
        <div class="rail-form-row">
          <label>Your Name *<input name="authorName" required placeholder="Manny &ldquo;The Machine&rdquo;" /></label>
          <label>Email * <span style="font-size:.55rem;color:#555;">(not published)</span><input name="authorEmail" type="email" required placeholder="you@example.com" /></label>
        </div>
        <p class="rail-form-section">Your Post</p>
        <div class="rail-form-row">
          <label>Post Type *<select name="postType" required>${typeSelectOpts}</select></label>
          <label>Title <span style="font-size:.55rem;color:#555;">(optional)</span><input name="title" placeholder="Lost with Aces Again" /></label>
        </div>
        <label>Your Story *<textarea name="content" required rows="5" placeholder="Tell us what happened. Be specific — good stories have details. What were the stakes? What was the read? What went wrong (or right)?"></textarea></label>
        <div class="rail-form-row">
          <label>Poker Room<input name="pokerRoom" placeholder="Foxwoods, Commerce, Bellagio…" /></label>
          <label>Game / Stakes<input name="gameStakes" placeholder="$2/$5 NLH, $1/$3 PLO…" /></label>
        </div>
        <label>Tags <span style="font-size:.55rem;color:#555;">(comma separated)</span><input name="tags" placeholder="bad-beat, aces, cooler" /></label>
        <div id="railConsentSection">
          <p class="rail-form-section">Required Confirmations</p>
          <label class="rail-consent-row">
            <input type="checkbox" name="c_ownership" required>
            <span>I confirm this content is my own or I have permission to post it.</span>
          </label>
          <label class="rail-consent-row">
            <input type="checkbox" name="c_guidelines" required>
            <span>I agree to the <a href="/community-guidelines" target="_blank">Community Guidelines</a>.</span>
          </label>
          <label class="rail-consent-row">
            <input type="checkbox" name="c_moderation" required>
            <span>I understand ATMNOPIN&#x2122; may edit, reject, or remove my content.</span>
          </label>
        </div>
        <p id="railReturnNote" style="display:none;font-size:.65rem;color:#666;border:1px solid #1a1a1a;padding:.5rem .75rem;">&#x2713; You agreed to our <a href="/community-guidelines" target="_blank" style="color:var(--green);">Community Guidelines</a> on a previous visit.</p>
        <div id="railFormError" class="rail-error-msg"></div>
        <div class="rail-form-actions">
          <button type="button" class="rail-ai-btn" id="railAIBtn" onclick="railAIRewrite()">&#x2736; Rewrite with ATM AI</button>
          <button type="submit" class="rail-submit-btn" id="railSubmitBtn">Post to The Rail</button>
          <button type="button" class="rail-cancel-btn" onclick="railCloseComposer()">Cancel</button>
        </div>
      </form>
    </div>

  </div>
</div>

<script>
function railOpenComposer() {
  var ageOk = localStorage.getItem('rail_age_ok') === '1';
  var prevConsented = localStorage.getItem('rail_consented') === '1';
  document.getElementById('railModal').style.display = 'flex';
  document.getElementById('railStep1').style.display = ageOk ? 'none' : 'block';
  document.getElementById('railStep2').style.display = ageOk ? 'block' : 'none';
  document.getElementById('ageCheck').checked = false;
  document.body.style.overflow = 'hidden';
  if (prevConsented) {
    ['c_ownership','c_guidelines','c_moderation'].forEach(function(n) {
      var el = document.querySelector('#railPostForm [name="'+n+'"]');
      if (el) el.checked = true;
    });
    var sec = document.getElementById('railConsentSection');
    if (sec) sec.style.display = 'none';
    var note = document.getElementById('railReturnNote');
    if (note) note.style.display = 'block';
  }
}
function railCloseComposer() {
  document.getElementById('railModal').style.display = 'none';
  document.body.style.overflow = '';
}
function railAgeConfirm() {
  if (!document.getElementById('ageCheck').checked) {
    alert('You must confirm you are at least 21 years old to post on The Rail.');
    return;
  }
  localStorage.setItem('rail_age_ok', '1');
  document.getElementById('railStep1').style.display = 'none';
  document.getElementById('railStep2').style.display = 'block';
}
async function railAIRewrite() {
  var content = document.querySelector('#railPostForm [name="content"]').value.trim();
  if (!content) { alert('Write your story first, then let ATM AI improve it.'); return; }
  var btn = document.getElementById('railAIBtn');
  btn.disabled = true; btn.textContent = '\\u2736 Rewriting…';
  try {
    var r = await fetch('/api/rail/ai-rewrite', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content })
    });
    var d = await r.json();
    if (d.rewritten) {
      document.querySelector('#railPostForm [name="content"]').value = d.rewritten;
    } else {
      alert('AI rewrite unavailable: ' + (d.error || 'try again shortly'));
    }
  } catch(e) { alert('AI rewrite failed. Please try again.'); }
  finally { btn.disabled = false; btn.textContent = '\\u2736 Rewrite with ATM AI'; }
}
async function railSubmit(e) {
  e.preventDefault();
  var form = e.target;
  var errEl = document.getElementById('railFormError');
  errEl.style.display = 'none';
  var payload = {
    authorName:  form.authorName.value.trim(),
    authorEmail: form.authorEmail.value.trim(),
    postType:    form.postType.value,
    title:       form.title.value.trim(),
    content:     form.content.value.trim(),
    pokerRoom:   form.pokerRoom.value.trim(),
    gameStakes:  form.gameStakes.value.trim(),
    tags:        form.tags.value.split(',').map(function(t){return t.trim();}).filter(Boolean),
    consents: [
      { consentType:'age_verification',     consentVersion:'1.0', accepted:true },
      { consentType:'content_ownership',    consentVersion:'1.0', accepted:form.c_ownership.checked },
      { consentType:'community_guidelines', consentVersion:'1.0', accepted:form.c_guidelines.checked },
      { consentType:'moderation_policy',    consentVersion:'1.0', accepted:form.c_moderation.checked }
    ]
  };
  var btn = document.getElementById('railSubmitBtn');
  btn.disabled = true; btn.textContent = 'Posting…';
  try {
    var r = await fetch('/api/rail/posts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    var d = await r.json();
    if (d.ok) {
      localStorage.setItem('rail_consented', '1');
      localStorage.setItem('rail_age_ok', '1');
      railCloseComposer();
      var msg = document.getElementById('railSuccessMsg');
      msg.style.display = 'block';
      form.reset();
      setTimeout(function(){ msg.style.display='none'; }, 8000);
    } else {
      errEl.textContent = d.error || 'Something went wrong. Please try again.';
      errEl.style.display = 'block';
    }
  } catch(e) {
    errEl.textContent = 'Network error. Please try again.';
    errEl.style.display = 'block';
  }
  finally { btn.disabled = false; btn.textContent = 'Post to The Rail'; }
}
function railFilter(key, val) {
  var params = new URLSearchParams(window.location.search);
  if (val) params.set(key, val); else params.delete(key);
  params.delete('page');
  window.location.href = '/rail' + (params.toString() ? '?' + params.toString() : '');
}
async function railLike(btn, postId) {
  btn.disabled = true;
  try {
    var r = await fetch('/api/rail/posts/' + postId + '/like', { method: 'POST' });
    var d = await r.json();
    btn.querySelector('.rail-lc').textContent = d.likeCount || 0;
    if (d.liked) { btn.style.color = 'var(--green)'; btn.style.borderColor = 'rgba(0,200,83,.4)'; }
    else if (d.alreadyLiked) { btn.style.opacity = '.55'; }
  } catch(e) {}
  finally { btn.disabled = false; }
}
async function railReport(postId) {
  var types = ['Harassment','Spam','Private Information','Copyright','Cheating Accusation','Offensive Content','Other'];
  var choice = prompt('Report reason (enter 1\\u20137):\\n\\n' + types.map(function(t,i){return (i+1)+'. '+t;}).join('\\n'));
  if (!choice) return;
  var idx = parseInt(choice) - 1;
  var keys = ['harassment','spam','private_info','copyright','cheating_accusation','offensive','other'];
  var reportType = keys[idx] || 'other';
  try {
    await fetch('/api/rail/posts/' + postId + '/report', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ reportType: reportType })
    });
    alert('Report submitted. Thank you for keeping The Rail safe.');
  } catch(e) {}
}
</script>
`);
}

function renderCommunityGuidelinesPage() {
  return renderLayout('Community Guidelines | ATMNOPIN™', `
<style>
.cg-hero{padding:2.5rem 0 1.5rem;border-bottom:1px solid #1e1e1e;}
.cg-h1{font-family:'Bebas Neue',sans-serif;font-size:clamp(2.5rem,6vw,4rem);line-height:1;color:var(--offwhite);margin:.5rem 0;}
.cg-lead{font-size:.82rem;color:#b0a898;max-width:50ch;line-height:1.85;margin-top:.5rem;}
.cg-body{max-width:65ch;padding:2rem 0 3rem;}
.cg-section{margin-bottom:2rem;}
.cg-section h2{font-family:'Bebas Neue',sans-serif;font-size:1.4rem;letter-spacing:.1em;color:var(--green);margin-bottom:.65rem;}
.cg-rule{display:flex;gap:.75rem;align-items:flex-start;margin-bottom:.6rem;font-size:.8rem;color:#b0a898;line-height:1.65;}
.cg-rule-num{font-family:'Bebas Neue',sans-serif;font-size:1rem;color:var(--gold);width:1.4rem;flex-shrink:0;}
.cg-footer-note{border:1px solid #1a1a1a;background:#0c0c0c;padding:1rem;font-size:.72rem;color:#888;line-height:1.75;}
</style>
<div class="cg-hero">
  <p class="eyebrow">&#x2756; ATMNOPIN&#x2122; Community</p>
  <h1 class="cg-h1">Community Guidelines</h1>
  <p class="cg-lead">The Rail is a poker community space. These rules keep it worth reading.</p>
</div>
<div class="cg-body">
  <div class="cg-section">
    <h2>The Rules</h2>
    <div class="cg-rule"><span class="cg-rule-num">01</span><span><strong style="color:var(--offwhite)">Be respectful.</strong> Disagree about poker strategy all you want. Don&rsquo;t disrespect the person across the felt.</span></div>
    <div class="cg-rule"><span class="cg-rule-num">02</span><span><strong style="color:var(--offwhite)">Keep it poker-related.</strong> Stories, hands, bad beats, humor, shoutouts, questions. If it has nothing to do with poker, it doesn&rsquo;t belong here.</span></div>
    <div class="cg-rule"><span class="cg-rule-num">03</span><span><strong style="color:var(--offwhite)">No harassment or personal attacks.</strong> Zero tolerance. A single incident results in permanent removal.</span></div>
    <div class="cg-rule"><span class="cg-rule-num">04</span><span><strong style="color:var(--offwhite)">No private information.</strong> Never post anyone&rsquo;s phone number, email, home address, or any identifying information without explicit permission.</span></div>
    <div class="cg-rule"><span class="cg-rule-num">05</span><span><strong style="color:var(--offwhite)">No unsubstantiated cheating accusations.</strong> If you believe someone cheated, report it to casino management. Posting accusations without evidence causes real harm.</span></div>
    <div class="cg-rule"><span class="cg-rule-num">06</span><span><strong style="color:var(--offwhite)">No copyrighted uploads without permission.</strong> Hand histories and personal stories are yours to share. Screenshots from other sites, media articles, or others&rsquo; videos need permission.</span></div>
    <div class="cg-rule"><span class="cg-rule-num">07</span><span><strong style="color:var(--offwhite)">No spam.</strong> No promotional posts, affiliate links, or unsolicited offers.</span></div>
    <div class="cg-rule"><span class="cg-rule-num">08</span><span><strong style="color:var(--offwhite)">No illegal content.</strong> This includes discussing soft-play arrangements, casino fraud, or anything that violates applicable law.</span></div>
    <div class="cg-rule"><span class="cg-rule-num">09</span><span><strong style="color:var(--offwhite)">21+ only.</strong> This is an adult community. You must be at least 21 years old to post, comment, or participate.</span></div>
    <div class="cg-rule"><span class="cg-rule-num">10</span><span><strong style="color:var(--offwhite)">Moderation is final.</strong> Posts may be edited, rejected, or removed at any time. Accounts may be suspended without notice for violations.</span></div>
  </div>
  <div class="cg-footer-note">
    <strong style="color:var(--offwhite);">Reporting:</strong> Use the Report button on any post to flag a concern. All reports are reviewed. By posting, you agree that ATMNOPIN™ (Sunfish Technologies LLC) may edit, remove, or republish your content.
    Questions? Email us at <a href="mailto:hello@atmwithnopin.com" style="color:var(--green);">hello@atmwithnopin.com</a>
  </div>
  <p style="margin-top:1.5rem;"><a href="/rail" style="color:var(--green);font-size:.72rem;text-transform:uppercase;letter-spacing:.1em;">&larr; Back to The Rail</a></p>
</div>
`);
}

function renderTermsPage() {
  return renderLayout('Terms of Service | ATMNOPIN™', `
<style>
.legal-hero{padding:2rem 0 1.25rem;border-bottom:1px solid #1e1e1e;}
.legal-h1{font-family:'Bebas Neue',sans-serif;font-size:clamp(2rem,5vw,3.5rem);line-height:1;color:var(--offwhite);margin:.4rem 0;}
.legal-body{max-width:68ch;padding:1.75rem 0 3rem;font-size:.8rem;color:#a0988a;line-height:1.85;}
.legal-body h2{font-family:'DM Serif Display',serif;font-size:1.05rem;color:var(--offwhite);margin:1.5rem 0 .5rem;}
.legal-body p{margin-bottom:.85rem;}
.legal-todo{border:1px solid rgba(201,168,76,.3);background:rgba(201,168,76,.05);padding:.85rem 1rem;margin-bottom:1.25rem;font-size:.72rem;color:var(--gold);}
</style>
<div class="legal-hero">
  <p class="eyebrow">&#x2756; ATMNOPIN&#x2122; Legal</p>
  <h1 class="legal-h1">Terms of Service</h1>
  <p style="font-size:.68rem;color:#555;margin-top:.4rem;">Version 1.0 &nbsp;&middot;&nbsp; Last updated: July 2026</p>
</div>
<div class="legal-body">
  <div class="legal-todo">&#x26A0; TODO: These terms are placeholder text and must be reviewed and finalized by qualified legal counsel before production use.</div>
  <h2>1. Acceptance of Terms</h2>
  <p>By accessing or using ATMNOPIN™ (operated by Sunfish Technologies LLC), you agree to be bound by these Terms of Service. If you do not agree, do not use the site.</p>
  <h2>2. Age Requirement</h2>
  <p>You must be at least 21 years of age to use community features including The Rail, Community Wall, and AI Profile Generator. By using these features, you certify that you meet this requirement.</p>
  <h2>3. User Content</h2>
  <p>You retain ownership of content you post. By submitting content, you grant ATMNOPIN™ a non-exclusive, royalty-free license to display, edit, and remove that content. You are solely responsible for ensuring your content does not violate any laws or third-party rights.</p>
  <h2>4. Prohibited Conduct</h2>
  <p>Users may not post content that is harassing, defamatory, fraudulent, infringing, or otherwise unlawful. See our <a href="/community-guidelines">Community Guidelines</a> for specifics.</p>
  <h2>5. Moderation</h2>
  <p>ATMNOPIN™ reserves the right to edit, remove, or reject any content at any time for any reason. Accounts may be suspended or banned for violations.</p>
  <h2>6. Disclaimer</h2>
  <p>ATMNOPIN™ is a poker entertainment and community platform. Nothing on this site constitutes gambling advice, financial advice, or legal advice. All poker content is for entertainment purposes only.</p>
  <h2>7. Limitation of Liability</h2>
  <p>To the maximum extent permitted by law, Sunfish Technologies LLC shall not be liable for any indirect, incidental, or consequential damages arising from your use of this site.</p>
  <h2>8. Changes to Terms</h2>
  <p>We may update these terms at any time. Continued use of the site after changes constitutes acceptance of the new terms.</p>
  <h2>9. Contact</h2>
  <p>Questions about these terms: <a href="mailto:hello@atmwithnopin.com">hello@atmwithnopin.com</a></p>
</div>
`);
}

function renderPrivacyPage() {
  return renderLayout('Privacy Policy | ATMNOPIN™', `
<style>
.legal-hero{padding:2rem 0 1.25rem;border-bottom:1px solid #1e1e1e;}
.legal-h1{font-family:'Bebas Neue',sans-serif;font-size:clamp(2rem,5vw,3.5rem);line-height:1;color:var(--offwhite);margin:.4rem 0;}
.legal-body{max-width:68ch;padding:1.75rem 0 3rem;font-size:.8rem;color:#a0988a;line-height:1.85;}
.legal-body h2{font-family:'DM Serif Display',serif;font-size:1.05rem;color:var(--offwhite);margin:1.5rem 0 .5rem;}
.legal-body p{margin-bottom:.85rem;}
.legal-todo{border:1px solid rgba(201,168,76,.3);background:rgba(201,168,76,.05);padding:.85rem 1rem;margin-bottom:1.25rem;font-size:.72rem;color:var(--gold);}
</style>
<div class="legal-hero">
  <p class="eyebrow">&#x2756; ATMNOPIN&#x2122; Legal</p>
  <h1 class="legal-h1">Privacy Policy</h1>
  <p style="font-size:.68rem;color:#555;margin-top:.4rem;">Version 1.0 &nbsp;&middot;&nbsp; Last updated: July 2026</p>
</div>
<div class="legal-body">
  <div class="legal-todo">&#x26A0; TODO: This policy is placeholder text and must be reviewed and finalized by qualified legal counsel before production use.</div>
  <h2>What We Collect</h2>
  <p>When you post on The Rail or submit a community profile, we collect: your name, email address, IP address, browser/device information, and the content you submit. We also log consent events tied to your email and IP for compliance purposes.</p>
  <h2>How We Use It</h2>
  <p>We use your information to display your posts, moderate content, prevent abuse, and improve the site. Your email is never published. We do not sell your data.</p>
  <h2>Consent Logs</h2>
  <p>Every checkbox you accept on ATMNOPIN™ creates a permanent consent record including your email, IP address, timestamp, and the specific version of the terms you agreed to. These records are retained indefinitely as a legal compliance requirement.</p>
  <h2>Cookies</h2>
  <p>We use a session cookie for admin authentication. We may use analytics cookies in the future. No third-party advertising cookies are used.</p>
  <h2>Firebase</h2>
  <p>Our chat and visitor tracking features use Firebase (Google). See Google&rsquo;s privacy policy for how Firebase handles data.</p>
  <h2>Your Rights</h2>
  <p>You may request deletion of your post or profile at any time by emailing <a href="mailto:hello@atmwithnopin.com">hello@atmwithnopin.com</a>. Note that consent log records cannot be deleted as they serve a legal compliance function.</p>
  <h2>Contact</h2>
  <p><a href="mailto:hello@atmwithnopin.com">hello@atmwithnopin.com</a></p>
</div>
`);
}

function renderDmcaPage() {
  return renderLayout('DMCA Policy | ATMNOPIN™', `
<style>
.legal-hero{padding:2rem 0 1.25rem;border-bottom:1px solid #1e1e1e;}
.legal-h1{font-family:'Bebas Neue',sans-serif;font-size:clamp(2rem,5vw,3.5rem);line-height:1;color:var(--offwhite);margin:.4rem 0;}
.legal-body{max-width:68ch;padding:1.75rem 0 3rem;font-size:.8rem;color:#a0988a;line-height:1.85;}
.legal-body h2{font-family:'DM Serif Display',serif;font-size:1.05rem;color:var(--offwhite);margin:1.5rem 0 .5rem;}
.legal-body p{margin-bottom:.85rem;}
.legal-todo{border:1px solid rgba(201,168,76,.3);background:rgba(201,168,76,.05);padding:.85rem 1rem;margin-bottom:1.25rem;font-size:.72rem;color:var(--gold);}
</style>
<div class="legal-hero">
  <p class="eyebrow">&#x2756; ATMNOPIN&#x2122; Legal</p>
  <h1 class="legal-h1">DMCA Policy</h1>
  <p style="font-size:.68rem;color:#555;margin-top:.4rem;">Version 1.0 &nbsp;&middot;&nbsp; Last updated: July 2026</p>
</div>
<div class="legal-body">
  <div class="legal-todo">&#x26A0; TODO: This DMCA policy is placeholder text and must be reviewed and finalized by qualified legal counsel before production use.</div>
  <h2>Copyright Infringement Notice</h2>
  <p>ATMNOPIN™ (Sunfish Technologies LLC) respects intellectual property rights. If you believe content on this site infringes your copyright, you may submit a DMCA takedown notice.</p>
  <h2>To File a Notice, Include:</h2>
  <p>1. Your name and contact information.<br>
  2. A description of the copyrighted work you claim has been infringed.<br>
  3. The URL of the allegedly infringing content on our site.<br>
  4. A statement that you have a good faith belief the use is not authorized.<br>
  5. A statement, under penalty of perjury, that the information is accurate and you are the copyright owner or authorized to act on their behalf.<br>
  6. Your physical or electronic signature.</p>
  <h2>Send Notices To</h2>
  <p>Email: <a href="mailto:hello@atmwithnopin.com">hello@atmwithnopin.com</a><br>
  Subject line: DMCA Takedown Notice</p>
  <h2>Counter-Notice</h2>
  <p>If you believe your content was wrongly removed, you may submit a counter-notice with the same information and a statement under penalty of perjury that the content was removed by mistake.</p>
</div>
`);
}

function renderAdminRailPage(pendingPosts, flaggedPosts, reports, consentRecords) {
  function escP(s) { return escapeHtml(String(s||'')); }
  function fmtDate(s) { return s ? new Date(s).toLocaleDateString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—'; }

  const pendingHtml = pendingPosts.length
    ? pendingPosts.map((p) => {
        const typeConf = RAIL_POST_TYPES[p.postType] || { label: p.postType||'Post', color: '#888' };
        return `<div style="border:1px solid #1e1e1e;background:#0c0c0c;padding:1rem;margin-bottom:.75rem;">
          <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:.5rem;margin-bottom:.5rem;">
            <span style="font-size:.56rem;letter-spacing:.1em;text-transform:uppercase;color:${escP(typeConf.color)};border:1px solid ${escP(typeConf.color)}40;padding:.1rem .4rem;">${escP(typeConf.label)}</span>
            <span style="font-size:.56rem;color:#555;">${escP(fmtDate(p.createdAt))} &middot; ${escP(p.authorName||'Anon')} &middot; ${escP(p.pokerRoom||'')}</span>
          </div>
          ${p.title ? `<p style="font-family:'DM Serif Display',serif;font-size:.92rem;color:var(--offwhite);margin-bottom:.35rem;">${escP(p.title)}</p>` : ''}
          <p style="font-size:.75rem;color:#888;line-height:1.65;margin-bottom:.65rem;">${escP((p.content||'').slice(0,400))}${(p.content||'').length>400?'…':''}</p>
          ${p.aiFlagged ? `<p style="font-size:.62rem;color:#e06060;margin-bottom:.5rem;">&#x26A0; AI Flagged: ${escP(p.aiFlagReason)}</p>` : ''}
          <div style="display:flex;gap:.5rem;flex-wrap:wrap;">
            <button onclick="railAdmin('approve','${escP(p.id)}')" style="background:rgba(0,200,83,.1);border:1px solid rgba(0,200,83,.35);color:var(--green);padding:.3rem .75rem;font:.64rem 'DM Mono',monospace;text-transform:uppercase;letter-spacing:.08em;cursor:pointer;">&#x2713; Approve</button>
            <button onclick="railAdmin('reject','${escP(p.id)}')" style="background:rgba(200,80,80,.08);border:1px solid rgba(200,80,80,.3);color:#e06060;padding:.3rem .75rem;font:.64rem 'DM Mono',monospace;text-transform:uppercase;letter-spacing:.08em;cursor:pointer;">&#x2717; Reject</button>
            <button onclick="railAdmin('remove','${escP(p.id)}')" style="background:#111;border:1px solid #2a2a2a;color:#666;padding:.3rem .75rem;font:.64rem 'DM Mono',monospace;text-transform:uppercase;letter-spacing:.08em;cursor:pointer;">Remove</button>
          </div>
        </div>`;
      }).join('')
    : '<div class="notice">No pending posts. The Rail is clear.</div>';

  const reportsHtml = reports.length
    ? reports.map((r) => `<div style="border:1px solid #1a1a1a;background:#0a0a0a;padding:.75rem;margin-bottom:.5rem;font-size:.7rem;color:#888;">
        <span style="color:var(--gold);font-size:.6rem;text-transform:uppercase;">${escP(RAIL_REPORT_TYPES[r.reportType]||r.reportType)}</span>
        &nbsp;&middot;&nbsp; Post: <code style="color:var(--offwhite);font-size:.65rem;">${escP(r.postId)}</code>
        &nbsp;&middot;&nbsp; ${escP(fmtDate(r.createdAt))}
        ${r.description ? `<p style="margin-top:.3rem;color:#777;">${escP(r.description)}</p>` : ''}
      </div>`).join('')
    : '<div class="notice">No pending reports.</div>';

  const consentHtml = consentRecords.length
    ? `<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:.65rem;">
        <thead><tr style="color:var(--green);font-size:.54rem;text-transform:uppercase;letter-spacing:.12em;border-bottom:1px solid #1a1a1a;">
          <th style="padding:.35rem .5rem;text-align:left;">Time</th>
          <th style="padding:.35rem .5rem;text-align:left;">Email</th>
          <th style="padding:.35rem .5rem;text-align:left;">Type</th>
          <th style="padding:.35rem .5rem;text-align:left;">IP</th>
          <th style="padding:.35rem .5rem;text-align:left;">Location</th>
          <th style="padding:.35rem .5rem;text-align:left;">Feature</th>
        </tr></thead>
        <tbody>${consentRecords.slice(0,50).map((c) => `<tr style="border-bottom:1px solid #0f0f0f;">
          <td style="padding:.3rem .5rem;color:#666;white-space:nowrap;">${escP(fmtDate(c.accepted_at||c.acceptedAt))}</td>
          <td style="padding:.3rem .5rem;color:var(--offwhite);">${escP(c.email_address||c.emailAddress||'')}</td>
          <td style="padding:.3rem .5rem;color:var(--green);">${escP(c.consent_type||c.consentType||'')}</td>
          <td style="padding:.3rem .5rem;color:#555;font-size:.58rem;white-space:nowrap;">${escP((c.ip_address||c.ipAddress||'').slice(0,20))}</td>
          <td style="padding:.3rem .5rem;color:#a0988a;font-size:.65rem;">${escP(c.location||'—')}</td>
          <td style="padding:.3rem .5rem;color:#777;">${escP(c.source_feature||c.sourceFeature||'')}</td>
        </tr>`).join('')}</tbody>
      </table></div>`
    : '<div class="notice">No consent records yet.</div>';

  return renderLayout('Rail Admin | ATMNOPIN™', `
<style>
.radm-tabs{display:flex;gap:.5rem;margin:1.5rem 0 1rem;border-bottom:1px solid #1e1e1e;padding-bottom:.75rem;}
.radm-tab{border:1px solid #242424;background:#111;color:#888;border-radius:8px;padding:.4rem .9rem;font:.7rem 'DM Mono',monospace;text-transform:uppercase;letter-spacing:.1em;cursor:pointer;transition:all .2s;}
.radm-tab.active,.radm-tab:hover{background:rgba(0,200,83,.1);border-color:rgba(0,200,83,.35);color:var(--green);}
</style>
<section class="hero" style="padding:1.5rem 0 1rem;border-bottom:1px solid #1e1e1e;">
  <p class="eyebrow">Admin &rarr; The Rail</p>
  <h1 style="font-size:clamp(2rem,5vw,3.5rem);">Rail Moderation</h1>
  <p style="font-size:.78rem;color:#888;margin-top:.35rem;"><a href="/admin" style="color:var(--green);">&larr; Back to Admin Dashboard</a></p>
</section>
<div class="radm-tabs">
  <button class="radm-tab active" onclick="radmShow('pending',this)">Pending (${pendingPosts.length})</button>
  <button class="radm-tab" onclick="radmShow('reports',this)">Reports (${reports.length})</button>
  <button class="radm-tab" onclick="radmShow('consent',this)">Consent Log (${consentRecords.length})</button>
</div>
<div id="radm-pending">${pendingHtml}</div>
<div id="radm-reports" style="display:none;">${reportsHtml}</div>
<div id="radm-consent" style="display:none;">${consentHtml}</div>
<div class="notice" id="radm-msg" style="display:none;margin-top:.75rem;"></div>
<script>
function radmShow(panel, btn) {
  ['pending','reports','consent'].forEach(function(p){
    document.getElementById('radm-'+p).style.display = p===panel?'':'none';
  });
  document.querySelectorAll('.radm-tab').forEach(function(b){ b.classList.remove('active'); });
  btn.classList.add('active');
}
async function railAdmin(action, postId) {
  var msg = document.getElementById('radm-msg');
  msg.style.display='none';
  try {
    var r = await fetch('/api/admin/rail/' + postId + '/' + action, { method:'POST', headers:{'Content-Type':'application/json'} });
    var d = await r.json();
    if (d.ok) {
      msg.textContent = 'Post ' + action + 'd successfully.';
      msg.style.display = 'block';
      msg.style.borderColor = 'rgba(0,200,83,.3)';
      // Remove the card from the DOM
      var cards = document.querySelectorAll('#radm-pending > div');
      cards.forEach(function(c){ if(c.innerHTML.includes(postId)) c.remove(); });
    } else {
      msg.textContent = 'Error: ' + (d.error||'Unknown');
      msg.style.display = 'block';
    }
  } catch(e) {
    msg.textContent = 'Network error.';
    msg.style.display = 'block';
  }
}
</script>
`);
}

function renderChronicleCard(c) {
  const dateStr = new Date(c.published_at || c.created_at).toLocaleDateString();
  const rt = estimateReadingTime(c.content);
  const iconMap = { player: '♠', dealer: '♦', floor: '♣', community: '♥' };
  const typeIcon = iconMap[c.icon_type] || iconMap[c.person_type] || '📖';
  const catClassMap = {
    'Player Spotlight': 'chron-cat-player',
    'Dealer Spotlight': 'chron-cat-dealer',
    'Floor Spotlight': 'chron-cat-floor',
    'Community Story': 'chron-cat-community',
    'Tournament Reports': 'chron-cat-tournament',
    'Poker Humor': 'chron-cat-humor',
    'Cash Games': 'chron-cat-cash',
    'Bad Beats': 'chron-cat-badbeats',
    'Vegas Adventures': 'chron-cat-vegas',
    'Behind the Scenes': 'chron-cat-bts',
  };
  const catClass = catClassMap[c.category] || '';
  const searchStr = [c.title, c.crew_nickname, c.poker_room, c.category, c.specialty, c.tell, (c.tags || []).join(' '), c.excerpt, String(c.content || '').slice(0, 600)]
    .filter(Boolean).join(' ').toLowerCase();
  const ctaHref = c.cta_href || `/chronicles/${escapeHtml(c.slug)}`;
  const ctaLabel = c.cta_label || 'Read Story →';
  return `<article class="chron-card" data-category="${escapeHtml(c.category || '')}" data-search="${escapeHtml(searchStr)}">
    ${c.featured_image_url
      ? `<div class="chron-img"><img src="${escapeHtml(c.featured_image_url)}" alt="${escapeHtml(c.featured_image_alt || c.title)}" loading="lazy" /></div>`
      : `<div class="chron-img chron-img-ph">${typeIcon}</div>`}
    <div class="chron-body">
      <div class="chron-meta"><span class="chron-cat ${catClass}">${escapeHtml(c.category || 'General')}</span><span class="meta">${escapeHtml(dateStr)} · ${rt} min read</span></div>
      ${c.poker_room ? `<div class="chron-room">📍 ${escapeHtml(c.poker_room)}</div>` : ''}
      <h3 class="chron-title"><a href="/chronicles/${escapeHtml(c.slug)}">${escapeHtml(c.title)}</a></h3>
      <p class="chron-excerpt">${escapeHtml(c.excerpt || '')}</p>
      <div class="chron-tags">${(c.tags || []).slice(0, 4).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
      <a href="${ctaHref}" class="chron-cta">${escapeHtml(ctaLabel)}</a>
    </div>
  </article>`;
}

function renderChroniclesListPage(chronicles) {
  const published = chronicles
    .filter((c) => c.status === 'published')
    .sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (b.pinned && !a.pinned) return 1;
      if (a.featured_on_home && !b.featured_on_home) return -1;
      if (b.featured_on_home && !a.featured_on_home) return 1;
      return new Date(b.published_at || b.created_at) - new Date(a.published_at || a.created_at);
    });

  const filterGroups = [
    { label: 'All', value: '', type: 'all' },
    { label: 'Foxwoods', value: 'foxwoods', type: 'location' },
    { label: 'Horseshoe', value: 'horseshoe', type: 'location' },
    { label: 'WSOP', value: 'wsop', type: 'location' },
    { label: 'Player Spotlight', value: 'Player Spotlight', type: 'cat' },
    { label: 'Dealer Spotlight', value: 'Dealer Spotlight', type: 'cat' },
    { label: 'Floor Spotlight', value: 'Floor Spotlight', type: 'cat' },
    { label: 'Community Stories', value: 'community story', type: 'tag' },
    { label: 'Fellow Fish', value: 'fellow fish', type: 'tag' },
    { label: 'Bad Beats', value: 'Bad Beats', type: 'cat' },
    { label: 'Poker Humor', value: 'Poker Humor', type: 'cat' },
    { label: 'Tournament Reports', value: 'Tournament Reports', type: 'cat' },
    { label: 'Cash Games', value: 'Cash Games', type: 'cat' },
    { label: 'Vegas Adventures', value: 'Vegas Adventures', type: 'cat' },
    { label: 'Behind the Scenes', value: 'Behind the Scenes', type: 'cat' },
  ];
  const filterBtns = filterGroups.map((f, i) =>
    `<button class="chron-filter-btn${i === 0 ? ' active' : ''}" data-fval="${escapeHtml(f.value)}" data-ftype="${f.type}">${escapeHtml(f.label)}</button>`
  ).join('');
  const cards = published.map(renderChronicleCard).join('');
  return renderLayout('Chronicles | ATMNOPIN™', `
    <style>
      .chron-controls{display:flex;flex-direction:column;gap:.75rem;margin:1.5rem 0 1rem;}
      .chron-search{width:100%;max-width:520px;border:1px solid #242424;background:#121212;color:var(--offwhite);padding:.75rem 1rem;border-radius:10px;font:inherit;font-size:.85rem;}
      .chron-search::placeholder{color:#666;}
      .chron-filter-wrap{display:flex;flex-wrap:wrap;gap:.4rem;}
      .chron-filter-btn{border:1px solid #2a2a2a;background:#111;color:#999;border-radius:999px;padding:.3rem .7rem;font:.68rem 'DM Mono',monospace;text-transform:uppercase;letter-spacing:.1em;cursor:pointer;transition:all .2s;}
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
      .chron-cat{border-radius:999px;padding:.2rem .55rem;font-size:.6rem;text-transform:uppercase;letter-spacing:.12em;background:rgba(0,200,83,.1);color:var(--green);border:1px solid rgba(0,200,83,.2);}
      .chron-cat-player{background:rgba(0,200,83,.12);color:#00e87a;border-color:rgba(0,200,83,.3);}
      .chron-cat-dealer{background:rgba(201,168,76,.1);color:var(--gold);border:1px solid rgba(201,168,76,.25);}
      .chron-cat-floor{background:rgba(100,160,255,.1);color:#88aaff;border:1px solid rgba(100,160,255,.25);}
      .chron-cat-community{background:rgba(255,120,120,.08);color:#ff8888;border:1px solid rgba(255,120,120,.2);}
      .chron-cat-tournament{background:rgba(255,180,50,.1);color:#ffb84d;border:1px solid rgba(255,180,50,.25);}
      .chron-cat-humor{background:rgba(200,100,255,.08);color:#cc88ff;border:1px solid rgba(200,100,255,.2);}
      .chron-cat-cash{background:rgba(50,200,150,.08);color:#44ddaa;border:1px solid rgba(50,200,150,.2);}
      .chron-cat-badbeats{background:rgba(255,80,80,.08);color:#ff6666;border:1px solid rgba(255,80,80,.2);}
      .chron-cat-vegas{background:rgba(255,210,0,.08);color:#ffd700;border:1px solid rgba(255,210,0,.2);}
      .chron-cat-bts{background:rgba(120,180,255,.08);color:#90b8ff;border:1px solid rgba(120,180,255,.2);}
      .chron-room{font-size:.68rem;color:var(--gray);letter-spacing:.05em;}
      .chron-title{font-family:'DM Serif Display',serif;font-size:1rem;line-height:1.3;margin:.15rem 0 0;}
      .chron-title a{color:var(--offwhite);text-decoration:none;}
      .chron-title a:hover{color:var(--green);}
      .chron-excerpt{color:#b0a898;font-size:.8rem;line-height:1.6;flex:1;}
      .chron-tags{display:flex;flex-wrap:wrap;gap:.3rem;margin-top:.2rem;}
      .chron-cta{display:inline-block;color:var(--green);font-size:.7rem;text-transform:uppercase;letter-spacing:.12em;text-decoration:none;margin-top:.4rem;}
      .chron-cta:hover{color:#00ff6a;}
      .chron-load-wrap{text-align:center;margin:2rem 0;}
      .chron-load-btn{border:1px solid #242424;background:#111;color:var(--offwhite);border-radius:10px;padding:.75rem 2rem;font:.78rem 'DM Mono',monospace;text-transform:uppercase;letter-spacing:.12em;cursor:pointer;}
      .chron-load-btn:hover{border-color:var(--green);color:var(--green);}
      .chron-no-results{grid-column:1/-1;text-align:center;padding:3rem;color:#777;font-size:.85rem;}
    </style>
    <section class="hero">
      <p class="eyebrow">Foxwoods · Horseshoe · WSOP · The Table</p>
      <h1>Chronicles</h1>
      <p class="body-text" style="max-width:60ch;">Stories from the ATMNOPIN poker universe — tournament runs, cash game chaos, player spotlights, dealer legends, floor staff heroes, bad beats, Vegas adventures, and the people who make poker worth playing.</p>
    </section>
    <div class="chron-controls">
      <input type="search" id="chronSearch" class="chron-search" placeholder="Search by name, nickname, poker room, specialty…" />
      <div class="chron-filter-wrap">${filterBtns}</div>
    </div>
    <div class="chron-grid" id="chronGrid">
      ${cards || '<div class="chron-no-results"><p style="font-size:1rem;color:var(--offwhite);margin-bottom:.4rem;">No stories yet.</p><p class="small" style="color:#777;margin-bottom:1rem;">The ATM is loading. Check back soon or submit your own story.</p><a href="/ai-profile-generator" class="pill">Get Featured →</a></div>'}
    </div>
    <div class="chron-load-wrap" id="chronLoadWrap" style="display:none;">
      <button type="button" class="chron-load-btn" id="chronLoadBtn">Load More Stories</button>
    </div>
    <script>
    (function() {
      var PAGE = 12;
      var all = Array.from(document.querySelectorAll('.chron-card'));
      var fval = '', ftype = 'all', q = '', shown = PAGE;
      function match(card) {
        var s = (card.dataset.search || '').toLowerCase();
        var cat = (card.dataset.category || '').toLowerCase();
        var passQ = !q || s.includes(q);
        var passF = ftype === 'all' || !fval ||
          (ftype === 'cat' && cat === fval.toLowerCase()) ||
          (ftype === 'location' && s.includes(fval.toLowerCase())) ||
          (ftype === 'tag' && s.includes(fval.toLowerCase()));
        return passQ && passF;
      }
      function paint() {
        var vis = all.filter(match);
        all.forEach(function(c) { c.style.display = 'none'; });
        vis.slice(0, shown).forEach(function(c) { c.style.display = ''; });
        var nr = document.getElementById('chronNoRes');
        if (!vis.length) {
          if (!nr) { nr = document.createElement('div'); nr.id='chronNoRes'; nr.className='chron-no-results'; nr.innerHTML='<p style="font-size:1rem;color:var(--offwhite);margin-bottom:.4rem;">No stories in this pile yet.</p><p class="small" style="color:#777;margin-bottom:1rem;">The ATM is loading. Check back soon or submit a story.</p><a href="/ai-profile-generator" class="pill">Get Featured →</a>'; document.getElementById('chronGrid').appendChild(nr); }
        } else if (nr) nr.remove();
        document.getElementById('chronLoadWrap').style.display = vis.length > shown ? '' : 'none';
      }
      document.querySelectorAll('.chron-filter-btn').forEach(function(b) {
        b.addEventListener('click', function() {
          document.querySelectorAll('.chron-filter-btn').forEach(function(x) { x.classList.remove('active'); });
          b.classList.add('active');
          fval = b.dataset.fval || '';
          ftype = b.dataset.ftype || 'all';
          shown = PAGE;
          paint();
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
  const hasStats = chronicle.specialty || chronicle.tell || chronicle.threat_level || chronicle.lucky_charm || chronicle.known_for || chronicle.table_reputation;
  const crewBox = (chronicle.crew_nickname || chronicle.crew_role || chronicle.crew_quote || hasStats) ? `
    <div class="crew-profile-box">
      ${chronicle.crew_nickname ? `<div class="crew-nick">"${escapeHtml(chronicle.crew_nickname)}"</div>` : ''}
      ${chronicle.crew_role ? `<div class="crew-role-label">Role: ${escapeHtml(chronicle.crew_role)}</div>` : ''}
      ${chronicle.poker_room ? `<div class="crew-role-label" style="margin-top:.2rem;">📍 ${escapeHtml(chronicle.poker_room)}</div>` : ''}
      ${hasStats ? `<div class="crew-stats-table" style="margin-top:.75rem;display:grid;gap:.35rem;">
        ${chronicle.specialty ? `<div class="crew-stat-row"><span class="crew-stat-lbl">Specialty</span><span class="crew-stat-val">${escapeHtml(chronicle.specialty)}</span></div>` : ''}
        ${chronicle.tell ? `<div class="crew-stat-row"><span class="crew-stat-lbl">Tell</span><span class="crew-stat-val">${escapeHtml(chronicle.tell)}</span></div>` : ''}
        ${chronicle.threat_level ? `<div class="crew-stat-row"><span class="crew-stat-lbl">Threat Level</span><span class="crew-stat-val">${escapeHtml(chronicle.threat_level)}</span></div>` : ''}
        ${chronicle.lucky_charm ? `<div class="crew-stat-row"><span class="crew-stat-lbl">Lucky Charm</span><span class="crew-stat-val">${escapeHtml(chronicle.lucky_charm)}</span></div>` : ''}
        ${chronicle.known_for ? `<div class="crew-stat-row"><span class="crew-stat-lbl">Known For</span><span class="crew-stat-val">${escapeHtml(chronicle.known_for)}</span></div>` : ''}
        ${chronicle.table_reputation ? `<div class="crew-stat-row"><span class="crew-stat-lbl">Table Reputation</span><span class="crew-stat-val">${escapeHtml(chronicle.table_reputation)}</span></div>` : ''}
      </div>` : ''}
      ${chronicle.crew_quote ? `<blockquote class="crew-quote-box">"${escapeHtml(chronicle.crew_quote)}"</blockquote>` : ''}
    </div>` : '';
  const relatedHtml = related.map((c) =>
    `<article class="rel-card"><p class="meta">${escapeHtml(new Date(c.published_at || c.created_at).toLocaleDateString())}</p><h4><a href="/chronicles/${escapeHtml(c.slug)}">${escapeHtml(c.title)}</a></h4><p class="small" style="margin-top:.25rem;color:#888;">${escapeHtml((c.excerpt || '').slice(0, 100))}${(c.excerpt || '').length > 100 ? '…' : ''}</p></article>`
  ).join('');
  return renderLayout(`${chronicle.title} | ATMNOPIN™ Chronicles`, `
    <style>
      .chron-hero-img{width:100%;max-height:420px;object-fit:cover;border-radius:14px;border:1px solid #1e1e1e;display:block;margin-bottom:1.25rem;}
      .chron-hero-ph{height:260px;background:linear-gradient(135deg,#0d2e1a 0%,#0a1a0f 100%);border-radius:14px;border:1px solid #1e1e1e;display:flex;align-items:center;justify-content:center;font-size:4rem;margin-bottom:1.25rem;}
      .chron-pg-meta{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;margin-bottom:.75rem;}
      .chron-pg-cat{background:rgba(0,200,83,.1);color:var(--green);border:1px solid rgba(0,200,83,.2);border-radius:999px;padding:.25rem .6rem;font-size:.6rem;text-transform:uppercase;letter-spacing:.12em;}
      .crew-profile-box{background:#0c1a10;border:1px solid #1e3a28;border-radius:12px;padding:1rem 1.25rem;margin:1rem 0;}
      .crew-nick{font-family:'DM Serif Display',serif;font-style:italic;font-size:1.4rem;color:var(--gold);margin-bottom:.3rem;}
      .crew-role-label{font-size:.68rem;text-transform:uppercase;letter-spacing:.15em;color:var(--gray);}
      .crew-stat-row{display:flex;gap:.5rem;align-items:baseline;font-size:.78rem;}
      .crew-stat-lbl{color:var(--gray);font-size:.65rem;text-transform:uppercase;letter-spacing:.1em;min-width:90px;}
      .crew-stat-val{color:var(--offwhite);}
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
            <a class="share-btn" href="https://twitter.com/intent/tweet?text=${encodeURIComponent(chronicle.title + ' — ATMNOPIN™ Chronicles')}&url=${encodeURIComponent('https://atmwithnopin.com/chronicles/' + chronicle.slug)}" target="_blank" rel="noopener">𝕏 Share</a>
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

// ─── THE RAIL ENGINE ────────────────────────────────────────────────────────

const RAIL_POST_TYPES = {
  bad_beat:          { label: 'Bad Beat',          color: '#e06060' },
  big_win:           { label: 'Big Win',            color: '#c9a84c' },
  tournament_update: { label: 'Tournament Update',  color: '#6699ee' },
  cash_game:         { label: 'Cash Game Story',    color: '#00c853' },
  hand_history:      { label: 'Hand History',       color: '#b060ff' },
  humor:             { label: 'Poker Humor',        color: '#ff8c00' },
  shoutout:          { label: 'Community Shoutout', color: '#00bcd4' },
  question:          { label: 'Question',           color: '#999999' },
  table_quote:       { label: 'Table Quote',        color: '#90c090' },
  behind_scenes:     { label: 'Behind the Scenes',  color: '#c0a08a' },
};

const RAIL_REPORT_TYPES = {
  harassment:           'Harassment',
  spam:                 'Spam',
  private_info:         'Private Information',
  copyright:            'Copyright',
  cheating_accusation:  'Cheating Accusation',
  offensive:            'Offensive Content',
  other:                'Other',
};

const RAIL_CONSENT_VERSIONS = {
  age_verification:       '1.0',
  content_ownership:      '1.0',
  community_guidelines:   '1.0',
  moderation_policy:      '1.0',
  terms_of_service:       '1.0',
  privacy_policy:         '1.0',
};

const RAIL_FLAG_PATTERNS = [
  [/\b(harass(?:ment|ing|ed)?|stalk(?:ing|ed)?|doxx(?:ing|ed)?|doxing)\b/i, 'Potential harassment or doxxing'],
  [/\b(cheat(?:er|ing|ed)|stole chips|marked cards|collu[sd](?:ion|e)?)\b/i, 'Possible cheating accusation'],
  [/\bfuck\s+you\b|\bpiece\s+of\s+shit\b|\bgo\s+fuck\b|\beat\s+shit\b|\bmotherfuck/i, 'Directed profanity'],
  [/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/, 'Possible phone number in content'],
  [/https?:\/\/[^\s]{20,}/i, 'External link detected'],
];

function moderateRailContent(text) {
  const s = String(text || '');
  for (const [pat, reason] of RAIL_FLAG_PATTERNS) {
    if (pat.test(s)) return { flagged: true, reason };
  }
  return { flagged: false, reason: '' };
}

async function lookupIpLocation(ip) {
  const local = ['127.0.0.1','::1','::ffff:127.0.0.1'];
  if (!ip || local.includes(ip) || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) return '';
  try {
    const r = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=city,regionName,country`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return '';
    const d = await r.json();
    return [d.city, d.regionName, d.country].filter(Boolean).join(', ');
  } catch { return ''; }
}

async function logConsent(entries, { ipAddress = '', emailAddress = '', userAgent = '', pageUrl = '', sourceFeature = '' } = {}) {
  const now = new Date().toISOString();
  const location = await lookupIpLocation(ipAddress);
  for (const e of (Array.isArray(entries) ? entries : [entries])) {
    if (!e.accepted) continue;
    const id = crypto.randomUUID();
    const acceptedAt = e.acceptedAt || now;
    const email = e.emailAddress || emailAddress || '';
    const ip = e.ipAddress || ipAddress;
    if (pgPool) {
      await pgPool.query(
        `INSERT INTO consent_log (id,email_address,consent_type,consent_version,accepted,accepted_at,source_feature,ip_address,location,user_agent,page_url,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, email, e.consentType, e.consentVersion||'1.0', true, acceptedAt, e.sourceFeature||sourceFeature, ip, location, e.userAgent||userAgent, e.pageUrl||pageUrl, now]
      );
    } else if (sqliteDb) {
      sqliteDb.prepare(
        `INSERT INTO consent_log (id,email_address,consent_type,consent_version,accepted,accepted_at,source_feature,ip_address,location,user_agent,page_url,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(id, email, e.consentType, e.consentVersion||'1.0', 1, acceptedAt, e.sourceFeature||sourceFeature, ip, location, e.userAgent||userAgent, e.pageUrl||pageUrl, now);
    }
  }
}

async function createRailPost(data) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const post = { ...data, id, createdAt: now, updatedAt: now, likeCount: 0, status: 'pending', approvedAt: null, approvedBy: '' };
  delete post.authorIp;
  const json = JSON.stringify({ ...post, authorIp: data.authorIp || '' });
  if (pgPool) {
    await pgPool.query(`INSERT INTO rail_posts (id,status,like_count,created_at,data) VALUES ($1,'pending',0,$2,$3)`, [id, now, json]);
  } else if (sqliteDb) {
    sqliteDb.prepare(`INSERT INTO rail_posts (id,status,like_count,created_at,data) VALUES (?,'pending',0,?,?)`).run(id, now, json);
  }
  return post;
}

async function loadRailPosts({ status = 'approved', page = 1, limit = 20, type = '' } = {}) {
  const offset = (page - 1) * limit;
  if (pgPool) {
    const typeClause = type ? ` AND data->>'postType'=$4` : '';
    const countClause = type ? ` AND data->>'postType'=$2` : '';
    const baseArgs = [status, limit, offset];
    const countArgs = [status];
    if (type) { baseArgs.push(type); countArgs.push(type); }
    const [{ rows }, { rows: cnt }] = await Promise.all([
      pgPool.query(`SELECT id,like_count,data FROM rail_posts WHERE status=$1${typeClause} ORDER BY created_at DESC LIMIT $2 OFFSET $3`, baseArgs),
      pgPool.query(`SELECT COUNT(*) AS n FROM rail_posts WHERE status=$1${countClause}`, countArgs),
    ]);
    const posts = rows.map((r) => { const d = (typeof r.data === 'string' ? JSON.parse(r.data) : r.data); d.likeCount = r.like_count; return d; });
    return { posts, total: parseInt(cnt[0]?.n || 0) };
  }
  if (sqliteDb) {
    const typeClause = type ? ` AND json_extract(data,'$.postType')=?` : '';
    const baseArgs = type ? [status, type, limit, offset] : [status, limit, offset];
    const countArgs = type ? [status, type] : [status];
    const rows = sqliteDb.prepare(`SELECT id,like_count,data FROM rail_posts WHERE status=?${typeClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...baseArgs);
    const { n } = sqliteDb.prepare(`SELECT COUNT(*) AS n FROM rail_posts WHERE status=?${typeClause}`).get(...countArgs) || { n: 0 };
    const posts = rows.map((r) => { const d = JSON.parse(r.data); d.likeCount = r.like_count; return d; });
    return { posts, total: n };
  }
  return { posts: [], total: 0 };
}

async function loadRailPost(id) {
  if (pgPool) {
    const { rows } = await pgPool.query(`SELECT id,like_count,data FROM rail_posts WHERE id=$1`, [id]);
    if (!rows[0]) return null;
    const d = (typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data);
    d.likeCount = rows[0].like_count;
    return d;
  }
  if (sqliteDb) {
    const row = sqliteDb.prepare(`SELECT id,like_count,data FROM rail_posts WHERE id=?`).get(id);
    if (!row) return null;
    const d = JSON.parse(row.data);
    d.likeCount = row.like_count;
    return d;
  }
  return null;
}

async function updateRailPostStatus(id, status, approvedBy) {
  const now = new Date().toISOString();
  if (pgPool) {
    const { rows } = await pgPool.query(`SELECT data FROM rail_posts WHERE id=$1`, [id]);
    if (!rows[0]) return null;
    const d = (typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data);
    d.status = status; d.updatedAt = now;
    if (status === 'approved') { d.approvedAt = now; d.approvedBy = approvedBy || ''; }
    await pgPool.query(`UPDATE rail_posts SET status=$1,data=$2 WHERE id=$3`, [status, JSON.stringify(d), id]);
    return d;
  }
  if (sqliteDb) {
    const row = sqliteDb.prepare(`SELECT data FROM rail_posts WHERE id=?`).get(id);
    if (!row) return null;
    const d = JSON.parse(row.data);
    d.status = status; d.updatedAt = now;
    if (status === 'approved') { d.approvedAt = now; d.approvedBy = approvedBy || ''; }
    sqliteDb.prepare(`UPDATE rail_posts SET status=?,data=? WHERE id=?`).run(status, JSON.stringify(d), id);
    return d;
  }
  return null;
}

async function likeRailPost(postId, likerIp) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  if (pgPool) {
    try {
      await pgPool.query(`INSERT INTO rail_likes (id,post_id,liker_ip,created_at) VALUES ($1,$2,$3,$4)`, [id, postId, likerIp, now]);
      const { rows } = await pgPool.query(`UPDATE rail_posts SET like_count=like_count+1 WHERE id=$1 RETURNING like_count`, [postId]);
      return { liked: true, likeCount: rows[0]?.like_count || 0 };
    } catch (e) {
      if (e.code === '23505') {
        const { rows } = await pgPool.query(`SELECT like_count FROM rail_posts WHERE id=$1`, [postId]);
        return { liked: false, alreadyLiked: true, likeCount: rows[0]?.like_count || 0 };
      }
      throw e;
    }
  }
  if (sqliteDb) {
    try {
      sqliteDb.prepare(`INSERT INTO rail_likes (id,post_id,liker_ip,created_at) VALUES (?,?,?,?)`).run(id, postId, likerIp, now);
      sqliteDb.prepare(`UPDATE rail_posts SET like_count=like_count+1 WHERE id=?`).run(postId);
      const row = sqliteDb.prepare(`SELECT like_count FROM rail_posts WHERE id=?`).get(postId);
      return { liked: true, likeCount: row?.like_count || 0 };
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        const row = sqliteDb.prepare(`SELECT like_count FROM rail_posts WHERE id=?`).get(postId);
        return { liked: false, alreadyLiked: true, likeCount: row?.like_count || 0 };
      }
      throw e;
    }
  }
  return { liked: false, likeCount: 0 };
}

async function reportRailPost(postId, reportType, description, reporterIp) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const data = JSON.stringify({ id, postId, reportType, description: String(description||'').slice(0,500), reporterIp, status: 'pending', createdAt: now });
  if (pgPool) {
    await pgPool.query(`INSERT INTO rail_reports (id,post_id,status,created_at,data) VALUES ($1,$2,'pending',$3,$4)`, [id, postId, now, data]);
  } else if (sqliteDb) {
    sqliteDb.prepare(`INSERT INTO rail_reports (id,post_id,status,created_at,data) VALUES (?,'pending',?,'pending',?)`).run(id, now, data);
  }
}

async function loadConsentLog({ limit = 100, offset = 0 } = {}) {
  if (pgPool) {
    const { rows } = await pgPool.query(`SELECT * FROM consent_log ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]);
    const { rows: cnt } = await pgPool.query(`SELECT COUNT(*) AS n FROM consent_log`);
    return { records: rows, total: parseInt(cnt[0]?.n || 0) };
  }
  if (sqliteDb) {
    const records = sqliteDb.prepare(`SELECT * FROM consent_log ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(limit, offset);
    const { n } = sqliteDb.prepare(`SELECT COUNT(*) AS n FROM consent_log`).get() || { n: 0 };
    return { records, total: n };
  }
  return { records: [], total: 0 };
}

async function loadRailReports() {
  if (pgPool) {
    const { rows } = await pgPool.query(`SELECT data FROM rail_reports WHERE status='pending' ORDER BY created_at DESC LIMIT 50`);
    return rows.map((r) => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data));
  }
  if (sqliteDb) {
    const rows = sqliteDb.prepare(`SELECT data FROM rail_reports WHERE status='pending' ORDER BY created_at DESC LIMIT 50`).all();
    return rows.map((r) => JSON.parse(r.data));
  }
  return [];
}

// ─── PLAYER CARD ENGINE ──────────────────────────────────────────────────────

const PC_FLAVOR_QUOTES = {
  'The Railbird':                             "Still cheering from the rail. Even when the cards aren't.",
  'Poker Jesus':                              "Every tournament starts with a blessing. Results are in God's hands.",
  'River Card Specialist':                    "The river is not my fault. I'm just the messenger.",
  'The Man Who Keeps the Poker Room Running': "The room runs. Nobody needs to know why.",
  'The Machine':                              "Confidence doesn't need good cards. Just chips.",
  'The Tuna':                                 "I had them. I definitely had them. The river disagreed.",
  'Ducky Jay':                                "The duck sees all. The duck judges nothing.",
  'The Connector':                            "Every player seated. Every problem solved. Moving on.",
  'Still Standing':                           "The chaos never stops. Neither do I.",
  'Birthday Variance':                        "Same birthday as Dhezz. Results still under investigation.",
  'The Setup Artist':                         "I don't cause the drama. I just deal it.",
  'Master of Timing':                         "Watch the stack. The cards tell their own story.",
  'Queen of the Rotation':                    "Best seat in the house is behind the deck.",
  'The Sugar Stacker':                        "Zero sugar. Maximum variance.",
  'Lucky Horseshoe Luke':                     "The horseshoe has more table hours than most regulars.",
};

const PC_PLAYER_STATS = ['Bluff Power', 'Patience', 'Tilt Resistance', 'Run Good', 'Hero Call', 'Entertainment'];
const PC_DEALER_STATS = ['River Drama', 'Table Control', 'Dry Humor', 'Speed', 'Complaint Resistance'];
const PC_FLOOR_STATS  = ['Seat Finding', 'Problem Solving', 'Chaos Control', 'Patience', 'Coffee Level'];

function pcRand(id, field) {
  let h = 0;
  const s = String(id) + '\x00' + String(field);
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return ((Math.abs(h) % 55) + 35);
}

function pcCardNumber(id) {
  let h = 0;
  const s = 'pcn\x00' + String(id);
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return String(Math.abs(h) % 1000000).padStart(6, '0');
}

function pcRarity(c) {
  const hasExtra = c.lucky_charm || c.known_for || c.table_reputation;
  const hasCore  = c.specialty && c.tell && c.threat_level;
  if (c.featured_on_home && hasCore && (c.person_type === 'dealer' || c.person_type === 'player')) return 'Legendary';
  if (hasCore && hasExtra) return 'Epic';
  if (hasCore && (c.person_type === 'player' || c.person_type === 'dealer')) return 'Rare';
  if (hasCore) return 'Uncommon';
  return 'Common';
}

function pcAbilities(type, c) {
  const spec = (c.specialty || '').trim();
  const tell = (c.tell || '').trim();
  if (type === 'dealer') {
    return {
      special:  spec || 'Delivers cards with professional indifference.',
      passive:  tell || 'Immune to all table commentary.',
      weakness: c.threat_level || 'Players who question their shuffle.',
    };
  }
  if (type === 'floor') {
    return {
      special:  spec || 'Can locate an open seat before the question is finished.',
      passive:  tell || 'Unfazed by disputes, chip shortages, and all-in arguments.',
      weakness: c.threat_level || 'Three simultaneous all-in calls at different tables.',
    };
  }
  return {
    special:  spec || 'Plays premium hands and waits for the perfect spot.',
    passive:  tell || 'Always looks like they have it, whether they do or not.',
    weakness: c.threat_level || 'The river.',
  };
}

function pcFlavorQuote(c) {
  if (c.crew_quote && c.crew_quote.trim()) return c.crew_quote.trim();
  const nick = (c.crew_nickname || '').trim();
  if (PC_FLAVOR_QUOTES[nick]) return PC_FLAVOR_QUOTES[nick];
  const ex = (c.excerpt || '').split(/\.\s/)[0].trim();
  return ex.length > 20 && ex.length < 160 ? ex + '.' : 'The table has stories. This is one of them.';
}

const PC_SPOTLIGHT_CATS = new Set(['Player Spotlight', 'Dealer Spotlight', 'Floor Spotlight']);
const PC_TYPE_SUIT = { player: '♠', dealer: '♦', floor: '♣', community: '♥' };

function buildPlayerCards(chronicles) {
  const seen = new Set();
  const cards = [];

  for (const c of chronicles) {
    if (c.status !== 'published') continue;
    if (!c.crew_nickname || c.crew_nickname === 'TBD') continue;
    if (!PC_SPOTLIGHT_CATS.has(c.category)) continue;
    if (seen.has(c.slug)) continue;
    seen.add(c.slug);

    const type   = c.person_type || 'player';
    const rarity = c.card_rarity || pcRarity(c);
    const id     = c.id || c.slug;
    const fields = type === 'dealer' ? PC_DEALER_STATS : type === 'floor' ? PC_FLOOR_STATS : PC_PLAYER_STATS;
    const stats  = {};
    for (const f of fields) stats[f] = pcRand(id, f);

    const titleMain = (c.title || '').replace(/^[^:]+:\s*/, '').split(/\s*[—–\-]\s*/)[0].trim();

    cards.push({
      id,
      slug:           c.slug,
      cardNumber:     c.card_number || pcCardNumber(id),
      fullName:       titleMain,
      nickname:       c.crew_nickname,
      pokerRoom:      c.poker_room || 'Foxwoods',
      game:           (c.tags || []).find((t) => t.includes('$') || t.includes('NLH') || t.includes('PLO')) || '$2/$5 NLH',
      cardType:       type,
      cardTypeLabel:  type === 'dealer' ? 'Dealer' : type === 'floor' ? 'Floor Staff' : 'Player',
      rarity,
      suit:           PC_TYPE_SUIT[type] || '♠',
      edition:        (c.poker_room || '').toLowerCase().includes('horseshoe') ? 'Horseshoe Ed.' : 'Foxwoods Ed.',
      summary:        (c.excerpt || '').slice(0, 160),
      flavorQuote:    pcFlavorQuote(c),
      abilities:      pcAbilities(type, c),
      stats,
      profileUrl:     `/chronicles/${c.slug}`,
      tags:           c.tags || [],
      publishedAt:    c.published_at || c.created_at,
    });
  }

  const RARITY_ORDER = { 'Legendary': 0, 'Epic': 1, 'Rare': 2, 'Uncommon': 3, 'Common': 4 };
  return cards.sort((a, b) => {
    const ro = (RARITY_ORDER[a.rarity] ?? 5) - (RARITY_ORDER[b.rarity] ?? 5);
    if (ro !== 0) return ro;
    return new Date(b.publishedAt) - new Date(a.publishedAt);
  });
}

function renderPlayerCardsPage(cards) {
  const total = cards.length;

  function rcColor(r) {
    if (r === 'Legendary') return '#c9a84c';
    if (r === 'Epic')      return '#b060ff';
    if (r === 'Rare')      return '#6699ee';
    if (r === 'Uncommon')  return '#00c853';
    return '#555';
  }

  function raritySlug(r) { return r.toLowerCase(); }

  function renderOneCard(card) {
    const rc = rcColor(card.rarity);
    const rs = raritySlug(card.rarity);
    const statsHtml = Object.entries(card.stats).map(([lbl, val]) =>
      `<div class="pc-stat">
        <span class="pc-sl">${escapeHtml(lbl)}</span>
        <div class="pc-bw"><div class="pc-bv" style="width:${val}%"></div></div>
        <span class="pc-sv">${val}</span>
      </div>`
    ).join('');

    const searchStr = [
      card.fullName, card.nickname, card.cardNumber,
      card.pokerRoom, card.cardType, card.cardTypeLabel,
      ...(card.tags || []),
    ].join(' ').toLowerCase();

    return `<div class="pc-wrap" data-type="${escapeHtml(card.cardType)}" data-rarity="${escapeHtml(rs)}" data-search="${escapeHtml(searchStr)}">
  <div class="pc-card" onclick="pcToggle(this)" title="Click to flip">
    <div class="pc-inner">

      <div class="pc-front" style="--rc:${rc};border-color:${rc}30">
        <div class="pc-top">
          <span class="pc-series">ATMNOPIN&#x2122; S1</span>
          <span class="pc-rbadge" style="color:${rc};border-color:${rc}50">${escapeHtml(card.rarity)}</span>
        </div>
        <div class="pc-art">
          <div class="pc-suit" style="color:${rc};filter:drop-shadow(0 0 14px ${rc}80)">${escapeHtml(card.suit)}</div>
          <div class="pc-typelabel" style="color:${rc}">${escapeHtml(card.cardTypeLabel)}</div>
        </div>
        <div class="pc-fb">
          <div class="pc-fname">${escapeHtml(card.fullName)}</div>
          <div class="pc-fnick">&ldquo;${escapeHtml(card.nickname)}&rdquo;</div>
          <div class="pc-froom">&#x1F4CD; ${escapeHtml(card.pokerRoom)}</div>
          <div class="pc-fgame">${escapeHtml(card.game)}</div>
        </div>
        <div class="pc-ftop">
          <span class="pc-fedition">${escapeHtml(card.edition)}</span>
          <span class="pc-fnum" style="color:${rc}">#${escapeHtml(card.cardNumber)}</span>
        </div>
      </div>

      <div class="pc-back" style="--rc:${rc};border-color:${rc}30">
        <div class="pc-bk-hdr">
          <span class="pc-bk-brand" style="color:${rc}">ATMNOPIN&#x2122;</span>
          <span class="pc-fnum" style="color:${rc}">#${escapeHtml(card.cardNumber)}</span>
        </div>
        <div class="pc-bk-quote">&ldquo;${escapeHtml(card.flavorQuote)}&rdquo;</div>
        <div class="pc-bk-ab">
          ${card.abilities.special ? `<div class="pc-ab"><span class="pc-ab-ic">&#x26A1;</span><span class="pc-ab-tx"><strong>Special:</strong> ${escapeHtml(card.abilities.special)}</span></div>` : ''}
          ${card.abilities.passive ? `<div class="pc-ab"><span class="pc-ab-ic">&#x1F6E1;</span><span class="pc-ab-tx"><strong>Passive:</strong> ${escapeHtml(card.abilities.passive)}</span></div>` : ''}
          ${card.abilities.weakness ? `<div class="pc-ab pc-ab-weak"><span class="pc-ab-ic">&#x26A0;</span><span class="pc-ab-tx"><strong>Weakness:</strong> ${escapeHtml(card.abilities.weakness)}</span></div>` : ''}
        </div>
        <div class="pc-bk-stats">
          <div class="pc-stats-lbl" style="color:${rc}60">&#x2500; Stats</div>
          ${statsHtml}
        </div>
        <div class="pc-bk-ftr">
          <a href="${escapeHtml(card.profileUrl)}" class="pc-view-btn" style="color:${rc};border-color:${rc}40" onclick="event.stopPropagation()">View Chronicle &#x2192;</a>
        </div>
      </div>

    </div>
  </div>
</div>`;
  }

  const cardsHtml = cards.map(renderOneCard).join('\n');

  const typeFilters = [['', 'All'], ['player', 'Players'], ['dealer', 'Dealers'], ['floor', 'Floor Staff']].map(([v, l], i) =>
    `<button class="pc-fbtn${i === 0 ? ' pc-factive' : ''}" data-fk="type" data-fv="${escapeHtml(v)}">${escapeHtml(l)}</button>`
  ).join('');

  const rarityFilters = [['', 'All Rarities'], ['legendary', 'Legendary'], ['epic', 'Epic'], ['rare', 'Rare'], ['uncommon', 'Uncommon']].map(([v, l], i) =>
    `<button class="pc-fbtn${i === 0 ? ' pc-factive' : ''}" data-fk="rarity" data-fv="${escapeHtml(v)}">${escapeHtml(l)}</button>`
  ).join('');

  return renderLayout('Player Card Gallery | ATMNOPIN™', `
<style>
.pc-hero{padding:2.5rem 0 1.5rem;border-bottom:1px solid #1e1e1e;}
.pc-hero .eyebrow{font-size:.58rem;letter-spacing:.28em;text-transform:uppercase;color:var(--green);margin-bottom:.65rem;}
.pc-h1{font-family:'Bebas Neue',sans-serif;font-size:clamp(3rem,8vw,5rem);line-height:1;color:var(--offwhite);margin-bottom:.5rem;}
.pc-h1 em{color:var(--gold);}
.pc-lead{font-size:.82rem;color:#b0a898;max-width:52ch;line-height:1.85;}
.pc-meta{margin-top:.65rem;font-size:.62rem;color:#555;letter-spacing:.1em;text-transform:uppercase;}
.pc-meta span{color:var(--green);}
.pc-controls{display:flex;flex-direction:column;gap:.55rem;padding:1.1rem 0 .75rem;}
.pc-search{width:100%;max-width:460px;border:1px solid #242424;background:#111;color:var(--offwhite);padding:.65rem 1rem;font:inherit;font-size:.8rem;outline:none;transition:border-color .2s;}
.pc-search::placeholder{color:#444;}
.pc-search:focus{border-color:rgba(0,200,83,.4);}
.pc-frow{display:flex;flex-wrap:wrap;gap:.3rem;align-items:center;}
.pc-flbl{font-size:.54rem;letter-spacing:.18em;text-transform:uppercase;color:#444;margin-right:.15rem;}
.pc-fbtn{border:1px solid #222;background:#0d0d0d;color:#666;padding:.25rem .6rem;font:.6rem 'DM Mono',monospace;text-transform:uppercase;letter-spacing:.1em;cursor:pointer;transition:all .15s;}
.pc-fbtn:hover,.pc-factive{border-color:rgba(0,200,83,.35);background:rgba(0,200,83,.07);color:var(--green);}
.pc-count{font-size:.6rem;color:#555;letter-spacing:.08em;padding:.1rem 0;}
.pc-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:.9rem;padding:.5rem 0 3.5rem;}
@media(max-width:1100px){.pc-grid{grid-template-columns:repeat(4,1fr);}}
@media(max-width:800px){.pc-grid{grid-template-columns:repeat(3,1fr);}}
@media(max-width:520px){.pc-grid{grid-template-columns:repeat(2,1fr);}}
.pc-wrap{perspective:900px;transition:transform .18s;}
.pc-wrap:hover{transform:translateY(-4px);}
.pc-card{width:100%;aspect-ratio:5/7;cursor:pointer;position:relative;}
.pc-inner{width:100%;height:100%;position:relative;transform-style:preserve-3d;transition:transform .52s cubic-bezier(.4,0,.2,1);}
.pc-card.pc-flipped .pc-inner{transform:rotateY(180deg);}
.pc-front,.pc-back{position:absolute;inset:0;backface-visibility:hidden;-webkit-backface-visibility:hidden;display:flex;flex-direction:column;border:1px solid #222;overflow:hidden;background:#080808;}
.pc-back{transform:rotateY(180deg);}
.pc-top{display:flex;justify-content:space-between;align-items:center;padding:.3rem .45rem;background:#060606;border-bottom:1px solid #111;}
.pc-series{font-size:.38rem;letter-spacing:.12em;text-transform:uppercase;color:#444;}
.pc-rbadge{font-size:.42rem;letter-spacing:.1em;text-transform:uppercase;border:1px solid;padding:.08rem .28rem;}
.pc-art{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0d2e1a;position:relative;overflow:hidden;}
.pc-art::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse at 50% 40%,rgba(0,200,83,.07) 0%,transparent 70%);}
.pc-suit{font-size:clamp(2.4rem,7vw,3.6rem);line-height:1;position:relative;z-index:1;}
.pc-typelabel{font-size:.46rem;letter-spacing:.22em;text-transform:uppercase;margin-top:.35rem;position:relative;z-index:1;}
.pc-fb{padding:.45rem .5rem .3rem;display:flex;flex-direction:column;gap:.1rem;border-top:1px solid #111;}
.pc-fname{font-family:'Bebas Neue',sans-serif;font-size:clamp(.85rem,2.4vw,1.15rem);letter-spacing:.05em;line-height:1;color:var(--offwhite);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.pc-fnick{font-family:'DM Serif Display',serif;font-style:italic;font-size:.58rem;color:var(--gold);line-height:1.2;}
.pc-froom{font-size:.46rem;color:#777;letter-spacing:.03em;margin-top:.06rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.pc-fgame{font-size:.42rem;color:#555;letter-spacing:.06em;text-transform:uppercase;}
.pc-ftop{display:flex;justify-content:space-between;align-items:center;padding:.28rem .5rem;background:#060606;border-top:1px solid #111;margin-top:auto;}
.pc-fedition{font-size:.38rem;letter-spacing:.08em;text-transform:uppercase;color:#3a3a3a;}
.pc-fnum{font-size:.44rem;letter-spacing:.07em;font-family:'DM Mono',monospace;}
.pc-bk-hdr{display:flex;justify-content:space-between;align-items:center;padding:.38rem .5rem;background:#060606;border-bottom:1px solid #111;}
.pc-bk-brand{font-family:'Bebas Neue',sans-serif;font-size:.72rem;letter-spacing:.14em;}
.pc-bk-quote{font-family:'DM Serif Display',serif;font-style:italic;font-size:.56rem;color:var(--offwhite);line-height:1.5;padding:.4rem .5rem;border-bottom:1px solid #0e0e0e;}
.pc-bk-ab{display:flex;flex-direction:column;gap:.2rem;padding:.32rem .5rem;flex:1;min-height:0;overflow:hidden;}
.pc-ab{display:flex;gap:.22rem;align-items:flex-start;font-size:.42rem;line-height:1.4;color:#a0988a;}
.pc-ab strong{color:var(--offwhite);}
.pc-ab-ic{flex-shrink:0;width:11px;font-size:.5rem;}
.pc-ab-weak .pc-ab-tx{color:#c09090;}
.pc-bk-stats{padding:.28rem .5rem;border-top:1px solid #0f0f0f;}
.pc-stats-lbl{font-size:.38rem;letter-spacing:.18em;text-transform:uppercase;margin-bottom:.22rem;}
.pc-stat{display:flex;align-items:center;gap:.28rem;margin-bottom:.1rem;}
.pc-sl{font-size:.38rem;color:#666;width:58px;flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.pc-bw{flex:1;height:2px;background:#1a1a1a;overflow:hidden;}
.pc-bv{height:100%;background:var(--green);}
.pc-sv{font-size:.38rem;color:#555;width:18px;text-align:right;flex-shrink:0;}
.pc-bk-ftr{padding:.28rem .5rem;border-top:1px solid #111;margin-top:auto;}
.pc-view-btn{display:block;text-align:center;padding:.28rem;font-size:.44rem;letter-spacing:.1em;text-transform:uppercase;border:1px solid;background:transparent;transition:background .18s;font-family:'DM Mono',monospace;}
.pc-view-btn:hover{background:rgba(255,255,255,.04);}
.pc-empty{grid-column:1/-1;text-align:center;padding:3rem;color:#444;font-size:.76rem;border:1px dashed #1a1a1a;}
</style>

<div class="pc-hero">
  <p class="eyebrow">&#x2756; ATMNOPIN&#x2122; Collectibles</p>
  <h1 class="pc-h1">Player <em>Card</em> Gallery</h1>
  <p class="pc-lead">Every personality at the table — dealers, floor staff, and regulars — immortalized as a premium collectible trading card. Click any card to flip it and reveal their stats and abilities.</p>
  <p class="pc-meta">Series 1 &nbsp;&middot;&nbsp; <span>${total}</span> cards &nbsp;&middot;&nbsp; Foxwoods &amp; Horseshoe Editions</p>
</div>

<div class="pc-controls">
  <input class="pc-search" type="search" placeholder="Search name, nickname, card number…" oninput="pcFilter()" id="pcSearch" autocomplete="off" />
  <div class="pc-frow">
    <span class="pc-flbl">Type:</span>
    ${typeFilters}
  </div>
  <div class="pc-frow">
    <span class="pc-flbl">Rarity:</span>
    ${rarityFilters}
  </div>
  <p class="pc-count" id="pcCount">${total} cards shown</p>
</div>

<div class="pc-grid" id="pcGrid">
${cardsHtml}
</div>

<script>
var pcActiveType = '';
var pcActiveRarity = '';

function pcToggle(el) {
  el.classList.toggle('pc-flipped');
}

function pcFilter() {
  var q = (document.getElementById('pcSearch').value || '').toLowerCase().trim();
  var wraps = document.querySelectorAll('#pcGrid .pc-wrap');
  var visible = 0;
  wraps.forEach(function(w) {
    var mt = !pcActiveType   || w.dataset.type   === pcActiveType;
    var mr = !pcActiveRarity || w.dataset.rarity === pcActiveRarity;
    var ms = !q || (w.dataset.search || '').indexOf(q) !== -1;
    var show = mt && mr && ms;
    w.style.display = show ? '' : 'none';
    if (show) visible++;
  });
  var lbl = document.getElementById('pcCount');
  if (lbl) lbl.textContent = visible + ' card' + (visible !== 1 ? 's' : '') + ' shown';
}

(function() {
  document.querySelectorAll('.pc-fbtn[data-fk="type"]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.pc-fbtn[data-fk="type"]').forEach(function(b) { b.classList.remove('pc-factive'); });
      btn.classList.add('pc-factive');
      pcActiveType = btn.dataset.fv;
      pcFilter();
    });
  });
  document.querySelectorAll('.pc-fbtn[data-fk="rarity"]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.pc-fbtn[data-fk="rarity"]').forEach(function(b) { b.classList.remove('pc-factive'); });
      btn.classList.add('pc-factive');
      pcActiveRarity = btn.dataset.fv;
      pcFilter();
    });
  });
})();
</script>
`);
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
  const displayChar = p.suit || ((p.nickname || p.name || '?')[0] || '?').toUpperCase();
  const tagsAttr = Array.isArray(p.tags) ? p.tags.join(',') : (p.tags || '');
  const excerpt = p.bio || p.biggest_accomplishment || p.funny_story || '';
  const isCrew = p.player_type === 'crew';
  const isOpenSeat = p.slug === 'open-seat-tbd';
  const badges = getPlayerBadges(p);
  const primaryBadge = badges[0] || '';
  const aiP = p.ai_personality;
  const aiTagline = (aiP && aiP.status === 'approved' && aiP.tagline) ? aiP.tagline : '';
  return `<article class="player-card" data-badge="${escapeHtml(primaryBadge)}" data-badges="${escapeHtml(badges.join(','))}" data-tags="${escapeHtml(tagsAttr)}" data-featured="${p.featured_on_home ? 'true' : 'false'}" data-points="${p.points || 0}" data-monthly="${p.is_monthly_winner ? 'true' : 'false'}">
    ${p.photo_url
      ? `<div class="player-photo-wrap"><img src="${escapeHtml(p.photo_url)}" alt="${escapeHtml(p.nickname || p.name)}" loading="lazy" /></div>`
      : `<div class="player-photo-ph${isOpenSeat ? ' player-photo-ph-open' : ''}">${escapeHtml(displayChar)}</div>`}
    <div class="player-card-body">
      <div style="display:flex;flex-wrap:wrap;gap:.3rem;margin-bottom:.25rem;">${badges.slice(0, 2).map((b) => renderBadge(b)).join('')}</div>
      <h3 class="player-card-name">${escapeHtml(p.nickname || p.name)}</h3>
      ${p.nickname && p.name && p.name !== 'You?' ? `<p class="small">${escapeHtml(p.name)}</p>` : ''}
      ${p.city ? `<p class="small" style="margin-top:.15rem;">${escapeHtml(p.city)}</p>` : ''}
      ${aiTagline ? `<p class="player-card-excerpt" style="color:var(--gold);font-style:italic;">"${escapeHtml(aiTagline)}"</p>` : `<p class="player-card-excerpt">${escapeHtml(excerpt.slice(0, 110))}${excerpt.length > 110 ? '…' : ''}</p>`}
      ${isCrew && p.specialty ? `<div class="crew-stats-mini">
        <div class="csm-row"><span class="csm-label">Specialty</span><span class="csm-val">${escapeHtml(p.specialty)}</span></div>
        <div class="csm-row"><span class="csm-label">Threat</span><span class="csm-val">${escapeHtml(p.threat_level || '')}</span></div>
      </div>` : ''}
      ${p.points ? `<p style="font-size:.62rem;color:var(--gold);margin-top:.3rem;letter-spacing:.05em;">🏆 ${p.points} pts</p>` : ''}
      ${isOpenSeat
        ? `<a href="/ai-profile-generator" class="player-view-cta">Get Featured →</a>`
        : `<a href="/players/${escapeHtml(p.slug)}" class="player-view-cta">View Profile →</a>`}
    </div>
  </article>`;
}

function renderProfileSetupPage(profile) {
  const score = computeCompletionScore(profile);
  const pct = score;
  const hasPhoto = !!profile.photo_url;
  const aiUnlocked = pct >= 40;
  const cardUnlocked = profile.status === 'approved' && hasPhoto && pct >= 70;
  const token = profile.edit_token || '';
  const badges = getPlayerBadges(profile);
  const aiP = profile.ai_personality || null;
  const aiStatus = aiP ? aiP.status : null;
  const chronicles = Array.isArray(profile.ai_chronicles) ? profile.ai_chronicles : [];

  function unlockMsg() {
    if (pct < 40) return 'Complete your basics to unlock your public player page.';
    if (!hasPhoto) return 'Upload a photo to unlock your Poker Trading Card.';
    if (!profile.ai_personality) return 'Add your poker story to unlock your AI Poker Personality.';
    if (!profile.bad_beat_story) return 'Submit a bad beat story to become eligible for community badges.';
    return 'Profile looking strong. Pending admin review.';
  }

  return renderLayout('Poker Profile Setup | ATMNOPIN™', `
    <style>
      .ps-wrap{max-width:720px;margin:0 auto;}
      .ps-progress-wrap{margin:1.5rem 0;padding:1.25rem;background:#0c1a10;border:1px solid #1a3a22;border-radius:14px;}
      .ps-progress-label{display:flex;justify-content:space-between;align-items:center;margin-bottom:.6rem;}
      .ps-progress-title{font-size:.7rem;text-transform:uppercase;letter-spacing:.18em;color:var(--green);}
      .ps-progress-pct{font-family:'Bebas Neue',sans-serif;font-size:1.6rem;color:var(--green);line-height:1;}
      .ps-bar-track{height:8px;background:#1a2a1a;border-radius:999px;overflow:hidden;}
      .ps-bar-fill{height:100%;background:var(--green);border-radius:999px;transition:width .6s ease;}
      .ps-unlock-msg{margin-top:.6rem;font-size:.75rem;color:#b0a898;}
      .ps-section{border:1px solid #1e1e1e;border-radius:14px;overflow:hidden;margin-bottom:.75rem;}
      .ps-section-hdr{display:flex;justify-content:space-between;align-items:center;padding:.9rem 1rem;cursor:pointer;user-select:none;background:#101010;}
      .ps-section-hdr:hover{background:#141414;}
      .ps-section-title{font-size:.78rem;text-transform:uppercase;letter-spacing:.14em;color:var(--offwhite);}
      .ps-section-tag{font-size:.62rem;text-transform:uppercase;letter-spacing:.1em;padding:.15rem .5rem;border-radius:999px;border:1px solid #2a2a2a;color:#888;}
      .ps-section-tag.done{border-color:rgba(0,200,83,.35);color:var(--green);background:rgba(0,200,83,.07);}
      .ps-section-tag.locked{border-color:#333;color:#555;background:#0c0c0c;}
      .ps-section-body{display:none;padding:1rem;border-top:1px solid #1a1a1a;background:#0c0c0c;}
      .ps-section-body.open{display:block;}
      .ps-form label{display:grid;gap:.3rem;font-size:.72rem;color:var(--gray);text-transform:uppercase;letter-spacing:.12em;margin-bottom:.65rem;}
      .ps-form input,.ps-form textarea,.ps-form select{width:100%;border:1px solid #242424;background:#121212;color:var(--offwhite);padding:.75rem .85rem;border-radius:10px;font:inherit;}
      .ps-form textarea{min-height:90px;resize:vertical;}
      .ps-save-btn{background:rgba(0,200,83,.12);border:1px solid rgba(0,200,83,.35);color:var(--green);border-radius:8px;padding:.5rem 1.1rem;font:.72rem 'DM Mono',monospace;text-transform:uppercase;letter-spacing:.1em;cursor:pointer;transition:all .2s;}
      .ps-save-btn:hover{background:rgba(0,200,83,.2);}
      .ps-save-btn:disabled{opacity:.4;cursor:not-allowed;}
      .ps-saved-msg{font-size:.7rem;color:var(--green);margin-left:.6rem;opacity:0;transition:opacity .3s;}
      .ps-saved-msg.show{opacity:1;}
      .ps-locked-msg{text-align:center;padding:1.5rem;color:#555;font-size:.8rem;}
      .ps-locked-msg .lock-icon{font-size:1.5rem;display:block;margin-bottom:.4rem;}
      .ai-box{border:1px solid #1a3a22;background:#0a1a10;border-radius:12px;padding:1rem;margin-top:.5rem;}
      .ai-box-label{font-size:.6rem;text-transform:uppercase;letter-spacing:.18em;color:var(--green);margin-bottom:.4rem;}
      .ai-box-text{font-size:.82rem;color:var(--offwhite);line-height:1.65;white-space:pre-wrap;}
      .ai-disclaimer{font-size:.65rem;color:#555;margin-top:.5rem;font-style:italic;}
      .story-type-select{margin-bottom:.65rem;}
      .ai-rewrite-option{border:1px solid #1e1e1e;border-radius:10px;padding:.75rem 1rem;margin-bottom:.5rem;cursor:pointer;transition:all .2s;}
      .ai-rewrite-option:hover{border-color:rgba(0,200,83,.4);}
      .ai-rewrite-option.selected{border-color:var(--green);background:rgba(0,200,83,.06);}
      .ai-rewrite-label{font-size:.62rem;text-transform:uppercase;letter-spacing:.12em;color:var(--green);margin-bottom:.3rem;}
      .ai-rewrite-text{font-size:.78rem;color:#b0a898;line-height:1.6;}
      .ps-points-row{display:flex;align-items:center;gap:1rem;margin-bottom:.75rem;}
      .ps-pts{font-family:'Bebas Neue',sans-serif;font-size:2.5rem;color:var(--gold);line-height:1;}
      .ps-pts-label{font-size:.62rem;text-transform:uppercase;letter-spacing:.15em;color:#888;}
      .ps-badge-row{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.5rem;}
      .card-preview-link{display:inline-block;margin-top:.75rem;border:1px solid rgba(201,168,76,.4);background:rgba(201,168,76,.07);color:var(--gold);border-radius:8px;padding:.5rem 1rem;font-size:.72rem;text-transform:uppercase;letter-spacing:.1em;text-decoration:none;}
      .ps-submit-final-btn{width:100%;padding:.9rem;font-size:.78rem;background:var(--green);border:none;color:#000;border-radius:10px;cursor:pointer;font-weight:700;text-transform:uppercase;letter-spacing:.1em;font-family:'DM Mono',monospace;margin-top:.25rem;}
      .ps-submit-final-btn:hover{background:#00e060;}
      .ps-submit-final-btn:disabled{opacity:.5;cursor:not-allowed;}
    </style>
    <section class="hero">
      <p class="eyebrow">ATMNOPIN™ Community</p>
      <h1>Your Poker Profile</h1>
      <p class="body-text" style="max-width:55ch;">Complete each section to unlock your public player page, AI Poker Personality, and Poker Trading Card.</p>
    </section>
    <div class="ps-wrap" id="psRoot">
      <!-- Progress -->
      <div class="ps-progress-wrap">
        <div class="ps-progress-label">
          <span class="ps-progress-title">Poker Profile Completion</span>
          <span class="ps-progress-pct" id="psPct">${pct}%</span>
        </div>
        <div class="ps-bar-track"><div class="ps-bar-fill" id="psBar" style="width:${pct}%;"></div></div>
        <p class="ps-unlock-msg" id="psUnlock">${escapeHtml(unlockMsg())}</p>
      </div>
      <!-- Points & Badges -->
      ${(profile.points || badges.length) ? `<div class="ps-section">
        <div class="ps-section-hdr" onclick="this.nextElementSibling.classList.toggle('open')">
          <span class="ps-section-title">🏆 Points &amp; Badges</span>
          <span class="ps-section-tag done">${profile.points || 0} pts</span>
        </div>
        <div class="ps-section-body">
          <div class="ps-points-row">
            <div><div class="ps-pts">${profile.points || 0}</div><div class="ps-pts-label">Total Points</div></div>
          </div>
          ${badges.length ? `<div class="ps-badge-row">${badges.map((b) => `<span style="display:inline-block;background:${badgeStyle(b)};border:1px solid;border-radius:999px;padding:.2rem .6rem;font-size:.62rem;text-transform:uppercase;letter-spacing:.1em;">${escapeHtml(b)}</span>`).join('')}</div>` : '<p class="small" style="color:#555;">No badges yet. Badges are awarded by the ATMNOPIN crew.</p>'}
          ${cardUnlocked ? `<a class="card-preview-link" href="/players/${escapeHtml(profile.slug)}/card">🃏 View Your Poker Trading Card →</a>` : ''}
        </div>
      </div>` : ''}
      <!-- Section 1: Basic Info -->
      <div class="ps-section">
        <div class="ps-section-hdr" onclick="this.nextElementSibling.classList.toggle('open')">
          <span class="ps-section-title">1 — Basic Poker Info</span>
          <span class="ps-section-tag${(profile.city || profile.favorite_casino || profile.favorite_game) ? ' done' : ''}">
            ${(profile.city || profile.favorite_casino || profile.favorite_game) ? 'Done ✓' : 'Incomplete'}
          </span>
        </div>
        <div class="ps-section-body open">
          <form class="ps-form" id="sectionBasic">
            <label>City / Hometown<input name="city" value="${escapeHtml(profile.city || '')}" maxlength="100" placeholder="Las Vegas, NV" /></label>
            <label>Home Poker Room<input name="favorite_casino" value="${escapeHtml(profile.favorite_casino || '')}" maxlength="100" placeholder="Foxwoods, Horseshoe, home game..." /></label>
            <label>Favorite Game<input name="favorite_game" value="${escapeHtml(profile.favorite_game || '')}" maxlength="100" placeholder="$2/$5 NLH, PLO, Tournaments..." /></label>
            <label>Playing Style<input name="playing_style" value="${escapeHtml(profile.playing_style || '')}" maxlength="100" placeholder="Tight-aggressive, calling station, maniac..." /></label>
            <label>Biggest Strength<input name="biggest_strength" value="${escapeHtml(profile.biggest_strength || '')}" maxlength="200" placeholder="Reading players, patience, bluffing..." /></label>
            <label>Biggest Weakness<input name="biggest_weakness" value="${escapeHtml(profile.biggest_weakness || '')}" maxlength="200" placeholder="Tilt, calling too much, can't fold..." /></label>
            <label>Funniest Table Habit<input name="funniest_habit" value="${escapeHtml(profile.funniest_habit || '')}" maxlength="300" placeholder="Always says 'nice hand' when losing..." /></label>
            <label>Social Media Link<input name="social_link" type="url" value="${escapeHtml(profile.social_link || '')}" maxlength="300" placeholder="https://twitter.com/yourhandle" /></label>
            <div style="display:flex;align-items:center;margin-top:.4rem;">
              <button type="button" class="ps-save-btn" onclick="psAutoSave('sectionBasic',this)">Save</button>
              <span class="ps-saved-msg" id="sectionBasicMsg">Saved ✓</span>
            </div>
          </form>
        </div>
      </div>
      <!-- Section 2: Poker Stories -->
      <div class="ps-section">
        <div class="ps-section-hdr" onclick="this.nextElementSibling.classList.toggle('open')">
          <span class="ps-section-title">2 — Your Poker Stories</span>
          <span class="ps-section-tag${(profile.biggest_accomplishment || profile.funny_story || profile.bad_beat_story) ? ' done' : ''}">
            ${(profile.biggest_accomplishment || profile.funny_story || profile.bad_beat_story) ? 'Done ✓' : 'Incomplete'}
          </span>
        </div>
        <div class="ps-section-body open">
          <form class="ps-form" id="sectionStories">
            <label>Biggest Poker Accomplishment<textarea name="biggest_accomplishment" maxlength="800" placeholder="Final tabled the WSOP Main, ran good once...">${escapeHtml(profile.biggest_accomplishment || '')}</textarea></label>
            <label>Biggest Poker Goal<input name="biggest_goal" value="${escapeHtml(profile.biggest_goal || '')}" maxlength="400" placeholder="Win a bracelet, grind to a million..." /></label>
            <label>Funniest Poker Story<textarea name="funny_story" maxlength="2000" placeholder="The story you always tell at the table...">${escapeHtml(profile.funny_story || '')}</textarea></label>
            <label>Worst Bad Beat<textarea name="bad_beat_story" maxlength="2000" placeholder="Aces cracked. Again.">${escapeHtml(profile.bad_beat_story || '')}</textarea></label>
            <div style="display:flex;align-items:center;margin-top:.4rem;">
              <button type="button" class="ps-save-btn" onclick="psAutoSave('sectionStories',this)">Save</button>
              <span class="ps-saved-msg" id="sectionStoriesMsg">Saved ✓</span>
            </div>
          </form>
        </div>
      </div>
      <!-- Section 3: Photo -->
      <div class="ps-section">
        <div class="ps-section-hdr" onclick="this.nextElementSibling.classList.toggle('open')">
          <span class="ps-section-title">3 — Profile Photo</span>
          <span class="ps-section-tag${hasPhoto ? ' done' : ''}">
            ${hasPhoto ? 'Uploaded ✓' : 'No Photo'}
          </span>
        </div>
        <div class="ps-section-body">
          ${hasPhoto ? `<img src="${escapeHtml(profile.photo_url)}" alt="Your photo" style="width:100%;max-height:280px;object-fit:cover;border-radius:10px;margin-bottom:.75rem;" />` : ''}
          <form class="ps-form" id="sectionPhoto" enctype="multipart/form-data">
            <label>Upload Photo (JPG/PNG/WEBP, max 5MB)<input name="photo" type="file" accept="image/jpeg,image/png,image/webp" /></label>
            <div style="display:flex;align-items:center;margin-top:.4rem;">
              <button type="button" class="ps-save-btn" onclick="psPhotoUpload(this)">Upload Photo</button>
              <span class="ps-saved-msg" id="sectionPhotoMsg">Uploaded ✓</span>
            </div>
          </form>
          ${!hasPhoto ? '<p class="small" style="color:#666;margin-top:.5rem;">Upload a photo to unlock your Poker Trading Card.</p>' : ''}
        </div>
      </div>
      <!-- Section 4: AI Poker Personality -->
      <div class="ps-section" id="aiSection">
        <div class="ps-section-hdr" onclick="this.nextElementSibling.classList.toggle('open')">
          <span class="ps-section-title">4 — AI Poker Personality ✨</span>
          <span class="ps-section-tag${aiUnlocked ? (aiStatus ? ' done' : '') : ' locked'}" id="aiSectionTag">
            ${aiUnlocked ? (aiStatus === 'approved' ? 'Approved ✓' : aiStatus === 'pending_review' ? 'Pending Review' : aiStatus === 'rejected' ? 'Needs Edit' : 'Generate') : '🔒 Locked'}
          </span>
        </div>
        <div class="ps-section-body${aiUnlocked ? ' open' : ''}" id="aiSectionBody">
          ${!aiUnlocked ? `<div class="ps-locked-msg" id="aiLockedMsg"><span class="lock-icon">🔒</span>Save your poker stories in Section 2 above — once you hit 40% profile completion, the Generate button will appear here automatically.</div>` : `
          <p class="small" style="color:#888;margin-bottom:1rem;">Powered by AI and clearly labeled as entertainment. Our AI reads your poker stories and creates a playful poker personality summary for your public profile.</p>
          ${aiP && aiP.text ? `<div class="ai-box">
            <div class="ai-box-label">AI Poker Personality${aiStatus === 'pending_review' ? ' — Pending Admin Review' : aiStatus === 'approved' ? ' — Approved ✓' : ''}</div>
            <div class="ai-box-text">${escapeHtml(aiP.text)}</div>
            ${aiP.tagline ? `<div style="margin-top:.6rem;font-size:.72rem;color:var(--gold);font-style:italic;">"${escapeHtml(aiP.tagline)}"</div>` : ''}
            ${aiP.style ? `<div style="margin-top:.4rem;font-size:.65rem;color:#888;">Playing Style: ${escapeHtml(aiP.style)}</div>` : ''}
            ${aiP.signature_tell ? `<div style="margin-top:.35rem;font-size:.65rem;color:#888;">Signature Tell: ${escapeHtml(aiP.signature_tell)}</div>` : ''}
            ${aiP.threat_level ? `<div style="margin-top:.35rem;font-size:.65rem;color:var(--gold);">Threat Level: ${escapeHtml(aiP.threat_level)}</div>` : ''}
            ${aiP.table_quote ? `<div style="margin-top:.35rem;font-size:.68rem;color:var(--offwhite);font-style:italic;">"${escapeHtml(aiP.table_quote)}"</div>` : ''}
            ${aiP.hall_of_fame_potential ? `<div style="margin-top:.35rem;font-size:.65rem;color:#888;">Hall of Fame Potential: ${escapeHtml(aiP.hall_of_fame_potential)}</div>` : ''}
            <div class="ai-disclaimer">✦ AI-generated for entertainment only. Appears publicly after admin review.</div>
          </div>` : ''}
          <div style="margin-top:.85rem;display:flex;gap:.6rem;align-items:center;flex-wrap:wrap;">
            <button class="ps-save-btn" id="aiGenBtn" onclick="psGenerateAI(this)">${aiP ? 'Regenerate Personality' : 'Generate My AI Poker Personality ✨'}</button>
            <span class="ps-saved-msg" id="aiGenMsg"></span>
          </div>
          <p class="small" style="color:#555;margin-top:.5rem;">Limited to 5 generations per day.</p>`}
        </div>
      </div>
      <!-- Section 5: AI Chronicle Submission -->
      <div class="ps-section" id="chronicleSection">
        <div class="ps-section-hdr" onclick="this.nextElementSibling.classList.toggle('open')">
          <span class="ps-section-title">5 — Submit a Poker Story ✨</span>
          <span class="ps-section-tag${!aiUnlocked ? ' locked' : chronicles.length ? ' done' : ''}" id="chronicleSectionTag">
            ${!aiUnlocked ? '🔒 Locked' : chronicles.length ? chronicles.length + ' Submitted' : 'Write Story'}
          </span>
        </div>
        <div class="ps-section-body">
          ${!aiUnlocked ? `<div class="ps-locked-msg"><span class="lock-icon">🔒</span>Complete 40% of your profile to unlock story submission.</div>` : `
          <p class="small" style="color:#888;margin-bottom:1rem;">Submit a raw story and our AI will offer 5 rewrite versions — funny, dramatic, sports announcer, poker roast, or WSOP documentary style. You pick one. Admin reviews before it publishes.</p>
          ${chronicles.length ? `<div style="margin-bottom:1rem;">
            ${chronicles.map((c, i) => `<div style="border:1px solid #1e1e1e;border-radius:10px;padding:.75rem;margin-bottom:.5rem;">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <span style="font-size:.72rem;color:var(--green);text-transform:uppercase;letter-spacing:.1em;">${escapeHtml(c.story_type || 'Story')}</span>
                <span style="font-size:.62rem;color:#555;border:1px solid #222;border-radius:999px;padding:.1rem .5rem;">${escapeHtml(c.status || 'draft')}</span>
              </div>
              <p style="font-size:.78rem;color:#b0a898;margin-top:.35rem;">${escapeHtml((c.raw_text || '').slice(0, 120))}${(c.raw_text || '').length > 120 ? '…' : ''}</p>
              ${c.selected_style ? `<p style="font-size:.65rem;color:var(--gold);margin-top:.3rem;">Selected: ${escapeHtml(c.selected_style)}</p>` : (Array.isArray(c.rewrites) && c.rewrites.length ? `<button class="ps-save-btn" style="margin-top:.5rem;font-size:.62rem;" onclick="psShowRewrites(${i})">View AI Rewrites</button>` : '')}
            </div>`).join('')}
          </div>` : ''}
          <form class="ps-form" id="sectionChronicle">
            <label>Story Type<select name="story_type" class="story-type-select">
              ${STORY_TYPES.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')}
            </select></label>
            <label>Your Story (rough draft is fine)<textarea name="raw_text" maxlength="3000" rows="5" placeholder="Tell us what happened. AI will rewrite it in 5 different styles..."></textarea></label>
            <div style="display:flex;align-items:center;margin-top:.4rem;">
              <button type="button" class="ps-save-btn" id="chronicleBtn" onclick="psSubmitChronicle(this)">Generate AI Rewrites ✨</button>
              <span class="ps-saved-msg" id="chronicleMsg"></span>
            </div>
          </form>
          <div id="rewriteResults" style="display:none;margin-top:1rem;"></div>`}
        </div>
      </div>
      <!-- Section 6: Submit for Review -->
      <div class="ps-section">
        <div class="ps-section-hdr" onclick="this.nextElementSibling.classList.toggle('open')">
          <span class="ps-section-title">6 — Submit for Review</span>
          <span class="ps-section-tag${profile.status === 'approved' ? ' done' : profile.submitted_for_review ? ' done' : ''}" id="sec6Tag">
            ${profile.status === 'approved' ? 'Live ✓' : profile.status === 'rejected' ? 'Rejected' : profile.submitted_for_review ? 'Submitted ✓' : 'Not Yet Submitted'}
          </span>
        </div>
        <div class="ps-section-body open">
          ${profile.status === 'approved' ? `<p class="small" style="color:var(--green);margin-bottom:.6rem;">✓ Your profile is live on the Community Wall.</p><a href="/players/${escapeHtml(profile.slug)}" style="color:var(--green);font-size:.78rem;text-transform:uppercase;letter-spacing:.12em;">View Public Profile →</a>${cardUnlocked ? `<br><a class="card-preview-link" href="/players/${escapeHtml(profile.slug)}/card">🃏 View Poker Trading Card →</a>` : ''}` : `
          <p class="small" style="color:#888;margin-bottom:.75rem;">Fill in as much as you can above, then hit Submit when you're ready. The more complete your profile, the better your public page will look.</p>
          ${profile.submitted_for_review ? `<p class="small" style="color:var(--green);">✓ Profile submitted! The ATMNOPIN crew will review it and get you live on the Community Wall soon.</p>` : `<button class="ps-submit-final-btn" id="submitFinalBtn" onclick="psSubmitProfile(this)">Submit My Profile for Review →</button>`}
          ${pct >= 70 ? '<p class="small" style="color:var(--gold);margin-top:.75rem;">Profile is looking strong — great time to submit!</p>' : ''}`}
        </div>
      </div>
    </div>

    <script>
    (function() {
      var TOKEN = '${escapeHtml(token)}';
      var score = ${pct};

      function vesc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

      function updateProgress(newScore) {
        score = newScore;
        document.getElementById('psPct').textContent = newScore + '%';
        document.getElementById('psBar').style.width = newScore + '%';
        var msg = '';
        if (newScore < 40) msg = 'Add your poker stories to unlock your AI Poker Personality.';
        else if (!${hasPhoto ? 'true' : 'false'}) msg = 'Upload a photo to unlock your Poker Trading Card.';
        else msg = 'Profile looking strong. Pending admin review.';
        document.getElementById('psUnlock').textContent = msg;
        if (newScore >= 40) {
          var aiBody = document.getElementById('aiSectionBody');
          var aiTag = document.getElementById('aiSectionTag');
          var aiLocked = document.getElementById('aiLockedMsg');
          var chrTag = document.getElementById('chronicleSectionTag');
          if (aiBody && aiLocked) {
            aiLocked.style.display = 'none';
            if (!document.getElementById('aiGenBtn')) {
              aiBody.insertAdjacentHTML('beforeend',
                '<p class="small" style="color:#888;margin-bottom:1rem;">Powered by AI and clearly labeled as entertainment. Our AI reads your poker stories and creates a playful poker personality summary for your public profile.</p>'
                + '<div style="margin-top:.85rem;display:flex;gap:.6rem;align-items:center;flex-wrap:wrap;">'
                + '<button class="ps-save-btn" id="aiGenBtn" onclick="psGenerateAI(this)">Generate My AI Poker Personality ✨</button>'
                + '<span class="ps-saved-msg" id="aiGenMsg"></span>'
                + '</div>'
                + '<p class="small" style="color:#555;margin-top:.5rem;">Limited to 5 generations per day.</p>'
              );
            }
            aiBody.classList.add('open');
          }
          if (aiTag) { aiTag.className = 'ps-section-tag'; aiTag.textContent = 'Generate'; }
          if (chrTag) { chrTag.className = 'ps-section-tag'; chrTag.textContent = 'Write Story'; }
        }
      }

      function showSaved(id, ok, text) {
        var el = document.getElementById(id);
        if (!el) return;
        el.textContent = text || (ok ? 'Saved ✓' : 'Error saving');
        el.style.color = ok ? 'var(--green)' : '#ff6666';
        el.classList.add('show');
        setTimeout(function() { el.classList.remove('show'); }, 2800);
      }

      window.psAutoSave = async function(formId, btn) {
        var form = document.getElementById(formId);
        if (!form) return;
        btn.disabled = true;
        btn.textContent = 'Saving...';
        var data = {};
        var inputs = form.querySelectorAll('input[name],textarea[name],select[name]');
        inputs.forEach(function(el) { data[el.name] = el.value; });
        try {
          var r = await fetch('/api/profile/' + TOKEN, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
          });
          var d = await r.json();
          if (!r.ok) throw new Error(d.error || 'Save failed');
          if (d.completion_score !== undefined) updateProgress(d.completion_score);
          showSaved(formId + 'Msg', true);
        } catch(e) {
          showSaved(formId + 'Msg', false, e.message);
        }
        btn.disabled = false;
        btn.textContent = 'Save';
      };

      window.psPhotoUpload = async function(btn) {
        var form = document.getElementById('sectionPhoto');
        var fileInput = form.querySelector('input[type=file]');
        if (!fileInput.files.length) { alert('Please select a photo first.'); return; }
        btn.disabled = true; btn.textContent = 'Uploading...';
        var fd = new FormData();
        fd.append('photo', fileInput.files[0]);
        try {
          var r = await fetch('/api/profile/' + TOKEN + '/photo', { method: 'POST', body: fd });
          var d = await r.json();
          if (!r.ok) throw new Error(d.error || 'Upload failed');
          if (d.completion_score !== undefined) updateProgress(d.completion_score);
          showSaved('sectionPhotoMsg', true, 'Uploaded ✓');
          if (d.photo_url) {
            var existing = form.previousElementSibling;
            var preview = document.createElement('img');
            preview.src = d.photo_url; preview.style.cssText = 'width:100%;max-height:280px;object-fit:cover;border-radius:10px;margin-bottom:.75rem;display:block;';
            form.parentNode.insertBefore(preview, form);
          }
        } catch(e) { showSaved('sectionPhotoMsg', false, e.message); }
        btn.disabled = false; btn.textContent = 'Upload Photo';
      };

      window.psGenerateAI = async function(btn) {
        var origText = btn.textContent;
        btn.disabled = true; btn.textContent = 'Generating...';
        var msgEl = document.getElementById('aiGenMsg');
        var errBox = document.getElementById('aiErrBox');
        if (msgEl) { msgEl.textContent = ''; msgEl.classList.remove('show'); }
        if (errBox) errBox.style.display = 'none';
        try {
          var r = await fetch('/api/profile/' + TOKEN + '/ai-personality', { method: 'POST' });
          var d = await r.json();
          if (!r.ok) throw new Error(d.error || 'Generation failed');
          if (msgEl) { msgEl.textContent = 'Generated! Pending admin review.'; msgEl.style.color = 'var(--green)'; msgEl.classList.add('show'); }
          var box = document.querySelector('.ai-box');
          if (!box) {
            box = document.createElement('div');
            box.className = 'ai-box';
            btn.parentNode.parentNode.insertBefore(box, btn.parentNode);
          }
          box.innerHTML = '<div class="ai-box-label">AI Poker Personality — Pending Admin Review</div>'
            + '<div class="ai-box-text">' + vesc(d.text || '') + '</div>'
            + (d.tagline ? '<div style="margin-top:.6rem;font-size:.72rem;color:var(--gold);font-style:italic;">"' + vesc(d.tagline) + '"</div>' : '')
            + (d.style ? '<div style="margin-top:.4rem;font-size:.65rem;color:#888;">Playing Style: ' + vesc(d.style) + '</div>' : '')
            + (d.signature_tell ? '<div style="margin-top:.35rem;font-size:.65rem;color:#888;">Signature Tell: ' + vesc(d.signature_tell) + '</div>' : '')
            + (d.threat_level ? '<div style="margin-top:.35rem;font-size:.65rem;color:var(--gold);">Threat Level: ' + vesc(d.threat_level) + '</div>' : '')
            + (d.table_quote ? '<div style="margin-top:.35rem;font-size:.68rem;color:var(--offwhite);font-style:italic;">"' + vesc(d.table_quote) + '"</div>' : '')
            + (d.hall_of_fame_potential ? '<div style="margin-top:.35rem;font-size:.65rem;color:#888;">Hall of Fame Potential: ' + vesc(d.hall_of_fame_potential) + '</div>' : '')
            + '<div class="ai-disclaimer">✦ AI-generated for entertainment only. Appears publicly after admin review.</div>';
          btn.textContent = 'Regenerate Personality';
        } catch(e) {
          btn.textContent = origText;
          var msg = e.message || 'Generation failed. Please try again.';
          if (!errBox) {
            errBox = document.createElement('div');
            errBox.id = 'aiErrBox';
            errBox.style.cssText = 'margin-top:.6rem;padding:.6rem .9rem;border:1px solid #5c1f1f;border-radius:8px;background:#1a0808;color:#ff8080;font-size:.75rem;line-height:1.5;';
            btn.parentNode.appendChild(errBox);
          }
          errBox.style.display = '';
          errBox.textContent = msg;
        }
        btn.disabled = false;
      };

      window.psSubmitChronicle = async function(btn) {
        var form = document.getElementById('sectionChronicle');
        var storyType = form.querySelector('[name=story_type]').value;
        var rawText = form.querySelector('[name=raw_text]').value.trim();
        if (!rawText || rawText.length < 30) { alert('Please write at least a brief story (30+ characters).'); return; }
        btn.disabled = true; btn.textContent = 'Generating Rewrites...';
        var msgEl = document.getElementById('chronicleMsg');
        msgEl.textContent = ''; msgEl.classList.remove('show');
        try {
          var r = await fetch('/api/profile/' + TOKEN + '/ai-chronicle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ story_type: storyType, raw_text: rawText }),
          });
          var d = await r.json();
          if (!r.ok) throw new Error(d.error || 'Generation failed');
          msgEl.textContent = 'Rewrites ready! Pick your favorite.';
          msgEl.style.color = 'var(--green)';
          msgEl.classList.add('show');
          showRewrites(d.chronicle_id, d.rewrites, form);
          form.querySelector('[name=raw_text]').value = '';
        } catch(e) {
          msgEl.textContent = e.message;
          msgEl.style.color = '#ff6666';
          msgEl.classList.add('show');
        }
        btn.disabled = false; btn.textContent = 'Generate AI Rewrites ✨';
      };

      function showRewrites(chronicleId, rewrites, afterEl) {
        var container = document.getElementById('rewriteResults');
        if (!container) return;
        container.style.display = '';
        container.innerHTML = '<p style="font-size:.75rem;color:#888;margin-bottom:.75rem;">Choose your favorite rewrite and submit it for review:</p>'
          + rewrites.map(function(rw, i) {
            return '<div class="ai-rewrite-option" data-idx="' + i + '" data-chronicle-id="' + chronicleId + '" onclick="psSelectRewrite(this)">'
              + '<div class="ai-rewrite-label">' + vesc(rw.style_label || rw.style) + '</div>'
              + '<div class="ai-rewrite-text">' + vesc(rw.text || '') + '</div>'
              + '</div>';
          }).join('')
          + '<p style="font-size:.65rem;color:#555;margin-top:.6rem;">Submitting a rewrite sends it to admin for review before it appears publicly.</p>';
      }

      window.psShowRewrites = function(idx) {
        var chronicles = ${JSON.stringify(chronicles)};
        var c = chronicles[idx];
        if (!c || !c.rewrites) return;
        var container = document.getElementById('rewriteResults');
        if (container) { container.style.display = ''; showRewrites(c.id, c.rewrites, null); }
      };

      window.psSelectRewrite = async function(el) {
        var chronicleId = el.dataset.chronicleId;
        var idx = parseInt(el.dataset.idx, 10);
        document.querySelectorAll('.ai-rewrite-option').forEach(function(o) { o.classList.remove('selected'); });
        el.classList.add('selected');
        try {
          var r = await fetch('/api/profile/' + TOKEN + '/ai-chronicle/' + chronicleId + '/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ selected_index: idx }),
          });
          var d = await r.json();
          if (!r.ok) throw new Error(d.error || 'Error selecting rewrite');
          el.insertAdjacentHTML('afterend', '<p style="font-size:.7rem;color:var(--green);margin-top:.5rem;">✓ Submitted for review. The ATMNOPIN crew will publish it if approved.</p>');
          document.querySelectorAll('.ai-rewrite-option').forEach(function(o) { o.style.pointerEvents = 'none'; });
        } catch(e) { alert(e.message); }
      };

      window.psSubmitProfile = async function(btn) {
        btn.disabled = true;
        btn.textContent = 'Submitting...';
        try {
          var r = await fetch('/api/profile/' + TOKEN + '/submit', { method: 'POST' });
          var d = await r.json();
          if (!r.ok) throw new Error(d.error || 'Submit failed');
          btn.style.display = 'none';
          var msg = document.createElement('p');
          msg.className = 'small';
          msg.style.cssText = 'color:var(--green);margin-top:.5rem;';
          msg.textContent = '✓ Profile submitted! The ATMNOPIN crew will review it and get you live on the Community Wall soon.';
          btn.parentNode.appendChild(msg);
          var tag = document.getElementById('sec6Tag');
          if (tag) { tag.className = 'ps-section-tag done'; tag.textContent = 'Submitted ✓'; }
        } catch(e) {
          btn.disabled = false;
          btn.textContent = 'Submit My Profile for Review →';
          alert(e.message || 'Submit failed. Please try again.');
        }
      };
    })();
    </script>`);
}

function renderTradingCardPage(player) {
  const badges = getPlayerBadges(player);
  const topBadges = badges.slice(0, 3);
  const aiP = player.ai_personality;
  const tagline = (aiP && aiP.status === 'approved' && aiP.tagline) ? aiP.tagline : '';
  const displayChar = player.suit || ((player.nickname || player.name || '?')[0] || '?').toUpperCase();
  const profileUrl = `https://atmwithnopin.com/players/${player.slug}`;

  return renderLayout(`${player.nickname || player.name} — Poker Trading Card | ATMNOPIN™`, `
    <style>
      body{background:#0a0a0a;}
      .tc-page{display:flex;flex-direction:column;align-items:center;padding:2rem 1rem;min-height:80vh;}
      .tc-card{width:320px;background:linear-gradient(145deg,#0d2e1a,#0a1010);border:2px solid #c9a84c;border-radius:18px;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,.6);}
      .tc-top{background:linear-gradient(135deg,#0d3a1e,#071a0d);padding:.75rem 1rem .5rem;text-align:center;border-bottom:1px solid rgba(201,168,76,.25);}
      .tc-brand{font-family:'Bebas Neue',sans-serif;font-size:.8rem;letter-spacing:.3em;color:var(--gold);opacity:.7;}
      .tc-photo{width:100%;height:260px;object-fit:cover;display:block;}
      .tc-photo-ph{height:260px;display:flex;align-items:center;justify-content:center;font-family:'Bebas Neue',sans-serif;font-size:6rem;color:var(--green);background:linear-gradient(135deg,#0d2e1a,#0a1a0f);}
      .tc-body{padding:1rem;}
      .tc-nickname{font-family:'Bebas Neue',sans-serif;font-size:1.8rem;color:var(--offwhite);line-height:1;margin-bottom:.15rem;}
      .tc-name{font-size:.65rem;color:#888;text-transform:uppercase;letter-spacing:.15em;margin-bottom:.5rem;}
      .tc-stat-row{display:flex;gap:.25rem;flex-wrap:wrap;margin-bottom:.5rem;}
      .tc-stat{background:#0c1a10;border:1px solid #1a2a1a;border-radius:8px;padding:.3rem .6rem;font-size:.6rem;color:#b0a898;display:flex;flex-direction:column;gap:.1rem;flex:1;min-width:80px;}
      .tc-stat-label{font-size:.5rem;text-transform:uppercase;letter-spacing:.15em;color:var(--green);}
      .tc-tagline{font-size:.72rem;color:var(--gold);font-style:italic;line-height:1.5;margin:.5rem 0;padding:.5rem;border-top:1px solid rgba(201,168,76,.2);border-bottom:1px solid rgba(201,168,76,.2);}
      .tc-badges{display:flex;flex-wrap:wrap;gap:.3rem;margin:.5rem 0;}
      .tc-badge{font-size:.52rem;text-transform:uppercase;letter-spacing:.1em;border-radius:999px;padding:.15rem .5rem;border:1px solid;}
      .tc-bottom{padding:.6rem 1rem;background:linear-gradient(135deg,#071a0d,#050f05);border-top:1px solid rgba(201,168,76,.2);text-align:center;}
      .tc-url{font-size:.55rem;color:#555;letter-spacing:.1em;text-transform:uppercase;}
      .tc-points{font-family:'Bebas Neue',sans-serif;font-size:1.3rem;color:var(--gold);}
      .tc-pts-label{font-size:.5rem;text-transform:uppercase;letter-spacing:.15em;color:#888;}
      .tc-actions{margin-top:1.5rem;display:flex;gap:.75rem;justify-content:center;flex-wrap:wrap;}
      .tc-action-btn{border:1px solid #242424;background:#111;color:var(--offwhite);border-radius:8px;padding:.5rem 1rem;font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;cursor:pointer;text-decoration:none;transition:all .2s;}
      .tc-action-btn:hover{border-color:var(--green);color:var(--green);}
      .tc-disclaimer{font-size:.6rem;color:#444;text-align:center;margin-top:.75rem;max-width:320px;}
      @media print {.tc-actions,.tc-disclaimer{display:none;}}
    </style>
    <div class="tc-page">
      <div class="tc-card">
        <div class="tc-top">
          <div class="tc-brand">ATMNOPIN™ Community</div>
        </div>
        ${player.photo_url
          ? `<img class="tc-photo" src="${escapeHtml(player.photo_url)}" alt="${escapeHtml(player.nickname || player.name)}" />`
          : `<div class="tc-photo-ph">${escapeHtml(displayChar)}</div>`}
        <div class="tc-body">
          <div class="tc-nickname">${escapeHtml(player.nickname || player.name)}</div>
          ${player.nickname && player.name ? `<div class="tc-name">${escapeHtml(player.name)}</div>` : ''}
          <div class="tc-stat-row">
            ${player.favorite_game ? `<div class="tc-stat"><span class="tc-stat-label">Game</span>${escapeHtml(player.favorite_game)}</div>` : ''}
            ${player.city ? `<div class="tc-stat"><span class="tc-stat-label">Hometown</span>${escapeHtml(player.city)}</div>` : ''}
            ${player.favorite_casino ? `<div class="tc-stat"><span class="tc-stat-label">Casino</span>${escapeHtml(player.favorite_casino)}</div>` : ''}
            ${player.points ? `<div class="tc-stat"><span class="tc-stat-label">Points</span><span class="tc-points">${player.points}</span></div>` : ''}
          </div>
          ${(aiP && aiP.status === 'approved' && (aiP.threat_level || aiP.signature_tell)) ? `<div class="tc-stat-row">
            ${aiP.threat_level ? `<div class="tc-stat"><span class="tc-stat-label">Threat Level</span><span style="color:var(--gold);">${escapeHtml(aiP.threat_level)}</span></div>` : ''}
            ${aiP.signature_tell ? `<div class="tc-stat"><span class="tc-stat-label">Tell</span>${escapeHtml(aiP.signature_tell)}</div>` : ''}
          </div>` : ''}
          ${tagline ? `<div class="tc-tagline">"${escapeHtml(tagline)}"</div>` : ''}
          ${(aiP && aiP.status === 'approved' && aiP.hall_of_fame_potential) ? `<div style="font-size:.6rem;color:#888;margin-bottom:.4rem;padding:0 .1rem;">🏆 HoF Potential: ${escapeHtml(aiP.hall_of_fame_potential)}</div>` : ''}
          ${topBadges.length ? `<div class="tc-badges">${topBadges.map((b) => `<span class="tc-badge" style="${badgeStyle(b)}">${escapeHtml(b)}</span>`).join('')}</div>` : ''}
        </div>
        <div class="tc-bottom">
          <div class="tc-url">${escapeHtml(profileUrl)}</div>
        </div>
      </div>
      <div class="tc-actions">
        <a class="tc-action-btn" href="/players/${escapeHtml(player.slug)}">← Back to Profile</a>
        <button class="tc-action-btn" onclick="window.print()">Print / Save as PDF</button>
        <button class="tc-action-btn" onclick="navigator.share ? navigator.share({title:'${escapeHtml(player.nickname || player.name)} — Poker Card',url:'${escapeHtml(profileUrl)}'}) : navigator.clipboard.writeText('${escapeHtml(profileUrl)}').then(function(){this.textContent='Link Copied!';}.bind(this))">Share</button>
      </div>
      <p class="tc-disclaimer">This Poker Trading Card is generated by ATMNOPIN™. Content requires admin approval before appearing publicly.</p>
    </div>`);
}

function renderCommunityWallPage(submissions) {
  const approved = submissions
    .filter((s) => s.status === 'approved')
    .sort((a, b) => {
      if (a.player_type === 'crew' && b.player_type !== 'crew') return -1;
      if (b.player_type === 'crew' && a.player_type !== 'crew') return 1;
      return new Date(b.approved_at || b.created_at) - new Date(a.approved_at || a.created_at);
    });
  const wallFilters = [
    { label: 'All', filter: '' },
    { label: 'Players', filter: 'Players' },
    { label: 'Fellow Fish', filter: 'Fellow Fish' },
    { label: 'Poker Friends', filter: 'Poker Friends' },
    { label: 'Table Characters', filter: 'Table Characters' },
    { label: 'Foxwoods', filter: 'Foxwoods' },
    { label: '$2/$5 NLH', filter: '$2/$5 NLH' },
    { label: 'Final Table Hero', filter: '__badge__Final Table Hero' },
    { label: 'Bad Beat Champion', filter: '__badge__Bad Beat Champion' },
    { label: 'WSOP Warrior', filter: '__badge__WSOP Warrior' },
    { label: 'Featured', filter: '__featured__' },
    { label: 'Monthly Winner', filter: '__monthly__' },
  ];
  const filterBtns = wallFilters.map((f) =>
    `<button class="pw-filter-btn${f.filter === '' ? ' active' : ''}" data-filter="${escapeHtml(f.filter)}">${escapeHtml(f.label)}</button>`
  ).join('');
  const cards = approved.map(renderPlayerCard).join('');
  return renderLayout('Community Wall | ATMNOPIN™', `
    <style>
      .pw-controls{display:flex;flex-direction:column;gap:.75rem;margin:1.5rem 0 1rem;}
      .pw-filter-wrap{display:flex;flex-wrap:wrap;gap:.4rem;}
      .pw-sort-wrap{display:flex;align-items:center;gap:.6rem;}
      .pw-sort-label{font-size:.62rem;text-transform:uppercase;letter-spacing:.14em;color:#666;}
      .pw-sort-select{background:#111;border:1px solid #2a2a2a;color:#aaa;border-radius:8px;padding:.3rem .6rem;font:.68rem 'DM Mono',monospace;text-transform:uppercase;letter-spacing:.08em;cursor:pointer;}
      .pw-filter-btn{border:1px solid #2a2a2a;background:#111;color:#999;border-radius:999px;padding:.3rem .7rem;font:.68rem 'DM Mono',monospace;text-transform:uppercase;letter-spacing:.1em;cursor:pointer;transition:all .2s;}
      .pw-filter-btn:hover,.pw-filter-btn.active{border-color:rgba(0,200,83,.4);background:rgba(0,200,83,.08);color:var(--green);}
      .pw-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;margin-top:.5rem;}
      @media(max-width:980px){.pw-grid{grid-template-columns:1fr;}}
      @media(min-width:600px) and (max-width:980px){.pw-grid{grid-template-columns:repeat(2,1fr);}}
      .player-card{border:1px solid #1e1e1e;background:#101010;border-radius:14px;overflow:hidden;display:flex;flex-direction:column;transition:border-color .2s;}
      .player-card:hover{border-color:#2e2e2e;}
      .player-photo-wrap img{width:100%;height:200px;object-fit:cover;display:block;}
      .player-photo-ph{height:160px;background:linear-gradient(135deg,#0d2e1a,#0a1a0f);display:flex;align-items:center;justify-content:center;font-family:'Bebas Neue',sans-serif;font-size:3.5rem;color:var(--green);border-bottom:1px solid #1a1a1a;}
      .player-photo-ph-open{background:linear-gradient(135deg,#111,#1a1a1a);color:#555;}
      .player-card-body{padding:1rem;display:flex;flex-direction:column;gap:.35rem;flex:1;}
      .player-card-name{font-family:'DM Serif Display',serif;font-size:1.05rem;margin:.2rem 0 0;}
      .player-card-excerpt{color:#b0a898;font-size:.78rem;line-height:1.6;flex:1;margin-top:.25rem;}
      .player-view-cta{display:inline-block;margin-top:.4rem;color:var(--green);font-size:.7rem;text-transform:uppercase;letter-spacing:.12em;text-decoration:none;}
      .player-view-cta:hover{color:#00ff6a;}
      .crew-stats-mini{margin-top:.5rem;border-top:1px solid #1a1a1a;padding-top:.5rem;display:flex;flex-direction:column;gap:.25rem;}
      .csm-row{display:flex;gap:.4rem;align-items:baseline;}
      .csm-label{font-size:.55rem;text-transform:uppercase;letter-spacing:.12em;color:var(--green);white-space:nowrap;min-width:4.5rem;}
      .csm-val{font-size:.72rem;color:#aaa;}
      .pw-no-results{grid-column:1/-1;text-align:center;padding:3rem;color:#777;font-size:.85rem;}
      .pw-get-featured{margin-top:2rem;padding:1.5rem;border:1px dashed #242424;border-radius:14px;text-align:center;}
      .pw-get-featured p{color:#b0a898;font-size:.82rem;margin-bottom:.75rem;}
    </style>
    <section class="hero">
      <p class="eyebrow">ATMNOPIN™ Community</p>
      <h1>Community Wall</h1>
      <p class="body-text" style="max-width:60ch;">The table characters, fellow fish, and poker friends of the ATMNOPIN™ universe. Every player has a story.</p>
    </section>
    <div class="pw-controls">
      <div class="pw-filter-wrap">${filterBtns}</div>
      <div class="pw-sort-wrap">
        <span class="pw-sort-label">Sort:</span>
        <select class="pw-sort-select" id="pwSort">
          <option value="newest">Newest</option>
          <option value="points">Most Points</option>
          <option value="badges">Most Badges</option>
          <option value="featured">Featured</option>
        </select>
      </div>
    </div>
    <div class="pw-grid" id="pwGrid">
      ${cards || '<p class="pw-no-results">No players featured yet. <a href="/ai-profile-generator">Be the first →</a></p>'}
    </div>
    <div class="pw-get-featured">
      <p>Sat at the table with Dhezz? Got a story, a bad beat, or a nickname worth immortalizing?</p>
      <a href="/ai-profile-generator" class="pill">Get Featured →</a>
    </div>
    <script>
    (function() {
      var grid = document.getElementById('pwGrid');
      var all = Array.from(grid.querySelectorAll('.player-card'));
      var active = '';
      var sortMode = 'newest';

      function matches(card) {
        if (!active) return true;
        if (active === '__featured__') return card.dataset.featured === 'true';
        if (active === '__monthly__') return card.dataset.monthly === 'true';
        if (active.startsWith('__badge__')) {
          var bname = active.slice('__badge__'.length).toLowerCase();
          return (card.dataset.badges || '').toLowerCase().split(',').some(function(b) { return b.trim() === bname; });
        }
        var badge = card.dataset.badge || '';
        var tags = (card.dataset.tags || '').split(',').map(function(t) { return t.trim(); });
        return badge === active || tags.indexOf(active) > -1;
      }

      function sortCards(cards) {
        return cards.slice().sort(function(a, b) {
          if (sortMode === 'points') return (parseInt(b.dataset.points)||0) - (parseInt(a.dataset.points)||0);
          if (sortMode === 'badges') return (b.dataset.badges||'').split(',').filter(Boolean).length - (a.dataset.badges||'').split(',').filter(Boolean).length;
          if (sortMode === 'featured') return (b.dataset.featured==='true'?1:0) - (a.dataset.featured==='true'?1:0);
          return 0; // newest = original DOM order
        });
      }

      function paint() {
        var vis = all.filter(matches);
        var sorted = sortCards(vis);
        var hidden = all.filter(function(c) { return !matches(c); });
        hidden.forEach(function(c) { c.style.display = 'none'; });
        sorted.forEach(function(c) { c.style.display = ''; grid.appendChild(c); });
        var nr = document.getElementById('pwNoRes');
        if (!vis.length && all.length) {
          if (!nr) { nr = Object.assign(document.createElement('p'), {id:'pwNoRes',className:'pw-no-results',textContent:'No players with this filter yet.'}); grid.appendChild(nr); }
        } else if (nr) nr.remove();
      }

      document.querySelectorAll('.pw-filter-btn').forEach(function(b) {
        b.addEventListener('click', function() {
          document.querySelectorAll('.pw-filter-btn').forEach(function(x) { x.classList.remove('active'); });
          b.classList.add('active'); active = b.dataset.filter || ''; paint();
        });
      });
      document.getElementById('pwSort').addEventListener('change', function() { sortMode = this.value; paint(); });
    })();
    </script>`);
}

function renderPlayerProfilePage(player, allPlayers) {
  const others = allPlayers
    .filter((p) => p.id !== player.id && p.status === 'approved' && p.slug !== 'open-seat-tbd')
    .slice(0, 3);
  const shareUrl = `https://atmwithnopin.com/players/${escapeHtml(player.slug)}`;
  const displayChar = player.suit || ((player.nickname || player.name || '?')[0] || '?').toUpperCase();
  const isOpenSeat = player.slug === 'open-seat-tbd';
  const descText = player.bio || player.biggest_accomplishment || player.funny_story || '';
  const badges = getPlayerBadges(player);
  const aiP = player.ai_personality;
  const approvedAI = (aiP && aiP.status === 'approved') ? aiP : null;
  const cardUnlocked = player.status === 'approved' && !!player.photo_url && (player.completion_score || 0) >= 70;
  const approvedChronicles = Array.isArray(player.ai_chronicles)
    ? player.ai_chronicles.filter((c) => c.status === 'approved')
    : [];
  return renderLayout(`${player.nickname || player.name} | ATMNOPIN™ Community`, `
    <meta name="description" content="${escapeHtml(descText.slice(0, 155))}" />
    <meta property="og:title" content="${escapeHtml((player.nickname || player.name) + ' — ATMNOPIN™ Community')}" />
    <meta property="og:description" content="${escapeHtml(descText.slice(0, 155))}" />
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
      .crew-stats-table{width:100%;margin-top:.5rem;border-collapse:collapse;}
      .crew-stats-table td{padding:.5rem 0;border-bottom:1px solid #1a1a1a;vertical-align:top;font-size:.8rem;}
      .crew-stats-table td:first-child{font-size:.58rem;text-transform:uppercase;letter-spacing:.15em;color:var(--green);width:36%;padding-right:1rem;}
      .pp-ai-box{background:#0a1a10;border:1px solid #1a3a22;border-radius:12px;padding:1rem;margin-top:.5rem;}
      .pp-ai-tagline{font-size:.85rem;color:var(--gold);font-style:italic;line-height:1.6;margin-bottom:.5rem;}
      .pp-ai-text{font-size:.8rem;color:#b0a898;line-height:1.7;white-space:pre-wrap;}
      .pp-ai-disclaimer{font-size:.6rem;color:#444;margin-top:.5rem;font-style:italic;}
      .pp-badge-row{display:flex;flex-wrap:wrap;gap:.35rem;margin-top:.4rem;}
      .pp-points-tag{display:inline-block;border:1px solid rgba(201,168,76,.3);background:rgba(201,168,76,.07);color:var(--gold);border-radius:999px;padding:.15rem .6rem;font-size:.65rem;text-transform:uppercase;letter-spacing:.1em;}
      .pp-story-card{border:1px solid #1e1e1e;border-radius:10px;padding:.85rem;margin-bottom:.6rem;background:#0c0c0c;}
      .pp-story-type{font-size:.6rem;text-transform:uppercase;letter-spacing:.14em;color:var(--green);margin-bottom:.3rem;}
      .pp-card-link{display:inline-block;margin-top:.6rem;border:1px solid rgba(201,168,76,.4);background:rgba(201,168,76,.07);color:var(--gold);border-radius:8px;padding:.4rem .85rem;font-size:.68rem;text-transform:uppercase;letter-spacing:.1em;text-decoration:none;transition:all .2s;}
      .pp-card-link:hover{background:rgba(201,168,76,.15);}
    </style>
    <section class="hero">
      <p class="eyebrow"><a href="/community-wall" style="color:var(--green);">Community Wall</a> › Player Profile</p>
      <h1>${escapeHtml(player.nickname || player.name)}</h1>
      <div style="display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;margin-top:.5rem;">
        ${badges.map((b) => renderBadge(b)).join('')}
        ${player.points ? `<span class="pp-points-tag">🏆 ${player.points} pts</span>` : ''}
        ${player.city ? `<span class="meta">${escapeHtml(player.city)}</span>` : ''}
        ${player.favorite_game ? `<span class="meta">${escapeHtml(player.favorite_game)}</span>` : ''}
        ${player.poker_room ? `<span class="meta">📍 ${escapeHtml(player.poker_room)}</span>` : ''}
        ${player.is_monthly_winner ? `<span style="display:inline-block;background:rgba(201,168,76,.12);border:1px solid rgba(201,168,76,.4);color:var(--gold);border-radius:999px;padding:.15rem .6rem;font-size:.6rem;text-transform:uppercase;letter-spacing:.1em;">Monthly Winner 🏅</span>` : ''}
      </div>
    </section>
    <section class="grid" style="margin-top:1rem;">
      <article class="card">
        ${player.photo_url
          ? `<img class="pp-photo" src="${escapeHtml(player.photo_url)}" alt="${escapeHtml(player.nickname || player.name)}" />`
          : `<div class="pp-photo-ph">${escapeHtml(displayChar)}</div>`}
        ${approvedAI ? `<div class="pp-section"><p class="pp-section-label">✨ AI Poker Personality</p><div class="pp-ai-box">
          ${approvedAI.tagline ? `<p class="pp-ai-tagline">"${escapeHtml(approvedAI.tagline)}"</p>` : ''}
          ${approvedAI.text ? `<p class="pp-ai-text">${escapeHtml(approvedAI.text)}</p>` : ''}
          ${(approvedAI.style || approvedAI.signature_tell || approvedAI.threat_level || approvedAI.table_quote || approvedAI.hall_of_fame_potential) ? `<table style="width:100%;border-collapse:collapse;margin-top:.75rem;font-size:.7rem;">
            ${approvedAI.style ? `<tr><td style="color:#888;padding:.2rem .6rem .2rem 0;width:40%;">Playing Style</td><td style="color:var(--offwhite);">${escapeHtml(approvedAI.style)}</td></tr>` : ''}
            ${approvedAI.signature_tell ? `<tr><td style="color:#888;padding:.2rem .6rem .2rem 0;">Signature Tell</td><td style="color:var(--offwhite);">${escapeHtml(approvedAI.signature_tell)}</td></tr>` : ''}
            ${approvedAI.threat_level ? `<tr><td style="color:#888;padding:.2rem .6rem .2rem 0;">Threat Level</td><td style="color:var(--gold);">${escapeHtml(approvedAI.threat_level)}</td></tr>` : ''}
            ${approvedAI.hall_of_fame_potential ? `<tr><td style="color:#888;padding:.2rem .6rem .2rem 0;">HoF Potential</td><td style="color:var(--offwhite);">${escapeHtml(approvedAI.hall_of_fame_potential)}</td></tr>` : ''}
          </table>` : ''}
          ${approvedAI.table_quote ? `<p style="font-size:.75rem;color:var(--gold);font-style:italic;margin-top:.6rem;border-left:2px solid var(--gold);padding-left:.75rem;">"${escapeHtml(approvedAI.table_quote)}"</p>` : ''}
          <p class="pp-ai-disclaimer">✦ AI-generated for entertainment only.</p>
        </div></div>` : ''}
        ${player.bio ? `<div class="pp-section"><p class="pp-section-label">About</p><p class="body-text">${escapeHtml(player.bio)}</p></div>` : ''}
        ${(player.specialty || player.tell || player.threat_level) ? `<div class="pp-section"><p class="pp-section-label">Player Profile</p><table class="crew-stats-table"><tbody>
          ${player.specialty ? `<tr><td>Specialty</td><td>${escapeHtml(player.specialty)}</td></tr>` : ''}
          ${player.tell ? `<tr><td>Tell</td><td>${escapeHtml(player.tell)}</td></tr>` : ''}
          ${player.threat_level ? `<tr><td>Threat Level</td><td>${escapeHtml(player.threat_level)}</td></tr>` : ''}
          ${player.favorite_casino ? `<tr><td>Favorite Casino</td><td>${escapeHtml(player.favorite_casino)}</td></tr>` : ''}
          ${player.biggest_goal ? `<tr><td>Biggest Goal</td><td>${escapeHtml(player.biggest_goal)}</td></tr>` : ''}
        </tbody></table></div>` : ''}
        ${!player.bio && player.biggest_accomplishment ? `<div class="pp-section"><p class="pp-section-label">Biggest Accomplishment</p><p class="body-text">${escapeHtml(player.biggest_accomplishment)}</p></div>` : ''}
        ${player.funny_story ? `<div class="pp-section"><p class="pp-section-label">Funniest Poker Story</p><div>${renderMarkdown(player.funny_story)}</div></div>` : ''}
        ${player.bad_beat_story ? `<div class="pp-section"><p class="pp-section-label">Bad Beat Story</p><div>${renderMarkdown(player.bad_beat_story)}</div></div>` : ''}
        ${approvedChronicles.length ? `<div class="pp-section"><p class="pp-section-label">✨ Community Chronicles</p>${approvedChronicles.map((c) => `<div class="pp-story-card"><div class="pp-story-type">${escapeHtml(c.story_type || 'Story')}</div><p style="font-size:.8rem;color:#b0a898;line-height:1.6;">${escapeHtml(c.selected_text || '')}</p></div>`).join('')}</div>` : ''}
        ${isOpenSeat ? `<div class="pp-section" style="text-align:center;padding:1.5rem 0;"><p class="meta" style="margin-bottom:.75rem;">The crew has one seat open. Foxwoods. $2/$5. Come sit down.</p><a href="/ai-profile-generator" class="pill">Get Featured →</a></div>` : ''}
        ${player.social_link && !isOpenSeat ? `<div class="pp-section"><p class="pp-section-label">Find Me Online</p><a class="pp-social-link" href="${escapeHtml(player.social_link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(player.social_link)}</a></div>` : ''}
        ${cardUnlocked && !isOpenSeat ? `<div class="pp-section"><a class="pp-card-link" href="/players/${escapeHtml(player.slug)}/card">🃏 View Poker Trading Card →</a></div>` : ''}
        ${!isOpenSeat ? `<div class="share-row">
          <p class="meta">Share this profile</p>
          <div class="share-btns">
            <a class="share-btn" href="https://twitter.com/intent/tweet?text=${encodeURIComponent((player.nickname || player.name) + ' on ATMNOPIN™')}&url=${encodeURIComponent(shareUrl)}" target="_blank" rel="noopener">𝕏 Share</a>
            <button class="share-btn" onclick="navigator.clipboard.writeText('${escapeHtml(shareUrl)}').then(function(){this.textContent='Copied!';var b=this;setTimeout(function(){b.textContent='Copy Link';},2000);}.bind(this))">Copy Link</button>
          </div>
        </div>` : ''}
      </article>
      ${others.length ? `<aside class="card">
        <h2>More Players</h2>
        <div class="others-section">
          ${others.map((p) => {
            const obs = getPlayerBadges(p);
            return `<article class="other-card">${obs.slice(0,1).map((b) => renderBadge(b)).join('')}<h4><a href="/players/${escapeHtml(p.slug)}">${escapeHtml(p.nickname || p.name)}</a></h4>${p.city ? `<p class="small">${escapeHtml(p.city)}</p>` : ''}${p.points ? `<p style="font-size:.6rem;color:var(--gold);margin-top:.2rem;">🏆 ${p.points} pts</p>` : ''}</article>`;
          }).join('')}
        </div>
        <div style="margin-top:1rem;"><a href="/community-wall" style="font-size:.78rem;text-transform:uppercase;letter-spacing:.12em;">View All Players →</a></div>
      </aside>` : ''}
    </section>`);
}

function renderAIProfileGeneratorPage(error) {
  return renderLayout('AI Poker Profile Generator | ATMwithNoPIN', `
    <meta name="description" content="Create a funny AI-generated poker profile, nickname, Chronicle, and Community Wall entry with ATMwithNoPIN." />
    <style>
      .aipg-hero{background:linear-gradient(160deg,#071a0d 0%,#0a0a0a 55%);border-bottom:1px solid rgba(0,200,83,.1);padding:4rem 2.5rem 3rem;text-align:center;}
      .aipg-badge{display:inline-flex;align-items:center;gap:.4rem;background:rgba(0,200,83,.1);border:1px solid rgba(0,200,83,.35);color:var(--green);font-size:.58rem;letter-spacing:.22em;text-transform:uppercase;padding:.28rem .8rem;border-radius:999px;margin-bottom:1.1rem;}
      .aipg-h1{font-family:'Bebas Neue',sans-serif;font-size:clamp(2.4rem,5vw,4rem);letter-spacing:.04em;color:var(--offwhite);line-height:1.05;margin-bottom:.75rem;}
      .aipg-h1 span{color:var(--green);}
      .aipg-sub{font-size:.82rem;line-height:1.85;color:#b0a898;max-width:58ch;margin:0 auto .75rem;}
      .aipg-warning{font-size:.72rem;color:var(--gold);font-style:italic;margin-top:.25rem;}
      .aipg-features{display:flex;gap:.5rem;flex-wrap:wrap;justify-content:center;margin-top:1.25rem;}
      .aipg-feat-pill{font-size:.58rem;letter-spacing:.12em;text-transform:uppercase;padding:.2rem .65rem;border:1px solid #222;border-radius:999px;color:#888;}
      .aipg-form-wrap{max-width:720px;margin:2rem auto;padding:0 1.5rem;}
      .aipg-section-hdr{font-size:.6rem;text-transform:uppercase;letter-spacing:.2em;color:var(--green);padding:.5rem 0 .3rem;border-bottom:1px solid #1a1a1a;margin:1.25rem 0 .5rem;}
      .aipg-form label{display:grid;gap:.3rem;font-size:.72rem;color:var(--gray);text-transform:uppercase;letter-spacing:.12em;margin-bottom:.6rem;}
      .aipg-form input,.aipg-form textarea,.aipg-form select{width:100%;border:1px solid #242424;background:#121212;color:var(--offwhite);padding:.75rem .9rem;border-radius:10px;font:inherit;}
      .aipg-form textarea{min-height:90px;resize:vertical;}
      .aipg-opt{font-size:.6rem;text-transform:none;letter-spacing:0;color:#555;margin-left:.3rem;font-style:italic;}
      .aipg-req{color:var(--green);margin-left:.15rem;}
      .aipg-consent{display:flex;align-items:flex-start;gap:.6rem;padding:.75rem;border:1px solid #1e3a28;background:#0c1a10;border-radius:10px;margin-bottom:1rem;}
      .aipg-consent input{width:auto;flex-shrink:0;margin-top:.2rem;}
      .aipg-consent label{text-transform:none;letter-spacing:0;font-size:.8rem;color:var(--offwhite);cursor:pointer;}
      .aipg-submit{width:100%;padding:1rem;font-size:.82rem;letter-spacing:.18em;background:var(--green);border:none;color:#000;border-radius:10px;cursor:pointer;font-weight:700;text-transform:uppercase;transition:opacity .2s;font-family:'DM Mono',monospace;}
      .aipg-submit:hover{opacity:.9;}
      .aipg-submit:disabled{opacity:.5;cursor:not-allowed;}
      .hp-field{position:absolute;left:-9999px;opacity:0;pointer-events:none;}
      .aipg-disclaimer{font-size:.65rem;color:#555;text-align:center;margin-top:.75rem;font-style:italic;}
    </style>
    <div class="aipg-hero">
      <div class="aipg-badge">✦ AI Poker Identity Engine</div>
      <h1 class="aipg-h1">Generate Your <span>Poker Profile</span></h1>
      <p class="aipg-sub">Tell us about your poker style, favorite game, home poker room, biggest bad beat, funniest table habit, and one story your poker friends still bring up. ATMwithNoPIN AI will turn it into your personalized poker identity.</p>
      <p class="aipg-warning">⚠ Warning: AI may reveal that you are actually the fish.</p>
      <div class="aipg-features">
        <span class="aipg-feat-pill">Funny Nickname</span>
        <span class="aipg-feat-pill">Poker Personality</span>
        <span class="aipg-feat-pill">Chronicle Draft</span>
        <span class="aipg-feat-pill">Playing Style</span>
        <span class="aipg-feat-pill">Signature Tell</span>
        <span class="aipg-feat-pill">Threat Level</span>
        <span class="aipg-feat-pill">Community Wall</span>
        <span class="aipg-feat-pill">Trading Card</span>
      </div>
    </div>
    <div class="aipg-form-wrap">
      ${error ? `<div class="notice" style="border-color:#5c1f1f;margin-bottom:1rem;">${escapeHtml(error)}</div>` : ''}
      <div class="card" style="padding:1.75rem;">
        <p class="small" style="color:#555;margin-bottom:1.25rem;"><span style="color:var(--green);">*</span> Required &nbsp;·&nbsp; All other fields make your AI profile more accurate and more entertaining.</p>
        <form id="aipgForm" class="aipg-form form-grid" enctype="multipart/form-data">
          <input class="hp-field" type="text" name="hp_url" tabindex="-1" autocomplete="off" aria-hidden="true" />

          <div class="aipg-section-hdr">About You</div>
          <label>Full Name <span class="aipg-req">*</span><input name="name" type="text" required maxlength="100" placeholder="Your real name" /></label>
          <label>Email <span class="aipg-req">*</span><input name="email" type="email" required maxlength="200" placeholder="you@example.com" /></label>
          <label>Poker Nickname <span class="aipg-opt">(optional — or let AI invent one)</span><input name="nickname" type="text" maxlength="80" placeholder="What they call you at the table" /></label>
          <label>City / Hometown <span class="aipg-opt">(optional)</span><input name="city" type="text" maxlength="100" placeholder="Las Vegas, NV" /></label>

          <div class="aipg-section-hdr">Your Game</div>
          <label>Home Poker Room <span class="aipg-opt">(optional)</span><input name="favorite_casino" type="text" maxlength="100" placeholder="Foxwoods, Horseshoe, home game..." /></label>
          <label>Favorite Game <span class="aipg-opt">(optional)</span><input name="favorite_game" type="text" maxlength="100" placeholder="$2/$5 NLH, PLO, tournaments..." /></label>
          <label>Playing Style <span class="aipg-opt">(optional)</span><input name="playing_style" type="text" maxlength="100" placeholder="Tight-aggressive, calling station, maniac..." /></label>
          <label>Biggest Poker Strength <span class="aipg-opt">(optional — in your own words)</span><input name="biggest_strength" type="text" maxlength="200" placeholder="Reading players, patience, bluffing..." /></label>
          <label>Biggest Poker Weakness <span class="aipg-opt">(optional — be honest, AI will find out anyway)</span><input name="biggest_weakness" type="text" maxlength="200" placeholder="Tilt, calling too much, can't fold..." /></label>
          <label>Funniest Table Habit <span class="aipg-opt">(optional)</span><input name="funniest_habit" type="text" maxlength="300" placeholder="Always says 'nice hand' when I lose..." /></label>
          <label>How Do Your Friends Describe You? <span class="aipg-opt">(optional)</span>
            <select name="friends_opinion">
              <option value="">— Select one —</option>
              <option value="Tight and disciplined">Tight and disciplined</option>
              <option value="Loose and aggressive">Loose and aggressive</option>
              <option value="Calling station">Calling station</option>
              <option value="The fish (lovingly)">The fish (lovingly)</option>
              <option value="A maniac">A maniac</option>
              <option value="Solid but predictable">Solid but predictable</option>
              <option value="Unpredictable">Unpredictable — nobody knows</option>
            </select>
          </label>

          <div class="aipg-section-hdr">Your Stories</div>
          <label>Biggest Poker Accomplishment <span class="aipg-opt">(optional)</span><textarea name="biggest_accomplishment" maxlength="800" placeholder="Final tabled the WSOP Main, won a home game once..."></textarea></label>
          <label>Biggest Poker Goal <span class="aipg-opt">(optional)</span><input name="biggest_goal" type="text" maxlength="400" placeholder="Win a bracelet, grind to a million..." /></label>
          <label>Funniest Poker Story <span class="aipg-opt">(optional — becomes your AI Chronicle)</span><textarea name="funny_story" maxlength="2000" placeholder="The story your poker friends still bring up..."></textarea></label>
          <label>Worst Bad Beat <span class="aipg-opt">(optional)</span><textarea name="bad_beat_story" maxlength="2000" placeholder="Aces cracked. Again."></textarea></label>

          <div class="aipg-section-hdr">Social &amp; Photo</div>
          <label>Social Handle <span class="aipg-opt">(optional — X, TikTok, Instagram)</span><input name="social_link" type="url" maxlength="300" placeholder="https://twitter.com/yourhandle" /></label>
          <label>Profile Photo <span class="aipg-opt">(optional — JPG/PNG/WEBP, max 5MB. Unlocks Poker Trading Card.)</span><input name="photo" type="file" accept="image/jpeg,image/png,image/webp" /></label>

          <div class="aipg-consent">
            <input name="permission" type="checkbox" id="aipgPerm" required />
            <label for="aipgPerm">I understand this information may be used to generate a funny poker profile, Chronicle draft, and Community Wall entry. I will review and approve before anything is published. I give ATMNOPIN™ permission to feature my name and stories on their website. <span style="color:var(--green);">*</span></label>
          </div>

          <button class="aipg-submit" type="submit" id="aipgSubmitBtn">Generate My Poker Profile ✨</button>
          <div class="notice" id="aipgStatus" style="display:none;margin-top:.75rem;"></div>
          <p class="aipg-disclaimer">Profiles are generated for entertainment and may be exaggerated for comedic effect. Content requires admin review before appearing publicly.</p>
        </form>
      </div>
    </div>
    <script>
    (function() {
      var form = document.getElementById('aipgForm');
      var statusEl = document.getElementById('aipgStatus');
      var submitBtn = document.getElementById('aipgSubmitBtn');
      if (!form) return;
      form.addEventListener('submit', async function(e) {
        e.preventDefault();
        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Submitting...'; }
        statusEl.style.display = '';
        statusEl.style.borderColor = '#1e1e1e';
        statusEl.textContent = 'Submitting your info...';
        try {
          var fd = new FormData(form);
          var res = await fetch('/request-feature', { method: 'POST', body: fd });
          var data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Submission failed.');
          statusEl.textContent = data.message || 'Submitted! Generating your poker profile...';
          statusEl.style.borderColor = '#1f5c31';
          form.style.opacity = '.5';
          form.style.pointerEvents = 'none';
          if (data.profile_url) {
            setTimeout(function() { window.location.href = data.profile_url; }, 1000);
          }
        } catch(err) {
          statusEl.textContent = err.message;
          statusEl.style.borderColor = '#5c1f1f';
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Generate My Poker Profile ✨'; }
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
  body.append('folder', 'atmnopin');

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

function renderHeroCarousel() {
  const cardsHtml = HERO_PROFILES.map((p) => {
    const linkHtml = `<a class="hc-card-link" href="${escapeHtml(p.href)}">${escapeHtml(p.cta || 'View Profile →')}</a>`;
    return `<div class="hc-card" data-type="${escapeHtml(p.type)}" role="listitem">
      <div class="hc-icon" aria-hidden="true">${escapeHtml(p.icon)}</div>
      <span class="hc-badge ${escapeHtml(p.badgeClass)}">${escapeHtml(p.badge)}</span>
      <div class="hc-name">${escapeHtml(p.name)}</div>
      <div class="hc-nickname">&ldquo;${escapeHtml(p.nickname)}&rdquo;</div>
      <div class="hc-summary">${escapeHtml(p.summary)}</div>
      <div class="hc-location">&#x1F4CD; ${escapeHtml(p.location)}</div>
      ${linkHtml}
    </div>`;
  }).join('');
  return `<div class="hc-panel">
  <div class="hc-header">
    <p class="hc-eyebrow">// Meet the Table</p>
    <h2 class="hc-heading">Get on the <em>Community Wall</em></h2>
    <p class="hc-sub">Players, dealers, floor staff, poker friends — submit your story and get featured.</p>
  </div>
  <div class="hc-carousel" id="hcCarousel">
    <div class="hc-viewport" id="hcViewport" role="list" tabindex="0" aria-label="Community profiles carousel">
      <div class="hc-track" id="hcTrack">${cardsHtml}</div>
    </div>
    <div class="hc-carousel-footer">
      <button class="hc-arrow" id="hcPrev" aria-label="Previous profiles" disabled>&#x2039;</button>
      <div class="hc-dots" id="hcDots" role="tablist" aria-label="Profile navigation"></div>
      <button class="hc-arrow" id="hcNext" aria-label="Next profiles">&#x203a;</button>
    </div>
  </div>
  <nav class="hc-cats" aria-label="Browse by type">
    <a href="/community-wall" class="hc-cat">&#x2660; Players</a>
    <a href="/community-wall" class="hc-cat">&#x2666; Dealers</a>
    <a href="/community-wall" class="hc-cat">&#x2663; Floor Staff</a>
    <a href="/community-wall" class="hc-cat">&#x2665; Poker Friends</a>
    <a href="/ai-profile-generator" class="hc-cat hc-cat-you">? You?</a>
  </nav>
  <div class="hc-cta-bar">
    <p class="hc-cta-text">Generate your AI poker profile and get featured on the community wall.</p>
    <a href="/ai-profile-generator" class="hc-cta-btn">Get Featured →</a>
  </div>
</div>`;
}

function renderTournamentSection() {
  const cardsHtml = TOURNAMENT_RESULTS.map((r) => {
    const descHtml = escapeHtml(r.desc).replace(/\n\n/g, '<br><br>');
    const numAttrs = r.valueStyle ? ` style="${r.valueStyle}"` : '';
    const badgeHtml = r.badge
      ? `<div class="t-badge">&#x1F3C6; ${escapeHtml(r.badge)}</div>`
      : '';
    return `<div class="t-card">
      <div class="t-label">${escapeHtml(r.label)}</div>
      <div class="t-num${r.valueClass ? ' ' + escapeHtml(r.valueClass) : ''}"${numAttrs}>${escapeHtml(r.value)}</div>
      <p class="t-desc">${descHtml}</p>
      ${badgeHtml}
    </div>`;
  }).join('');
  return `<div class="section-divider"><div class="hp-section"><p class="section-label">// The Results</p><h2>Tournament Journey</h2><p class="body-text">From $2/$5 cash games to WSOP deep runs — tracking the mission in real time.</p><div class="tournament-grid">${cardsHtml}</div><div class="section-cta-row"><a href="/blog" class="section-cta-link">Read all tournament stories →</a></div></div></div>`;
}

function renderInsideTheATMPage() {
  return renderLayout('Inside the ATM | ATMNOPIN™', `
<style>
  .ita-hero{padding:2.5rem 0 2rem;border-bottom:1px solid #1e1e1e;}
  .ita-hero .eyebrow{font-size:.6rem;letter-spacing:.25em;text-transform:uppercase;color:var(--green);margin-bottom:.75rem;}
  .ita-h1{font-family:'Bebas Neue',sans-serif;font-size:clamp(3rem,8vw,5rem);line-height:1;color:var(--offwhite);margin-bottom:.75rem;}
  .ita-lead{font-size:.88rem;color:#c0b8a8;max-width:55ch;line-height:1.85;}
  .ita-section{padding:2.5rem 0;border-top:1px solid #1e1e1e;margin-top:2.5rem;}
  .ita-section:first-of-type{margin-top:0;}
  .ita-label{font-size:.58rem;letter-spacing:.25em;text-transform:uppercase;color:var(--green);margin-bottom:.85rem;}
  .ita-h2{font-family:'DM Serif Display',serif;font-size:clamp(1.7rem,3.5vw,2.4rem);color:var(--offwhite);margin-bottom:.65rem;line-height:1.2;}
  .ita-h2 em{color:var(--gold);font-style:italic;}
  .ita-body{font-size:.8rem;line-height:1.9;color:#c0b8a8;max-width:52ch;}
  /* About */
  .ita-about{display:grid;grid-template-columns:1fr 1fr;gap:2.5rem;margin-top:1.75rem;align-items:start;}
  .dhezz-portrait{border:1px solid #1e1e1e;overflow:hidden;}
  .dhezz-portrait img{width:100%;display:block;transition:transform .4s;}
  .dhezz-portrait:hover img{transform:scale(1.02);}
  .portrait-caption{padding:.9rem 1.1rem;background:#0d0d0d;border-top:1px solid #1e1e1e;}
  .caption-tag{font-size:.5rem;letter-spacing:.2em;text-transform:uppercase;color:var(--green);display:block;margin-bottom:.35rem;}
  .portrait-caption p{font-family:'DM Serif Display',serif;font-style:italic;font-size:.84rem;color:var(--offwhite);line-height:1.6;}
  .caption-sub{display:block;margin-top:.35rem;font-size:.6rem;color:#7a7268;letter-spacing:.08em;}
  /* House Rules */
  .rules-stack{display:flex;flex-direction:column;gap:.85rem;margin-top:1.25rem;}
  .rule{padding:1.1rem;border:1px solid #1e1e1e;position:relative;overflow:hidden;transition:border-color .3s;}
  .rule:hover{border-color:var(--green-dim);}
  .rule::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--green);transform:scaleY(0);transition:transform .3s;transform-origin:bottom;}
  .rule:hover::before{transform:scaleY(1);}
  .rule-num{font-family:'Bebas Neue',sans-serif;font-size:.7rem;letter-spacing:.2em;color:var(--green);margin-bottom:.25rem;}
  .rule-title{font-family:'DM Serif Display',serif;font-size:.98rem;color:var(--offwhite);margin-bottom:.25rem;}
  .rule-body{font-size:.72rem;color:#8a8278;line-height:1.7;}
  /* Foxwoods */
  .ita-fw-grid{display:grid;grid-template-columns:1fr 2fr;gap:1.5rem;margin-top:1.5rem;}
  .fw-left{background:var(--felt);padding:2.5rem;position:relative;overflow:hidden;}
  .fw-left::before{content:'♠';position:absolute;bottom:-1rem;right:-1rem;font-size:8rem;color:rgba(0,200,83,0.06);pointer-events:none;}
  .fw-left h3{font-family:'DM Serif Display',serif;font-size:clamp(1.6rem,3vw,2.6rem);color:var(--offwhite);margin-bottom:.4rem;}
  .fw-left h3 em{color:var(--green);}
  .fw-tag{font-size:.6rem;letter-spacing:.14em;text-transform:uppercase;color:var(--green-dim);line-height:1.6;}
  .fw-right{padding:1.75rem;border:1px solid #1e1e1e;background:#0c0c0c;display:flex;flex-direction:column;gap:1.1rem;justify-content:center;}
  .fw-quote{font-family:'DM Serif Display',serif;font-size:clamp(1rem,1.8vw,1.4rem);font-style:italic;color:var(--offwhite);line-height:1.4;padding-left:1.1rem;border-left:3px solid var(--green);}
  .fw-body{font-size:.78rem;line-height:1.9;color:#c0b8a8;}
  .fw-punchline{font-family:'DM Serif Display',serif;font-size:.95rem;font-style:italic;color:var(--gold);}
  .fw-stats{display:flex;gap:2rem;padding-top:1.1rem;border-top:1px solid #1e1e1e;flex-wrap:wrap;}
  .fw-stat-num{font-family:'Bebas Neue',sans-serif;font-size:1.9rem;color:var(--green);line-height:1;}
  .fw-stat-label{font-size:.56rem;letter-spacing:.14em;text-transform:uppercase;color:#7a7268;}
  /* Schedule */
  .sched-grid{display:grid;gap:1px;background:#1a1a1a;margin-top:1.25rem;}
  .sched-row{display:grid;grid-template-columns:100px 1fr 110px 130px;gap:1.25rem;padding:1.1rem 1.25rem;background:var(--black);align-items:center;transition:background .2s;}
  .sched-row:hover{background:#0e0e0e;}
  .sched-row.hdr{font-size:.56rem;letter-spacing:.2em;text-transform:uppercase;color:#666;background:#080808;}
  .sched-date{font-size:.74rem;color:var(--green);}
  .sched-venue{font-size:.76rem;color:var(--offwhite);}
  .sched-game{font-size:.68rem;color:#8a8278;}
  .sched-status{display:inline-block;padding:3px 8px;font-size:.56rem;letter-spacing:.1em;text-transform:uppercase;border-radius:2px;}
  .s-likely{background:rgba(201,168,76,.12);color:var(--gold);border:1px solid rgba(201,168,76,.3);}
  .s-tbd{background:#111;color:#666;border:1px solid #2a2a2a;}
  .no-sched{padding:1.75rem;text-align:center;color:#666;font-size:.72rem;border:1px dashed #2a2a2a;margin-top:1px;}
  /* Staff */
  .staff-role-label{font-size:.56rem;letter-spacing:.25em;text-transform:uppercase;color:var(--green);padding-bottom:.45rem;border-bottom:1px solid #1a1a1a;margin:2rem 0 1rem;}
  .staff-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:#1a1a1a;}
  .staff-card{background:#0a0a0a;padding:1.4rem;transition:background .2s;display:flex;flex-direction:column;gap:.65rem;}
  .staff-card:hover{background:#0e0e0e;}
  .staff-top{display:flex;align-items:center;gap:.8rem;}
  .staff-initial{width:40px;height:40px;border:1px solid #2a2a2a;display:flex;align-items:center;justify-content:center;font-family:'Bebas Neue',sans-serif;font-size:1.2rem;color:var(--green);flex-shrink:0;}
  .staff-name{font-family:'Bebas Neue',sans-serif;font-size:1.25rem;letter-spacing:.1em;color:var(--offwhite);line-height:1;}
  .staff-role{font-size:.54rem;letter-spacing:.18em;text-transform:uppercase;color:#7a7268;margin-top:.1rem;}
  .staff-quote{font-family:'DM Serif Display',serif;font-style:italic;font-size:.76rem;color:#a09888;line-height:1.6;padding-left:.7rem;border-left:2px solid #2a2a2a;}
  .staff-banter{display:flex;flex-direction:column;gap:.12rem;padding:.45rem .65rem;background:#111;border:1px solid #1a1a1a;}
  .banter-label{font-size:.52rem;letter-spacing:.12em;text-transform:uppercase;color:#5a5a5a;}
  .banter-text{font-size:.7rem;color:var(--offwhite);line-height:1.5;}
  .staff-footer{margin-top:1.75rem;padding:1.1rem;border:1px solid #1a1a1a;text-align:center;font-size:.68rem;color:#666;font-style:italic;line-height:1.8;}
  /* Crew */
  .crew-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:#1a1a1a;margin-top:1.25rem;}
  .crew-card{background:var(--black);padding:1.6rem;transition:background .2s;border-left:3px solid transparent;}
  .crew-card:hover{background:#0d0d0d;border-left-color:var(--green);}
  .crew-card-open{border-left:3px solid #1a1a1a!important;}
  .crew-card-open:hover{border-left-color:#2a2a2a!important;}
  .crew-header{display:flex;align-items:center;gap:.9rem;margin-bottom:.9rem;}
  .crew-suit{font-size:2rem;color:var(--green);line-height:1;}
  .crew-name{font-family:'Bebas Neue',sans-serif;font-size:1.55rem;letter-spacing:.08em;color:var(--offwhite);line-height:1;}
  .crew-alias{font-family:'DM Serif Display',serif;font-style:italic;font-size:.8rem;color:var(--gold);margin-top:.12rem;}
  .crew-bio{font-size:.72rem;line-height:1.8;color:#666;margin-bottom:1.1rem;}
  .crew-stats{display:flex;flex-direction:column;gap:.35rem;}
  .crew-stat{display:flex;justify-content:space-between;align-items:center;padding:.3rem 0;border-top:1px solid #111;font-size:.62rem;}
  .cs-label{color:#5a5a5a;letter-spacing:.1em;text-transform:uppercase;font-size:.56rem;}
  .cs-val{color:var(--offwhite);text-align:right;}
  .cs-green{color:var(--green);}.cs-gold{color:var(--gold);}
  /* Hall */
  .hall-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:#1a1a1a;margin-top:1.25rem;}
  .winner-card{background:var(--black);padding:1.6rem;transition:background .2s;}
  .winner-card:hover{background:#0d0d0d;}
  .winner-rank{font-family:'Bebas Neue',sans-serif;font-size:2.6rem;color:#1a1a1a;line-height:1;margin-bottom:.35rem;}
  .winner-rank.gold{color:rgba(201,168,76,.4);}.winner-rank.silver{color:rgba(180,180,180,.3);}.winner-rank.bronze{color:rgba(140,90,50,.3);}
  .winner-name{font-family:'DM Serif Display',serif;font-size:1.15rem;color:var(--offwhite);}
  .winner-amount{color:var(--green);font-size:.8rem;margin-top:.2rem;}
  .winner-note{font-size:.66rem;color:#555;margin-top:.35rem;line-height:1.5;}
  .hall-cta{margin-top:1.5rem;text-align:center;font-size:.7rem;color:#555;}
  /* Responsive */
  @media(max-width:980px){
    .ita-about{grid-template-columns:1fr;}
    .ita-fw-grid{grid-template-columns:1fr;}
    .sched-row{grid-template-columns:1fr 1fr;gap:.65rem;}
    .sched-row.hdr{display:none;}
    .staff-grid{grid-template-columns:1fr;}
    .crew-grid{grid-template-columns:1fr;}
    .hall-grid{grid-template-columns:1fr;}
  }
</style>

<div class="ita-hero">
  <p class="eyebrow">// The ATM Universe</p>
  <h1 class="ita-h1">Inside the ATM</h1>
  <p class="ita-lead">The people, places, rules, and ridiculous stories behind ATMNOPIN™ — from the Foxwoods home base to wherever the action takes us next.</p>
  <div style="margin-top:1.5rem;display:flex;gap:1rem;flex-wrap:wrap;">
    <a href="/chronicles" class="pill">Chronicles →</a>
    <a href="/community-wall" class="pill">Community Wall →</a>
    <a href="/blog" class="pill">Stories →</a>
  </div>
</div>

<div class="ita-section">
  <p class="ita-label">// About ATMNOPIN™</p>
  <h2 class="ita-h2">Who is <em>Dhezz</em>?</h2>
  <div class="ita-about">
    <div>
      <p class="ita-body">Find Dhezz at Foxwoods, WSOP stops, and $2/$5 NLH games across the Northeast. The brand follows his poker journey through live updates, photos, videos, table stories, and occasional questionable calls.</p>
      <p class="ita-body" style="margin-top:.8rem;">ATMNOPIN™ keeps the table humor intact — the fish jokes, the bad beat stories, and the confidence that somehow always feels one hand away from turning into a legendary session.</p>
      <div style="margin-top:1.75rem;">
        <p class="ita-label">// House Rules</p>
        <div class="rules-stack">
          <div class="rule"><div class="rule-num">01</div><div class="rule-title">No PIN. No Problem.</div><div class="rule-body">Just sit down. The chips have already started moving in your direction. Think of it as contactless payment.</div></div>
          <div class="rule"><div class="rule-num">02</div><div class="rule-title">Good Times Included</div><div class="rule-body">Every session comes with commentary, self-deprecating analysis of every fold, and at least one hand history that will haunt you.</div></div>
          <div class="rule"><div class="rule-num">03</div><div class="rule-title">The Table Is Better With Dhezz</div><div class="rule-body">Ask anyone who's sat with him. The vibes are immaculate. The poker decisions, less so.</div></div>
          <div class="rule"><div class="rule-num">04</div><div class="rule-title">Results May Vary. Entertainment Won't.</div><div class="rule-body">He cannot guarantee you'll win money. He can guarantee you'll have a story to tell your poker group chat later.</div></div>
        </div>
      </div>
    </div>
    <div>
      <div class="dhezz-portrait">
        <img src="/dhezz.jpeg" alt="Dhezz at the poker table" loading="lazy">
        <div class="portrait-caption">
          <span class="caption-tag">&#x2756; Actual Photo — Not Staged</span>
          <p>"That stack? Gone in 20 minutes.<br>The hat? Still on his head.<br>The smile? Never left."</p>
          <span class="caption-sub">— Every Foxwoods dealer, probably</span>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="ita-section">
  <p class="ita-label">// Home Base</p>
  <h2 class="ita-h2">Foxwoods <em>Resort Casino</em></h2>
  <div class="ita-fw-grid">
    <div class="fw-left">
      <h3>Foxwoods<br><em>Resort Casino</em></h3>
      <div class="fw-tag">Mashantucket, CT &mdash; The ATM's Natural Habitat</div>
    </div>
    <div class="fw-right">
      <div class="fw-quote">Where legends are made, fortunes are lost, and Dhezz shows up anyway.</div>
      <p class="fw-body">The greatest poker room in the Northeast, if only because the ATMNOPIN calls it home. Come find him at the $2/$5 table.</p>
      <p class="fw-punchline">He'll be the one smiling while his chips disappear.</p>
      <div class="fw-stats">
        <div><div class="fw-stat-num">$2/$5</div><div class="fw-stat-label">His game</div></div>
        <div><div class="fw-stat-num">&#x221E;</div><div class="fw-stat-label">Buy-ins</div></div>
        <div><div class="fw-stat-num">0</div><div class="fw-stat-label">Regrets</div></div>
        <div><div class="fw-stat-num">100%</div><div class="fw-stat-label">Still smiling</div></div>
      </div>
    </div>
  </div>
</div>

<div class="ita-section">
  <p class="ita-label">// ATM Deployment Schedule</p>
  <h2 class="ita-h2">Find Me <em>at the Tables</em></h2>
  <div class="sched-grid">
    <div class="sched-row hdr"><span>Date</span><span>Venue</span><span>Game</span><span>Status</span></div>
    <div class="sched-row">
      <div class="sched-date">TBD</div>
      <div class="sched-venue">Foxwoods Resort Casino<span style="display:block;font-size:.62rem;color:#444;margin-top:2px;">Mashantucket, CT</span></div>
      <div class="sched-game">$2/$5 NLH</div>
      <div><span class="sched-status s-likely">Likely</span></div>
    </div>
    <div class="sched-row">
      <div class="sched-date">TBD</div>
      <div class="sched-venue">Traveling<span style="display:block;font-size:.62rem;color:#444;margin-top:2px;">Casino TBD</span></div>
      <div class="sched-game">$2/$5 NLH</div>
      <div><span class="sched-status s-tbd">TBD</span></div>
    </div>
  </div>
  <div class="no-sched">&#x1F4E1; &nbsp; Follow on social for real-time session announcements — "The ATM is open."</div>
</div>

<div class="ita-section">
  <p class="ita-label">// The Real MVPs</p>
  <h2 class="ita-h2">Foxwoods Staff — <em>The Unsung Heroes</em></h2>
  <p class="ita-body">They deal the cards, run the floor, and somehow still show up knowing Dhezz is coming. This one's for the people who make the Foxwoods poker room the greatest place to donate chips in the Northeast.</p>
  <div class="staff-role-label">// Floor Staff</div>
  <div class="staff-grid">
    <div class="staff-card"><div class="staff-top"><div class="staff-initial">B</div><div><div class="staff-name">Bhavin</div><div class="staff-role">Floor</div></div></div><div class="staff-quote">"The man who helps Dhezz get seated faster than Dhezz can lose his chips."</div><div class="staff-banter"><span class="banter-label">What Dhezz says:</span><span class="banter-text">"Thank you, Bhavin."</span></div><div class="staff-banter"><span class="banter-label">What Bhavin does:</span><span class="banter-text">Helps anyway. Every time. A true professional.</span></div></div>
    <div class="staff-card"><div class="staff-top"><div class="staff-initial" style="color:#c44;">C</div><div><div class="staff-name">Charlie</div><div class="staff-role">Floor</div></div></div><div class="staff-quote">"Foxwoods' most secure employee. No severance package could save him from Dhezz's commentary."</div><div class="staff-banter"><span class="banter-label">What Dhezz says:</span><span class="banter-text">"Fire Charlie! No Severance!"</span></div><div class="staff-banter"><span class="banter-label">What Charlie does:</span><span class="banter-text">Shows up again tomorrow. Unfazed. Untouchable. Undefeated.</span></div></div>
    <div class="staff-card"><div class="staff-top"><div class="staff-initial" style="color:var(--gold);">S</div><div><div class="staff-name">Steve</div><div class="staff-role">Floor</div></div></div><div class="staff-quote">"Born on the same day and month as Dhezz. The universe's most suspicious coincidence."</div><div class="staff-banter"><span class="banter-label">What they share:</span><span class="banter-text">Same birthday. That's where the similarities end.</span></div><div class="staff-banter"><span class="banter-label">Fun fact:</span><span class="banter-text">Steve has kept his chips. Dhezz has not.</span></div></div>
  </div>
  <div class="staff-role-label">// The Dealers — Artists of Chaos</div>
  <div class="staff-grid">
    <div class="staff-card"><div class="staff-top"><div class="staff-initial">F</div><div><div class="staff-name">Felix</div><div class="staff-role">Dealer</div></div></div><div class="staff-quote">"A man of eternal optimism, matching Dhezz's energy beat for beat."</div><div class="staff-banter"><span class="banter-label">Dhezz says:</span><span class="banter-text">"Coming Soon."</span></div><div class="staff-banter"><span class="banter-label">Felix fires back:</span><span class="banter-text">"Very Soon." &#x1F0CF;</span></div></div>
    <div class="staff-card"><div class="staff-top"><div class="staff-initial" style="color:#c44;">R</div><div><div class="staff-name">Ray</div><div class="staff-role">Dealer</div></div></div><div class="staff-quote">"The dealer who gives as good as he gets. Mutual respect at its finest."</div><div class="staff-banter"><span class="banter-label">Dhezz says:</span><span class="banter-text">"You suck, Ray."</span></div><div class="staff-banter"><span class="banter-label">Ray fires back:</span><span class="banter-text">"You suck." No hesitation. No apology.</span></div></div>
    <div class="staff-card"><div class="staff-top"><div class="staff-initial" style="color:var(--gold);">J</div><div><div class="staff-name">Jenny</div><div class="staff-role">Dealer</div></div></div><div class="staff-quote">"The zen master of the felt. One word. Always the right one."</div><div class="staff-banter"><span class="banter-label">Dhezz, panicking:</span><span class="banter-text">*does something impulsive*</span></div><div class="staff-banter"><span class="banter-label">Jenny, calmly:</span><span class="banter-text">"Patience." &#x1F9D8;</span></div></div>
    <div class="staff-card"><div class="staff-top"><div class="staff-initial">S</div><div><div class="staff-name">Saku</div><div class="staff-role">Dealer</div></div></div><div class="staff-quote">"Prescribed the only known cure for Dhezz's chip-losing condition."</div><div class="staff-banter"><span class="banter-label">The situation:</span><span class="banter-text">Dhezz about to give away his stack. Again.</span></div><div class="staff-banter"><span class="banter-label">Saku's prescription:</span><span class="banter-text">"Fevicol." — Hold on to your chips, man.</span></div></div>
    <div class="staff-card"><div class="staff-top"><div class="staff-initial" style="color:var(--green);">D</div><div><div class="staff-name">Dave</div><div class="staff-role">Dealer</div></div></div><div class="staff-quote">"The only dealer who gets his own personalized greeting. Every. Single. Time."</div><div class="staff-banter"><span class="banter-label">Dhezz, every time:</span><span class="banter-text">"Behave, Dave." &#x1F604;</span></div><div class="staff-banter"><span class="banter-label">Dave's response:</span><span class="banter-text">*deals another bad beat* Mission not accomplished.</span></div></div>
  </div>
  <div class="staff-footer">&#x2660; &nbsp; To all the Foxwoods poker room staff — thank you for the memories, the laughs, and for not banning Dhezz yet. You are the real winners here.</div>
</div>

<div class="ita-section">
  <p class="ita-label">// The Usual Suspects</p>
  <h2 class="ita-h2">The Crew has <em>moved</em></h2>
  <p class="ita-body">Manny, Jamie, Ducky Jay, and the rest of the usual suspects now live on the Community Wall — alongside every other player, table character, and poker friend in the ATMNOPIN™ universe.</p>
  <div style="margin-top:1.5rem;display:flex;gap:.75rem;flex-wrap:wrap;align-items:center;">
    <a href="/community-wall" class="pill" style="background:var(--green);color:#000;border-color:var(--green);">Meet The Crew →</a>
    <a href="/ai-profile-generator" class="pill">Get Featured →</a>
  </div>
</div>

<div class="ita-section">
  <p class="ita-label">// Hall of Winners</p>
  <h2 class="ita-h2">The Leaderboard of <em>Grateful Recipients</em></h2>
  <div class="hall-grid">
    <div class="winner-card"><div class="winner-rank gold">01</div><div class="winner-name">Manny "The Machine"</div><div class="winner-amount">Clockwork. Every time.</div><div class="winner-note">Deposits so reliably he should be registered as a financial institution. The undisputed champion of giving Dhezz's chips a new home.</div></div>
    <div class="winner-card"><div class="winner-rank silver">02</div><div class="winner-name">Jamie "The Tuna"</div><div class="winner-amount">Never saw it coming.</div><div class="winner-note">Called every bet, folded none, won somehow. A mystery wrapped in an enigma wrapped in a bad poker hand.</div></div>
    <div class="winner-card"><div class="winner-rank bronze">03</div><div class="winner-name">Seat Available</div><div class="winner-amount">—</div><div class="winner-note">Third place is wide open. Foxwoods. $2/$5. You know what to do.</div></div>
  </div>
  <div class="hall-cta">&#x1F3C6; &nbsp; Won a big pot off Dhezz? DM him on social to claim your spot on the leaderboard.</div>
</div>

<div style="margin-top:2.5rem;padding:2rem;background:#0c0c0c;border:1px solid #1e1e1e;display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;">
  <div style="padding:1.25rem;border:1px solid #1e1e1e;background:var(--black);"><p style="font-size:.58rem;letter-spacing:.15em;text-transform:uppercase;color:var(--green);margin-bottom:.45rem;">Chronicles</p><p style="font-size:.78rem;color:#888;margin-bottom:.7rem;">Stories from dealers, floor staff, and poker life at the Hall of Fame Poker Room.</p><a href="/chronicles" style="color:var(--green);font-size:.65rem;text-transform:uppercase;letter-spacing:.1em;">Read Chronicles →</a></div>
  <div style="padding:1.25rem;border:1px solid #1e1e1e;background:var(--black);"><p style="font-size:.58rem;letter-spacing:.15em;text-transform:uppercase;color:var(--green);margin-bottom:.45rem;">Community</p><p style="font-size:.78rem;color:#888;margin-bottom:.7rem;">Poker players from the ATMNOPIN universe — their stories, bad beats, and badges.</p><a href="/community-wall" style="color:var(--green);font-size:.65rem;text-transform:uppercase;letter-spacing:.1em;">View Community →</a></div>
  <div style="padding:1.25rem;border:1px solid #1e1e1e;background:var(--black);"><p style="font-size:.58rem;letter-spacing:.15em;text-transform:uppercase;color:var(--gold);margin-bottom:.45rem;">Get Featured</p><p style="font-size:.78rem;color:#888;margin-bottom:.7rem;">Got a story? Submit your profile and join the ATMNOPIN community wall.</p><a href="/ai-profile-generator" style="color:var(--gold);font-size:.65rem;text-transform:uppercase;letter-spacing:.1em;">Get Featured →</a></div>
</div>
`);
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
      res.end(renderLayout('ATMNOPIN™ Admin Login', `
        <section class="hero">
          <p class="eyebrow">Secure admin</p>
          <h1>Admin login</h1>
          <p class="body-text" style="max-width:52ch;">Use the credentials from your environment to access the ATMNOPIN™ blog and publishing dashboard.</p>
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
    const preloadedSubs = await loadSubmissions().catch(() => []);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderAdminPage(preloadedSubs));
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
    logPageVisit(req, pathname);
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
    logPageVisit(req, pathname);
    return;
  }

  if (pathname === '/inside-the-atm') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderInsideTheATMPage());
    logPageVisit(req, pathname);
    return;
  }

  if (pathname === '/chronicles') {
    const all = await loadChronicles();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderChroniclesListPage(all));
    logPageVisit(req, pathname);
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
    logPageVisit(req, pathname);
    return;
  }

  if (pathname === '/player-cards') {
    const all = await loadChronicles();
    const cards = buildPlayerCards(all);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderPlayerCardsPage(cards));
    logPageVisit(req, pathname);
    return;
  }

  if (pathname === '/api/admin/generate-player-profile' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const submissionId = String(body.submissionId || '').trim();
      const styleHints = String(body.styleHints || '').trim().slice(0, 500);
      if (!submissionId) throw new Error('submissionId is required.');

      const allSubs = await loadSubmissions();
      const sub = allSubs.find((s) => s.id === submissionId);
      if (!sub) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Submission not found.' })); return; }

      // Build context — intentionally omits email, IP, consent, location/city, admin_notes
      const ctx = [
        `Name: ${sub.name || ''}${sub.nickname ? ` (self-described nickname: "${sub.nickname}")` : ''}`,
        sub.favorite_game    ? `Favorite Game: ${sub.favorite_game}` : '',
        sub.favorite_casino  ? `Favorite Casino: ${sub.favorite_casino}` : '',
        sub.playing_style    ? `Playing Style (self-described): ${sub.playing_style.slice(0, 200)}` : '',
        sub.biggest_strength ? `Biggest Strength: ${sub.biggest_strength.slice(0, 200)}` : '',
        sub.biggest_weakness ? `Biggest Weakness: ${sub.biggest_weakness.slice(0, 200)}` : '',
        sub.funniest_habit   ? `Funniest Table Habit: ${sub.funniest_habit.slice(0, 200)}` : '',
        sub.friends_opinion  ? `Friends describe them as: ${sub.friends_opinion.slice(0, 200)}` : '',
        sub.biggest_accomplishment ? `Biggest Accomplishment: ${sub.biggest_accomplishment.slice(0, 300)}` : '',
        sub.biggest_goal     ? `Biggest Goal: ${sub.biggest_goal.slice(0, 200)}` : '',
        sub.funny_story      ? `Funny Story: ${sub.funny_story.slice(0, 500)}` : '',
        sub.bad_beat_story   ? `Bad Beat Story: ${sub.bad_beat_story.slice(0, 400)}` : '',
        sub.social_link      ? `Social/Profile link (use as-is in knownFor if relevant): ${sub.social_link}` : '',
        styleHints           ? `Admin style direction: ${styleHints}` : '',
      ].filter(Boolean).join('\n');

      const systemPrompt = `You are writing a player spotlight profile for ATMNOPIN™, a poker entertainment brand. Match the voice of existing profiles like "The Sugar Stacker" and "Lucky Horseshoe Luke": witty, poker-themed, community-friendly, never mean-spirited — think ESPN feature meets Foxwoods table banter.

RULES:
- Do NOT include hometown, city, state, or geographic location.
- Do NOT include email, IP, consent timestamp, or admin notes.
- Never be cruel. Friendly roasting only.
- The "content" field is the full narrative (300-500 words): short punchy paragraphs, lots of white space, ends with **ATMNOPIN Rating:** block (bold header + 6-8 bullet points) followed by a **Fun Fact:** line.
- Available badges: ${PLAYER_BADGES.join(', ')}.
- Default badge for community friends is "Fellow Fish".

Return ONLY valid JSON (no markdown fences) with EXACTLY these fields:
{
  "title": "Player Spotlight: [FirstName] — [Nickname]",
  "nickname": "[Poker Nickname]",
  "slug": "player-spotlight-[lowercase-kebab-of-nickname]",
  "badge": "Fellow Fish",
  "game": "$2/$5 NLH",
  "casino": "[Casino from submission or Foxwoods Resort Casino]",
  "about": "[2-3 sentence compelling teaser shown on listing pages, max 200 words]",
  "specialty": "[one-liner describing their poker specialty — funny]",
  "tell": "[their most obvious table tell — specific and funny]",
  "threatLevel": "[funny threat-level phrase matching existing style]",
  "luckyCharm": "[lucky charm or superstition if applicable, else empty string]",
  "knownFor": "[what they are known for at the table]",
  "tableReputation": "[how other players see them — one sentence]",
  "content": "[full narrative in ATMwithNoPIN voice with ATMNOPIN Rating and Fun Fact]"
}`;

      const raw = await callOpenAI(systemPrompt, ctx, 1600, true);
      let parsed;
      try { parsed = JSON.parse(raw); } catch { throw new Error('AI returned malformed JSON. Try regenerating.'); }

      const profile = {
        title:           String(parsed.title || '').slice(0, 200),
        nickname:        String(parsed.nickname || sub.nickname || sub.name || '').slice(0, 100),
        slug:            '',
        badge:           String(parsed.badge || 'Fellow Fish').slice(0, 80),
        game:            String(parsed.game || sub.favorite_game || '').slice(0, 80),
        casino:          String(parsed.casino || sub.favorite_casino || '').slice(0, 100),
        about:           String(parsed.about || '').slice(0, 1000),
        specialty:       String(parsed.specialty || '').slice(0, 300),
        tell:            String(parsed.tell || '').slice(0, 200),
        threatLevel:     String(parsed.threatLevel || '').slice(0, 200),
        luckyCharm:      String(parsed.luckyCharm || '').slice(0, 200),
        knownFor:        String(parsed.knownFor || '').slice(0, 200),
        tableReputation: String(parsed.tableReputation || '').slice(0, 200),
        content:         String(parsed.content || '').slice(0, 8000),
      };

      // Build & deduplicate slug
      const existingChronicles = await loadChronicles();
      const slugSet = new Set(existingChronicles.map((c) => c.slug));
      let base = slugify(String(parsed.slug || profile.nickname || 'player-spotlight'));
      if (!base.startsWith('player-spotlight')) base = 'player-spotlight-' + base;
      let final = base; let n = 2;
      while (slugSet.has(final)) { final = base + '-' + n++; }
      profile.slug = final;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, profile }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
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
        person_type: String(body.person_type || 'player').trim(),
        poker_room: String(body.poker_room || '').trim(),
        specialty: String(body.specialty || '').trim(),
        tell: String(body.tell || '').trim(),
        threat_level: String(body.threat_level || '').trim(),
        lucky_charm: String(body.lucky_charm || '').trim(),
        known_for: String(body.known_for || '').trim(),
        table_reputation: String(body.table_reputation || '').trim(),
        icon_type: String(body.icon_type || '♠').trim(),
        source_submission_id: String(body.source_submission_id || '').trim(),
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
        person_type: String(body.person_type !== undefined ? body.person_type : old.person_type || 'player').trim(),
        poker_room: String(body.poker_room !== undefined ? body.poker_room : old.poker_room || '').trim(),
        specialty: String(body.specialty !== undefined ? body.specialty : old.specialty || '').trim(),
        tell: String(body.tell !== undefined ? body.tell : old.tell || '').trim(),
        threat_level: String(body.threat_level !== undefined ? body.threat_level : old.threat_level || '').trim(),
        lucky_charm: String(body.lucky_charm !== undefined ? body.lucky_charm : old.lucky_charm || '').trim(),
        known_for: String(body.known_for !== undefined ? body.known_for : old.known_for || '').trim(),
        table_reputation: String(body.table_reputation !== undefined ? body.table_reputation : old.table_reputation || '').trim(),
        icon_type: String(body.icon_type !== undefined ? body.icon_type : old.icon_type || '♠').trim(),
        source_submission_id: String(body.source_submission_id !== undefined ? body.source_submission_id : old.source_submission_id || '').trim(),
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

  if (pathname === '/ai-profile-generator' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderAIProfileGeneratorPage());
    logPageVisit(req, pathname);
    return;
  }

  if (pathname === '/request-feature' && req.method === 'GET') {
    res.writeHead(301, { 'Location': '/ai-profile-generator' });
    res.end();
    return;
  }

  // ── Profile setup routes (magic-link token) ──────────────────────────────

  if (pathname.startsWith('/profile/setup/') && req.method === 'GET') {
    const token = pathname.split('/').pop();
    const all = await loadSubmissions();
    const profile = all.find((s) => s.edit_token === token);
    if (!profile) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderLayout('Profile Not Found | ATMNOPIN™', `<section class="hero"><h1>Profile Not Found</h1><p class="body-text">This profile link is invalid or has expired. <a href="/ai-profile-generator">Generate your profile →</a></p></section>`));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderProfileSetupPage(profile));
    return;
  }

  if (pathname.startsWith('/api/profile/') && req.method === 'GET') {
    const parts = pathname.split('/');
    const token = parts[3];
    const all = await loadSubmissions();
    const profile = all.find((s) => s.edit_token === token);
    if (!profile) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found.' })); return; }
    const safe = { ...profile };
    delete safe.consent_ip; delete safe.consent_city; delete safe.consent_region; delete safe.consent_country;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(safe));
    return;
  }

  if (pathname.match(/^\/api\/profile\/[^/]+\/submit$/) && req.method === 'POST') {
    const token = pathname.split('/')[3];
    const all = await loadSubmissions();
    const idx = all.findIndex((s) => s.edit_token === token);
    if (idx === -1) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found.' })); return; }
    const updated = { ...all[idx], submitted_for_review: true, submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    all[idx] = updated;
    await saveSubmissions(all);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (pathname.startsWith('/api/profile/') && !pathname.includes('/ai-') && !pathname.includes('/photo') && !pathname.endsWith('/submit') && req.method === 'POST') {
    const token = pathname.split('/')[3];
    const all = await loadSubmissions();
    const idx = all.findIndex((s) => s.edit_token === token);
    if (idx === -1) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found.' })); return; }
    try {
      const body = await parseJsonBody(req);
      const allowed = ['city', 'favorite_casino', 'favorite_game', 'social_link', 'biggest_accomplishment', 'biggest_goal', 'funny_story', 'bad_beat_story', 'nickname', 'playing_style', 'biggest_strength', 'biggest_weakness', 'funniest_habit', 'friends_opinion'];
      const updated = { ...all[idx] };
      for (const key of allowed) {
        if (body[key] !== undefined) updated[key] = String(body[key] || '').trim().slice(0, key.includes('story') ? 2000 : 400);
      }
      updated.updated_at = new Date().toISOString();
      updated.completion_score = computeCompletionScore(updated);
      all[idx] = updated;
      await saveSubmissions(all);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, completion_score: updated.completion_score }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (pathname.match(/^\/api\/profile\/[^/]+\/photo$/) && req.method === 'POST') {
    const token = pathname.split('/')[3];
    const all = await loadSubmissions();
    const idx = all.findIndex((s) => s.edit_token === token);
    if (idx === -1) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found.' })); return; }
    try {
      const contentType = req.headers['content-type'] || '';
      const boundary = contentType.split('boundary=')[1];
      if (!boundary) throw new Error('Multipart form required.');
      const bodyBuffer = await readBodyBuffer(req);
      const form = parseMultipartForm(bodyBuffer, boundary);
      if (!form.files.photo || !form.files.photo.filename) throw new Error('No photo file.');
      const photoFile = form.files.photo;
      if (!isSafeImage(photoFile.filename)) throw new Error('Invalid file type.');
      if (photoFile.data.length > 5 * 1024 * 1024) throw new Error('Photo is too large. Max 5MB.');
      let uploadResult = null;
      try { uploadResult = await uploadImageToCloudinary(photoFile.data, photoFile.filename, 'featured'); } catch { uploadResult = null; }
      if (!uploadResult) uploadResult = uploadImageLocally(photoFile.data, photoFile.filename);
      const updated = { ...all[idx], photo_url: uploadResult.url, updated_at: new Date().toISOString() };
      updated.completion_score = computeCompletionScore(updated);
      all[idx] = updated;
      await saveSubmissions(all);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, photo_url: uploadResult.url, completion_score: updated.completion_score }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (pathname.match(/^\/api\/profile\/[^/]+\/ai-personality$/) && req.method === 'POST') {
    const token = pathname.split('/')[3];
    if (!checkAIRateLimit(token)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Rate limit reached. Max 5 AI generations per day. Try again tomorrow.' }));
      return;
    }
    const all = await loadSubmissions();
    const idx = all.findIndex((s) => s.edit_token === token);
    if (idx === -1) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found.' })); return; }
    const p = all[idx];
    const score = computeCompletionScore(p);
    if (score < 40) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Complete at least 40% of your profile to generate an AI Poker Personality.' })); return; }
    try {
      const context = [
        `Name: ${p.name || ''}${p.nickname ? ' (nicknamed "' + p.nickname + '")' : ''}`,
        p.city ? `Hometown: ${p.city}` : '',
        p.favorite_casino ? `Favorite Casino: ${p.favorite_casino}` : '',
        p.favorite_game ? `Favorite Game: ${p.favorite_game}` : '',
        p.playing_style ? `Self-described Playing Style: ${p.playing_style}` : '',
        p.biggest_strength ? `Self-described Strength: ${p.biggest_strength}` : '',
        p.biggest_weakness ? `Self-described Weakness: ${p.biggest_weakness}` : '',
        p.funniest_habit ? `Funniest Table Habit: ${p.funniest_habit}` : '',
        p.friends_opinion ? `Friends describe them as: ${p.friends_opinion}` : '',
        p.biggest_accomplishment ? `Biggest Accomplishment: ${p.biggest_accomplishment.slice(0, 300)}` : '',
        p.biggest_goal ? `Biggest Goal: ${p.biggest_goal.slice(0, 200)}` : '',
        p.funny_story ? `Funny Story: ${p.funny_story.slice(0, 300)}` : '',
        p.bad_beat_story ? `Bad Beat: ${p.bad_beat_story.slice(0, 300)}` : '',
      ].filter(Boolean).join('\n');
      const systemPrompt = `You are a poker entertainment writer for ATMNOPIN™, a funny, irreverent poker content brand in the style of Foxwoods table banter. Write a poker identity profile for this player. Be playful, clever, and roast-y but never mean. Profiles are for entertainment only. Output JSON with EXACTLY these fields: text (2-3 paragraph poker personality bio, 150-250 words), tagline (one punchy shareable one-liner, under 20 words), style (one concise phrase for their playing style), strengths (array of 2-3 funny strengths), weaknesses (array of 2-3 funny weaknesses), suggested_nickname (a funny poker nickname if they don't have one already, else null), suggested_badges (array of 1-3 badge names from: ${PLAYER_BADGES.join(', ')}), signature_tell (their most obvious poker tell in under 15 words, funny), threat_level (a string like "6/10 — Will fold to any three-barrel"), table_quote (the one thing they probably say too much at the table, in quotes, under 15 words), hall_of_fame_potential (a short funny phrase, e.g. "Likely — if the Hall counts bad-beat storytellers").`;
      const raw = await callOpenAI(systemPrompt, context, 900, true);
      const parsed = JSON.parse(raw);
      const aiP = {
        text: String(parsed.text || '').slice(0, 1500),
        tagline: String(parsed.tagline || '').slice(0, 120),
        style: String(parsed.style || '').slice(0, 80),
        strengths: Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 3).map((s) => String(s).slice(0, 80)) : [],
        weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses.slice(0, 3).map((s) => String(s).slice(0, 80)) : [],
        suggested_nickname: parsed.suggested_nickname ? String(parsed.suggested_nickname).slice(0, 60) : null,
        suggested_badges: Array.isArray(parsed.suggested_badges) ? parsed.suggested_badges.filter((b) => PLAYER_BADGES.includes(b)).slice(0, 3) : [],
        signature_tell: parsed.signature_tell ? String(parsed.signature_tell).slice(0, 120) : null,
        threat_level: parsed.threat_level ? String(parsed.threat_level).slice(0, 80) : null,
        table_quote: parsed.table_quote ? String(parsed.table_quote).slice(0, 120) : null,
        hall_of_fame_potential: parsed.hall_of_fame_potential ? String(parsed.hall_of_fame_potential).slice(0, 120) : null,
        status: 'pending_review',
        generated_at: new Date().toISOString(),
      };
      const updated = { ...all[idx], ai_personality: aiP, updated_at: new Date().toISOString() };
      updated.completion_score = computeCompletionScore(updated);
      all[idx] = updated;
      await saveSubmissions(all);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...aiP, completion_score: updated.completion_score }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (pathname.match(/^\/api\/profile\/[^/]+\/ai-chronicle$/) && req.method === 'POST') {
    const token = pathname.split('/')[3];
    if (!checkAIRateLimit(token)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Rate limit reached. Max 5 AI generations per day.' }));
      return;
    }
    const all = await loadSubmissions();
    const idx = all.findIndex((s) => s.edit_token === token);
    if (idx === -1) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found.' })); return; }
    const score = computeCompletionScore(all[idx]);
    if (score < 40) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Complete at least 40% of your profile first.' })); return; }
    try {
      const body = await parseJsonBody(req);
      const storyType = String(body.story_type || 'Bad Beat').slice(0, 50);
      const rawText = String(body.raw_text || '').trim().slice(0, 2000);
      if (rawText.length < 30) throw new Error('Story is too short. Write at least a brief summary.');
      const playerName = all[idx].nickname || all[idx].name || 'the player';
      const rewritePrompts = [
        { style: 'funny', label: 'Funny Version', instruction: 'Rewrite this poker story in a funny, self-deprecating style. Add poker humor and table banter. 100-150 words.' },
        { style: 'dramatic', label: 'Dramatic Version', instruction: 'Rewrite this poker story with dramatic, cinematic tension like a final table ESPN broadcast. 100-150 words.' },
        { style: 'announcer', label: 'Sports Announcer Version', instruction: 'Rewrite this poker story as if a live sports announcer is calling it at the World Series of Poker. 100-150 words.' },
        { style: 'roast', label: 'Poker Roast Version', instruction: 'Rewrite this story as a friendly poker roast of the player. Playful, not mean. 100-150 words.' },
        { style: 'documentary', label: 'WSOP Documentary Version', instruction: 'Rewrite this story as narration from a WSOP poker documentary with voiceover gravitas. 100-150 words.' },
      ];
      const systemBase = `You are a poker story writer for ATMNOPIN™. The subject is ${playerName}. Write vivid, entertaining poker content.`;
      const rewrites = await Promise.all(rewritePrompts.map(async (rp) => {
        const text = await callOpenAI(`${systemBase} ${rp.instruction}`, rawText, 300);
        return { style: rp.style, style_label: rp.label, text: text.slice(0, 1000) };
      }));
      const chronicle = {
        id: crypto.randomUUID(),
        story_type: storyType,
        raw_text: rawText,
        rewrites,
        selected_style: null,
        selected_text: null,
        status: 'draft',
        submitted_at: new Date().toISOString(),
      };
      const updated = { ...all[idx] };
      updated.ai_chronicles = Array.isArray(updated.ai_chronicles) ? [...updated.ai_chronicles, chronicle] : [chronicle];
      updated.updated_at = new Date().toISOString();
      all[idx] = updated;
      await saveSubmissions(all);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, chronicle_id: chronicle.id, rewrites }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (pathname.match(/^\/api\/profile\/[^/]+\/ai-chronicle\/[^/]+\/select$/) && req.method === 'POST') {
    const parts = pathname.split('/');
    const token = parts[3];
    const chronicleId = parts[5];
    const all = await loadSubmissions();
    const idx = all.findIndex((s) => s.edit_token === token);
    if (idx === -1) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found.' })); return; }
    try {
      const body = await parseJsonBody(req);
      const selIdx = parseInt(body.selected_index);
      const updated = { ...all[idx] };
      const chronicles = Array.isArray(updated.ai_chronicles) ? [...updated.ai_chronicles] : [];
      const cIdx = chronicles.findIndex((c) => c.id === chronicleId);
      if (cIdx === -1) throw new Error('Chronicle not found.');
      const rw = chronicles[cIdx].rewrites[selIdx];
      if (!rw) throw new Error('Invalid rewrite index.');
      chronicles[cIdx] = { ...chronicles[cIdx], selected_style: rw.style_label, selected_text: rw.text, status: 'pending_review' };
      updated.ai_chronicles = chronicles;
      updated.updated_at = new Date().toISOString();
      all[idx] = updated;
      await saveSubmissions(all);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Trading card route ────────────────────────────────────────────────────

  if (pathname.match(/^\/players\/[^/]+\/card$/) && req.method === 'GET') {
    const slug = pathname.split('/')[2];
    const all = await loadSubmissions();
    const player = all.find((p) => p.slug === slug && p.status === 'approved');
    if (!player) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderLayout('Card Not Found | ATMNOPIN™', `<section class="hero"><h1>Card Not Available</h1><p class="body-text">This player's Trading Card is not available yet. The profile must be approved and include a photo.</p><p style="margin-top:.75rem;"><a href="/community-wall">← Community Wall</a></p></section>`));
      return;
    }
    const cardUnlocked = !!player.photo_url && (player.completion_score || 0) >= 70;
    if (!cardUnlocked) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderLayout('Card Locked | ATMNOPIN™', `<section class="hero"><h1>Trading Card Locked</h1><p class="body-text">Complete 70% of your poker profile and add a photo to unlock your Poker Trading Card.</p><p style="margin-top:.75rem;"><a href="/community-wall">← Community Wall</a></p></section>`));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderTradingCardPage(player));
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
      const rawIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
      const ip = rawIp.replace(/^::ffff:/, '');
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
      const consentAt = new Date().toISOString();
      const consentGeo = await geoLookup(ip);
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
      const edit_token = crypto.randomUUID();
      const nickname = String(f.nickname || '').trim();
      const submission = {
        id,
        slug: playerProfileSlug(name, nickname),
        edit_token,
        name,
        nickname,
        email,
        city: String(f.city || '').trim(),
        favorite_casino: String(f.favorite_casino || '').trim(),
        favorite_game: String(f.favorite_game || '').trim(),
        playing_style: String(f.playing_style || '').trim().slice(0, 100),
        biggest_strength: String(f.biggest_strength || '').trim().slice(0, 200),
        biggest_weakness: String(f.biggest_weakness || '').trim().slice(0, 200),
        funniest_habit: String(f.funniest_habit || '').trim().slice(0, 300),
        friends_opinion: String(f.friends_opinion || '').trim().slice(0, 100),
        biggest_accomplishment: String(f.biggest_accomplishment || '').trim().slice(0, 800),
        biggest_goal: String(f.biggest_goal || '').trim().slice(0, 400),
        funny_story: String(f.funny_story || '').trim().slice(0, 2000),
        bad_beat_story: String(f.bad_beat_story || '').trim().slice(0, 2000),
        social_link: String(f.social_link || '').trim().slice(0, 300),
        photo_url,
        permission_granted: true,
        consent_at: consentAt,
        consent_ip: ip,
        consent_city: consentGeo.city || 'unknown',
        consent_region: consentGeo.region || 'unknown',
        consent_country: consentGeo.country || 'unknown',
        status: 'pending',
        badge: '',
        badges: [],
        points: 0,
        point_log: [],
        featured_on_home: false,
        is_monthly_winner: false,
        admin_notes: '',
        ai_personality: null,
        ai_chronicles: [],
        completion_score: 0,
        created_at: consentAt,
        updated_at: consentAt,
        approved_at: null,
      };
      submission.completion_score = computeCompletionScore(submission);
      console.log('[submit] new submission id=' + submission.id + ' name=' + submission.name);
      const all = await loadSubmissions();
      all.unshift(submission);
      await saveSubmissions(all);
      console.log('[submit] saved OK, total now', all.length);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        message: 'Story submitted! Complete your poker profile to unlock your AI Poker Personality and public player page.',
        profile_url: `/profile/setup/${edit_token}`,
      }));
    } catch (error) {
      console.error('[submit] error:', error.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (pathname === '/community-wall') {
    const all = await loadSubmissions();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderCommunityWallPage(all));
    logPageVisit(req, pathname);
    return;
  }

  // ─── THE RAIL ROUTES ────────────────────────────────────────────────────────

  if (pathname === '/rail') {
    const page = Math.max(1, parseInt(parsed.searchParams.get('page') || '1', 10));
    const filters = { type: parsed.searchParams.get('type') || '' };
    const { posts, total } = await loadRailPosts({ status: 'approved', page, limit: 20, type: filters.type });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderRailPage(posts, total, page, filters));
    logPageVisit(req, pathname);
    return;
  }

  if (pathname === '/community-guidelines') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderCommunityGuidelinesPage());
    logPageVisit(req, pathname);
    return;
  }

  if (pathname === '/terms') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderTermsPage());
    logPageVisit(req, pathname);
    return;
  }

  if (pathname === '/privacy') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderPrivacyPage());
    logPageVisit(req, pathname);
    return;
  }

  if (pathname === '/dmca') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderDmcaPage());
    logPageVisit(req, pathname);
    return;
  }

  // POST /api/rail/posts — submit a new post
  if (pathname === '/api/rail/posts' && req.method === 'POST') {
    let body;
    try { body = await parseJsonBody(req); } catch { body = {}; }
    const { authorName, authorEmail, postType, title, content, pokerRoom, gameStakes, tags, consents } = body;
    if (!content || !authorName || !authorEmail || !postType) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required fields: authorName, authorEmail, postType, content.' }));
      return;
    }
    if (!RAIL_POST_TYPES[postType]) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid post type.' }));
      return;
    }
    const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const ua = req.headers['user-agent'] || '';
    try {
      if (Array.isArray(consents) && consents.length > 0) {
        await logConsent(consents, {
          ipAddress: clientIp, userAgent: ua,
          pageUrl: '/rail', sourceFeature: 'rail_post_submit',
          emailAddress: authorEmail,
        });
      }
      const post = await createRailPost({
        authorName, authorEmail, postType,
        title: title || '', content,
        pokerRoom: pokerRoom || '', gameStakes: gameStakes || '',
        tags: Array.isArray(tags) ? tags : [],
        submitterIp: clientIp,
      });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: post.id }));
    } catch (err) {
      console.error('[rail] createRailPost error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to submit post. Please try again.' }));
    }
    return;
  }

  // GET /api/rail/posts — paginated public feed
  if (pathname === '/api/rail/posts' && req.method === 'GET') {
    const page = Math.max(1, parseInt(parsed.searchParams.get('page') || '1', 10));
    const type = parsed.searchParams.get('type') || '';
    try {
      const result = await loadRailPosts({ status: 'approved', page, limit: 20, type });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST /api/rail/posts/:id/like
  if (pathname.match(/^\/api\/rail\/posts\/([^/]+)\/like$/) && req.method === 'POST') {
    const postId = pathname.split('/')[4];
    const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    try {
      const result = await likeRailPost(postId, clientIp);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST /api/rail/posts/:id/report
  if (pathname.match(/^\/api\/rail\/posts\/([^/]+)\/report$/) && req.method === 'POST') {
    const postId = pathname.split('/')[4];
    let body;
    try { body = await parseJsonBody(req); } catch { body = {}; }
    const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    try {
      await reportRailPost(postId, body.reportType || 'other', body.description || '', clientIp);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST /api/rail/ai-rewrite
  if (pathname === '/api/rail/ai-rewrite' && req.method === 'POST') {
    let body;
    try { body = await parseJsonBody(req); } catch { body = {}; }
    const rawContent = (body.content || '').trim().slice(0, 2000);
    if (!rawContent) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No content provided.' }));
      return;
    }
    try {
      const rewritten = await callOpenAI(
        'You are ATM AI — a poker storytelling assistant for the ATMNOPIN™ community. Rewrite the user\'s poker story to be more vivid, punchy, and entertaining while keeping all facts exactly the same. Keep it under 400 words. Return only the rewritten text, no commentary.',
        rawContent,
        600
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ rewritten: rewritten.trim() }));
    } catch (err) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'AI rewrite unavailable right now. Try again shortly.' }));
    }
    return;
  }

  // GET /admin/rail — admin moderation page
  if (pathname === '/admin/rail') {
    if (!(await verifyAdmin(req))) {
      res.writeHead(302, { Location: '/admin' });
      res.end();
      return;
    }
    try {
      const [{ posts: pendingPosts }, { posts: flaggedPosts }, reports, { records: consentRecords }] = await Promise.all([
        loadRailPosts({ status: 'pending', page: 1, limit: 50 }),
        loadRailPosts({ status: 'flagged', page: 1, limit: 50 }),
        loadRailReports(),
        loadConsentLog({ limit: 100 }),
      ]);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderAdminRailPage(pendingPosts, flaggedPosts, reports, consentRecords));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderLayout('Rail Admin Error', `<section class="card"><h1>Error loading Rail admin</h1><p>${escapeHtml(err.message)}</p></section>`));
    }
    return;
  }

  // POST /api/admin/rail/:id/(approve|reject|remove)
  if (pathname.match(/^\/api\/admin\/rail\/([^/]+)\/(approve|reject|remove)$/) && req.method === 'POST') {
    if (!(await verifyAdmin(req))) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const parts = pathname.split('/');
    const postId = parts[4];
    const action = parts[5];
    const statusMap = { approve: 'approved', reject: 'rejected', remove: 'removed' };
    const newStatus = statusMap[action];
    try {
      const session = sessions.get(req.headers.cookie?.match(/admin_session=([^;]+)/)?.[1] || '');
      await updateRailPostStatus(postId, newStatus, session?.email || 'admin');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /api/admin/consent-log
  if (pathname === '/api/admin/consent-log' && req.method === 'GET') {
    if (!(await verifyAdmin(req))) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const limit = Math.min(500, parseInt(parsed.searchParams.get('limit') || '100', 10));
    const offset = Math.max(0, parseInt(parsed.searchParams.get('offset') || '0', 10));
    try {
      const result = await loadConsentLog({ limit, offset });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ────────────────────────────────────────────────────────────────────────────

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
    logPageVisit(req, pathname);
    return;
  }

  if (pathname === '/api/admin/visitor-log' && req.method === 'GET') {
    try {
      const logs = await loadVisitorLog(1000);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(logs)); // { rows: [...], total: N }
    } catch (err) {
      console.error('loadVisitorLog error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to load visitor log: ' + (err.message || String(err)) }));
    }
    return;
  }

  if (pathname === '/api/admin/db-ping' && req.method === 'GET') {
    const result = { sqlite: !!sqliteDb, pg: !!pgPool, tables: {} };
    try {
      if (pgPool) {
        const t1 = await pgPool.query("SELECT to_regclass('public.player_submissions') AS exists");
        result.tables.player_submissions = t1.rows[0]?.exists ?? null;
        const t2 = await pgPool.query("SELECT to_regclass('public.blog_posts') AS exists");
        result.tables.blog_posts = t2.rows[0]?.exists ?? null;
      }
      if (sqliteDb) {
        const r = sqliteDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        result.tables = Object.fromEntries(r.map(row => [row.name, row.name]));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (pathname === '/api/admin/submissions' && req.method === 'GET') {
    try {
      console.log('[submissions] loading from DB...');
      const timeoutP = new Promise((_, reject) => setTimeout(() => reject(new Error('DB query timed out after 8s')), 8000));
      const all = await Promise.race([loadSubmissions(), timeoutP]);
      console.log('[submissions] loaded', all.length, 'records');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(all));
    } catch (err) {
      console.error('[submissions] error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || String(err) }));
    }
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
      const updated = { ...old, updated_at: new Date().toISOString() };
      if (body.status !== undefined) {
        updated.status = body.status;
        if (body.status === 'approved' && !old.approved_at) updated.approved_at = new Date().toISOString();
      }
      if (body.badge !== undefined) updated.badge = String(body.badge || '');
      if (Array.isArray(body.badges)) updated.badges = body.badges.filter((b) => PLAYER_BADGES.includes(b));
      if (body.featured_on_home !== undefined) updated.featured_on_home = !!body.featured_on_home;
      if (body.is_monthly_winner !== undefined) updated.is_monthly_winner = !!body.is_monthly_winner;
      if (body.admin_notes !== undefined) updated.admin_notes = String(body.admin_notes || '');
      if (body.points_delta !== undefined) {
        const delta = parseInt(body.points_delta) || 0;
        updated.points = Math.max(0, (old.points || 0) + delta);
        const log = Array.isArray(old.point_log) ? [...old.point_log] : [];
        log.push({ amount: delta, reason: String(body.points_reason || ''), awarded_at: new Date().toISOString() });
        updated.point_log = log.slice(-50);
      }
      if (body.ai_personality_status !== undefined && updated.ai_personality) {
        updated.ai_personality = { ...updated.ai_personality, status: body.ai_personality_status };
      }
      if (body.chronicle_id && body.chronicle_status) {
        const chronicles = Array.isArray(updated.ai_chronicles) ? [...updated.ai_chronicles] : [];
        const cIdx = chronicles.findIndex((c) => c.id === body.chronicle_id);
        if (cIdx !== -1) chronicles[cIdx] = { ...chronicles[cIdx], status: body.chronicle_status };
        updated.ai_chronicles = chronicles;
      }
      updated.completion_score = computeCompletionScore(updated);
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
      const featPost = pubPosts[0];
      const compactPosts = pubPosts.slice(1, 4);
      const featuredHtml = featPost ? `
        <div class="featured-story-card">
          <div class="fs-image">
            ${featPost.featured_image_url
              ? `<img src="${escapeHtml(featPost.featured_image_url)}" alt="${escapeHtml(featPost.featured_image_alt || featPost.title)}" loading="lazy">`
              : `<div class="fs-no-image">♠</div>`}
          </div>
          <div class="fs-content">
            <div class="fs-date">${escapeHtml(new Date(featPost.published_at || featPost.created_at).toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'}))}</div>
            <div class="fs-title"><a href="/blog/${escapeHtml(featPost.slug)}">${escapeHtml(featPost.title)}</a></div>
            <p class="fs-excerpt">${escapeHtml((featPost.excerpt || '').slice(0, 180))}${(featPost.excerpt || '').length > 180 ? '…' : ''}</p>
            <a href="/blog/${escapeHtml(featPost.slug)}" class="fs-cta">Read Story →</a>
          </div>
        </div>
        ${compactPosts.length ? `<div class="compact-stories">${compactPosts.map((p) => `
          <div class="compact-story">
            <div class="cs-date">${escapeHtml(new Date(p.published_at || p.created_at).toLocaleDateString('en-US', {month:'short',day:'numeric',year:'numeric'}))}</div>
            <div class="cs-title"><a href="/blog/${escapeHtml(p.slug)}">${escapeHtml(p.title)}</a></div>
            <a href="/blog/${escapeHtml(p.slug)}" class="cs-link">Read →</a>
          </div>`).join('')}</div>` : ''}` : '<div class="notice">No published posts yet.</div>';
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
        : '<div style="color:var(--gray);font-size:.9rem;">No community profiles yet. <a href="/ai-profile-generator" style="color:var(--green);">Be the first →</a></div>';
      const communitySection = `<section class="schedule" id="community-preview" style="border-top:1px solid #1a1a1a;">
        <p class="section-label">// ATMNOPIN Community</p>
        <h2>Community Wall</h2>
        <p class="body-text" style="max-width:60ch;">Poker players from the ATMNOPIN universe — their stories, bad beats, and moments of glory.</p>
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:1rem;margin-top:1rem;">${communityCardsHtml}</div>
        <div style="margin-top:1.5rem;display:flex;gap:1rem;flex-wrap:wrap;">
          <a href="/community-wall" style="display:inline-block;color:var(--green);font-size:.78rem;text-transform:uppercase;letter-spacing:.12em;">View Community Wall →</a>
          <a href="/ai-profile-generator" style="display:inline-block;color:var(--gold);font-size:.78rem;text-transform:uppercase;letter-spacing:.12em;">Get Featured →</a>
        </div>
      </section>`;
      const html = data
        .replace('<!-- HERO_CAROUSEL -->', renderHeroCarousel())
        .replace('<!-- BLOG_PREVIEW -->', `<div class="section-divider"><div class="hp-section" id="stories"><p class="section-label">// Latest from the ATM</p><h2>Latest Stories</h2>${featuredHtml}<div class="section-cta-row"><a href="/blog" class="section-cta-link">View all stories →</a></div></div></div>`)
        .replace('<!-- RECENT_POSTS -->', '')
        .replace('<!-- CHRONICLES_PREVIEW -->', chronSection)
        .replace('<!-- TOURNAMENT_JOURNEY -->', renderTournamentSection())
        .replace('<!-- COMMUNITY_PREVIEW -->', communitySection)
        .replace(/ATM With No PIN — Dhezz/g, 'ATMNOPIN™ Poker | Official Site')
        .replace(/<title>ATM With No PIN — Dhezz<\/title>/, '<title>ATMNOPIN™ Poker | Official Site</title>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      logPageVisit(req, '/');
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

async function seedDefaultSubmissions() {
  try {
    const existing = await loadSubmissions();
    const existingById = new Map(existing.map((s) => [s.id, s]));
    const existingSlugs = new Set(existing.map((s) => s.slug));
    const seedById = new Map(SEED_SUBMISSIONS.map((s) => [s.id, s]));
    const idsToUpdate = new Set();
    const toAdd = [];
    for (const seed of SEED_SUBMISSIONS) {
      if (existingById.has(seed.id)) { idsToUpdate.add(seed.id); }
      else if (!existingSlugs.has(seed.slug)) { toAdd.push(seed); }
    }
    if (!toAdd.length && !idsToUpdate.size) return;
    const updated = existing.map((s) =>
      idsToUpdate.has(s.id) ? { ...s, ...seedById.get(s.id) } : s
    );
    await saveSubmissions([...toAdd, ...updated]);
  } catch {
    // non-fatal
  }
}

async function start() {
  await initializeDatabase();
  await migrateLegacyPosts();
  await seedDefaultPosts();
  await seedDefaultChronicles();
  await seedDefaultSubmissions();
  server.listen(PORT, () => {
    console.log(`ATM is open on port ${PORT} 🏧`);
  });
}

start().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
