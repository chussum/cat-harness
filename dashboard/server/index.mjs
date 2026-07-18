#!/usr/bin/env node
/**
 * dashboard/server/index.mjs — entry point: node dashboard/server/index.mjs
 *
 * Wires lifecycle, registry, snapshot, watcher, and sse (server.mjs) into a
 * running process: start()s the server, then handles SIGINT/SIGTERM for a
 * graceful compare-and-delete shutdown. F16: if the fixed port is already
 * taken, this process logs and exits non-zero — it never tries another port.
 */

import { createServer } from "./server.mjs";

async function main() {
  const server = createServer();
  try {
    const info = await server.start();
    process.stderr.write(
      `[dashboard/server] listening on http://127.0.0.1:${info.port} (pid=${info.pid}, home=${server.homeDir})\n`,
    );
  } catch (err) {
    // F16: no port fallback. A bind failure is a hard, logged failure.
    process.stderr.write(`[dashboard/server] failed to bind port ${server.port}: ${err?.message ?? err}\n`);
    await server.shutdown("bind_failed"); // releases the watcher cleanly before exit
    process.exitCode = 1;
    return;
  }

  let shuttingDown = false;
  async function handleSignal(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[dashboard/server] received ${signal}, shutting down\n`);
    const result = await server.shutdown(signal);
    process.stderr.write(`[dashboard/server] shutdown result: ${JSON.stringify(result)}\n`);
    process.exit(0);
  }
  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));
}

main().catch((err) => {
  process.stderr.write(`[dashboard/server] fatal: ${err?.stack ?? err}\n`);
  process.exitCode = 1;
});
