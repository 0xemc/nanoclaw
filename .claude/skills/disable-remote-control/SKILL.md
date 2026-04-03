---
name: disable-remote-control
description: Disable the /remote-control command for existing NanoClaw installations. Prevents the host machine from being accessed via claude.ai/code remote sessions. Safe to run on any install regardless of version — patches source code if needed and updates the database.
---

# Disable Remote Control

Disables the `/remote-control` and `/remote-control-end` commands on your NanoClaw installation. After applying this, anyone who sends `/remote-control` from the main channel will receive a rejection message and no session will start.

Works on any install — whether or not the `remoteControl` flag support has been merged into core yet.

## Phase 1: Check what's already in place

```bash
grep -q "remoteControl === false" src/index.ts && echo "Runtime check: YES" || echo "Runtime check: MISSING"
grep -q "remoteControl" src/types.ts && echo "Type field: YES" || echo "Type field: MISSING"
grep -q "remote_control" src/db.ts && echo "DB support: YES" || echo "DB support: MISSING"
grep -q "no-remote-control" setup/register.ts && echo "Register flag: YES" || echo "Register flag: MISSING"
```

## Phase 2: Patch source code (if needed)

Only do this if Phase 1 showed anything as MISSING. Apply only the sections that are missing.

### `src/types.ts` — add `remoteControl` to `RegisteredGroup`

In the `RegisteredGroup` interface, add after `isMain`:

```typescript
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
  remoteControl?: boolean; // Default: true. Set to false to disable /remote-control commands.
```

### `src/db.ts` — add DB column + migration + read/write support

**1. In the `CREATE TABLE registered_groups` statement**, change the last column line from:
```sql
      requires_trigger INTEGER DEFAULT 1
```
to:
```sql
      requires_trigger INTEGER DEFAULT 1,
      remote_control INTEGER DEFAULT 1
```

**2. After the existing `is_main` migration block** (the `ALTER TABLE ... ADD COLUMN is_main` try/catch), add:
```typescript
  // Add remote_control column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN remote_control INTEGER DEFAULT 1`,
    );
  } catch {
    /* column already exists */
  }
```

**3. In `getRegisteredGroup`**, add to the row type:
```typescript
        remote_control: number | null;
```
And add to the returned object:
```typescript
    remoteControl: row.remote_control !== 0,
```

**4. In `setRegisteredGroup`**, change the INSERT statement from:
```typescript
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ...
    group.isMain ? 1 : 0,
  );
```
to:
```typescript
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main, remote_control)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ...
    group.isMain ? 1 : 0,
    group.remoteControl === false ? 0 : 1,
  );
```

**5. In `getAllRegisteredGroups`**, add to the row type:
```typescript
    remote_control: number | null;
```
And add to the mapping inside the loop:
```typescript
      remoteControl: row.remote_control !== 0,
```

### `src/index.ts` — add runtime guard

In `handleRemoteControl`, immediately after the `!group?.isMain` guard block, add:

```typescript
    if (group.remoteControl === false) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: disabled for this group',
      );
      const channel = findChannel(channels, chatJid);
      await channel?.sendMessage(chatJid, 'Remote control is disabled for this installation.');
      return;
    }
```

### `setup/register.ts` — add `--no-remote-control` flag

In the `RegisterArgs` interface, add:
```typescript
  remoteControl: boolean;
```

In the defaults object inside `parseArgs`, add:
```typescript
    remoteControl: true,
```

In the `for` loop's `switch` block, add a case:
```typescript
      case '--no-remote-control':
        result.remoteControl = false;
        break;
```

In the `run` function where the group is written, add `remoteControl` to the object passed to `setRegisteredGroup`:
```typescript
    remoteControl: parsed.remoteControl,
```

## Phase 3: Build

```bash
npm run build
```

Fix any TypeScript errors before continuing.

## Phase 4: Disable via database

Run the following — idempotent and safe to run multiple times:

```bash
sqlite3 store/messages.db "
  ALTER TABLE registered_groups ADD COLUMN remote_control INTEGER DEFAULT 1;
" 2>/dev/null || true

sqlite3 store/messages.db "
  UPDATE registered_groups SET remote_control = 0 WHERE is_main = 1;
"

sqlite3 store/messages.db "
  SELECT jid, folder, is_main, remote_control FROM registered_groups;
"
```

Confirm the main group row shows `remote_control = 0`.

## Phase 5: Restart NanoClaw

```bash
# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux (systemd)
systemctl --user restart nanoclaw

# Dev mode — just stop and re-run
npm run dev
```

## Phase 6: Verify

Send `/remote-control` from your main channel. You should get back "Remote control is disabled for this installation." and no session should start. Check logs:

```bash
grep "Remote control rejected" logs/nanoclaw.log | tail -5
```

Expected: `Remote control rejected: disabled for this group`

## To re-enable

```bash
sqlite3 store/messages.db "UPDATE registered_groups SET remote_control = 1 WHERE is_main = 1;"
```

Then restart NanoClaw.

## Notes

- Only the main group's `remote_control` flag matters — `/remote-control` is already rejected for non-main groups.
- If you have multiple main groups (unusual), this disables Remote Control for all of them.
- The `--no-remote-control` flag on `setup/register.ts` only applies when registering a new group. Use the Phase 4 SQL for existing installations.
- On new installs with this change already merged into core, Phase 2 can be skipped entirely.
