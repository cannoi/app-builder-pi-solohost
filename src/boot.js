/**
 * Bootstrap: register fatal handlers before loading the full server graph.
 * Ensures Docker logs always show the real crash reason.
 */
function logFatal(kind, err) {
  const msg = err && (err.stack || err.message) ? (err.stack || err.message) : String(err);
  console.error(`[boot] ${kind}:`, msg);
}

process.on('uncaughtException', (err) => logFatal('uncaughtException', err));
process.on('unhandledRejection', (err) => logFatal('unhandledRejection', err));

try {
  await import('./server.js');
} catch (err) {
  logFatal('server import/start failed', err);
  process.exit(1);
}
