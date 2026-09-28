import crypto from 'node:crypto';
import { queryAll, execute } from '../db/index.js';

export interface WebhookRecord {
  id: string;
  url: string;
  event_types: string;
  secret: string | null;
  created_at: string;
}

export interface WebhookDeliveryRecord {
  id: string;
  webhook_id: string;
  event_type: string;
  payload: string;
  response_status: number | null;
  response_body: string | null;
  error_message: string | null;
  delivered_at: string;
}

export function isSafeWebhookUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const hostname = parsed.hostname.toLowerCase();
    const isPrivate =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '0.0.0.0' ||
      hostname === '169.254.169.254' ||
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.local');
    if (isPrivate && process.env.NODE_ENV !== 'test') {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Dispatches an event payload to all registered webhook subscribers asynchronously.
 * Calculates cryptographic HMAC-SHA256 signature using the subscriber's secret in X-Dogfood-Signature.
 * Records delivery telemetry in the webhook_deliveries table.
 */
export async function dispatchWebhookEvent(
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  const webhooks = queryAll<WebhookRecord>('SELECT id, url, event_types, secret FROM webhooks');
  if (webhooks.length === 0) return;

  const serialized = JSON.stringify({
    event: eventType,
    timestamp: new Date().toISOString(),
    data: payload,
  });

  const promises = webhooks.map(async (wh) => {
    // Check event subscription affinity
    const subscribedTypes = wh.event_types.split(',').map((t) => t.trim().toLowerCase());
    const isSubscribed =
      wh.event_types === 'all' ||
      subscribedTypes.includes('*') ||
      subscribedTypes.includes(eventType.toLowerCase());

    if (!isSubscribed) return;
    if (!isSafeWebhookUrl(wh.url)) return;

    const deliveryId = `del_${crypto.randomBytes(6).toString('hex')}`;
    let signatureHeader = '';

    if (wh.secret) {
      const hmac = crypto.createHmac('sha256', wh.secret).update(serialized).digest('hex');
      signatureHeader = `sha256=${hmac}`;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Dogfood-Webhook-Dispatcher/1.0',
      'X-Dogfood-Event': eventType,
    };
    if (signatureHeader) {
      headers['X-Dogfood-Signature'] = signatureHeader;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000); // 3-second timeout

      const res = await fetch(wh.url, {
        method: 'POST',
        headers,
        body: serialized,
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      const responseText = await res.text().catch(() => '');

      execute(
        `INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload, response_status, response_body, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        deliveryId,
        wh.id,
        eventType,
        serialized,
        res.status,
        responseText.substring(0, 500)
      );
    } catch (err: any) {
      execute(
        `INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload, error_message, delivered_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        deliveryId,
        wh.id,
        eventType,
        serialized,
        err?.message || 'Delivery failed'
      );
    }
  });

  // Execute dispatches asynchronously without blocking the primary request cycle
  Promise.allSettled(promises).catch(() => {});
}

/**
 * Retrieves the recent webhook delivery history for coordinator inspection.
 */
export function getRecentWebhookDeliveries(limit: number = 50): WebhookDeliveryRecord[] {
  return queryAll<WebhookDeliveryRecord>(
    `SELECT id, webhook_id, event_type, payload, response_status, response_body, error_message, delivered_at
     FROM webhook_deliveries
     ORDER BY delivered_at DESC
     LIMIT ?`,
    limit
  );
}
