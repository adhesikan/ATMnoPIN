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
  return renderLayout('ATMwithNoPIN™ Admin', `
    <section class="hero">
      <p class="eyebrow">Admin</p>
      <h1>Publish the next table story</h1>
      <p class="body-text" style="max-width:60ch;">Create, edit, draft, publish, and upload media for the ATMwithNoPIN™ blog.</p>
    </section>
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

  if (pathname === '/' || pathname === '/index.html') {
    const allPosts = (await loadPosts())
      .filter((post) => post.status === 'published')
      .sort((a, b) => new Date(b.published_at || b.created_at) - new Date(a.published_at || a.created_at));
    const heroPosts = allPosts.slice(0, 5);
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
      const allPostsHtml = allPosts.map((post) => `
          <article class="post-card" style="margin-top:.75rem;">
            ${post.featured_image_url ? `<img src="${escapeHtml(post.featured_image_url)}" alt="${escapeHtml(post.featured_image_alt || post.title)}" />` : ''}
            <p class="meta">${escapeHtml(new Date(post.published_at || post.created_at).toLocaleDateString())}</p>
            <h3 style="font-size:1.1rem; margin:.25rem 0;">${escapeHtml(post.title)}</h3>
            <p class="body-text">${escapeHtml(post.excerpt || '')}</p>
            <a href="/blog/${escapeHtml(post.slug)}" style="display:inline-block; margin-top:.5rem;">Read story →</a>
          </article>`).join('');
      const html = data
        .replace('<!-- BLOG_PREVIEW -->', `<section class="schedule" id="latest" style="border-top:1px solid #1a1a1a;"><p class="section-label">// Latest from the ATM</p><h2>Latest from the ATM</h2><p class="body-text" style="max-width:60ch;">Fresh table stories, tournament notes, and bad beats from the ATMwithNoPIN™ world.</p><div class="posts">${allPostsHtml || '<div class="notice">No published posts yet. Publish your first story in the admin area.</div>'}</div><div style="margin-top:1.5rem;"><a href="/blog" style="display:inline-block;color:var(--green);font-size:.78rem;text-transform:uppercase;letter-spacing:.12em;">View all stories on the blog →</a></div></section>`)
        .replace('<!-- RECENT_POSTS -->', recentPostsHtml || '<div class="notice">No published posts yet.</div>')
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
  server.listen(PORT, () => {
    console.log(`ATM is open on port ${PORT} 🏧`);
  });
}

start().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
