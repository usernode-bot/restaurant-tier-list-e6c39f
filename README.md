# Restaurant Tier List

Rank your favorite restaurants together. Anyone in the group can add
restaurants, everyone sorts them into tiers (S, A, B, C, D), and the board
shows where each one lands. One communal list, no per-person ranks: what
you see is what the group built.

## Sharing

Any signed-in member can turn on sharing from the **Share** button. The
link it creates shows a read-only view of the list to anyone at all, with
no account needed and nothing to sign in to. The page shows the ranking
and never the people: no usernames, no who-added-what. Stopping sharing
kills the link for good; sharing again creates a brand new one, so a
revoked link can never come back.

## How it works

- **Sign-in** — the server verifies the platform-issued user token
  (an RS256 JWT) on every request, so the app already knows who is
  using it. No accounts to build. People without an account can look
  around read-only, including at shared links.
- **Database** — one communal list (`tier_lists`) with restaurant
  `entries`, plus the `share_slug` that powers the public link.
- **Public share page** — served by the server at `/share/<slug>`:
  server-rendered, deliberately public, and HTML-escaped; registered
  before the auth-gated catch-all.
- **Styling** — Tailwind CSS, precompiled by `npm run build` during
  image creation with either Kubernetes/Paketo or standalone Docker, in a
  light and a dark look that follow the viewer's Homeroom theme.
