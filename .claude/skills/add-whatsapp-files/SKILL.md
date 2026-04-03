---
name: add-whatsapp-files
description: Add WhatsApp file attachment support — automatically download and save incoming media, images, documents, audio, and video so agents can read them.
---

# Add WhatsApp Files

Adds media attachment handling to NanoClaw's WhatsApp channel. When a user sends a file, image, video, audio, or document, it is automatically downloaded and saved to the group's `uploads/` directory before the agent runs. The agent receives the file path as part of the message content.

Requires the WhatsApp channel to already be installed (`/add-whatsapp`).

## Phase 1: Pre-flight

```bash
grep -q 'MIME_TO_EXT' src/channels/whatsapp.ts && echo "Already applied" || echo "Not applied"
grep -q 'downloadMediaMessage' src/channels/whatsapp.ts && echo "Import present" || echo "Import missing"
```

If already applied, skip to Phase 3 (Verify).

## Phase 2: Patch `src/channels/whatsapp.ts`

### 2a — Add `downloadMediaMessage` to the baileys import

Find the existing `@whiskeysockets/baileys` import block and add `downloadMediaMessage` to it:

```typescript
import makeWASocket, {
  Browsers,
  DisconnectReason,
  WASocket,
  downloadMediaMessage,   // ← add this
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
```

### 2b — Add `resolveGroupFolderPath` import

Add this import alongside the other local imports (e.g. after the `logger` import):

```typescript
import { resolveGroupFolderPath } from '../group-folder.js';
```

### 2c — Add MIME map and helper (after the imports, before the class)

```typescript
// Map mimetype prefixes to file extensions
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'video/quicktime': 'mov',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'text/plain': 'txt',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

function extFromMime(mimetype: string | null | undefined): string {
  if (!mimetype) return 'bin';
  const base = mimetype.split(';')[0].trim().toLowerCase();
  return MIME_TO_EXT[base] ?? base.split('/')[1] ?? 'bin';
}
```

### 2d — Add media download logic in the message handler

Inside the `messages.upsert` event handler, find the block where `textContent` is assembled from `normalized` message fields. It will look roughly like:

```typescript
const textContent =
  normalized.conversation ||
  normalized.extendedTextMessage?.text ||
  normalized.imageMessage?.caption ||
  ...
  '';
```

Immediately after that block (before `content` is constructed and passed to `onMessage`), insert:

```typescript
// Detect and download media attachments
const mediaMsg =
  normalized.imageMessage ||
  normalized.videoMessage ||
  normalized.audioMessage ||
  normalized.documentMessage ||
  normalized.stickerMessage;

let attachmentRef = '';
if (mediaMsg) {
  try {
    const groupDir = resolveGroupFolderPath(group.folder);
    const uploadsDir = path.join(groupDir, 'uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });

    const mimetype = (mediaMsg as { mimetype?: string }).mimetype ?? null;
    const originalFilename =
      (normalized.documentMessage?.fileName as string | undefined) ?? null;
    const ext = originalFilename
      ? path.extname(originalFilename).replace(/^\./, '') || extFromMime(mimetype)
      : extFromMime(mimetype);
    const msgId = msg.key.id ?? Date.now().toString();
    const basename = originalFilename
      ? `${msgId}_${path.basename(originalFilename)}`
      : `${msgId}.${ext}`;
    const filePath = path.join(uploadsDir, basename);

    const buffer = await downloadMediaMessage(
      msg,
      'buffer',
      {},
      { logger, reuploadRequest: this.sock.updateMediaMessage },
    );
    fs.writeFileSync(filePath, buffer as Buffer);

    // Container sees this path as /workspace/group/uploads/{basename}
    const containerPath = `/workspace/group/uploads/${basename}`;
    attachmentRef = ` [attachment: ${containerPath}]`;
    logger.info({ basename, mimetype, chatJid }, 'Media file saved to uploads');
  } catch (err) {
    logger.warn({ err, chatJid }, 'Failed to download media');
  }
}

const content = textContent + attachmentRef;
```

If the existing code already constructs `content` as `const content = textContent`, change that line to use `textContent + attachmentRef` instead of inserting a duplicate declaration.

Also update the guard that skips empty messages to account for attachment-only messages:

```typescript
// Skip protocol messages with no text content and no attachment
if (!content.trim()) continue;
```

## Phase 3: Build and verify

```bash
npm run build
```

Fix any TypeScript errors, then restart:

```bash
# Linux
systemctl --user restart nanoclaw

# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Test

1. Send an image or document to your registered WhatsApp group
2. Check the uploads directory:
   ```bash
   ls groups/*/uploads/
   ```
3. Ask the agent to describe the file — it should reference the path and be able to read it

The agent's message content will include:
```
[attachment: /workspace/group/uploads/3EB0C123456789AB.jpg]
```

## Troubleshooting

**File not appearing in uploads/**
- Check logs for `Failed to download media` errors
- Verify the WhatsApp channel is connected and the group is registered

**Agent receives path but file is empty**
- WhatsApp media links expire — re-send the file
- Check logs for the download error detail

**Conflicts with skill/reactions**
Both `add-whatsapp-files` and `add-reactions` modify `src/channels/whatsapp.ts`. Resolve by keeping both the media download block and the reaction event handler — they operate in different parts of the message pipeline.
