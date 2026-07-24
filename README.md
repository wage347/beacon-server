# Beacon

A self-hosted chat app: accounts, custom profiles, friends, direct messages, and file
attachments — served by your own Node.js server instead of running only in a browser tab.

## What's inside

- **server.js** — Express REST API + a WebSocket channel for live message/friend updates.
  Data is stored in plain JSON files under `data/` (no database server to install).
- **public/index.html** — the whole frontend (one file, no build step).
- **data/** — created automatically on first run: `db.json` (users, friends, messages)
  and `uploads/` (attached files). This folder is your entire database — back it up if
  you care about the data.

## Running it locally

You'll need [Node.js](https://nodejs.org) 18 or newer.

```bash
cd beacon-server
npm install
npm start
```

Then open **http://localhost:3000**. Create an account, then open the same URL in a
second browser (or an incognito window) and create a second account to test adding a
friend and messaging between them.

By default it runs on port 3000. To use a different port:

```bash
PORT=8080 npm start
```

## How the pieces fit together

- **Passwords** are hashed with bcrypt before they're stored — never saved as plain text.
- **Login** issues a JWT (JSON Web Token), stored in the browser's `localStorage`, sent
  with every request in an `Authorization: Bearer …` header.
- **Friend requests** are one-directional until accepted; accepting creates a mutual
  friendship, at which point a conversation between the two of you exists.
- **Messages and file uploads** go through the same endpoint
  (`POST /api/messages/:username`), sent as multipart form data. Files are saved to
  `data/uploads/` and served back at `/uploads/<file>`. Attachments are capped at 8 MB —
  change `MAX_UPLOAD_BYTES` in `server.js` if you want a different limit.
- **Live updates** (new messages, friend requests/accepts, profile/status changes) are
  pushed over a WebSocket at `/ws`, so you don't need to refresh the page.

## Deploying it somewhere real

This is a normal Node app, so it runs on any host that runs Node: a VPS, or a
platform-as-a-service host (Render, Railway, Fly.io, etc.). A few things to set up
wherever you deploy:

1. **Persistent disk.** The `data/` folder must survive restarts and redeploys — most
   PaaS free tiers use an ephemeral filesystem that wipes on redeploy, so check for a
   "persistent disk" or "volume" option, or point `DATA_DIR` at a mounted volume.
2. **`JWT_SECRET` environment variable.** Without it, the server generates and saves a
   random secret to `data/.secret` on first run, which is fine as long as `data/`
   persists. Setting `JWT_SECRET` explicitly avoids depending on that file being kept.
3. **`PORT` environment variable.** Most hosts inject this automatically; the server
   already reads `process.env.PORT`.
4. **HTTPS.** The server itself speaks plain HTTP — put it behind a reverse proxy
   (nginx, Caddy, or whatever TLS termination your host provides) before exposing it
   publicly, especially since login sends passwords over the connection.

## Known limits (worth knowing before relying on this)

- No email verification or password reset flow — if you forget a password, there's no
  recovery path built in.
- No rate limiting on login/signup — fine for personal or small-group use, not hardened
  against abuse at scale.
- The JSON-file datastore is simple and fine for a handful of users; it's not built for
  concurrent write-heavy traffic at real scale. Swapping in a real database (Postgres,
  SQLite via a proper driver, etc.) is a reasonable next step if you outgrow it.
