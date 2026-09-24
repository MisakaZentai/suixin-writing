/**
 * 最小的 WebSocket 客户端：只用来连本机浏览器的 DevTools（ws://127.0.0.1）。
 * Node 20 没有内置 WebSocket；这里只支持文本帧、不压缩，够用即可。
 */
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import type { Socket } from 'node:net'

export interface MiniSocket {
  send: (text: string) => void
  onMessage: (fn: (text: string) => void) => void
  onClose: (fn: () => void) => void
  close: () => void
}

export function connectWs(url: string, timeout = 10_000): Promise<MiniSocket> {
  const u = new URL(url)
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
      },
      timeout,
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('连接浏览器超时')))
    req.on('response', (res) => reject(new Error(`浏览器拒绝连接：HTTP ${res.statusCode}`)))
    req.on('upgrade', (_res, socket: Socket, head: Buffer) => resolve(wrap(socket, head)))
    req.end()
  })
}

function wrap(socket: Socket, head: Buffer): MiniSocket {
  const handlers: ((t: string) => void)[] = []
  const closers: (() => void)[] = []
  let buf = head
  let parts: Buffer[] = []

  const onData = (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
    for (;;) {
      if (buf.length < 2) return
      const fin = (buf[0] & 0x80) !== 0
      const opcode = buf[0] & 0x0f
      const masked = (buf[1] & 0x80) !== 0
      let len = buf[1] & 0x7f
      let at = 2
      if (len === 126) {
        if (buf.length < 4) return
        len = buf.readUInt16BE(2)
        at = 4
      } else if (len === 127) {
        if (buf.length < 10) return
        len = Number(buf.readBigUInt64BE(2))
        at = 10
      }
      const maskAt = at
      if (masked) at += 4
      if (buf.length < at + len) return
      let payload = buf.subarray(at, at + len)
      if (masked) {
        const mask = buf.subarray(maskAt, maskAt + 4)
        payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))
      }
      buf = buf.subarray(at + len)
      if (opcode === 0x8) {
        socket.end()
        return
      }
      if (opcode === 0x9) {
        frame(0xa, payload)
        continue
      }
      if (opcode === 0x1 || opcode === 0x0) {
        parts.push(Buffer.from(payload))
        if (fin) {
          const text = Buffer.concat(parts).toString('utf8')
          parts = []
          handlers.forEach((h) => h(text))
        }
      }
    }
  }

  // 客户端发出的帧必须加掩码
  const frame = (opcode: number, payload: Buffer) => {
    const mask = randomBytes(4)
    const len = payload.length
    const header = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10)
    header[0] = 0x80 | opcode
    if (len < 126) header[1] = 0x80 | len
    else if (len < 65536) {
      header[1] = 0x80 | 126
      header.writeUInt16BE(len, 2)
    } else {
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(len), 2)
    }
    const body = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))
    socket.write(Buffer.concat([header, mask, body]))
  }

  socket.on('data', onData)
  socket.on('close', () => closers.forEach((c) => c()))
  if (head.length) onData(Buffer.alloc(0))

  return {
    send: (text) => frame(0x1, Buffer.from(text, 'utf8')),
    onMessage: (fn) => void handlers.push(fn),
    onClose: (fn) => void closers.push(fn),
    close: () => socket.end(),
  }
}
