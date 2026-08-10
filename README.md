# Signal — Client Ops

A lightweight client management dashboard for freelancers juggling social
media / digital marketing and software engineering clients. Track daily
metrics per client, get an automatic red / yellow / green performance tag,
and generate AI-written weekly or monthly reports.

## Files

```
signal-client-ops/
├── index.html      # page structure
├── css/style.css    # all styling (dark "control room" theme)
├── js/app.js        # app logic: data model, scoring, rendering, AI calls
└── README.md
```

## Running it

Just open `index.html` in a browser. No build step, no server required.

> Note: this app was originally generated to run inside Claude.ai's
> Artifacts environment, where `window.storage` (data persistence) and the
> `/v1/messages` API call (AI reports) are provided automatically by that
> sandbox. Outside of Claude.ai those two things need to be wired up
> yourself — see "Running outside Claude.ai" below.

## What it does

- **Add / remove clients.** Mark each as new or already-established
  (existing clients get a free-text field to capture where things
  currently stand).
- **Service-based metric templates.** Choose Social Media Marketing,
  Digital Marketing, and/or Software Engineering per client, and the app
  generates the right daily fields automatically (followers, likes, leads,
  conversion rate, sprint progress, bugs fixed, etc.), with optional
  numeric targets per metric.
- **Daily entry logging** with a recent-history table per client.
- **Automatic red / yellow / green scoring**, computed from recent entries
  vs. your targets (or vs. the prior period's trend if no target is set).
  You can also manually force a color per client.
- **Alert banner** on the dashboard listing any client currently red.
- **AI-generated weekly / monthly reports** per client — summary,
  highlights, concerns, recommendations, and a suggested status.
- **Reports tab** aggregating every report you've generated, across all
  clients.

## Running outside Claude.ai

If you want to host this yourself (e.g. on GitHub Pages, Netlify, or your
own server), two things in `js/app.js` need replacing:

1. **Persistence** — `loadClients()` / `saveClients()` currently call
   `window.storage.get/set('clients', ...)`. Swap these for `localStorage`,
   or a real backend (e.g. a small API + database) if you want the data
   accessible from more than one browser/device.

2. **AI reports** — `callClaude()` posts directly to
   `https://api.anthropic.com/v1/messages` with no API key, relying on the
   Claude.ai sandbox to inject auth. To run this yourself you'll need to
   proxy that call through your own backend, attach your own Anthropic API
   key there (never in browser JS), and point `callClaude()` at your proxy
   endpoint instead.

Everything else (UI, scoring logic, metric templates) is plain HTML/CSS/JS
and works anywhere as-is.

## Customizing

- **Metric templates** live in `SERVICE_TEMPLATES` at the top of
  `js/app.js` — add, remove, or rename metrics/services there.
- **Scoring thresholds** (what counts as green/yellow/red) are in
  `computeStatus()` — currently ≥90% of target/trend = green, 60–89% =
  yellow, below 60% or 7+ days without an update = red.
- **Colors/fonts** are CSS variables at the top of `css/style.css`.
