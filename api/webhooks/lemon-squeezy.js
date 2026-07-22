const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

// Disable Vercel's default bodyParser to obtain exact raw body buffer for HMAC SHA256 signature verification
export const config = {
  api: {
    bodyParser: false,
  },
};

/**
 * Helper to extract raw request body stream into a Buffer
 */
async function getRawBody(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Verify Lemon Squeezy Webhook Signature
 */
function verifySignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  try {
    const hmac = crypto.createHmac('sha256', secret);
    const digest = Buffer.from(hmac.update(rawBody).digest('hex'), 'utf8');
    const signatureBuffer = Buffer.from(signature, 'utf8');
    return crypto.timingSafeEqual(digest, signatureBuffer);
  } catch (err) {
    console.error('Signature verification error:', err);
    return false;
  }
}

/**
 * Send Push Message via LINE Messaging API
 */
async function sendLineMessagingPush(userEmail, bookingDate, bookingHour, amountStr, currentSold = null) {
  const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const adminUserId = process.env.LINE_ADMIN_USER_ID;

  if (!channelAccessToken || !adminUserId) {
    console.warn('[LINE Notification] Skipped: LINE_CHANNEL_ACCESS_TOKEN or LINE_ADMIN_USER_ID not configured.');
    return false;
  }

  let messageText = [
    `🎉【Chronid 新短租訂單通知】`,
    `📧 買家 Email：${userEmail}`,
    `📅 租用日期：${bookingDate}`,
    `⏰ 租用時段：${bookingHour} 起 (24小時)`,
    `💰 付款金額：${amountStr}`
  ];

  if (currentSold !== null) {
    messageText[0] = `🎉【Chronid 買斷版訂單通知】`;
    messageText.push(`🔥 早鳥已售出：${currentSold} / 10`);
  }

  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${channelAccessToken}`
    },
    body: JSON.stringify({
      to: adminUserId,
      messages: [
        {
          type: 'text',
          text: messageText.join('\n')
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[LINE Messaging API Error]', response.status, errorText);
    return false;
  }

  console.log('[LINE Notification] Push message sent successfully.');
  return true;
}

/**
 * Send Notification via LINE Notify (Fallback / Alternative option)
 */
async function sendLineNotify(userEmail, bookingDate, bookingHour, amountStr, currentSold = null) {
  const notifyToken = process.env.LINE_NOTIFY_TOKEN;
  if (!notifyToken) return false;

  let messageText = [
    `\n🎉【Chronid 新短租訂單通知】`,
    `📧 買家 Email：${userEmail}`,
    `📅 租用日期：${bookingDate}`,
    `⏰ 租用時段：${bookingHour} 起 (24小時)`,
    `💰 付款金額：${amountStr}`
  ];

  if (currentSold !== null) {
    messageText[0] = `\n🎉【Chronid 買斷版訂單通知】`;
    messageText.push(`🔥 早鳥已售出：${currentSold} / 10`);
  }

  const response = await fetch('https://notify-api.line.me/api/notify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Bearer ${notifyToken}`
    },
    body: new URLSearchParams({ message: messageText.join('\n') }).toString()
  });

  return response.ok;
}

/**
 * Increment early bird sold count in Vercel KV
 */
