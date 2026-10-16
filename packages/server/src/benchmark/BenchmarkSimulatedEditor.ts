/**
 * benchmark/BenchmarkSimulatedEditor.ts
 *
 * A simulated editor instrumented for benchmark latency measurement.
 *
 * KEY DIFFERENCES from the production SimulatedEditor:
 *
 * 1. LATENCY MODE (default):
 *    Sends INCREMENTAL Yjs delta updates (Y.encodeStateAsUpdate(ydoc, stateVectorBefore))
 *    so that exactly ONE struct appears in the update binary.
 *    This makes (clientID, clock) correlation unambiguous and O(1).
 *
 * 2. LOAD MODE:
 *    Sends FULL-STATE updates (Y.encodeStateAsUpdate(ydoc)) matching the real
 *    production SimulatedEditor.ts behaviour for realistic load testing.
 *    Propagation latency is NOT measured in this mode.
 *
 * 3. Auth uses `sim-user-` prefix for userId and `sim-` prefix for fileId so the
 *    PermissionGateway sim-bypass triggers (no DB lookup needed).
 *
 * 4. On every received MSG_SYNC update (LATENCY mode only), calls
 *    propagationTracker.recordReceive() with the exact update bytes.
 *
 * 5. Supports pauseEditing() / resumeEditing() for cooldown phase.
 *
 * 6. Exposes getDocFingerprint() for CRDT convergence integrity check.
 *
 * IMPORTANT: Do NOT modify this editor's Y.Doc update semantics for production
 * PeerGrid use. The incremental delta update is benchmark-specific instrumentation.
 */

import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { createHash } from 'node:crypto';
import { getLogger } from '../utils/logger';
import type { BenchmarkPropagationTracker } from './BenchmarkPropagationTracker';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

export type BenchmarkEditorMode = 'latency' | 'load';

export interface BenchmarkSimulatedEditorConfig {
  editorId: string;
  displayName: string;
  accessToken: string;
  fileId: string;
  wsUrl: string;
  typingSpeed?: number;
  reconnectProbability?: number;
  abortSignal: AbortSignal;
  propagationTracker: BenchmarkPropagationTracker;
  mode?: BenchmarkEditorMode;
  getEligibleRecipients: (senderId: string) => string[];
  injectApplyFailure?: boolean;
  injectTrackingFailure?: boolean;
  injectDelayedAck?: boolean;
}

const TEXT_POOL = [
  'The quick brown fox jumps over the lazy dog. ',
  'In distributed systems, consistency and availability are fundamental trade-offs. ',
  'Real-time collaboration requires efficient conflict resolution. ',
  'CRDTs enable eventual consistency without coordination overhead. ',
  'PeerGrid uses Yjs for collaborative document editing at scale. ',
  'Benchmark results depend on network conditions and server load. ',
  'Latency percentiles (p50, p95, p99) reveal tail behaviour. ',
  'WebSocket connections provide full-duplex communication channels. ',
  'The system processes thousands of edits per second across multiple nodes. ',
  'Load testing helps identify bottlenecks before they affect users. ',
];

export class BenchmarkSimulatedEditor {
  private readonly config: BenchmarkSimulatedEditorConfig;
  private readonly mode: BenchmarkEditorMode;
  private ws: WebSocket | null = null;
  private ydoc: Y.Doc;
  private awareness: awarenessProtocol.Awareness;
  private synced = false;
  private _connected = false;
  private _editsGenerated = 0;
  private _paused = false;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly log = getLogger().child({ component: 'BenchSimEditor' });

