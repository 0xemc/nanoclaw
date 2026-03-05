---
name: add-matrix
description: Add Matrix as a channel. Connects to the reference Matrix server (matrix.org) or a custom server via access token. Rooms become JIDs with the `mx:` prefix.
---

# Add Matrix Channel

This skill adds Matrix support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `matrix` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Do you already have a Matrix access token, or do you need to create one?

If they have one, ask which server they're using:
- Default: **matrix.org** (the reference Matrix server)
- Or a custom server URL they provide

Collect the server URL (default `https://matrix.org`), access token, and user ID. If they don't have a token yet, guide them through Phase 3.

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

### 3a. Choose server

AskUserQuestion: Which Matrix server are you using?
- **matrix.org** (default — the reference Matrix server)
- **Custom** — user provides their own server URL

Store the chosen URL as `MATRIX_SERVER` for all subsequent API calls (default `https://matrix.org`).

### 3b. Collect credentials

If the user already has a token (from Phase 1 pre-flight), skip to 3d.

AskUserQuestion: Collect the Matrix username (full MXID like `@you:matrix.org`, or just the localpart like `you` if using matrix.org) and password. Do NOT store the password anywhere — use it only for the login API call, then discard it.

If the user doesn't have a Matrix account yet, tell them to register one at https://app.element.io (for matrix.org) or on their own server, then come back.

### 3c. Generate access token automatically

Run the login API call and extract the token in one step:

```bash
curl -s -XPOST "$MATRIX_SERVER/_matrix/client/v3/login" \
  -H 'Content-Type: application/json' \
  -d "{\"type\":\"m.login.password\",\"user\":\"$MATRIX_USER\",\"password\":\"$MATRIX_PASSWORD\"}"
```

Parse the response:
- If it contains `access_token`: extract it with `jq -r '.access_token'` (or parse manually if jq unavailable)
- If it contains `errcode`: show the error and ask the user to check their credentials. Common errors:
  - `M_FORBIDDEN` — wrong password
  - `M_INVALID_USERNAME` — check the username format (try full MXID `@user:matrix.org`)

Extract `user_id` from the response too (the canonical MXID) — use this as `MATRIX_USER_ID`.

### 3d. Write credentials to .env

Upsert these three lines in `.env` (replace if key exists, append if not):

```bash
upsert_env() {
  local key=$1 val=$2
  if grep -q "^${key}=" .env 2>/dev/null; then
    sed -i.bak "s|^${key}=.*|${key}=${val}|" .env && rm -f .env.bak
  else
    echo "${key}=${val}" >> .env
  fi
}
upsert_env MATRIX_HOMESERVER_URL "$MATRIX_SERVER"
upsert_env MATRIX_ACCESS_TOKEN "$TOKEN"
upsert_env MATRIX_USER_ID "$USER_ID"
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

Channels auto-enable when their credentials are present — no extra configuration needed.

### 3e. Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Registration

### 4a. Look up room by name automatically

Ask the user for the **name** of the room they want to register (e.g. "General", "NanoClaw"). Do NOT ask them to find the room ID manually.

Fetch all joined rooms using the stored access token:

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$MATRIX_SERVER/_matrix/client/v3/joined_rooms"
```

For each returned room ID, fetch its display name:

```bash
ENCODED=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$ROOM_ID")
curl -s -H "Authorization: Bearer $TOKEN" \
  "$MATRIX_SERVER/_matrix/client/v3/rooms/$ENCODED/state/m.room.name"
```

Match the user's input against room display names (case-insensitive substring). If multiple rooms match, present them and ask the user to pick one. If none match, list all joined rooms and ask them to choose.

The JID is `mx:${roomId}` where `roomId` is the raw Matrix room ID (e.g. `!abc123:matrix.org`).

### 4b. Register the room

AskUserQuestion: Should this be the **main** room (responds to all messages) or a **trigger-only** room (requires @Andy prefix)?

For a main room:

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

For a trigger-only room:

```typescript
registerGroup("mx:!roomId:matrix.org", {
  name: "<room-name>",
  folder: "matrix_<slug>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

After registering, ask: "Do you want to register another room?" If yes, repeat Phase 4a–4b.

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
curl -XPOST 'https://<server>/_matrix/client/v3/login' \
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

```bash
npx tsx scripts/uninstall-skill.ts matrix
```
