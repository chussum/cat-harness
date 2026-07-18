/**
 * dashboard/server/sse.mjs — Server-Sent Events hub.
 *
 * Contract: a FULL snapshot is sent on every (re)connect (never replayed
 * in-memory state — the caller must pass a freshly rebuilt snapshot), then
 * `delta` events afterward as a per-changed-project full resend (coarse,
 * self-healing, matching the watcher's own no-byte-diffing discipline).
 *
 * `removed` events (added for the real server-side "폐업 처리"/unregister
 * endpoint, server.mjs's `POST /api/unregister`) are the drop counterpart to
 * `delta`: `{ root }` only, telling every already-connected client to drop
 * that one project from its live snapshot without waiting for a reconnect.
 */

function formatEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createSseHub() {
  const clients = new Set();

  /** Attach an HTTP response as an SSE client; writes the initial full snapshot immediately. */
  function addClient(res, initialSnapshot) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.write(formatEvent("snapshot", initialSnapshot));
    clients.add(res);
    const removeOnClose = () => clients.delete(res);
    res.on("close", removeOnClose);
    res.on("error", removeOnClose);
  }

  /** Broadcast one changed project's snapshot to every connected client as a delta. */
  function broadcastDelta(projectSnapshot) {
    const payload = formatEvent("delta", projectSnapshot);
    for (const res of clients) {
      try {
        res.write(payload);
      } catch {
        clients.delete(res);
      }
    }
  }

  /** Broadcast that `root` was removed (unregistered) — see the module doc comment. */
  function broadcastRemoved(root) {
    const payload = formatEvent("removed", { root });
    for (const res of clients) {
      try {
        res.write(payload);
      } catch {
        clients.delete(res);
      }
    }
  }

  function clientCount() {
    return clients.size;
  }

  function closeAll() {
    for (const res of clients) {
      try {
        res.end();
      } catch {
        /* already closed */
      }
    }
    clients.clear();
  }

  return { addClient, broadcastDelta, broadcastRemoved, clientCount, closeAll };
}
