import { createInterface } from 'node:readline';
import { createProtocol, rpcError } from './protocol.js';

export function startStdio(service, { input = process.stdin, output = process.stdout, onClose } = {}) {
  const protocol = createProtocol(service);
  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
  let outputFailed = false;
  const stop = () => {
    outputFailed = true;
    lines.close();
  };
  output.on('error', stop);
  lines.on('error', stop);
  const send = message => {
    if (!message || outputFailed) return;
    try {
      if (output.destroyed || output.writableEnded) stop();
      else output.write(JSON.stringify(message) + '\n');
    } catch {
      stop();
    }
  };
  const pending = new Set();
  lines.on('line', line => {
    if (outputFailed || !line.trim()) return;
    let message;
    try {
      if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('Too large');
      message = JSON.parse(line);
    } catch {
      send(rpcError(null, -32700, 'Parse error'));
      return;
    }
    const call = Promise.resolve().then(() => protocol(message, send))
      .then(send, () => send(rpcError(message?.id ?? null, -32603, 'Internal error')))
      .catch(stop)
      .finally(() => pending.delete(call));
    pending.add(call);
  });
  lines.once('close', () => {
    Promise.allSettled(pending).finally(onClose).catch(() => {});
  });
  return lines;
}
