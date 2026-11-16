// The IPC transport: a Windows named pipe (\\.\pipe\house-signer), or a unix socket in
// tests and on other systems. Newline-delimited JSON, one request per line, one answer per
// line, matched by `id` (answers can come back in a different order than the requests).
//
// The transport is not the security boundary: whatever connects can only ask for what
// policy.mjs allows. It does refuse oversized lines (a line is held in memory until its
// newline) and anything that is not JSON, and it only listens locally.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const MAX_LINE_BYTES = 64 * 1024;

export function defaultPipePath() {
  return process.platform === 'win32' ? '\\\\.\\pipe\\house-signer' : path.join(os.tmpdir(), 'house-signer.sock');
}

const bad = (reason) => `${JSON.stringify({ ok: false, id: null, field: 'request', reason })}\n`;

/** Serve `handle(request) -> answer` on `pipePath`. Resolves once listening. */
export async function startServer({ pipePath = defaultPipePath(), handle, maxLineBytes = MAX_LINE_BYTES, log = () => {} }) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    const answer = (res) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(res)}\n`);
    };
    socket.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (Buffer.byteLength(line, 'utf8') > maxLineBytes) { socket.write(bad(`a request line may be at most ${maxLineBytes} bytes`)); continue; } // PIN:S.line
        if (line.trim() === '') continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          socket.write(bad('a request must be one line of JSON'));
          continue;
        }
        Promise.resolve()
          .then(() => handle(req))
          .then(answer, () => answer({ ok: false, id: typeof req?.id === 'string' ? req.id : null, field: 'internal', reason: 'the signer hit an unexpected error' }));
      }
      if (Buffer.byteLength(buffer, 'utf8') > maxLineBytes) {
        // No newline within the limit: drop the connection rather than buffer without end.
        socket.end(bad(`a request line may be at most ${maxLineBytes} bytes`));
        socket.destroy();
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        reject(new Error(`${pipePath} is already in use: another signer (or something pretending to be one) is listening there`));
      } else {
        reject(e);
      }
    });
    server.listen(pipePath, resolve);
  });
  if (process.platform !== 'win32') {
    // Only this user may connect to the socket.
    fs.chmodSync(pipePath, 0o600);
  }
  log(`listening on ${pipePath}`);
  return {
    server,
    // server.close() alone only stops new connections, and the bot keeps one open for its
    // whole life: so every open one is ended here too, or Ctrl+C would leave it answered.
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      for (const socket of sockets) socket.destroy(); // PIN:S.close
    }),
  };
}

/** A tiny client, for the CLI and tests: send one request, wait for the answer with its id. */
export function request(pipePath, req, { timeoutMs = 240_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('the signer did not answer in time'));
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(req)}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let res;
        try {
          res = JSON.parse(line);
        } catch {
          continue;
        }
        if (res.id === req.id || res.id === null) {
          clearTimeout(timer);
          socket.end();
          resolve(res);
          return;
        }
      }
    });
    socket.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
