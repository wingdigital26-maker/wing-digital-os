// Web-push sender for the 24/7 watchdog. Subscriptions live in the OS
// Supabase `push_subscriptions` table (service-key only). Every alert goes to
// every registered device; dead endpoints (410/404) are pruned on the spot.
import webpush from "web-push";
import { sbUrl, sbService, sbSelect } from "./osSupabase";

function configured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY &&
      process.env.VAPID_PRIVATE_KEY &&
      sbUrl() &&
      sbService()
  );
}

let vapidSet = false;
function ensureVapid() {
  if (vapidSet) return;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:wjackwing1@gmail.com",
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!
  );
  vapidSet = true;
}

type SubRow = { id: number; endpoint: string; p256dh: string; auth: string };

async function deleteSub(id: number) {
  const url = sbUrl();
  const key = sbService();
  if (!url || !key) return;
  await fetch(`${url}/rest/v1/push_subscriptions?id=eq.${id}`, {
    method: "DELETE",
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  }).catch(() => {});
}

export type PushPayload = {
  title: string;
  body?: string;
  // path the notification opens when tapped, e.g. "/mission"
  url?: string;
  tag?: string;
};

// Send a notification to every subscribed device. Returns counts.
export async function pushToAll(
  payload: PushPayload
): Promise<{ sent: number; failed: number; total: number }> {
  if (!configured()) return { sent: 0, failed: 0, total: 0 };
  ensureVapid();
  const subs = await sbSelect<SubRow>({
    table: "push_subscriptions",
    select: "id,endpoint,p256dh,auth",
    service: true,
  });
  let sent = 0;
  let failed = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
          { TTL: 3600 }
        );
        sent++;
      } catch (e: any) {
        failed++;
        const code = e?.statusCode;
        if (code === 404 || code === 410) await deleteSub(s.id); // device gone
      }
    })
  );
  return { sent, failed, total: subs.length };
}
