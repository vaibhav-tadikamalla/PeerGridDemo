# PeerGrid Benchmark Architecture & Implementation Report

This is the source-of-truth technical evaluation of the PeerGrid benchmark system, based strictly on direct inspection of the codebase.

## A. Executive Summary
The PeerGrid benchmark engine is a purpose-built, in-memory simulated swarm environment designed to strictly measure real-time CRDT edit propagation latency under O(N²) broadcast loads. It bypasses real browser environments by running headless `WebSocket` clients directly on the server, injecting incremental Yjs updates, and measuring the millisecond-precision wall-clock time between an update being framed for transmission and that identical update being successfully applied at a receiving peer.

## B. Architecture Diagram
```text
[BenchmarkEngine] Orchestrator
   │
   ├─► Spawns N [BenchmarkSimulatedEditor] instances
   │     ├─► 1. Establish WebSocket to ws://localhost:4860
   │     ├─► 2. Sync Y.Doc (Step 1 / Step 2)
   │     └─► 3. Edit Loop (Timer)
   │
   ├─► [Editor A] Generates Edit
   │     ├─► Applies to local Y.Doc
   │     ├─► Generates Delta Update
   │     ├─► SHA-256 Hashing (opId)
   │     ├─► T1 Timestamp Captured
   │     ├─► recordSend(opId, T1, expectedRecipients)
   │     └─► ws.send(binary)
   │
[Server (websocket.ts / Room.ts)]
   │     ├─► Receives binary on WebSocket
   │     ├─► handleSyncMsg -> applyClientUpdate
   │     ├─► Y.applyUpdate(room.ydoc)
   │     ├─► Broadcasts to all connected peers (excluding A)
   │     └─► Asynchronously fires WAL persistence & Redis pub (NOT blocking)
   │
   ├─► [Editor B, C, D...] Receive Broadcast
   │     ├─► Y.applyUpdate(local ydoc)
   │     ├─► T2 Timestamp Captured
   │     └─► recordAck(opId, T2) 
   │
[BenchmarkPropagationTracker]
   └─► Matches SHA-256 opId -> calculates (T2 - T1) -> aggregates metrics
```

## C. Complete Benchmark Lifecycle
*(Source: `packages/server/src/benchmark/BenchmarkEngine.ts` - `runBenchmark`)*

1. **Configuration & Init**: Admin UI sends a request to `/admin/benchmark/start`. `BenchmarkEngine` allocates a unique `fileId` (prefixed with `sim-bench-`) and creates a `BenchmarkPropagationTracker`.
2. **Spawn (Connection)**: For `i = 0` to `userCount`, a `BenchmarkSimulatedEditor` is instantiated and `editor.start()` is called. The engine strictly awaits a `spawnDelay` between each editor to stagger the connection load.
3. **Warmup**: A `sleepWithAbort(warmupMs)` occurs. Editors are generating edits and broadcasting them, but the tracker `_active` flag is false. Metrics are ignored.
4. **Measurement**: The tracker's `activate()` method is called. For `durationMs`, every generated edit is rigorously tracked through the Delivery Matrix.
5. **Drain/Cooldown**: The tracker's `deactivate()` is called. Editors are sent a `pauseEditing()` command. The engine waits `drainMs` (e.g., 5000ms) to allow all in-flight operations over the WebSockets to land and be ACKed by the tracker.
6. **Convergence Verification**: The engine compares the cryptographic fingerprint of every simulated editor's Y.Doc.
7. **Persistence**: The aggregated metrics (generated, verified, latencies) are extracted from the Tracker, written to the `benchmark_runs` PostgreSQL table, and the editors are destroyed.

## D. Simulated User Behavior
*(Source: `packages/server/src/benchmark/BenchmarkSimulatedEditor.ts`)*

A simulated user is an isolated class instance holding its own `ws` (WebSocket connection) and its own `ydoc` (Y.Doc replica). 
- **Identity**: They use UUIDs prefixed with `sim-user-`. Because the `fileId` also uses a `sim-` prefix, the server's `PermissionGateway` instantly bypasses PostgreSQL auth lookups, treating them as verified.
- **Typing Rate**: "2 chars/sec" is probabilistic, not rigid. The editor calculates a `baseDelay` (e.g., 500ms). It applies a jitter multiplier of `0.5` to `2.0`, and a 10% chance to simulate a long "idle burst" (500–3000ms pause). It uses `setTimeout` to schedule the next edit.
- **Edit Payload**: During an edit, a random string of 5-20 characters from a predefined `TEXT_POOL` is inserted into `Y.Text('default')`.

