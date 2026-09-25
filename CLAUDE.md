# ATMwithNoPIN

## Project Overview

A poker entertainment brand site for Dhezz (`@ATMwithNoPIN`). The site is a Node.js-served static frontend with a server-rendered blog CMS, Firebase-powered chat and visitor tracking, and a merchandise shop page. Hosted on Railway at `atmwithnopin.com` (DNS via Namecheap).

## Stack

- **Server**: Node.js (`server.js`) — custom HTTP server, no Express. Handles routing, blog API, admin auth, image uploads, and static file serving in a single file.
- **Frontend**: Vanilla HTML/CSS/JS. No build step, no bundler, no framework.
- **Blog storage**: PostgreSQL via `pg` (Railway-provided `DATABASE_URL`) in production; SQLite via `better-sqlite3` locally (auto-selected when `DATABASE_URL` is absent). Legacy fallback to `data/blog-posts.json`.
- **Chat & visitor tracking**: Firebase Firestore, loaded client-side via CDN (`gstatic.com`). Never used server-side.
- **Image uploads**: Cloudinary (optional, set via env); falls back to local `uploads/` directory.
- **Deployment**: Railway — push to `main`, auto-deploys within ~60 seconds.
- **Domain**: `atmwithnopin.com` via Namecheap.

## Pages

| Route | Source | Notes |
|---|---|---|
| `/` | `index.html` + server injection | Blog preview injected at `<!-- BLOG_PREVIEW -->` and `<!-- RECENT_POSTS -->` placeholders |
| `/blog` | server-rendered | Published posts list |
| `/blog/:slug` | server-rendered | Individual post page |
| `/admin` | server-rendered | Password-gated CMS; login form at `/admin` when unauthenticated |
| `/chat.html` | `chat.html` | Firebase real-time chat |
| `/shop.html` | `shop.html` | Merchandise page |
| `/stories/poker-wildlife` | server-rendered | Poker Wildlife landing (published species only) |
| `/stories/poker-wildlife/:slug` | server-rendered | Individual species page; `?preview=1` + admin session shows drafts |
| `/uploads/*` | `uploads/` dir | Locally uploaded images |
| `/login` | server-rendered | Passwordless email-code sign-in (redirects to `/account` if signed in) |
| `/account/setup` | server-rendered | One-time @username + display name, then profile-claim offer |
| `/account` | server-rendered | "My ATM": identity, linked Poker Profile / claim / create, log out |

## Design System

All pages share the same CSS variables and font stack. Never deviate from these:

```css
--black:     #0a0a0a   /* page background */
--green:     #00c853   /* primary accent, links, CTAs */
--green-dim: #007a33   /* secondary green for borders/hovers */
--felt:      #0d2e1a   /* poker-felt dark green (hero sections) */
--gold:      #c9a84c   /* secondary accent */
--offwhite:  #f0ece0   /* body text */
--gray:      #888      /* muted/meta text */
```

Fonts (loaded from Google Fonts):
- `DM Mono` — body, UI, monospace elements
- `Bebas Neue` — display headings, brand marks
- `DM Serif Display` — editorial headings (blog, cards)

## File Map

```
server.js              — entire backend (routing, CMS API, rendering, auth, uploads)
index.html             — landing page
chat.html              — Firebase chat room
shop.html              — merchandise page
visitor-tracker.js     — client-side Firestore visit logger (included in index.html)
logo.svg               — site logo (used in nav across pages)
dhezz.jpeg             — Dhezz portrait
ducky-jay.png          — branding asset
FirstHat.png           — hat product photo
hat-mockup.png         — hat mockup
favicon.ico            — favicon
favicon-32.png         — 32px favicon
data/blog-posts.json   — legacy blog store (now empty; real data in DB)
data/blog-posts.sqlite — local SQLite DB
uploads/               — locally uploaded images (not committed)
.env.example           — env var reference (committed; contains dev credentials)
```

## Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `ADMIN_EMAIL` | Yes | Login email for `/admin` |
| `ADMIN_PASSWORD_HASH` | Prod | SHA-256 hash of admin password |
| `ADMIN_PASSWORD` | Dev only | Plaintext password (overridden by hash if both set) |
| `DATABASE_URL` | Prod | Railway PostgreSQL connection string; absence triggers SQLite mode |
| `CLOUDINARY_CLOUD_NAME` | Optional | Cloudinary account name for image CDN |
| `CLOUDINARY_UPLOAD_PRESET` | Optional | Cloudinary unsigned upload preset |
| `PORT` | Railway | Injected by Railway; defaults to 3000 |

## Blog / Admin System

### Data model (per post)

```js
{
  id: uuid,
  title: string,
  slug: string,           // URL-safe, auto-generated from title if omitted
  excerpt: string,        // shown on list page and homepage preview
  content: string,        // Markdown (custom renderer in server.js)
  tags: string[],
  status: 'draft' | 'published',
  featured_image_url: string,
  featured_image_alt: string,
  gallery_images: { url, alt }[],
  video_urls: string[],   // YouTube / Vimeo — auto-embedded
  created_at: ISO string,
  updated_at: ISO string,
  published_at: ISO string | null,
}
```

### Markdown renderer (`renderMarkdown`)

Custom, minimal — supports: `# h1`, `## h2`, `### h3`, `- / *` unordered lists, `**bold**`, `__bold__`, `*italic*`, `[text](url)` links, and `<br />` for blank lines. No tables, no code fences, no nested lists. Do not replace this with a markdown library without explicit instruction.

### Admin auth

- Session tokens stored in an in-memory `Map` with 8-hour TTL.
- Sessions are lost on server restart (expected — Railway restarts are infrequent).
- `POST /api/admin/login` sets an `HttpOnly; SameSite=Lax` cookie.
- All `/api/admin/*` routes (except login/logout) require a valid session cookie.

### Image upload flow

1. Admin uploads via multipart form to `POST /api/admin/upload`.
2. Server tries Cloudinary first (if env vars are set).
3. Falls back to writing to `uploads/` and returning a `/uploads/<filename>` URL.
4. Only JPG, PNG, WEBP accepted. Max 5MB.

## Poker Wildlife

An editorial series of **fictional / composite** poker-table archetypes (The Shark, The Whale, etc.). It is its **own content type** — deliberately not a Chronicles category — but reuses the Chronicles engine patterns.

