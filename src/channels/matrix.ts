import { createClient, MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface MatrixChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class MatrixChannel implements Channel {
  name = 'matrix';

  private client: MatrixClient | null = null;
  private opts: MatrixChannelOpts;
  private homeserverUrl: string;
  private accessToken: string;
  private userId: string;
  private connected = false;

  constructor(
    homeserverUrl: string,
    accessToken: string,
    userId: string,
    opts: MatrixChannelOpts,
  ) {
    this.homeserverUrl = homeserverUrl;
    this.accessToken = accessToken;
    this.userId = userId;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = createClient({
      baseUrl: this.homeserverUrl,
      accessToken: this.accessToken,
      userId: this.userId,
    });

    this.client.on(
      'Room.timeline' as any,
      (
        event: MatrixEvent,
        room: Room | undefined,
        toStartOfTimeline: boolean | undefined,
      ) => {
        if (toStartOfTimeline) return; // skip historical events during initial sync
        if (!room) return;
        this.handleTimelineEvent(event, room);
      },
    );

    await new Promise<void>((resolve, reject) => {
      const onSync = (state: string) => {
        if (state === 'PREPARED') {
          this.client!.off('sync' as any, onSync);
          this.connected = true;
          logger.info({ userId: this.userId }, 'Matrix client connected');
          console.log(`\n  Matrix: connected as ${this.userId}`);
          console.log(`  Room IDs are your JIDs, prefixed with mx:\n`);
          resolve();
        } else if (state === 'ERROR') {
          this.client!.off('sync' as any, onSync);
          reject(new Error('Matrix initial sync failed'));
        }
      };
      this.client!.on('sync' as any, onSync);
      this.client!.startClient({ initialSyncLimit: 10 });
    });
  }

  private handleTimelineEvent(event: MatrixEvent, room: Room): void {
    if (event.getType() !== 'm.room.message') return;

    // Skip our own messages
    if (event.getSender() === this.userId) return;

    const content = event.getContent();

    // Skip edits and reactions
    const relType = content['m.relates_to']?.['rel_type'];
    if (relType === 'm.replace' || relType === 'm.annotation') return;

    const roomId = room.roomId;
    const jid = `mx:${roomId}`;
    const sender = event.getSender() || '';
    const timestamp = new Date(event.getTs()).toISOString();
    const msgId = event.getId() || '';

    // Resolve sender display name from room membership
    const member = room.getMember(sender);
    const senderName = member?.name || sender;

    const roomName = room.name || roomId;
    const isDirect = room.getMembers().length === 2;

    // Store chat metadata for discovery
    this.opts.onChatMetadata(jid, timestamp, roomName, 'matrix', !isDirect);

    // Only deliver to registered groups
    const group = this.opts.registeredGroups()[jid];
    if (!group) {
      logger.debug({ jid, roomName }, 'Message from unregistered Matrix room');
      return;
    }

    // Map Matrix message types to human-readable content
    const msgType = content.msgtype as string;
    let text: string;
    if (msgType === 'm.text') {
      text = (content.body as string) || '';
    } else if (msgType === 'm.image') {
      text = `[Image${content.body ? ': ' + content.body : ''}]`;
    } else if (msgType === 'm.video') {
      text = `[Video${content.body ? ': ' + content.body : ''}]`;
    } else if (msgType === 'm.audio') {
      text = `[Audio${content.body ? ': ' + content.body : ''}]`;
    } else if (msgType === 'm.file') {
      text = `[File: ${content.body || 'unknown'}]`;
    } else if (msgType === 'm.location') {
      text = `[Location]`;
    } else if (msgType === 'm.sticker') {
      text = `[Sticker]`;
    } else {
      text = `[${msgType || 'Message'}]`;
    }

    this.opts.onMessage(jid, {
      id: msgId,
      chat_jid: jid,
      sender,
      sender_name: senderName,
      content: text,
      timestamp,
      is_from_me: false,
    });

    logger.info({ jid, roomName, sender: senderName }, 'Matrix message stored');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Matrix client not initialized');
      return;
    }

    const roomId = jid.replace(/^mx:/, '');
    try {
      await this.client.sendTextMessage(roomId, text);
      logger.info({ jid, length: text.length }, 'Matrix message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Matrix message');
    }
  }

  async syncGroups(_force = false): Promise<void> {
    if (!this.client) return;
    const rooms = this.client.getRooms();
    for (const room of rooms) {
      const jid = `mx:${room.roomId}`;
      const isDirect = room.getMembers().length === 2;
      this.opts.onChatMetadata(
        jid,
        new Date().toISOString(),
        room.name,
        'matrix',
        !isDirect,
      );
    }
    logger.info({ count: rooms.length }, 'Matrix rooms synced');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('mx:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.stopClient();
      this.client = null;
      this.connected = false;
      logger.info('Matrix client stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client) return;
    const roomId = jid.replace(/^mx:/, '');
    try {
      await (this.client as any).sendTyping(roomId, isTyping, 30000);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Matrix typing indicator');
    }
  }
}

registerChannel('matrix', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'MATRIX_HOMESERVER_URL',
    'MATRIX_ACCESS_TOKEN',
    'MATRIX_USER_ID',
  ]);
  const homeserverUrl =
    process.env.MATRIX_HOMESERVER_URL || envVars.MATRIX_HOMESERVER_URL || '';
  const accessToken =
    process.env.MATRIX_ACCESS_TOKEN || envVars.MATRIX_ACCESS_TOKEN || '';
  const userId = process.env.MATRIX_USER_ID || envVars.MATRIX_USER_ID || '';

  if (!homeserverUrl || !accessToken || !userId) {
    logger.warn(
      'Matrix: MATRIX_HOMESERVER_URL, MATRIX_ACCESS_TOKEN, and MATRIX_USER_ID are all required',
    );
    return null;
  }

  return new MatrixChannel(homeserverUrl, accessToken, userId, opts);
});
