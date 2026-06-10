# Caleb's Space

Browser client and multiplayer relay for the Kings Path space game.

## Main files

- `space_arena_v2.html`: browser game client
- `server.js`: WebSocket multiplayer relay with persistent room state
- `render.yaml`: Render deployment config
- `publish-space-arena.js`: rebuilds the WordPress page payload

## Local run

```powershell
npm install
node server.js
```

Then open `space_arena_v2.html` with a `ws` query param pointing at the running server.

## Notes

- The `main` room is intended to be the shared public room.
- Room state is persisted on the server in `room-state.json`.
- The WordPress homepage needs a live `wss://...` URL in `SPACE_ARENA_CONFIG` for auto-join to work.