## E. Yjs/CRDT Mechanics
In PeerGrid, Yjs is the engine ensuring conflict-free collaboration.
- **Y.Doc**: The root container for the CRDT state.
- **applyUpdate()**: Merges remote binary data into the local document. Because Yjs operations are commutative and associative, applying the same operations in different orders yields the exact same document.
- **Delta/Incremental Updates**: When an editor types, they do not send the whole document. By capturing `stateVectorBefore = Y.encodeStateVector(ydoc)` prior to the transaction, the editor can call `Y.encodeStateAsUpdate(ydoc, stateVectorBefore)` to produce a tiny byte array containing *only* the newly generated characters and their logical clocks.

## F. Operation Identity
*(Source: `packages/server/src/benchmark/BenchmarkSimulatedEditor.ts`)*

**How PeerGrid identifies an operation:** `SHA-256(deltaUpdate)`
- **What is hashed**: The raw incremental Yjs update binary byte array (the delta).
- **When**: In the sender, immediately before WebSocket transmission.
- **Reconstruction**: The receiving editor extracts the Yjs update from the WebSocket frame and hashes those exact same bytes.
- **Why this is used**: It avoids parsing complex Yjs clientID/clock structs. By hashing the raw bytes, it acts as a perfect cryptographic proof of payload delivery and integrity. It is an O(1) string lookup in the Tracker's memory map.

## G. Expected Recipient Logic
*(Source: `BenchmarkEngine.ts` and `BenchmarkPropagationTracker.ts`)*

The `expectedRecipients` array is calculated as a **strict immutable snapshot** at the exact millisecond the operation is generated (`T_gen`).
- **Logic**: `this.editors.filter(e => e.isConnected && e.editorId !== senderId)`
- **Rules**: The sender is explicitly excluded. The peer must have a WebSocket `OPEN` state and have finished initial Yjs sync.
- **Late joins/Disconnects**: Because it is an immutable snapshot, if a recipient disconnects 1ms *after* generation, they are permanently recorded as an expected recipient. The operation will fail to reach 100% verification and will register as a "Missing Delivery".
- **Math**: In a 20-user room, an operation generated by User 1 snapshots the 19 other connected users. `1 operation × 19 recipients = 19 expected deliveries`. Over a test generating 712 ops, `712 × 19 = 13,528 expected peer deliveries.`

## H. Delivery Verification
*(Source: `BenchmarkPropagationTracker.ts`)*

A "Delivery" in this benchmark does **not** just mean the network bytes arrived.
- **Trace**: Bytes arrive at peer → Decoded → `Y.applyUpdate()` executed → Hash generated → Tracker notified.
- **Apply Failure**: If `applyUpdate` throws an error (e.g., malformed CRDT), the tracker `recordAck` is skipped. It will register as a missing delivery.
- **Duplicate Updates**: The tracker uses `op.receivedBy.add(receiverEditorId)`. `Set` structures naturally deduplicate. Duplicate ACKs do not inflate the actual delivery count, ensuring rigorous integrity.

## I. Latency Measurement (MOST IMPORTANT)
*(Source: `BenchmarkSimulatedEditor.ts`)*

- `T1` = `performance.now()` in the Sender, captured **immediately before** `ws.send()`.
- `T2` = `performance.now()` in the Receiver, captured **immediately after** successful `Y.applyUpdate()`.
- **peerLatency** = `T2 - T1`

**What it includes**: 
- Sender OS/Node socket write time
- Loopback network transit to Server
- Server WebSocket decode
- Server `Room.ts` `Y.applyUpdate()` (CRDT merge cost)
- Server fan-out `ws.send()` loop execution
- Loopback network transit to Receiver
- Receiver WebSocket decode
- Receiver `Y.applyUpdate()` (CRDT merge cost)

**What it does NOT measure**:
- User-perceived rendering time (React/DOM reconciliation is totally bypassed).
- Network RTT over the internet (since clients are running on `localhost`).
- Sender encoding cost (T1 is captured after `Y.encodeStateAsUpdate`).

## J. P50 / P95 / P99
*(Source: `BenchmarkPropagationTracker.ts`)*

- **Samples**: Every single successful peer delivery inserts an integer into the latency array. (For 20 users and 712 ops, there are 13,528 individual latency integers).
- **Missing/Failed**: Missing deliveries do not insert `0` or `Infinity`; they are simply absent from the array, but flagged in the Delivery Rate.
- **Phases**: Only deliveries for operations generated during the `Measurement` phase are recorded. Warmup and Drain edits are ignored by the tracker.
- **Completion Latency vs Peer Latency**: 
  - `peerLatency`: Distribution of all 13,528 individual deliveries.
  - `completionLatency`: Distribution of the 712 "Max" times (the time it took for the *slowest* peer to receive an operation, representing swarm convergence time per-op).

