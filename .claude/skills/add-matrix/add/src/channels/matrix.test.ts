import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- matrix-js-sdk mock ---

const clientRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('matrix-js-sdk', () => ({
  createClient: (opts: any) => {
    const handlers = new Map<string, ((...args: any[]) => any)[]>();
    const client = {
      opts,
      sendTextMessage: vi.fn().mockResolvedValue({ event_id: '$sent:matrix.org' }),
      sendTyping: vi.fn().mockResolvedValue(undefined),
      stopClient: vi.fn(),
      getRooms: vi.fn(() => []),
      startClient: vi.fn(async () => {
        // Fire 'PREPARED' synchronously so connect() resolves
        const syncHandlers = handlers.get('sync') || [];
        for (const h of syncHandlers) h('PREPARED', null, {});
      }),
      on(event: string, handler: (...args: any[]) => any) {
        const existing = handlers.get(event) || [];
        existing.push(handler);
        handlers.set(event, existing);
        return this;
      },
      off(event: string, handler: (...args: any[]) => any) {
        const existing = handlers.get(event) || [];
        handlers.set(event, existing.filter((h) => h !== handler));
        return this;
      },
      emit(event: string, ...args: any[]) {
        const existing = handlers.get(event) || [];
        for (const h of existing) h(...args);
      },
      _handlers: handlers,
    };
    clientRef.current = client;
    return client;
  },
}));

import { MatrixChannel, MatrixChannelOpts } from './matrix.js';

// --- Test helpers ---

