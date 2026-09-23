import { loadEmailFeed, type FeedItem, type FeedPayload } from "../../email/feed/source";

// ───────────────────────────────────────────────────────────────────────────
// GET /api/messages/stream — Server-Sent Events for the email feed.
//
// Jack asked for a live connection: "I want it to be a live connection too,
// instantly." A refresh button is not that, and a client-side poll re-renders
// the whole board every tick. This route holds the connection open, reads the
// same loader the feed route uses, and pushes only what changed:
//
//   event: snapshot   the whole payload, once, on connect
//   event: append     rows whose key was never seen on this connection
//   event: patch      rows whose state / timestamp / engagement moved
//   event: lanes      a lane's availability or reason changed
//   event: bye        the connection hit its lifetime, reconnect
//   (a `:` comment every tick doubles as the keepalive)
//
// DELIBERATELY NOT A STATUS LIGHT. The UI shows it is live by rows appearing,
// never by a badge or a dot — Jack's standing rule against status indicators.
//
// Read-only. Nothing here sends, queues, or schedules an email.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// How often the server re-reads the lanes. The cold lane is a paid third-party
// API, so this is a real cost: 8 seconds would be 450 calls an hour per open
// tab. 20 seconds is live enough for a feed a human reads.
const TICK_MS = 20_000;
// Long-lived connections leak through proxies and through Next's dev server on
// hot reload. Hang up cleanly after 30 minutes and let EventSource reconnect.
const MAX_LIFETIME_MS = 30 * 60 * 1000;

/** Only the fields whose change is worth pushing. Cheap to compare, no deep diff. */
function fingerprint(i: FeedItem): string {
  return [i.state, i.at, i.opens, i.clicks, i.replies, i.error, i.subject].join("|");
}

function laneFingerprint(p: FeedPayload): string {
  return p.lanes.map((l) => `${l.id}:${l.available ? 1 : 0}:${l.reason ?? ""}`).join("||");
}

export async function GET(req: Request) {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | null = null;
  let endTimer: ReturnType<typeof setTimeout> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const seen = new Map<string, string>();
      let lanes = "";

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const comment = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ${text}\n\n`));
        } catch {
          closed = true;
        }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        if (endTimer) clearTimeout(endTimer);
        try { controller.close(); } catch { /* already torn down */ }
      };

      req.signal.addEventListener("abort", finish);

      // Tell the browser how long to wait before reconnecting if we drop.
      comment("wing os email stream");
      if (!closed) controller.enqueue(encoder.encode(`retry: 5000\n\n`));

      // ── First paint: the whole payload, so the client never has to make a
      // separate /api/email/feed call just to get started.
      try {
        const first = await loadEmailFeed({ limit: 100, forceContext: true });
        for (const i of first.items) seen.set(i.key, fingerprint(i));
        lanes = laneFingerprint(first);
        send("snapshot", first);
      } catch (e) {
        send("failed", { reason: e instanceof Error ? e.message : String(e) });
        finish();
        return;
      }

      // ── Ticks: diff against what this connection has already shown.
      timer = setInterval(() => {
        void (async () => {
          if (closed) return;
          let next: FeedPayload;
          try {
            next = await loadEmailFeed({ limit: 100 });
          } catch (e) {
            // A failed tick is a fact, not a reason to drop the connection —
            // the next one may well succeed.
            send("failed", { reason: e instanceof Error ? e.message : String(e) });
            return;
          }

          const appended: FeedItem[] = [];
          const patched: FeedItem[] = [];
          for (const i of next.items) {
            const fp = fingerprint(i);
            const had = seen.get(i.key);
            if (had === undefined) appended.push(i);
            else if (had !== fp) patched.push(i);
            seen.set(i.key, fp);
          }

          if (appended.length) send("append", { items: appended, fetchedAt: next.fetchedAt });
          if (patched.length) send("patch", { items: patched, fetchedAt: next.fetchedAt });

          const lf = laneFingerprint(next);
          if (lf !== lanes) {
            lanes = lf;
            send("lanes", { lanes: next.lanes, campaigns: next.campaigns, fetchedAt: next.fetchedAt });
          }

          // Keepalive on every tick, whether or not anything moved, so a proxy
          // never decides the connection is idle.
          comment(`tick ${next.fetchedAt}`);
        })();
      }, TICK_MS);

      endTimer = setTimeout(() => {
        send("bye", { reason: "connection lifetime reached, reconnecting" });
        finish();
      }, MAX_LIFETIME_MS);
    },
    cancel() {
      if (timer) clearInterval(timer);
      if (endTimer) clearTimeout(endTimer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx and some CDNs buffer text/event-stream unless told not to.
      "X-Accel-Buffering": "no",
    },
  });
}
