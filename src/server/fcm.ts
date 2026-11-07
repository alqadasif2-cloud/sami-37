import fs from 'fs';
import path from 'path';

export interface DeviceTokenRecord {
  id: string;
  token: string;
  userId: number;
  username: string;
  deviceId?: string;
  platform?: string;
  deviceModel?: string;
  updatedAt: number;
  createdAt: number;
}

const FCM_STORE_FILE = path.resolve('data/fcm_tokens.json');

function loadFcmTokens(): Record<string, DeviceTokenRecord> {
  try {
    if (fs.existsSync(FCM_STORE_FILE)) {
      return JSON.parse(fs.readFileSync(FCM_STORE_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('[FCM] Error reading tokens:', err);
  }
  return {};
}

function saveFcmTokens(tokens: Record<string, DeviceTokenRecord>) {
  try {
    const dir = path.dirname(FCM_STORE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(FCM_STORE_FILE, JSON.stringify(tokens, null, 2), 'utf-8');
  } catch (err) {
    console.error('[FCM] Error saving tokens:', err);
  }
}

export function hasServerFcmCredentials(): boolean {
  return Boolean(process.env.FCM_SERVER_KEY || process.env.FIREBASE_MESSAGING_KEY);
}

export async function registerDeviceToken(params: {
  token: string;
  userId: number;
  username: string;
  deviceId?: string;
  platform?: string;
  deviceModel?: string;
}): Promise<DeviceTokenRecord> {
  const tokens = loadFcmTokens();
  const id = `fcm_tok_${params.userId}_${params.deviceId || 'dev'}`;
  const now = Date.now();

  const record: DeviceTokenRecord = {
    id,
    token: params.token,
    userId: params.userId,
    username: params.username,
    deviceId: params.deviceId,
    platform: params.platform || 'android',
    deviceModel: params.deviceModel,
    updatedAt: now,
    createdAt: tokens[id]?.createdAt || now,
  };

  tokens[id] = record;
  saveFcmTokens(tokens);
  return record;
}

export async function unregisterDeviceToken(userId: number, token?: string, deviceId?: string): Promise<void> {
  const tokens = loadFcmTokens();
  let changed = false;

  for (const [key, item] of Object.entries(tokens)) {
    if (item.userId === userId) {
      if ((token && item.token === token) || (deviceId && item.deviceId === deviceId) || (!token && !deviceId)) {
        delete tokens[key];
        changed = true;
      }
    }
  }

  if (changed) {
    saveFcmTokens(tokens);
  }
}

export async function sendNotificationToUsers(
  recipientIds: number[],
  payload: { title?: string; body?: string; chatType?: string; data?: Record<string, string> }
): Promise<{ success: boolean; sentCount: number }> {
  const tokens = loadFcmTokens();
  const matchingTokens: string[] = [];

  for (const item of Object.values(tokens)) {
    if (recipientIds.includes(item.userId) && item.token) {
      matchingTokens.push(item.token);
    }
  }

  if (matchingTokens.length === 0) {
    return { success: true, sentCount: 0 };
  }

  console.log(`[FCM Push] Notification queued for ${matchingTokens.length} devices:`, payload.title);
  return { success: true, sentCount: matchingTokens.length };
}

export async function dispatchAuthorizedChatPush(params: {
  senderId: number;
  senderName?: string;
  senderRole?: string;
  chatType: 'channel' | 'private';
  channelId?: string;
  receiverId?: number;
  messageId: string;
  snippet: string;
}): Promise<{ sentCount: number; recipientIds?: number[]; error?: string }> {
  try {
    const tokens = loadFcmTokens();
    const recipientIds: number[] = [];

    if (params.chatType === 'private' && params.receiverId) {
      recipientIds.push(params.receiverId);
    } else {
      for (const item of Object.values(tokens)) {
        if (item.userId !== params.senderId && !recipientIds.includes(item.userId)) {
          recipientIds.push(item.userId);
        }
      }
    }

    const title = params.senderName || 'رسالة جديدة';
    await sendNotificationToUsers(recipientIds, {
      title,
      body: params.snippet,
      chatType: params.chatType,
      data: {
        chatType: params.chatType,
        channelId: params.channelId || '',
        messageId: params.messageId,
      },
    });

    return { sentCount: recipientIds.length, recipientIds };
  } catch (err: any) {
    return { sentCount: 0, error: err?.message || String(err) };
  }
}