- **Storage**: `wildlife_species` table, same `(id, data JSONB/TEXT, created_at)` shape as `chronicles`. `loadSpecies()` / `saveSpecies()` mirror `loadChronicles()` / `saveChronicles()` (transactional DELETE + re-INSERT).
- **Seed**: `WILDLIFE_SEED` (10 species) + `seedWildlifeSpecies()`, run from `start()`. **Idempotent by slug** — inserts a species only if its slug is absent, never updates/overwrites an existing row. Seeds are metadata-only drafts (name, slug, animal, tagline, display_order).
- **Model fields**: `name, slug, animal, classification (optional), tagline, short_description, content (markdown), image_url, image_alt, status (draft|published), featured, display_order, published_at, seo_title, seo_description, created_at, updated_at`.
- **Images**: reuse `POST /api/admin/upload`; the record stores only `image_url` (string). Deleting a species never deletes the file.
- **Production image guard**: `speciesPublishBlockReason()` — in production (`isProductionEnv()`), publishing a species whose `image_url` starts with `/uploads/` is rejected (ephemeral Railway storage). Cloudinary HTTPS URLs always allowed; local dev allows `/uploads/`.
- **Admin**: "Poker Wildlife" tab in `/admin` (`renderAdminPage`). API: `GET/POST /api/admin/wildlife`, `GET/PUT/DELETE /api/admin/wildlife/:id` (behind the `/api/admin/` auth gate).
- **Public**: `renderWildlifeLandingPage()` (`/stories/poker-wildlife`), `renderSpeciesPage()` (`/stories/poker-wildlife/:slug`, published only). Draft preview: `?preview=1` + valid admin session (`verifyAdmin`).
- **Homepage caching**: `GET /` / `/index.html` is composed fresh from live DB content every request and is sent with `Cache-Control: no-store, must-revalidate` + `Pragma: no-cache`. Do not remove this — without it a pre-deploy copy (bfcache / HTTP cache / speculative prerender) can paint over the current homepage.
- **Hero-right promo panel** (`<!-- HERO_CAROUSEL -->` → `#heroCommunityPanel`): `renderHeroCarousel(pubWildlife)` promotes Poker Wildlife (was the "Get on the Community Wall" profile carousel; `HERO_PROFILES` removed). It reuses the `.hc-*` panel/carousel markup, CSS and the hero carousel inline script unchanged, and rotates published+featured species (by `display_order`, max 6); with none published it shows a static promo (no carousel — the script's `if (!track) return` guard handles that). Community Wall / its nav / GET FEATURED / its APIs are untouched.
- **Homepage**: the Poker Wildlife feature section is server-injected into the `<!-- POKER_WILDLIFE_FEATURE -->` slot in `index.html` immediately after the hero. The former `<!-- COMMUNITY_PREVIEW -->` placeholder is no longer used (the Community Wall page, routes, nav, admin tab and APIs are all untouched). It renders `section#poker-wildlife` with the intro + "Meet the species" CTA always, plus a grid of up to 4 **published AND featured** species sorted by `display_order`, a dynamic "Explore all N species" CTA, and a non-clickable "Which species are you?" teaser. The grid is omitted when no published+featured species exist. The old `<!-- POKER_WILDLIFE_PREVIEW -->` placeholder was removed.
- **SEO**: `renderLayout(title, body, head='')` now takes an optional third arg for per-page `<head>` markup (canonical + OG + Twitter). Existing 2-arg calls are unchanged; when `head` is passed, the generic fallback `<meta name="description">` is suppressed.
- Every species page shows a fixed satire disclaimer, rendered by the template via `renderPokerSatireDisclaimer()` (text: `POKER_SATIRE_DISCLAIMER`) — never entered into the markdown body. It renders as an `<aside>` with a "Satire Disclaimer" heading, near the bottom of the article, before the prev/next nav and "Explore All Species" CTA. No fields exist for real names / casinos / locations — this is intentional.
- Smoke test: `node scripts/smoke-wildlife.js` (self-contained, spawns its own server against a temp SQLite DB).

## Community / Get Featured

`player_submissions` table (same `id/data/created_at` shape). Flow:

1. Public form at `/ai-profile-generator` ("Start My Poker Profile →") → creates a submission, `status: 'pending'`, returns a private link `/profile/setup/<edit_token>`. **No AI runs at this step** — it just saves + redirects.
2. On `/profile/setup/<token>` the user completes fields; once `computeCompletionScore >= 40` the **Generate My AI Poker Personality** button unlocks (Section 4) → `POST /api/profile/<token>/ai-personality` (`ai_personality.status: 'pending_review'`). AI Chronicles work the same (`POST .../ai-chronicle`, `ai_chronicles[].status: 'pending_review'` after they pick a rewrite). Then **Submit for Review** (`submitted_for_review: true`).
   - **AI requires `OPENAI_API_KEY`** (see `.env.example`). Handler order: 404 check → `<40%` → 400 → key missing → **503** ("temporarily unavailable") → daily limit → 429. `aiRateLimitExceeded()` only peeks; `consumeAIRateLimit()` is called **only after a successful OpenAI call**, so blocked/failed attempts never burn the 5/day quota (`aiRateLimiter` is an in-memory Map keyed by `edit_token`, resets on deploy).
3. Admin: `/admin` → **Community** tab → **📬 Ready for Review** filter → expand a card → **Approve** (`status: 'approved'`, stamps `approved_at`). That publishes the player to `/community-wall` and `/players/<slug>`.
4. Each card also has an **AI Content Review** block: **Approve AI Personality** / **Reject** (`subAIApprove`/`subAIReject` → PUT `ai_personality_status`) and per-story **Approve Story** / **Reject** (`subChronicleApprove`/`subChronicleReject` → PUT `chronicle_id`+`chronicle_status`). The public profile only renders `ai_personality`/`ai_chronicles` entries whose `status === 'approved'`.
5. The `/profile/setup` page tells the submitter their profile stays private until an admin approves it, then appears on the Community Wall + their `/players/<slug>` page.

Community routes/APIs/data are independent of Poker Wildlife; do not merge them.

## User Identity Foundation

Server-side primitives (block after `migrateLegacyPosts()` in `server.js`); the HTTP flow on top of them is under **Passwordless Auth** below. **Community features (feed/posts/likes/follows/DMs) do not exist yet.**

- **Tables** (both DBs, `CREATE TABLE IF NOT EXISTS`, targeted single-row queries — never the load-all/save-all pattern): `users` (unique `email_normalized`, nullable unique `username_normalized`, `status` active|suspended|banned, `trust_level` new|verified|established|trusted — TEXT, no enums), `user_sessions` (stores only SHA-256 `token_hash`), `email_verification_codes` (`code_hash` = SHA-256 of `<row id>:<code>`, `purpose` signup|login|claim_profile, 10-min TTL, max 5 attempts, single-use), `user_profile_links` (bridge: one user ↔ one `player_submissions.id`, both unique).
- **Profile ownership** goes through `user_profile_links`; `player_submissions` is unchanged (no `user_id`). `findPlayerSubmissionsByNormalizedEmail()` is read-only (id/name/nickname/slug/email/status, never `edit_token`). The existing `edit_token` setup flow remains fully supported.
- **Cookie**: `atm_session` via `buildUserSessionCookie()` / `buildUserSessionLogoutCookie()` — HttpOnly, SameSite=Lax, Path=/, 30 days, `Secure` only when `isProductionEnv()`. Separate from `admin_session`.
- **Email**: `sendVerificationEmail()` POSTs to Resend's HTTPS API with `fetch` (no SDK). Needs `RESEND_API_KEY` + `AUTH_EMAIL_FROM`; missing → `EMAIL_NOT_CONFIGURED`. Never log tokens, codes, or their hashes.
- `server.js` only calls `start()` when run directly (`require.main === module`) and exports the identity helpers for tests.
- Smoke test: `node scripts/smoke-user-identity.js` (temp SQLite, fetch stubbed, no network).

## Passwordless Auth (Sprint 1B)

Helpers follow `sendVerificationEmail()`; routes/pages live in `handleAuthRoutes()` (called first in the request handler). All responses are `Cache-Control: no-store`; tokens, codes and edit_tokens never go in URLs, JSON, or logs.

- **Flow**: `/login` → `POST /api/auth/request-code` (creates the user if absent — `trust_level: new`, no username — issues a `login`-purpose code, emails it; generic response that never reveals account existence; provider failure → 503) → `POST /api/auth/verify-code` (newest unused login code via `getLatestLoginVerification`; wrong code bumps attempts; success marks used, sets `email_verified_at`, `new → verified`, `last_login_at`, sets `atm_session`; returns only `needs_username`/`has_profile`) → `/account/setup` if no username → `/account`.
- **Session**: `getCurrentUser(req)` resolves `atm_session` (hash lookup, active session, user `status === 'active'`), returns null otherwise, never throws. `GET /api/auth/me` returns safe fields only. `POST /api/auth/logout` revokes + clears the cookie, idempotent. `admin_session` is untouched.
- **Rate limits** (in-memory, `AUTH_RATE_LIMITS`, reset on deploy): send — 60s cooldown + 5/hour per email, 15/hour per IP; verify — 30/hour per IP (plus the per-code 5-attempt cap). State-changing auth POSTs require `Content-Type: application/json`.
- **Username**: `POST /api/account/username` sets @username + display name (1–50 chars) **once**; changes are not supported yet (409).
- **Profile claiming**: `GET /api/account/profile-candidates` (unclaimed `player_submissions` matching the *verified account* email; safe fields only) and `POST /api/account/claim-profile` (requires username, one profile per user, re-checks the email match, relies on `user_profile_links` uniqueness for races). Never auto-claims.
- **Generator auto-link**: after `/request-feature` saves a submission, `autoLinkNewProfileForUser()` links it if the requester is a signed-in verified user whose email matches and neither side is linked. Unauthenticated generator + `edit_token` flow unchanged.
- **Nav**: no SIGN IN / MY ATM link yet (nav is duplicated across `renderLayout`, `index.html`, `shop.html`) — deferred.
- Smoke test: `node scripts/smoke-auth-flow.js` (in-process server, temp SQLite, Resend stubbed).

## AI-First Poker Profile (Sprint 1B.2 + 1B.3 instant activation)

`GET /ai-profile-generator` branches: signed-in + verified + @username → `renderAIFirstProfilePage()` (or `renderPokerProfileExistsPage()` if already linked); everyone else → the **legacy** generator + `POST /request-feature` (temporarily kept, unchanged). Helpers sit just before `handleAuthRoutes()`; routes are inside it.

- **Minimal inputs**: optional nickname, game type (cash|tournaments|both), style (aggressive|tight|loose|tricky|no_idea), optional clue (≤500), explicit consent checkbox. Never asks for name/email — those come from the session (`display_name`, verified `email`) and body identity fields are never read.
- **Gate** (`requireProfileCreatorJson`): verified user, username set, no `user_profile_links` row (409). JSON-only, `no-store`.
- `POST /api/account/generate-poker-profile` → AI **draft** only (8 fields: nickname, tagline, playing_style, biggest_strength, biggest_weakness, funniest_habit, table_reputation, bio; limits in `POKER_PROFILE_FIELDS`). Prompt forbids invented wins/casinos/money/events. Output is tag-stripped and clamped; malformed → 502. Creates nothing. Rate limit `profile_ai_user` 5/hour per user (incl. regenerate) in `AUTH_RATE_LIMITS`; a hit is released only if the OpenAI call throws.
- **Preview** is client-side (KEEP IT / REGENERATE / EDIT); edits are re-validated at save.
- **Poker Wildlife Alter Ego** (optional; step skipped when nothing is published): `POST /api/account/wildlife-alter-ego` with `mode: surprise|choose`. Species come only from `getPublishedWildlifeForProfiles()` (published, by `display_order`; drafts never shown). AI-returned slugs are checked against that list (invalid → 502). "Choose" falls back to `defaultWildlifeExplanation()` if AI is unavailable. Limit `wildlife_ai_user` 10/hour.
- `POST /api/account/save-poker-profile` → one legacy-compatible `player_submissions` row (`status: approved`, consent_* fields as in `/request-feature` plus `consent_source: 'account_ai_profile'`, legacy story/casino/goal fields left empty, extra `tagline`/`table_reputation`/`bio`, and `wildlife_alter_ego: { species_slug, species_name, explanation }` only when chosen — slug re-checked against the current published list). Written with a **single-row INSERT** (`insertPlayerSubmissionRow`), not `saveSubmissions()`, then linked; if linking fails the row is deleted. An in-process per-user lock blocks concurrent saves. Returns only `{ ok, profile_url, public_url }` (`profile_url` = `/profile/setup/<edit_token>`, `public_url` = `/players/<slug>`).
- **Instant activation (Sprint 1B.3)**: verified account → @username → AI draft → user reviews/accepts → optional Wildlife alter ego → save → **immediately approved and public**, linked to the account. `buildAccountPlayerSubmission()` sets `status: 'approved'` and `approved_at` at save time (server values; browser-supplied status/id/approved_at are ignored). `submitted_for_review: true` + `submitted_at` are still set for compatibility with the normal submit → approve lifecycle; these rows never show in Ready for Review because that filter is `submitted_for_review && status !== 'approved'`. The public page is live at `/players/<slug>` and on `/community-wall` right away. Success screen and `/account` say "Your Poker Profile is live." with **VIEW MY POKER PROFILE**; `/account` keeps the "stays private until an admin approves it" copy for linked profiles that are genuinely pending (e.g. claimed legacy ones).
- `/profile/setup/<edit_token>` remains available for optional enrichment (photo, casino, stories); it shows the approved profile as "Live ✓" with no submit button, and re-hitting the legacy `/submit` endpoint does not demote it.
- Admin moderation is unchanged: admins can still reject/unapprove, feature, badge, and approve/reject AI personality and stories from the Community tab.
- The legacy unauthenticated `/request-feature` flow is unchanged: it still creates `status: pending` profiles (not auto-submitted, not auto-approved) that follow the normal Submit for Review → admin approval path.
- Existing records were not migrated; the change only affects rows created by the AI-first save after 1B.3.
- Smoke test: `node scripts/smoke-ai-profile.js` (temp SQLite, OpenAI + geo fetch stubbed).

## Firebase Configuration

Firebase is client-side only. The config is hardcoded in `visitor-tracker.js` and `chat.html` (public API keys — this is intentional for Firebase web apps; security is enforced via Firestore rules).

- **Project**: `atmwithnopin-c5bd7`
- **Firestore collections**:
  - `visits` — visitor audit log (written by `visitor-tracker.js`)
  - `channels` — chat messages and metadata
  - `pins` — pinned messages per channel

## Coding Rules

1. **No frameworks or build tools.** All pages are plain HTML/CSS/JS. Do not introduce React, Vue, Webpack, Vite, or any bundler.
2. **No new dependencies** without explicit approval. The only npm packages in use are `pg`, `better-sqlite3`, and `firebase` (client CDN).
3. **Keep everything in `server.js`.** Routing, rendering, API handlers, and helpers all live in a single file by design. Do not split into modules unless asked.
4. **Server-rendered HTML only for blog routes.** The blog list, blog post, and admin pages are rendered as template strings in `server.js`. Do not add client-side routing.
5. **Sanitize all user input before rendering.** Use the existing `escapeHtml` / `sanitizeHtml` helpers. Never inject raw user content into HTML strings.
6. **Never commit real secrets.** `.env.example` is committed with dev credentials for convenience — never add `ADMIN_PASSWORD_HASH`, `DATABASE_URL`, or Cloudinary credentials to committed files.
7. **Preserve the CSS variable system.** Any new UI must use the existing `--black`, `--green`, `--gold`, `--offwhite`, `--gray` variables — no hardcoded hex values in new code.
8. **Mobile-first breakpoints.** The existing breakpoint is `@media (max-width: 980px)`. Match this in any new layout work.
9. **Silent-fail visitor tracking.** The `visitor-tracker.js` IIFE is wrapped in try/catch intentionally — never let analytics errors surface to the user.
10. **Database writes are transactional.** The `savePosts` function issues a full DELETE + re-INSERT in a transaction. When modifying blog storage, maintain this atomicity.

## Deployment Notes

- **Deploy trigger**: `git push origin main` — Railway picks it up automatically.
- **No build step**: Railway runs `node server.js` directly (`npm start`).
- **Node version**: `>=18.0.0` (required for `crypto.randomUUID()` and `AbortSignal.timeout()`).
- **Persistent storage**: The `uploads/` directory is ephemeral on Railway — use Cloudinary for images that must survive redeploys.
- **Database**: Railway PostgreSQL is provisioned as a service addon. The `DATABASE_URL` env var is injected automatically.
- **SQLite is local-only**: `data/blog-posts.sqlite` should never be committed. Local dev uses SQLite; production always uses PostgreSQL.
- **Session loss on redeploy**: In-memory admin sessions reset on every deploy. Admins must log in again after a Railway redeploy.

## Social & Brand

- X / Twitter: `@ATMwithNoPIN`
- TikTok: `@ATMwithNoPIN`
- YouTube: `@ATMwithNoPIN`
- Brand entity: Sunfish Technologies LLC
- Subject matter: poker entertainment — Foxwoods sessions, tournament recaps, bad beats, table stories
