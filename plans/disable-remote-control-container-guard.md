# Container-Level Remote Control Guard

## Problem

`/remote-control` is a Claude Code feature that opens an outbound tunnel from the
host machine to Anthropic's relay infrastructure, giving interactive shell access
to the host. This bypasses container isolation entirely — the session runs as the
host user, not inside the container.

The threat: if a WhatsApp account is compromised, an attacker could instruct the
agent to initiate a remote session and gain host-level access, escaping the
container security boundary that NanoClaw relies on.

## Why the host-level block alone isn't enough

`src/index.ts` already blocks `/remote-control` when sent as a WhatsApp command.
But the agent runs Claude Code inside the container via the Agent SDK. If the agent
is socially engineered, it could invoke `claude /remote-control` directly via the
`Bash` tool, bypassing the WhatsApp-level check entirely.

## Approach

Two complementary layers applied at container build time, activated by the presence
of a `container/disable-remote-control` marker file:

### Layer 1: Feature flag suppression

`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` is set as a container environment
variable. This disables the GrowthBook feature flag evaluation that enables remote
control, hiding the `/remote-control` and `/rc` commands from Claude Code entirely.

### Layer 2: Binary wrapper

The `claude` binary is replaced with a shell script that intercepts any invocation
where `/remote-control` or `/remote-control-end` appears as an argument and exits
with an error. The real binary is preserved as `claude.real`.

This guards against any future scenario where Layer 1 is bypassed (e.g. if
Anthropic changes how the feature flag works).

## Implementation

### `container/disable-remote-control` (marker file)

An empty file. Its presence on disk signals to `build.sh` that the guard should
be baked into the container image. Not committed to git — it's a per-install
decision, like `.env`.

Create it:
```bash
touch container/disable-remote-control
```

Remove it to re-enable remote control:
```bash
rm container/disable-remote-control
./container/build.sh
```

### `container/build.sh`

Checks for the marker file and passes `--build-arg DISABLE_REMOTE_CONTROL=1` to
the Docker build if present.

### `container/Dockerfile`

Accepts `ARG DISABLE_REMOTE_CONTROL=0`. When set to `1`:
- Wraps the `claude` binary to block `/remote-control` invocations
- Sets `ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`

### Applying via skill

Run `/disable-remote-control` — Phase 5 of the skill creates the marker file and
rebuilds the container.

### Applying during setup

The `/setup` skill asks about disabling remote control during the security hardening
step and creates the marker file + rebuilds if confirmed.

## Limitations

- The binary wrapper only intercepts calls where `/remote-control` appears as a CLI
  argument. If Claude Code's remote control protocol is invoked through the SDK
  internals without going via the binary, the wrapper won't catch it.
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is not officially documented as a
  remote control disable. It works by suppressing feature flag fetches — Anthropic
  could change this behaviour in a future release.
- Neither layer prevents a sufficiently determined agent from making direct HTTP
  requests to Anthropic's relay infrastructure using `WebFetch` or `Bash` + curl,
  since the container has unrestricted outbound internet access.

## Known open issues at Anthropic

- [#28917](https://github.com/anthropics/claude-code/issues/28917) — request to revoke remote control session links
- [#29929](https://github.com/anthropics/claude-code/issues/29929) — config toggle resets unreliably
- [#30495](https://github.com/anthropics/claude-code/issues/30495) — config toggle missing for some users

No account-level or managed-settings key exists to disable remote control as of
March 2026.

## Related

- `src/index.ts` — host-level block with user-facing reply message
- `.claude/skills/disable-remote-control/SKILL.md` — skill that applies all layers
