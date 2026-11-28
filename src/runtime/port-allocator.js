/**
 * Port allocator — hands out free loopback ports without races between
 * concurrent previews. A port stays reserved until released, so two projects
 * that start at the same moment can never receive the same number.
 */
import net from 'node:net';

const reserved = new Set();

function probe() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

export async function allocatePort(avoid = []) {
  const skip = new Set(avoid.map(Number));
  for (let i = 0; i < 50; i++) {
    const p = await probe();
    if (reserved.has(p) || skip.has(p)) continue;
    reserved.add(p);
    return p;
  }
  throw new Error('No free port available for preview.');
}

export function releasePort(port) {
  if (port) reserved.delete(Number(port));
}

export function reservedPorts() {
  return [...reserved];
}

export function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(Number(port), '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

export default { allocatePort, releasePort, reservedPorts, isPortFree };
