import http from 'http';

import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, RegisteredGroup } from '../types.js';

const COPILOT_JID = process.env.COPILOT_JID || 'http:copilot';
const COPILOT_GROUP_FOLDER = process.env.COPILOT_GROUP_FOLDER || 'copilot';
const COPILOT_HTTP_PORT = parseInt(process.env.COPILOT_HTTP_PORT || '3001', 10);

interface SseWriter {
  res: http.ServerResponse;
  resolve: () => void;
}

export class HttpChannel implements Channel {
  name = 'http';

  private server: http.Server | null = null;
  private opts: ChannelOpts;

  // FIFO queue: each POST /message enqueues a writer, setTyping(true) dequeues it
  private pendingQueue: SseWriter[] = [];
  private currentWriter: SseWriter | null = null;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Self-register the copilot group so NanoClaw's in-memory state knows about it
    const group: RegisteredGroup = {
      name: 'CoPilot',
      folder: COPILOT_GROUP_FOLDER,
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    };
    this.opts.registerGroup?.(COPILOT_JID, group);

    // Register chat metadata so it shows up in the DB
    this.opts.onChatMetadata(COPILOT_JID, new Date().toISOString(), 'CoPilot', 'http', false);

    this.server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', channel: 'http' }));
        return;
      }

      if (req.method === 'POST' && req.url === '/message') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          let parsed: { message?: string; sender?: string } = {};
          try {
            parsed = JSON.parse(body);
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
            return;
          }

          const message = parsed.message?.trim();
          if (!message) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'message field required' }));
            return;
          }

          const senderName = parsed.sender || 'copilot';

          // Set up SSE response headers
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
          });

          // Enqueue this SSE writer — it will be dequeued when setTyping(true) fires
          const writer: SseWriter = {
            res,
            resolve: () => {},
          };

          // Keep a promise so the request stays open until agent finishes
          new Promise<void>((resolve) => {
            writer.resolve = resolve;
            this.pendingQueue.push(writer);

            req.on('close', () => {
              // Client disconnected early — remove from queue if still pending
              const idx = this.pendingQueue.indexOf(writer);
              if (idx !== -1) this.pendingQueue.splice(idx, 1);
              if (this.currentWriter === writer) this.currentWriter = null;
              resolve();
            });

            // Deliver message into NanoClaw's pipeline
            const timestamp = new Date().toISOString();
            this.opts.onMessage(COPILOT_JID, {
              id: `http-${Date.now()}`,
              chat_jid: COPILOT_JID,
              sender: senderName,
              sender_name: senderName,
              content: message,
              timestamp,
              is_from_me: false,
            });

            logger.info({ sender: senderName, length: message.length }, 'HTTP channel message received');
          });
        });
        return;
      }

      // OPTIONS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    return new Promise<void>((resolve, reject) => {
      this.server!.listen(COPILOT_HTTP_PORT, () => {
        logger.info({ port: COPILOT_HTTP_PORT }, 'HTTP channel listening');
        console.log(`\n  HTTP channel: http://localhost:${COPILOT_HTTP_PORT}`);
        console.log(`  POST /message  { "message": "...", "sender": "..." }`);
        console.log(`  GET  /health\n`);
        resolve();
      });
      this.server!.on('error', reject);
    });
  }

  async sendMessage(_jid: string, text: string): Promise<void> {
    if (!this.currentWriter) {
      logger.warn('HTTP channel: sendMessage called with no active SSE writer');
      return;
    }
    const event = JSON.stringify({ type: 'text', content: text });
    this.currentWriter.res.write(`data: ${event}\n\n`);
  }

  async setTyping(_jid: string, isTyping: boolean): Promise<void> {
    if (isTyping) {
      // Agent starting — dequeue the next waiting SSE writer
      if (this.pendingQueue.length > 0) {
        this.currentWriter = this.pendingQueue.shift()!;
        logger.debug('HTTP channel: dequeued SSE writer for agent response');
      }
    } else {
      // Agent done — send done event and close the response
      if (this.currentWriter) {
        const event = JSON.stringify({ type: 'done' });
        this.currentWriter.res.write(`data: ${event}\n\n`);
        this.currentWriter.res.end();
        this.currentWriter.resolve();
        this.currentWriter = null;
        logger.debug('HTTP channel: SSE stream closed after agent response');
      }
    }
  }

  isConnected(): boolean {
    return this.server !== null;
  }

  ownsJid(jid: string): boolean {
    return jid === COPILOT_JID;
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
      logger.info('HTTP channel stopped');
    }
  }
}

registerChannel('http', (opts: ChannelOpts) => {
  return new HttpChannel(opts);
});