async function incrementEarlyBirdCount() {
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return null;

  try {
    const response = await fetch(`${kvUrl}/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${kvToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(['INCR', 'early_bird_sold_count'])
    });
    const data = await response.json();
    return data.result; // new count
  } catch (err) {
    console.error('Error incrementing count:', err);
    return null;
  }
}

export default async function handler(req, res) {
  // Webhooks from Lemon Squeezy are POST requests
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  try {
    // 1. Get raw request body & signature header
    const rawBody = await getRawBody(req);
    const signature = req.headers['x-signature'];
    const webhookSecret = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET;

    // 2. Verify Webhook Signature
    if (!webhookSecret) {
      console.warn('[Webhook Warning] LEMON_SQUEEZY_WEBHOOK_SECRET is not configured.');
    } else if (!verifySignature(rawBody, signature, webhookSecret)) {
      console.error('[Webhook Error] Invalid signature verification failed.');
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    // 3. Parse JSON Payload
    const payload = JSON.parse(rawBody.toString('utf8'));
    const eventName = payload?.meta?.event_name;

    console.log(`[Lemon Squeezy Webhook] Received event: ${eventName}`);

    // Filter for order_created event
    if (eventName === 'order_created') {
      const attributes = payload?.data?.attributes || {};
      const customData = payload?.meta?.custom_data || {};

      // Extract buyer Email
      const userEmail = attributes.user_email || attributes.customer_email || customData.email || '未提供 Email';

      // Extract custom booking date & hour
      const bookingDate = customData.booking_date || '未指定日期';
      const bookingHour = customData.start_time || customData.booking_hour || '未指定時間';
      const userTimezone = customData.user_timezone || 'UTC';

      // Compute startAtUtc if not directly supplied in custom_data
      let startAtUtc = customData.start_at_utc;
      if (!startAtUtc && customData.booking_date) {
        try {
          const hourStr = (customData.start_time || customData.booking_hour || '00:00').padStart(5, '0');
          startAtUtc = new Date(`${customData.booking_date}T${hourStr}:00Z`).toISOString();
        } catch (e) {
          console.error('[Webhook Error] Failed to parse startAtUtc from booking_date & start_time:', e);
        }
      }

      // Amount formatted
      const amountStr = attributes.total_formatted || '$49 USD';
      
      // Increment early bird count if amount indicates early bird price (99 USD)
      let currentSold = null;
      if (attributes.total === 9900 || amountStr.includes('99')) {
        currentSold = await incrementEarlyBirdCount();
      }

      // Check for $49 Short-Term Rental Automation
      if (startAtUtc && (attributes.total === 4900 || amountStr.includes('49'))) {
        try {
          const startDate = new Date(startAtUtc);
          const endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
          const endAtUtc = endDate.toISOString();

          const randomPassword = crypto.randomBytes(6).toString('hex'); // 12 characters

          const supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_SERVICE_ROLE_KEY
          );

          const { data: userData, error: userError } = await supabase.auth.admin.createUser({
            email: userEmail,
            password: randomPassword,
            email_confirm: true,
            user_metadata: {
              startTime: startAtUtc,
              endTime: endAtUtc
            }
          });

          if (userError) {
            console.error('[Supabase] Error creating user:', userError);
          } else {
            console.log('[Supabase] User created successfully.');
            const resend = new Resend(process.env.RESEND_API_KEY);
            const formattedLocalTime = new Intl.DateTimeFormat('en-US', {
              timeZone: userTimezone,
              dateStyle: 'medium',
              timeStyle: 'short'
            }).format(startDate);

            const fromEmail = process.env.RESEND_FROM_EMAIL || 'Chronid Support <chronid.tw@gmail.com>';
            const loginUrl = process.env.APP_URL ? `${process.env.APP_URL}/login` : 'https://your-domain.com/login';

            await resend.emails.send({
              from: fromEmail,
              to: userEmail,
              subject: '[Chronid] Your Rental Access Credentials & Instructions',
              html: `
                <h2>Welcome to Chronid!</h2>
                <p>Your short-term rental has been successfully processed.</p>
                <p><strong>Login URL:</strong> <a href="${loginUrl}">${loginUrl}</a></p>
                <p><strong>Email:</strong> ${userEmail}</p>
                <p><strong>Password:</strong> ${randomPassword}</p>
                <br/>
                <p><strong>Valid Booking Window:</strong></p>
                <p>${formattedLocalTime} (Local Time) / ${startAtUtc} UTC</p>
                <p>to</p>
                <p>${endAtUtc} UTC</p>
                <br/>
                <p>If you have any questions, contact us at chronid.tw@gmail.com</p>
              `
            });
            console.log('[Resend] Credentials sent successfully.');
          }
        } catch (rentalErr) {
          console.error('[Rental Processing Error]', rentalErr);
        }
      }

      // 4. Trigger LINE Notification (Messaging API or LINE Notify)
      await Promise.all([
        sendLineMessagingPush(userEmail, bookingDate, bookingHour, amountStr, currentSold),
        sendLineNotify(userEmail, bookingDate, bookingHour, amountStr, currentSold)
      ]);

      return res.status(200).json({
        success: true,
        message: 'Order created webhook processed and LINE notification sent.',
        booking: { userEmail, bookingDate, bookingHour, amountStr }
      });
    }

    // Ignore other events smoothly
    return res.status(200).json({ success: true, message: `Event ${eventName} ignored.` });

  } catch (error) {
    console.error('[Lemon Squeezy Webhook Error]', error);
    return res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
}
