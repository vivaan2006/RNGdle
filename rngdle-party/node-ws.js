// Minimal zero-dependency WebSocket (RFC 6455) + static file server for Node.
// Only what RNGparty needs: text frames, ping/pong, close. No extensions,
// no permessage-deflate, no client mode. Bun users never touch this file —
// server.js picks Bun.serve when it's running under Bun.

import { createServer } from "http";
import { createHash } from "crypto";
import { readFile, stat } from "fs/promises";
import { extname } from "path";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

/** Server-side socket wrapper exposing just `.send()` — mirrors Bun's ws API. */
class NodeWS {
  constructor(socket) { this.socket = socket; this.closed = false; }
  send(data) {
    if (this.closed || !this.socket.writable) return;
    this.socket.write(encodeFrame(0x1, Buffer.from(String(data), "utf8")));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.write(encodeFrame(0x8, Buffer.alloc(0))); } catch {}
    this.socket.end();
  }
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;          // FIN + opcode; server frames are never masked
  return Buffer.concat([header, payload]);
}

/**
 * Pulls complete messages out of a socket byte stream.
 * Calls onMessage(string) for each finished text message.
 */
function makeFrameReader(ws, onMessage) {
  let buf = Buffer.alloc(0);
  let fragments = [];          // payloads of an in-progress fragmented message
  let fragOpcode = 0;

  return function feed(chunk) {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buf.length < offset + 2) return;
        len = buf.readUInt16BE(offset); offset += 2;
      } else if (len === 127) {
        if (buf.length < offset + 8) return;
        const big = buf.readBigUInt64BE(offset); offset += 8;
        if (big > 0x7fffffffn) { ws.close(); return; }   // absurd frame, drop the client
        len = Number(big);
      }

      let maskKey = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        maskKey = buf.subarray(offset, offset + 4); offset += 4;
      }
      if (buf.length < offset + len) return;             // wait for the rest

      let payload = Buffer.from(buf.subarray(offset, offset + len));
      buf = buf.subarray(offset + len);
      if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];

      if (opcode === 0x8) { ws.close(); return; }                       // close
      if (opcode === 0x9) {                                             // ping → pong
        if (!ws.closed && ws.socket.writable) ws.socket.write(encodeFrame(0xa, payload));
        continue;
      }
      if (opcode === 0xa) continue;                                     // pong, ignore

      if (opcode === 0x0) fragments.push(payload);                      // continuation
      else { fragments = [payload]; fragOpcode = opcode; }

      if (!fin) continue;
      const full = Buffer.concat(fragments);
      fragments = [];
      if (fragOpcode === 0x1) onMessage(full.toString("utf8"));         // text only
    }
  };
}

/**
 * @param {object} opts
 * @param {number} opts.port
 * @param {Record<string,string>} opts.staticFiles  url path -> file path
 * @param {(ws:NodeWS)=>void} opts.open
 * @param {(ws:NodeWS, msg:string)=>void} opts.message
 * @param {(ws:NodeWS)=>void} opts.close
 */
export function serve({ port, staticFiles, open, message, close }) {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    const file = staticFiles[path];
    if (!file) { res.writeHead(404).end("Not found"); return; }
    try {
      // Always revalidate. Without this browsers heuristically cache index.html and
      // keep serving a stale copy while you're editing it. The ETag still lets an
      // unchanged engine.js (~1MB) come back as a 304 instead of a re-download.
      const url = new URL(file, import.meta.url);
      const { mtimeMs, size } = await stat(url);
      const etag = `W/"${size.toString(16)}-${Math.round(mtimeMs).toString(16)}"`;
      const headers = {
        "content-type": MIME[extname(file)] || "application/octet-stream",
        "cache-control": "no-cache",
        etag
      };
      if (req.headers["if-none-match"] === etag) { res.writeHead(304, headers).end(); return; }
      res.writeHead(200, headers).end(await readFile(url));
    } catch {
      res.writeHead(404).end("Not found");
    }
  });

  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (new URL(req.url, "http://localhost").pathname !== "/ws" || !key) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);

    const ws = new NodeWS(socket);
    const feed = makeFrameReader(ws, msg => message(ws, msg));
    let closed = false;
    const onGone = () => { if (closed) return; closed = true; ws.closed = true; close(ws); };

    open(ws);
    socket.on("data", chunk => { try { feed(chunk); } catch { onGone(); socket.destroy(); } });
    socket.on("close", onGone);
    socket.on("end", onGone);
    socket.on("error", onGone);
  });

  server.listen(port);
  return server;
}
