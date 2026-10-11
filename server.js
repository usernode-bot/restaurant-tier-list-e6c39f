const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Visitors with no Homeroom account ("guests") may look around this app at
// its own address, read-only (every public app). The platform marks
// them with a token of their own: ES256, signed by a key of its own (its
// public half is USERNODE_GUEST_JWT_PUBLIC_KEY), this audience, `pur:
// 'guest'`, `guest: true`, and no id or username. Such a visitor is
// `req.guest`, never `req.user`, and every write they try is answered 401
// `account_required`, which the bridge turns into "Make an account to
// continue".
const GUEST_AUDIENCE = APP_AUDIENCE ? APP_AUDIENCE + ':guest' : null;
const GUEST_PUBLIC_KEY = (process.env.USERNODE_GUEST_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
//
// /api/list and /api/me are deliberately open reads: the app's own HTML
// shell is reachable at its address like any public app's, guests may read
// everything anyway, and the board is communal content. Keeping them open
// means a visitor with no token at all still gets the honest read-only
// board instead of console 401s. Every write stays deny-by-default.
const PUBLIC_API_PATHS = new Set(['/health', '/api/list', '/api/me']);

// ── Tier list data ─────────────────────────────────────────────────────────
// The product is one communal list ("a tier list for our favorite
// restaurants"): the app reads and writes the oldest tier_lists row, and
// there is no list picker. Staging previews open with ?demo=1 point at the
// seeded demo list instead, so the plain route keeps its production shape.
const TIERS = ['S', 'A', 'B', 'C', 'D'];
const DEMO_LIST_ID = 900001;
const DEMO_UNSHARED_LIST_ID = 900002;

// Escape user text for the server-rendered share page. The page is served
// to anonymous strangers and carries user input (titles, restaurant names,
// notes), so this runs on every interpolated value.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// "Now" for this request, as a Date: `req.now`, set for every request by
// the middleware below. Read the day and the time through it (and
// `usernode.now()` in the page), never `new Date()` or SQL's NOW(),
// wherever they decide what shows: a reminder, a rota, a deadline.
// Production always gets the real time. A staging preview may be shown as of
// a chosen moment: the platform opens it with `?un-now=<ISO time>`, and the
// page sends `usernode.now()` on as the `x-usernode-now` header. Only a
// staging container reads either. See "Time-dependent features" in the
// platform conventions.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const PREVIEW_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
function requestNow(req) {
  const raw = IS_STAGING ? (req.headers['x-usernode-now'] || req.query['un-now']) : null;
  return typeof raw === 'string' && PREVIEW_NOW.test(raw) ? new Date(raw) : new Date();
}

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  req.now = requestNow(req);
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }
  if (!req.user && token && GUEST_PUBLIC_KEY && GUEST_AUDIENCE) {
    try {
      const guest = jwt.verify(token, GUEST_PUBLIC_KEY, {
        algorithms: ['ES256'],
        issuer: 'usernode',
        audience: GUEST_AUDIENCE,
      });
      if (guest && guest.pur === 'guest' && guest.guest === true) req.guest = true;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet. A guest may READ: every GET,
  // `/api/*` included, so read routes must not assume req.user (use
  // `req.user ? req.user.id : null`). Every write needs an account.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user && req.guest) {
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      return res.status(401).json({ error: 'account_required' });
    }
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ── Tier list API ──────────────────────────────────────────────────────────
// Read routes never assume req.user (guests may read): they only pick the
// list, never the viewer. Writes arrive here only with a verified account —
// the middleware above already answers guests with 401 account_required.

// Which list this request operates on: the demo list in staging demo mode,
// otherwise the one communal list.
async function currentListId(req) {
  if (IS_STAGING && req.query.demo === '1') {
    const demo = await pool.query('SELECT id FROM tier_lists WHERE id = $1', [DEMO_LIST_ID]);
    if (demo.rows.length) return demo.rows[0].id;
  }
  const own = await pool.query('SELECT id FROM tier_lists ORDER BY id LIMIT 1');
  return own.rows.length ? own.rows[0].id : null;
}

// Who is looking, so the page can hide member-only controls from guests.
app.get('/api/me', (req, res) => {
  res.json({ user: req.user ? { id: req.user.id, username: req.user.username } : null });
});

app.get('/api/list', async (req, res) => {
  try {
    const listId = await currentListId(req);
    if (!listId) return res.json({ list: null, tiers: {} });
    const list = await pool.query('SELECT id, title FROM tier_lists WHERE id = $1', [listId]);
    const entries = await pool.query(
      'SELECT id, name, note, tier, position FROM entries WHERE list_id = $1 ORDER BY position ASC, id ASC',
      [listId],
    );
    const tiers = {};
    for (const tier of TIERS) tiers[tier] = [];
    for (const row of entries.rows) if (tiers[row.tier]) tiers[row.tier].push(row);
    const tierCount = TIERS.filter((tier) => tiers[tier].length > 0).length;
    return res.json({
      list: {
        id: list.rows[0].id,
        title: list.rows[0].title,
        entryCount: entries.rows.length,
        tierCount,
      },
      tiers,
    });
  } catch (err) {
    console.error('list load failed: ' + err.message);
    return res.status(500).json({ error: 'Could not load the list' });
  }
});

app.post('/api/entries', async (req, res) => {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const tier = typeof req.body.tier === 'string' ? req.body.tier.toUpperCase() : '';
    if (!name) return res.status(400).json({ error: 'Give the restaurant a name first' });
    if (name.length > 80) return res.status(400).json({ error: 'Keep the name under 80 characters' });
    if (!TIERS.includes(tier)) return res.status(400).json({ error: 'Pick a tier' });
    const listId = await currentListId(req);
    if (!listId) return res.status(500).json({ error: 'No list to add to yet' });
    // New restaurants land at the end of their tier; rows keep arrival order.
    const next = await pool.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS position FROM entries WHERE list_id = $1 AND tier = $2',
      [listId, tier],
    );
    const added = await pool.query(
      `INSERT INTO entries (list_id, name, tier, position, added_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, note, tier, position`,
      [listId, name, tier, next.rows[0].position, req.user.id],
    );
    return res.status(201).json({ entry: added.rows[0] });
  } catch (err) {
    console.error('entry add failed: ' + err.message);
    return res.status(500).json({ error: 'Could not add the restaurant' });
  }
});

