---
name: add-matrix
description: Add Matrix as a channel. Connects to any Matrix homeserver via access token. Rooms become JIDs with the `mx:` prefix.
---

# Add Matrix Channel

This skill adds Matrix support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `matrix` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Do you already have a Matrix access token, or do you need to create one?

If they have one, collect the homeserver URL, access token, and user ID now. If not, guide them through Phase 3.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-matrix
```

This deterministically:
- Adds `src/channels/matrix.ts` (MatrixChannel class with self-registration via `registerChannel`)
- Adds `src/channels/matrix.test.ts` (unit tests)
- Appends `import './matrix.js'` to the channel barrel file `src/channels/index.ts`
- Installs the `matrix-js-sdk` npm dependency
- Updates `.env.example` with `MATRIX_HOMESERVER_URL`, `MATRIX_ACCESS_TOKEN`, `MATRIX_USER_ID`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent file:
- `modify/src/channels/index.ts.intent.md` — what changed and invariants

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Setup

### Create a Matrix access token (if needed)

Tell the user:

> To connect NanoClaw to Matrix, you need:
>
> 1. **Homeserver URL** — e.g. `https://matrix.org` or your own homeserver
> 2. **User ID** — e.g. `@mybot:matrix.org`
> 3. **Access token** — get one by logging in via Element or running:
>    ```
>    curl -XPOST 'https://matrix.org/_matrix/client/v3/login' \
>      -d '{"type":"m.login.password","user":"@mybot:matrix.org","password":"yourpassword"}'
>    ```
>    Copy the `access_token` from the response.
>
> For a dedicated bot account, create a new Matrix account on your homeserver.

Wait for the user to provide all three values.

### Configure environment

Add to `.env`:

```bash
MATRIX_HOMESERVER_URL=https://matrix.org
MATRIX_ACCESS_TOKEN=syt_...
MATRIX_USER_ID=@mybot:matrix.org
```

Channels auto-enable when their credentials are present — no extra configuration needed.

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Registration

### Get Room IDs

Tell the user:

> To find a room's ID for registration:
>
> 1. In Element (or any Matrix client), open the room
> 2. Go to **Room Settings** > **Advanced**
> 3. Copy the **Internal room ID** — it looks like `!abc123:matrix.org`
>
> The JID format for NanoClaw is `mx:!abc123:matrix.org`

Wait for the user to provide the room ID and a display name for it.

### Register the room

For a main room (responds to all messages):

```typescript
registerGroup("mx:!roomId:matrix.org", {
  name: "<room-name>",
  folder: "matrix_main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: true,
});
```

For additional rooms (trigger-only):

```typescript
registerGroup("mx:!roomId:matrix.org", {
  name: "<room-name>",
  folder: "matrix_<room-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

Tell the user:

> Send a message in your registered Matrix room:
> - For main room: any message works
> - For non-main: mention the bot with `@Andy` or whatever your trigger is
>
> The bot should respond within a few seconds.

Check logs if needed:

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

Check:
1. All three env vars are set in `.env` AND synced to `data/env/env`
2. Room is registered in SQLite: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'mx:%'"`
3. For non-main rooms: message includes trigger pattern
4. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)

### Access token invalid

Tokens expire or get revoked. Generate a new one:
```bash
curl -XPOST 'https://<homeserver>/_matrix/client/v3/login' \
  -d '{"type":"m.login.password","user":"<user_id>","password":"<password>"}'
```
Update `MATRIX_ACCESS_TOKEN` in `.env` and `data/env/env`, then restart.

### Bot sees its own messages

This shouldn't happen — the channel skips events where `getSender() === MATRIX_USER_ID`. Verify `MATRIX_USER_ID` in `.env` exactly matches the bot's full MXID (e.g. `@bot:matrix.org`).

### Bot not joining rooms

The bot must be invited to and join rooms before it can receive messages. In Element:
1. Invite `@mybot:matrix.org` to the room
2. Accept the invite from the bot's account (or use Element web logged in as the bot)

## Removal

1. Delete `src/channels/matrix.ts` and `src/channels/matrix.test.ts`
2. Remove `import './matrix.js'` from `src/channels/index.ts`
3. Remove `MATRIX_HOMESERVER_URL`, `MATRIX_ACCESS_TOKEN`, `MATRIX_USER_ID` from `.env`
4. Remove Matrix registrations: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'mx:%'"`
5. Uninstall: `npm uninstall matrix-js-sdk`
6. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