## K. Throughput
*(Source: `PerformanceEvaluation.tsx`)*

Throughput calculation: `results.opsVerified / (results.measurementDurationMs / 1000)`
- **Meaning**: Verified Operations per Second (Swarm-wide).
- **Not deliveries**: It counts the 712 source operations, not the 13,528 fan-out deliveries.
- **Phase**: It strictly divides by the Measurement duration (e.g., 30s), entirely excluding Warmup and Drain phases.

## L. Delivery Rate / Integrity
- **Generated**: Operations successfully encoded and transmitted by senders.
- **Tracked**: Operations successfully registered in the Tracker's Multi-Peer Matrix.
- **Fully Verified**: Operations where `receivedBy.size === expectedRecipients.size`.
- **Expected / Actual**: The sum of all snapshot recipients vs the sum of all successful ACKs.

If `Generated == Tracked == Fully Verified`, it mathematically proves that the server did not drop a single WebSocket frame and the CRDT state processed flawlessly across the entire swarm. 

## M. Warmup / Measurement / Drain
1. **Connection/Spawn**: Users connect via WebSocket over `spawnDelay` intervals.
2. **Warmup**: Users type, server broadcasts, but Tracker is inactive. (Allows V8 JIT compilation to warm up and TCP windows to scale).
3. **Measurement**: Tracker is activated. Senders log `T1`, Receivers log `T2`.
4. **Drain/Cooldown**: Users are paused. The engine waits (e.g., 5 seconds) to ensure operations in the OS network buffer or Node event loop finish broadcasting and applying.

## N. Spawn Delay
*(Source: `BenchmarkEngine.ts`)*
If `spawnDelay` is 100ms, user 1 connects at 0ms, user 2 at 100ms, user 20 at 1900ms. 
- **0ms**: All 20 WS connection requests hit the server instantly. This spikes CPU due to crypto/auth handshakes and Yjs state vector syncs, potentially causing event loop lag.
- **100ms**: Staggers the load, isolating the CPU cost of connecting from the steady-state broadcasting latency. Essential for clean experimental data.

## O. Latency vs Load Mode
- **Latency Mode (The default)**: Sends only `deltaUpdate` (incremental bytes). This isolates the exact transmission latency of a single user action. This mode answers the research question: *"How fast does a keystroke propagate?"*
- **Load Mode**: Forces the editor to send a Full-State Update (`Y.encodeStateAsUpdate(ydoc)`) on every keystroke. This matches the fallback behavior of standard editors and tests how the server handles massive bandwidth spikes (megabytes per second). It does not measure latency.

## P. Scaling Behavior (Why Latency Jumps at 53 Users)
**Mathematical Fan-Out:**
In a room of N users, each typing at `R` chars/sec, the server receives `N * R` updates per second.
For each update, the server executes a broadcast loop to `N - 1` peers.
Total server websocket writes per second = `(N * R) * (N - 1)`.

- **10 Users (2 char/s)**: (20) * 9 = 180 writes/sec. The Node.js event loop handles this instantly.
- **20 Users**: (40) * 19 = 760 writes/sec. Barely noticeable.
- **53 Users**: (106) * 52 = 5,512 writes/sec. 
Because Node.js is single-threaded, a single incoming message from User 1 requires a blocking `for` loop to write to 52 sockets. If multiple users' packets arrive in the same OS tick, the event loop queue backs up. `T2 - T1` latency spikes exponentially (e.g., to 446ms) because the messages are waiting in Node's memory to be flushed to the TCP socket layer.

## Q. Database / Redis / WebSocket Hot Path (CRITICAL DISCOVERY)
*(Source: `packages/server/src/websocket.ts`)*

**Neither Postgres nor Redis are on the critical path of WebSocket broadcasting.**
The codebase contains a massive latency optimization:
```typescript
// LATENCY OPTIMIZATION: Broadcast first, THEN persist!
room.applyClientUpdate(result.rawUpdate, conn.connectionId);
// ...
appendUpdate(conn.fileId, Buffer.from(result.rawUpdate))
```
1. The server receives the binary.
2. It applies it to the in-memory Y.Doc.
3. It broadcasts synchronously to all WS peers.
4. It calls `appendUpdate` (Postgres WAL) as a **fire-and-forget** async Promise.

This achieves minimal latency but guarantees only "Eventual/Soft Durability". If the Node process is `SIGKILL`'d 1 millisecond after broadcasting, the connected peers will have the update applied in their browsers, but it will be permanently lost from the PostgreSQL WAL.