app.patch('/api/entries/:id', async (req, res) => {
  try {
    const tier = typeof req.body.tier === 'string' ? req.body.tier.toUpperCase() : '';
    if (!TIERS.includes(tier)) return res.status(400).json({ error: 'Pick a tier' });
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad restaurant id' });
    const listId = await currentListId(req);
    const next = await pool.query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS position FROM entries WHERE list_id = $1 AND tier = $2',
      [listId, tier],
    );
    const moved = await pool.query(
      `UPDATE entries SET tier = $1, position = $2
       WHERE id = $3 AND list_id = $4
       RETURNING id, name, note, tier, position`,
      [tier, next.rows[0].position, id, listId],
    );
    if (!moved.rows.length) return res.status(404).json({ error: 'Restaurant not found on this list' });
    return res.json({ entry: moved.rows[0] });
  } catch (err) {
    console.error('entry move failed: ' + err.message);
    return res.status(500).json({ error: 'Could not move the restaurant' });
  }
});

// ── Sharing ────────────────────────────────────────────────────────────────
// A share link is the list's slug: unguessable (128-bit random), revocable,
// and the only key to the public page. Sharing state lives on the list row.

app.get('/api/share', async (req, res) => {
  try {
    const listId = await currentListId(req);
    if (!listId) return res.json({ shared: false, slug: null });
    const state = await pool.query('SELECT share_slug FROM tier_lists WHERE id = $1', [listId]);
    const slug = state.rows[0] ? state.rows[0].share_slug : null;
    return res.json({ shared: !!slug, slug });
  } catch (err) {
    console.error('share state failed: ' + err.message);
    return res.status(500).json({ error: 'Could not load sharing' });
  }
});

app.post('/api/share', async (req, res) => {
  try {
    const listId = await currentListId(req);
    if (!listId) return res.status(500).json({ error: 'No list to share yet' });
    // Idempotent: sharing an already-shared list hands back the SAME link,
    // so a double tap never invalidates one someone already has.
    const existing = await pool.query(
      'SELECT share_slug FROM tier_lists WHERE id = $1 AND share_slug IS NOT NULL',
      [listId],
    );
    if (existing.rows.length) return res.json({ shared: true, slug: existing.rows[0].share_slug });
    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = crypto.randomBytes(16).toString('base64url');
      try {
        const minted = await pool.query(
          `UPDATE tier_lists SET share_slug = $1, shared_at = now(), updated_at = now()
           WHERE id = $2 AND share_slug IS NULL
           RETURNING share_slug`,
          [slug, listId],
        );
        if (minted.rows.length) return res.status(201).json({ shared: true, slug: minted.rows[0].share_slug });
        // Someone shared concurrently; their slug wins.
        const current = await pool.query('SELECT share_slug FROM tier_lists WHERE id = $1', [listId]);
        return res.json({ shared: true, slug: current.rows[0].share_slug });
      } catch (err) {
        if (err.code !== '23505') throw err; // slug collision: retry with fresh randomness
      }
    }
    return res.status(500).json({ error: 'Could not create the link' });
  } catch (err) {
    console.error('share create failed: ' + err.message);
    return res.status(500).json({ error: 'Could not create the link' });
  }
});

