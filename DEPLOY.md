# Space Arena Deployment

This project has two deploy targets:

1. `space_arena_v2.html`
   Host this on `kings-path.com` as the production browser client.

2. `server.js`
   Host this on a public Node/WebSocket host like Render, Railway, or Fly.io.

## What is ready

- Multiplayer browser client in `space_arena_v2.html`
- WebSocket server in `server.js`
- Node dependency in `package.json`
- Render config in `render.yaml`
- Production-safe room fallback: `main`
- Multiplayer config memory for the last live `ws`, `room`, and pilot name

## Recommended live setup

### 1. Deploy the WebSocket server

Use Render:

- Create a new Web Service from this folder
- Render should detect `render.yaml`
- After deploy, copy the live URL, for example:
  `wss://kings-path-space-arena-mp.onrender.com`

You can test health at:
`https://your-render-host/health`

### 2. Publish the game page on WordPress

Best options:

- Upload `space_arena_v2.html` as a static file and link to it
- Or create a blank page and embed the HTML with a plugin that allows raw HTML

If you host it as a page, use a URL like:

`https://kings-path.com/space-arena/?ws=wss://YOUR-SERVER-HOST&room=main`

The game now reads:

- `ws` query param for the WebSocket URL
- `room` query param for the room code
- `name` query param for the pilot name
- `window.SPACE_ARENA_CONFIG = { wsUrl: 'wss://...', room: 'main' }` if you want to inject the live server config directly in WordPress

## Recommended launch checklist

1. Deploy `server.js` to Render and confirm `https://your-render-host/health` returns JSON with `"ok": true`.
2. Publish `space_arena_v2.html` to WordPress as a static file or in a full-width raw HTML page.
3. Point the game at the live WebSocket host using either the `ws` query param or `SPACE_ARENA_CONFIG`.
4. Test with two browsers at the same time before sharing the public page.

## Important current limitation

The game has:

- shared co-op enemy combat
- shared room world snapshots
- per-player gems/inventory

But full shared-world authority is not complete yet. The environment sync is currently host-authoritative for the room world.

## Local run

```bash
npm install
node server.js
```

Then open:

`space_arena_v2.html?ws=ws://localhost:8080&room=main`

## Files to upload/share

- `space_arena_v2.html`
- `server.js`
- `package.json`
- `package-lock.json`
- `render.yaml`