## R. CRDT Convergence
*(Source: `BenchmarkEngine.ts`)*
Convergence is checked by generating `SHA-256(Y.encodeStateAsUpdate(ydoc))` for all simulated editors at the end of the Drain phase. 
- It compares Editor 0 to Editors 1 through N. 
- If even a single byte differs in the CRDT structure, the hashes mismatch and Convergence fails.
- Successful delivery does not imply convergence if there was a protocol bug causing non-deterministic application. Hashing the whole doc proves true identical replication.

## S. Current 20-User Result Explained
- **20 users / 2 chars/sec / 30 sec**: 20 bots typing ~2 times per second for 30s.
- **712 generated/tracked/verified**: Every single one of the 712 generated edits was strictly tracked and successfully reached every peer.
- **13,528 deliveries (712 * 19)**: 19 expected recipients per op. `712 * 19 = 13,528`.
- **0 missing / 100% propagation**: Zero data loss across the network layer.
- **P50 4.1 ms**: 50% of the 13,528 deliveries reached their destination in under 4.1 milliseconds.
- **23.7 operations/sec**: `712 ops / 30 seconds`.

## T. Research Interpretation
- **PROVEN**: The server's in-memory broadcast logic and WebSocket routing is flawless at 20 users. The Yjs CRDT logic mathematically converges. Propagation latency over localhost is negligible (<10ms).
- **SUGGESTED**: The architecture will face severe event-loop CPU bottlenecking at high user counts (50+) due to O(N²) fan-out.
- **NOT MEASURED**: User-perceived latency (React rendering time), real-world internet packet loss / RTT, and database durability under crash conditions.

## U. IOPW Paper Comparison
The IOPW paper measures **User-Perceived Delay** (Writer typing → Reader screen update). 
The PeerGrid benchmark measures **Edit Propagation Latency** (Writer network dispatch → Reader CRDT logic application).
**Verdict**: PeerGrid is NOT a direct replication of the IOPW metric. PeerGrid measures the *system-level network and processing latency*, entirely bypassing the DOM rendering pipeline. To perfectly replicate IOPW, PeerGrid would need to run inside a real browser automation framework (e.g., Playwright) and measure the delta between the sender's UI keypress and the receiver's React DOM mutation observer.

## V. File-by-File Study Map
1. **`packages/server/src/benchmark/BenchmarkEngine.ts`**: The orchestrator. Understand the lifecycle (Warmup -> Measurement -> Drain) and the Convergence hash check.
2. **`packages/server/src/benchmark/BenchmarkSimulatedEditor.ts`**: The user bot. Understand how `deltaUpdate` is generated, how it is SHA-256 hashed to create `opId`, and when `T1` and `T2` are captured.
3. **`packages/server/src/benchmark/BenchmarkPropagationTracker.ts`**: The multi-peer matrix. Understand the strict rules for what constitutes a "Verified" operation.
4. **`packages/server/src/websocket.ts`**: The hot path. Focus on the `LATENCY OPTIMIZATION` comment to understand why Postgres/Redis are decoupled from broadcast latency.
5. **`packages/server/src/ws/Room.ts`**: The fan-out engine. Look at `broadcastBinary` to understand how the Node.js event loop handles O(N²) writes.

## W. Things you absolutely need to understand for a faculty viva
1. **"Are you measuring real latency?"**: No, you are measuring *System/Propagation Latency* over localhost, not *User-Perceived Latency* over WAN. Be explicitly clear about this distinction to defend your methodology.
2. **"Why does latency spike at 50 users?"**: Because Node.js is single-threaded. Broadcasting an update to 50 users requires 50 synchronous `ws.send()` calls. At 100 ops/sec, that is 5,000 socket writes per second, which queues up in the event loop, delaying the processing of incoming messages.
3. **"Is your system ACID compliant?"**: No. The WebSocket broadcast happens *before* the Postgres WAL append. It trades strict durability for extreme real-time latency. 

## X. Likely faculty questions and exact technical answers
**Q: How do you know an operation actually reached the peer and wasn't just sent?**
A: "We don't measure at the socket layer. We wait until the receiving client actually executes `Y.applyUpdate()`. The tracker records the ACK timestamp only after the CRDT successfully merges the data."

**Q: How do you correlate a received packet to the original typing event?**
A: "We generate a SHA-256 cryptographic hash of the raw Yjs incremental delta binary on the sender. The receiver hashes the incoming payload. This creates a mathematically unique `operationId` without needing to parse the complex Yjs clock struct."

**Q: Did you implement the IOPW paper exactly?**
A: "We replicated their concurrent workload and scaling methodology, but we isolated the *network and CRDT layer* from the UI layer. Our metric evaluates the distributed system's architectural limit, whereas IOPW evaluates the full client browser pipeline."