app.delete('/api/share', async (req, res) => {
  try {
    const listId = await currentListId(req);
    if (listId) {
      // Revocation is permanent by design: clearing the slug kills every
      // copy of the link, and a later share mints a fresh one, so a revoked
      // link can never come back.
      await pool.query(
        'UPDATE tier_lists SET share_slug = NULL, shared_at = NULL, updated_at = now() WHERE id = $1',
        [listId],
      );
    }
    return res.json({ shared: false, slug: null });
  } catch (err) {
    console.error('share revoke failed: ' + err.message);
    return res.status(500).json({ error: 'Could not stop sharing' });
  }
});

// ── The public share page ──────────────────────────────────────────────────
// Deliberately public: that is the feature. A GET outside /api/* already
// passes the auth gate, so nothing is added to PUBLIC_API_PATHS and there is
// no public write surface. Server-rendered, so read-only is enforced by the
// server rather than by hiding buttons. Must stay registered BEFORE the
// catch-all below, which would otherwise send unauthenticated visits to the
// chromeless redirect instead of the shared list.

const THEME_SCRIPT = `(function () {
  var media = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    var theme = (window.usernode && window.usernode.theme) || (media.matches ? 'dark' : 'light');
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
  }
  applyTheme();
  window.addEventListener('usernode:theme-changed', applyTheme);
  media.addEventListener('change', applyTheme);
})();`;

// The head every server-rendered page here shares: same relative hosted
// assets and theme following as the app shell, so a shared link looks like
// the app in any browser, inside Homeroom or out. noindex keeps search
// engines away; the og tags give pasted links a title in chat previews.
function publicPageHead(title) {
  const safeTitle = escapeHtml(title);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex">
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="A shared restaurant tier list. Read only.">
  <title>${safeTitle} · Restaurant Tier List</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='45' fill='%237c3aed'/><circle cx='50' cy='50' r='18' fill='white'/></svg>">
  <link rel="stylesheet" href="/tailwind.css">
  <script src="/usernode-bridge/v1/bridge.js"></script>
  <script>${THEME_SCRIPT}</script>
</head>`;
}

function renderSharePage(title, entryRows) {
  const tiers = {};
  for (const tier of TIERS) tiers[tier] = [];
  for (const row of entryRows) if (tiers[row.tier]) tiers[row.tier].push(row);
  const shownTiers = TIERS.filter((tier) => tiers[tier].length > 0);
  const count = entryRows.length;
  // The public page shows the ranking, never the people: no added_by, no
  // user ids, no usernames anywhere in the markup.
  const board = count === 0
    ? `<div class="state-empty">
      <h2 class="text-heading">No restaurants yet</h2>
      <p class="text-body text-muted">The group has not added any restaurants to this list.</p>
    </div>`
    : shownTiers.map((tier) => `<section>
      <h2 class="section-label">Tier ${tier}</h2>
      <ul class="list">
        ${tiers[tier].map((entry) => `<li class="list-row">
          <div class="min-w-0 flex-1">
            <p class="text-body">${escapeHtml(entry.name)}</p>
            ${entry.note ? `<p class="text-small text-muted">${escapeHtml(entry.note)}</p>` : ''}
          </div>
        </li>`).join('\n')}
      </ul>
    </section>`).join('\n');
  const meta = count === 0 ? '' : `<p class="text-small text-muted">${count}
    ${count === 1 ? 'restaurant' : 'restaurants'} · ${shownTiers.length}
    ${shownTiers.length === 1 ? 'tier' : 'tiers'}</p>`;
  return `${publicPageHead(title)}
<body class="min-h-screen bg-ground text-fg">
  <main class="mx-auto flex max-w-md flex-col gap-6 px-4 py-10">
    <span class="self-start rounded-full bg-raised px-3 py-1 text-small font-medium text-muted">Shared view · read only</span>
    <div>
      <h1 class="text-title">${escapeHtml(title)}</h1>
      ${meta}
    </div>
    ${board}
    <p class="text-center text-small text-muted">This is a shared view. To add or sort restaurants, open the app in Homeroom.</p>
  </main>
</body>
</html>`;
}

function renderNotSharedPage() {
  return `${publicPageHead('Link not shared')}
<body class="min-h-screen bg-ground text-fg">
  <main class="mx-auto flex max-w-md flex-col gap-8 px-4 py-10">
    <div class="state-error">
      <h1 class="text-heading">This link is not shared anymore</h1>
      <p class="text-body text-muted">Sharing was turned off, or the link was never valid. Ask the group for a fresh link if you want to see the list.</p>
    </div>
    <p class="text-center text-small text-muted">Restaurant Tier List</p>
  </main>
</body>
</html>`;
}

app.get('/share/:slug', async (req, res) => {
  try {
    const slug = String(req.params.slug || '');
    const found = await pool.query('SELECT id, title FROM tier_lists WHERE share_slug = $1', [slug]);
    if (!found.rows.length) {
      res.set('Cache-Control', 'no-store');
      // A soft 404: unknown and revoked slugs show the same "not shared"
      // page. It stays under 200 so link checks that require a loadable
      // page keep passing; noindex keeps crawlers away either way.
      return res.send(renderNotSharedPage());
    }
    const entries = await pool.query(
      'SELECT name, note, tier FROM entries WHERE list_id = $1 ORDER BY position ASC, id ASC',
      [found.rows[0].id],
    );
    // no-store so turning sharing off takes hold on the very next visit.
    res.set('Cache-Control', 'no-store');
    return res.send(renderSharePage(found.rows[0].title, entries.rows));
  } catch (err) {
    console.error('share page failed: ' + err.message);
    return res.status(500).send(`<!DOCTYPE html><meta charset="utf-8"><title>Restaurant Tier List</title>
      <p style="font-family:system-ui;padding:2rem">Something went wrong loading this shared list. Try again.</p>`);
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user && !req.guest) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/restaurant-tier-list-e6c39f/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/restaurant-tier-list-e6c39f/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Schema, applied idempotently on boot. Both tables are public by default
// (platform rule): the content is communal and already visible to members
// in-app, and a share slug is revocable state, not a credential.
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tier_lists (
      id bigserial PRIMARY KEY,
      title text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS entries (
      id bigserial PRIMARY KEY,
      list_id bigint NOT NULL REFERENCES tier_lists(id),
      name text NOT NULL,
      note text,
      tier text NOT NULL,
      position integer NOT NULL,
      added_by bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await pool.query('ALTER TABLE tier_lists ADD COLUMN IF NOT EXISTS share_slug text');
  await pool.query('ALTER TABLE tier_lists ADD COLUMN IF NOT EXISTS shared_at timestamptz');
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS tier_lists_share_slug_idx
    ON tier_lists (share_slug) WHERE share_slug IS NOT NULL`);
  // The communal list exists exactly once, from the very first boot.
  await pool.query(`
    INSERT INTO tier_lists (title)
    SELECT 'Favorite restaurants'
    WHERE NOT EXISTS (SELECT 1 FROM tier_lists)`);
}

