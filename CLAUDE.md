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
| `/uploads/*` | `uploads/` dir | Locally uploaded images |

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