  constructor(config: BenchmarkSimulatedEditorConfig) {
    this.config = config;
    this.mode = config.mode ?? 'latency';
    this.ydoc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.ydoc);
  }

  get isConnected(): boolean { return this._connected; }
  get isSynced(): boolean { return this.synced; }
  get editsGenerated(): number { return this._editsGenerated; }
  get editorId(): string { return this.config.editorId; }
  get displayName(): string { return this.config.displayName; }

  async start(): Promise<void> {
    if (this.config.abortSignal.aborted) return;
    await this.connect();
    this.scheduleEditLoop();
  }

  stop(): void {
    if (this.loopTimer) { clearTimeout(this.loopTimer); this.loopTimer = null; }
    this.disconnect();
    this._connected = false;
  }

  pauseEditing(): void { this._paused = true; }
  resumeEditing(): void { this._paused = false; }

  private connect(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.config.abortSignal.aborted) { resolve(); return; }

      try {
        this.ydoc.destroy();
        this.ydoc = new Y.Doc();
        this.awareness = new awarenessProtocol.Awareness(this.ydoc);
        this.synced = false;

        this.ws = new WebSocket(this.config.wsUrl);

        this.ws.on('open', () => {
          this._connected = true;
          this.ws!.send(JSON.stringify({
            type: 'auth',
            accessToken: this.config.accessToken,
            fileId: this.config.fileId,
          }));
        });

        this.ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
          const buf = data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer);
          
          if (!this._connected) return;

          // If we haven't received auth_success yet, check if this is it.
          if (!this.synced && buf.length > 0 && buf[0] === 123) { // 123 is '{'
            try {
              const str = buf.toString('utf8');
              const json = JSON.parse(str);
              if (json.type === 'auth_success') {
                // Send Yjs sync step 1 NOW
                const enc = encoding.createEncoder();
                encoding.writeVarUint(enc, MSG_SYNC);
                syncProtocol.writeSyncStep1(enc, this.ydoc);
                this.ws!.send(encoding.toUint8Array(enc));
                resolve();
              }
            } catch {
              // ignore
            }
            return;
          }

          const uint8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
          this.handleMessage(uint8);
        });

        this.ws.on('close', () => {
          this._connected = false;
          this.synced = false;
        });

        this.ws.on('error', () => {
          this._connected = false;
          resolve();
        });
      } catch {
        this._connected = false;
        resolve();
      }
    });
  }

  private disconnect(): void {
    if (this.ws) {
      try { this.ws.close(1000, 'Benchmark ended'); } catch { /* noop */ }
      this.ws = null;
    }
  }

  private handleMessage(data: Uint8Array): void {
    if (data.length === 0) return;
    try {
      const msgType = data[0]!;

      if (msgType === MSG_SYNC) {
        const decoder = decoding.createDecoder(data);
        decoding.readVarUint(decoder);
        const syncType = decoding.readVarUint(decoder);

        if (syncType === syncProtocol.messageYjsSyncStep1) {
          const sv = decoding.readVarUint8Array(decoder);
          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, MSG_SYNC);
          syncProtocol.writeSyncStep2(enc, this.ydoc, sv);
          this.wsSend(encoding.toUint8Array(enc));
        } else if (syncType === syncProtocol.messageYjsSyncStep2) {
          const update = decoding.readVarUint8Array(decoder);
          Y.applyUpdate(this.ydoc, update);
          if (!this.synced) { this.synced = true; }
        } else if (syncType === syncProtocol.messageYjsUpdate) {
          const update = decoding.readVarUint8Array(decoder);

          if (this.mode === 'latency') {
            const opId = createHash('sha256').update(update).digest('hex');
            
            if (this.config.injectApplyFailure) throw new Error('Injected apply failure');
            
            // applyUpdate will throw if invalid. Do not ACK on failure.
            Y.applyUpdate(this.ydoc, update);
            
            const t2 = performance.now();
            
            if (this.config.injectDelayedAck) {
              setTimeout(() => this.config.propagationTracker.recordAck(opId, this.config.editorId, performance.now()), 15000);
            } else {
              this.config.propagationTracker.recordAck(opId, this.config.editorId, t2);
            }
          } else {
            Y.applyUpdate(this.ydoc, update);
          }
        }
      } else if (msgType === MSG_AWARENESS) {
        const decoder = decoding.createDecoder(data);
        decoding.readVarUint(decoder);
        const update = decoding.readVarUint8Array(decoder);
        awarenessProtocol.applyAwarenessUpdate(this.awareness, update, null);
      }
    } catch {
      // Ignore
    }
  }

  private wsSend(data: Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  private scheduleEditLoop(): void {
    if (this.config.abortSignal.aborted) return;
    const speed = this.config.typingSpeed ?? 2;
    const baseDelay = 1000 / speed;
    const jitter = 0.5 + Math.random() * 1.5;
    const idleBurst = Math.random() < 0.1 ? (500 + Math.random() * 3000) : 0;
    const delay = baseDelay * jitter + idleBurst;
    this.loopTimer = setTimeout(() => void this.editCycle(), delay);
  }

  private async editCycle(): Promise<void> {
    if (this.config.abortSignal.aborted) return;

    if (!this._paused && this.ws?.readyState === WebSocket.OPEN && this.synced) {
      this.performEdit();
    }

    this.scheduleEditLoop();
  }

  private performEdit(): void {
    const ytext = this.ydoc.getText('default');
    const source = TEXT_POOL[Math.floor(Math.random() * TEXT_POOL.length)]!;
    const snippet = source.slice(0, 5 + Math.floor(Math.random() * 5));
    const insertPos = Math.floor(Math.random() * (ytext.length + 1));

    if (this.mode === 'latency') {
      this.config.propagationTracker.incrementGenerated(); // Pre-flight increment
      this._editsGenerated++;

      const stateVectorBefore = Y.encodeStateVector(this.ydoc);
      this.ydoc.transact(() => { ytext.insert(insertPos, snippet); });
      
      try {
        const deltaUpdate = Y.encodeStateAsUpdate(this.ydoc, stateVectorBefore);
        const opId = createHash('sha256').update(deltaUpdate).digest('hex');
        
        const expectedRecipients = this.config.getEligibleRecipients(this.config.editorId);
        
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        encoding.writeVarUint(enc, 2);
        encoding.writeVarUint8Array(enc, deltaUpdate);
        
        const frame = encoding.toUint8Array(enc);
        const t1 = performance.now();
        if (!this.config.injectTrackingFailure) {
          this.config.propagationTracker.recordSend(opId, this.config.editorId, expectedRecipients, t1);
        }
        
        this.wsSend(frame);
      } catch (e) {
        // failed to send
      }
    } else {
      this._editsGenerated++;
      this.ydoc.transact(() => { ytext.insert(insertPos, snippet); });
      const fullUpdate = Y.encodeStateAsUpdate(this.ydoc);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      encoding.writeVarUint(enc, 2);
      encoding.writeVarUint8Array(enc, fullUpdate);
      this.wsSend(encoding.toUint8Array(enc));
    }
  }

  getDocFingerprint(): string {
    try {
      const state = Y.encodeStateAsUpdate(this.ydoc);
      return createHash('sha256').update(Buffer.from(state)).digest('hex');
    } catch {
      return 'error';
    }
  }
}