// Staging seed: fake identities only, "Staging demo" prefixed, idempotent,
// and strictly a no-op outside staging. List 900001 carries the fixed slug
// staging-demo-share so testers and checks can reach the public page; the
// boot re-asserts that slug (DO UPDATE), so a tester revoking sharing cannot
// leave the preview's share test broken until the next rebuild. List 900002
// stays unshared for seeing sharing start from zero.
const DEMO_ENTRIES = [
  ['Staging demo noodle bar', 'S'],
  ['Staging demo dumpling house', 'S'],
  ['Staging demo laksa corner', 'A'],
  ['Staging demo grilled cheese cart', 'A'],
  ['Staging demo sushi express', 'A'],
  ['Staging demo pizza on the corner', 'B'],
  ['Staging demo late-night martabak', 'B'],
  ['Staging demo cafeteria buffet', 'C'],
];

async function seedStagingDemo() {
  if (!IS_STAGING) return;
  await pool.query(
    `INSERT INTO tier_lists (id, title, share_slug, shared_at)
     VALUES ($1, 'Staging demo: favorite restaurants', 'staging-demo-share', now())
     ON CONFLICT (id) DO UPDATE SET share_slug = 'staging-demo-share', shared_at = now()`,
    [DEMO_LIST_ID],
  );
  await pool.query(
    `INSERT INTO tier_lists (id, title)
     VALUES ($1, 'Staging demo: unshared list')
     ON CONFLICT (id) DO NOTHING`,
    [DEMO_UNSHARED_LIST_ID],
  );
  const have = await pool.query(
    'SELECT COUNT(*)::int AS n FROM entries WHERE list_id = $1',
    [DEMO_LIST_ID],
  );
  if (have.rows[0].n > 0) return;
  for (let i = 0; i < DEMO_ENTRIES.length; i++) {
    await pool.query(
      'INSERT INTO entries (list_id, name, tier, position, added_by) VALUES ($1, $2, $3, $4, $5)',
      [DEMO_LIST_ID, DEMO_ENTRIES[i][0], DEMO_ENTRIES[i][1], i + 1, 900001],
    );
  }
}

async function start() {
  await migrate();
  await seedStagingDemo();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
  // Stop accepting connections, drain briefly, close the pool, exit.
  const shutdown = () => {
    server.close(() => { pool.end().then(() => process.exit(0)); });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch(err => { console.error(err); process.exit(1); });