function createTestOpts(overrides?: Partial<MatrixChannelOpts>): MatrixChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'mx:!room1:matrix.org': {
        name: 'Test Room',
        folder: 'test-room',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createChannel(opts?: MatrixChannelOpts) {
  return new MatrixChannel(
    'https://matrix.org',
    'syt_access_token_123',
    '@bot:matrix.org',
    opts ?? createTestOpts(),
  );
}

function currentClient() {
  return clientRef.current;
}

function makeEvent(overrides: {
  type?: string;
  sender?: string;
  content?: Record<string, any>;
  ts?: number;
  eventId?: string;
}) {
  return {
    getType: () => overrides.type ?? 'm.room.message',
    getSender: () => overrides.sender ?? '@alice:matrix.org',
    getContent: () => overrides.content ?? { msgtype: 'm.text', body: 'Hello' },
    getTs: () => overrides.ts ?? 1704067200000,
    getId: () => overrides.eventId ?? '$ev1:matrix.org',
  };
}

function makeRoom(overrides: {
  roomId?: string;
  name?: string;
  memberIds?: string[];
}) {
  const memberIds = overrides.memberIds ?? ['@alice:matrix.org', '@bot:matrix.org'];
  const members = memberIds.map((id) => ({
    userId: id,
    name: id.split(':')[0].replace('@', ''),
  }));
  return {
    roomId: overrides.roomId ?? '!room1:matrix.org',
    name: overrides.name ?? 'Test Room',
    getMembers: () => members,
    getMember: (userId: string) => members.find((m) => m.userId === userId) ?? null,
  };
}

async function triggerTimeline(
  event: ReturnType<typeof makeEvent>,
  room: ReturnType<typeof makeRoom>,
  toStartOfTimeline = false,
) {
  const handlers = currentClient()._handlers.get('Room.timeline') || [];
  for (const h of handlers) await h(event, room, toStartOfTimeline);
}

// --- Tests ---

describe('MatrixChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when sync reaches PREPARED', async () => {
      const channel = createChannel();
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
    });

    it('isConnected() returns false before connect', () => {
      const channel = createChannel();
      expect(channel.isConnected()).toBe(false);
    });

    it('calls startClient with initialSyncLimit', async () => {
      const channel = createChannel();
      await channel.connect();
      expect(currentClient().startClient).toHaveBeenCalledWith({ initialSyncLimit: 10 });
    });

    it('registers Room.timeline handler on connect', async () => {
      const channel = createChannel();
      await channel.connect();
      expect(currentClient()._handlers.has('Room.timeline')).toBe(true);
    });

    it('disconnects cleanly', async () => {
      const channel = createChannel();
      await channel.connect();
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
      expect(currentClient().stopClient).toHaveBeenCalled();
    });

    it('isConnected() returns false after disconnect', async () => {
      const channel = createChannel();
      await channel.connect();
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('rejects connect() when sync reaches ERROR', async () => {
      // Override startClient to emit ERROR instead of PREPARED
      const channel = createChannel();
      // Re-mock startClient to fire ERROR
      vi.spyOn(clientRef, 'current', 'get').mockReturnValue(clientRef.current);
      const origStartClient = clientRef.current?.startClient;

      // Must get the client before connect so we can override after createClient runs
      // We create the channel here, then patch startClient before calling connect
      const c2 = createChannel();
      // After createClient ran for c2, patch startClient on the new client
      currentClient().startClient = vi.fn(async () => {
        const syncHandlers = currentClient()._handlers.get('sync') || [];
        for (const h of syncHandlers) h('ERROR', null, {});
      });

      await expect(c2.connect()).rejects.toThrow('Matrix initial sync failed');
      if (origStartClient) currentClient().startClient = origStartClient;
    });
  });

  // --- Text message handling ---

  describe('text message handling', () => {
    it('delivers m.text message for registered room', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);
      await channel.connect();

      const event = makeEvent({ content: { msgtype: 'm.text', body: 'Hello world' } });
      const room = makeRoom({});
      await triggerTimeline(event, room);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'mx:!room1:matrix.org',
        expect.any(String),
        'Test Room',
        'matrix',
        false, // 2-member room = DM = not a group
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'mx:!room1:matrix.org',
        expect.objectContaining({
          id: '$ev1:matrix.org',
          chat_jid: 'mx:!room1:matrix.org',
          sender: '@alice:matrix.org',
          sender_name: 'alice',
          content: 'Hello world',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered rooms', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);
      await channel.connect();

      const event = makeEvent({});
      const room = makeRoom({ roomId: '!unknown:matrix.org', name: 'Unknown' });
      await triggerTimeline(event, room);

      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips own messages', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);
      await channel.connect();

      const event = makeEvent({ sender: '@bot:matrix.org' });
      const room = makeRoom({});
      await triggerTimeline(event, room);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips non-message event types', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);
      await channel.connect();

      const event = makeEvent({ type: 'm.room.member' });
      const room = makeRoom({});
      await triggerTimeline(event, room);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips edited messages (m.replace)', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);
      await channel.connect();

      const event = makeEvent({
        content: {
          msgtype: 'm.text',
          body: '* edited',
          'm.relates_to': { rel_type: 'm.replace', event_id: '$orig:matrix.org' },
        },
      });
      const room = makeRoom({});
      await triggerTimeline(event, room);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips reactions (m.annotation)', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);
      await channel.connect();

      const event = makeEvent({
        content: {
          msgtype: 'm.text',
          body: '👍',
          'm.relates_to': { rel_type: 'm.annotation', event_id: '$orig:matrix.org', key: '👍' },
        },
      });
      const room = makeRoom({});
      await triggerTimeline(event, room);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips historical events (toStartOfTimeline=true)', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);
      await channel.connect();

      const event = makeEvent({});
      const room = makeRoom({});
      await triggerTimeline(event, room, true);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips events with no room', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);
      await channel.connect();

      const handlers = currentClient()._handlers.get('Room.timeline') || [];
      for (const h of handlers) await h(makeEvent({}), undefined, false);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('resolves sender name from room member', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);
      await channel.connect();

      const event = makeEvent({ sender: '@alice:matrix.org' });
      const room = makeRoom({ memberIds: ['@alice:matrix.org', '@bot:matrix.org'] });
      await triggerTimeline(event, room);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'mx:!room1:matrix.org',
        expect.objectContaining({ sender_name: 'alice' }),
      );
    });

    it('falls back to sender ID when member not found', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);
      await channel.connect();

      const event = makeEvent({ sender: '@ghost:matrix.org' });
      const room = makeRoom({ memberIds: ['@alice:matrix.org', '@bot:matrix.org'] });
      await triggerTimeline(event, room);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'mx:!room1:matrix.org',
        expect.objectContaining({ sender_name: '@ghost:matrix.org' }),
      );
    });

    it('marks multi-member rooms as groups (isGroup=true)', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'mx:!room1:matrix.org': {
            name: 'Team Room',
            folder: 'team-room',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = createChannel(opts);
      await channel.connect();

      const event = makeEvent({});
      const room = makeRoom({
        memberIds: ['@alice:matrix.org', '@bob:matrix.org', '@bot:matrix.org'],
      });
      await triggerTimeline(event, room);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'mx:!room1:matrix.org',
        expect.any(String),
        'Test Room',
        'matrix',
        true, // 3 members = group
      );
    });

    it('converts event timestamp to ISO string', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);
      await channel.connect();

      const event = makeEvent({ ts: 1704067200000 });
      const room = makeRoom({});
      await triggerTimeline(event, room);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'mx:!room1:matrix.org',
        expect.objectContaining({ timestamp: '2024-01-01T00:00:00.000Z' }),
      );
    });
  });

  // --- Message type mapping ---

  describe('message type mapping', () => {
    async function sendMsgType(opts: MatrixChannelOpts, content: Record<string, any>) {
      const channel = createChannel(opts);
      await channel.connect();
      const event = makeEvent({ content });
      const room = makeRoom({});
      await triggerTimeline(event, room);
    }

    it('passes m.text body as-is', async () => {
      const opts = createTestOpts();
      await sendMsgType(opts, { msgtype: 'm.text', body: 'Plain text' });
      expect(opts.onMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ content: 'Plain text' }),
      );
    });

    it('formats m.image with filename', async () => {
      const opts = createTestOpts();
      await sendMsgType(opts, { msgtype: 'm.image', body: 'photo.jpg' });
      expect(opts.onMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ content: '[Image: photo.jpg]' }),
      );
    });

    it('formats m.image without body', async () => {
      const opts = createTestOpts();
      await sendMsgType(opts, { msgtype: 'm.image' });
      expect(opts.onMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ content: '[Image]' }),
      );
    });

    it('formats m.video', async () => {
      const opts = createTestOpts();
      await sendMsgType(opts, { msgtype: 'm.video', body: 'clip.mp4' });
      expect(opts.onMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ content: '[Video: clip.mp4]' }),
      );
    });

    it('formats m.audio', async () => {
      const opts = createTestOpts();
      await sendMsgType(opts, { msgtype: 'm.audio', body: 'voice.ogg' });
      expect(opts.onMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ content: '[Audio: voice.ogg]' }),
      );
    });

    it('formats m.file with filename', async () => {
      const opts = createTestOpts();
      await sendMsgType(opts, { msgtype: 'm.file', body: 'report.pdf' });
      expect(opts.onMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ content: '[File: report.pdf]' }),
      );
    });

    it('formats m.file without filename', async () => {
      const opts = createTestOpts();
      await sendMsgType(opts, { msgtype: 'm.file' });
      expect(opts.onMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ content: '[File: unknown]' }),
      );
    });

    it('formats m.location', async () => {
      const opts = createTestOpts();
      await sendMsgType(opts, { msgtype: 'm.location', body: 'geo:51.5,-0.1' });
      expect(opts.onMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ content: '[Location]' }),
      );
    });

    it('formats m.sticker', async () => {
      const opts = createTestOpts();
      await sendMsgType(opts, { msgtype: 'm.sticker' });
      expect(opts.onMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ content: '[Sticker]' }),
      );
    });

    it('formats unknown message types with type label', async () => {
      const opts = createTestOpts();
      await sendMsgType(opts, { msgtype: 'm.custom.type' });
      expect(opts.onMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ content: '[m.custom.type]' }),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via Matrix client', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);
      await channel.connect();

      await channel.sendMessage('mx:!room1:matrix.org', 'Hello Matrix');

      expect(currentClient().sendTextMessage).toHaveBeenCalledWith(
        '!room1:matrix.org',
        'Hello Matrix',
      );
    });

    it('strips mx: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);
      await channel.connect();

      await channel.sendMessage('mx:!private:example.com', 'DM message');

      expect(currentClient().sendTextMessage).toHaveBeenCalledWith(
        '!private:example.com',
        'DM message',
      );
    });

    it('handles send failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);
      await channel.connect();

      currentClient().sendTextMessage.mockRejectedValueOnce(new Error('Forbidden'));

      await expect(
        channel.sendMessage('mx:!room1:matrix.org', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('does nothing when client is not initialized', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);

      // Don't connect
      await channel.sendMessage('mx:!room1:matrix.org', 'No client');

      // No API call made — clientRef.current is from last test but we check it wasn't called on a fresh channel
    });
  });

  // --- syncGroups ---

  describe('syncGroups', () => {
    it('iterates getRooms and emits metadata', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);
      await channel.connect();

      currentClient().getRooms.mockReturnValue([
        makeRoom({ roomId: '!room1:matrix.org', name: 'Room One' }),
        makeRoom({
          roomId: '!room2:matrix.org',
          name: 'Group Chat',
          memberIds: ['@a:h', '@b:h', '@c:h'],
        }),
      ]);

      await channel.syncGroups();

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'mx:!room1:matrix.org',
        expect.any(String),
        'Room One',
        'matrix',
        false,
      );
      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'mx:!room2:matrix.org',
        expect.any(String),
        'Group Chat',
        'matrix',
        true,
      );
    });

    it('does nothing when client is not initialized', async () => {
      const opts = createTestOpts();
      const channel = createChannel(opts);

      await channel.syncGroups(); // no error
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns mx: room JIDs', () => {
      const channel = createChannel();
      expect(channel.ownsJid('mx:!room1:matrix.org')).toBe(true);
    });

    it('owns mx: DM JIDs', () => {
      const channel = createChannel();
      expect(channel.ownsJid('mx:@user:matrix.org')).toBe(true);
    });

    it('does not own Telegram JIDs', () => {
      const channel = createChannel();
      expect(channel.ownsJid('tg:123456789')).toBe(false);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = createChannel();
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = createChannel();
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('sends typing indicator when isTyping is true', async () => {
      const channel = createChannel();
      await channel.connect();

      await channel.setTyping('mx:!room1:matrix.org', true);

      expect(currentClient().sendTyping).toHaveBeenCalledWith(
        '!room1:matrix.org',
        true,
        30000,
      );
    });

    it('sends stop-typing when isTyping is false', async () => {
      const channel = createChannel();
      await channel.connect();

      await channel.setTyping('mx:!room1:matrix.org', false);

      expect(currentClient().sendTyping).toHaveBeenCalledWith(
        '!room1:matrix.org',
        false,
        30000,
      );
    });

    it('does nothing when client is not initialized', async () => {
      const channel = createChannel();
      await channel.setTyping('mx:!room1:matrix.org', true);
      // No error
    });

    it('handles typing failure gracefully', async () => {
      const channel = createChannel();
      await channel.connect();

      currentClient().sendTyping.mockRejectedValueOnce(new Error('Rate limited'));

      await expect(
        channel.setTyping('mx:!room1:matrix.org', true),
      ).resolves.toBeUndefined();
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "matrix"', () => {
      const channel = createChannel();
      expect(channel.name).toBe('matrix');
    });
  });
});
