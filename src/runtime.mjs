import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Admission, normalizeJid } from './admission.mjs';
import { readSource } from './source.mjs';
import { connect } from './baileys.mjs';
import { writeStatusSnapshot } from './runtime-state.mjs';

const defaultTimers = {
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: timer => clearTimeout(timer),
  setInterval: (...args) => setInterval(...args),
  clearInterval: timer => clearInterval(timer),
};

export function validateRuntimeConfiguration({ allowedGroups, sourcePath, requireSource = false }) {
  if (!Array.isArray(allowedGroups) || !allowedGroups.length ||
      allowedGroups.some(group => !/^\d[\d-]*@g\.us$/.test(group))) {
    throw new Error('Set WPP_GROUPS to one or more valid group JIDs');
  }
  if (requireSource && !existsSync(sourcePath)) throw new Error('Configured source file is missing');
  if (existsSync(sourcePath)) readSource(sourcePath, allowedGroups);
  return true;
}

export class WorkerRuntime {
  constructor({
    dataDir,
    sourcePath,
    allowedGroups,
    operators = [],
    transport = connect,
    clock = () => Date.now(),
    timers = defaultTimers,
    onOutput = () => {},
    onStatus = () => {},
    pollMs = 10_000,
    heartbeatMs = 1_000,
    shutdownLimitMs = 60_000,
    admissionTimeoutMs = 30_000,
    onDrainTimeout = () => {},
  }) {
    this.dataDir = resolve(dataDir);
    this.sourcePath = resolve(sourcePath);
    this.authDir = join(this.dataDir, 'auth');
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.allowedGroups = [...allowedGroups];
    this.operators = [...operators];
    this.transport = transport;
    this.clock = clock;
    this.timers = timers;
    this.onOutput = onOutput;
    this.onStatus = onStatus;
    this.pollMs = pollMs;
    this.heartbeatMs = heartbeatMs;
    this.shutdownLimitMs = shutdownLimitMs;
    this.onDrainTimeout = onDrainTimeout;
    this.instanceId = randomUUID();
    this.lifecycle = 'starting';
    this.activeClaims = 0;
    this.activeCommands = 0;
    this.commandTasks = new Set();
    this.stopping = false;
    this.session = null;
    this.admission = new Admission({
      dbPath: join(this.dataDir, 'jobs.db'),
      dataDir: this.dataDir,
      allowedGroups: this.allowedGroups,
      operators: this.operators,
      timeoutMs: admissionTimeoutMs,
      clock: this.clock,
      timers: this.timers,
    });
    this.publishStatus();
  }

  publishStatus() {
    const control = this.admission.runtimeState.readControl();
    const status = writeStatusSnapshot(this.dataDir, {
      instanceId: this.instanceId,
      lifecycle: this.lifecycle,
      admission: control.admission,
      session: control.session,
      activeClaims: this.activeClaims,
      activeCommands: this.activeCommands,
    }, { now: this.clock() });
    this.onStatus({
      lifecycle: status.lifecycle,
      admission: status.admission,
      session: status.session,
      activeClaims: status.activeClaims,
      activeCommands: status.activeCommands,
      instanceId: status.instanceId,
    });
  }

  async run() {
    if (this.running) throw new Error('Worker runtime is already running');
    this.running = true;
    this.heartbeatTimer = this.timers.setInterval(() => this.publishStatus(), this.heartbeatMs);
    this.publishStatus();
    try {
      this.admission.recoverInterrupted();
      const control = this.admission.runtimeState.readControl();
      if (control.session === 'needs_pairing') {
        this.lifecycle = 'needs_pairing';
        this.publishStatus();
        await this.waitUntilStopped();
      } else {
        let configurationValid = true;
        try {
          validateRuntimeConfiguration({ allowedGroups: this.allowedGroups, sourcePath: this.sourcePath });
        } catch {
          configurationValid = false;
          this.lifecycle = 'failed';
          this.onOutput({ event: 'configuration_invalid' });
          this.publishStatus();
          await this.waitUntilStopped();
        }

        if (configurationValid) {
          this.lifecycle = 'connecting';
          this.publishStatus();
          const connected = await this.connectSession();
          if (!connected && this.lifecycle === 'needs_pairing') await this.waitUntilStopped();

          while (connected && !this.stopping) {
            if (this.lifecycle !== 'ready') {
              await this.wait(this.pollMs);
              continue;
            }
            await this.cycle();
            if (!this.stopping) await this.wait(this.pollMs);
          }
        }
      }
    } catch {
      if (!this.stopping) {
        this.fail('runtime_failed', 'Worker runtime failed');
      } else if (!this.failure) {
        this.failure = new Error('Runtime failed during shutdown');
      }
    } finally {
      await this.shutdown();
    }
    if (this.failure) throw this.failure;
  }

  async connectSession() {
    try {
      this.session = await this.transport({
        authDir: this.authDir,
        pair: false,
        timers: this.timers,
        onDisconnect: event => this.handleDisconnect(event),
      });
    } catch {
      if (this.admission.runtimeState.readControl().session === 'needs_pairing') {
        this.lifecycle = 'needs_pairing';
        this.publishStatus();
        return false;
      }
      this.fail('transport_connect_failed', 'Transport connection failed');
      return false;
    }

    const control = this.admission.runtimeState.readControl();
    if (control.session === 'needs_pairing' || this.lifecycle === 'failed') {
      await this.closeSession();
      return false;
    }
    this.admission.socket = this.session.socket;
    this.admission.botIds = new Set([
      this.session.socket.user?.id,
      this.session.socket.user?.lid,
    ].filter(Boolean).map(normalizeJid));
    this.session.socket.ev.on('messages.upsert', upsert => this.receive(upsert));
    this.lifecycle = 'ready';
    this.publishStatus();
    return true;
  }

  async cycle() {
    if (!this.admission.runtimeState.accepting()) return;
    if (existsSync(this.sourcePath)) {
      try {
        const rows = readSource(this.sourcePath, this.allowedGroups);
        for (const row of rows) {
          if (this.stopping || !this.admission.runtimeState.accepting()) break;
          if (!this.admission.enqueueIfAccepting(row)) break;
        }
      } catch {
        this.onOutput({ event: 'source_validation_failed' });
      }
    }

    for (const job of this.admission.list().filter(item => item.state === 'queued').slice(0, 10)) {
      if (this.stopping || !this.admission.runtimeState.accepting()) break;
      this.activeClaims++;
      this.publishStatus();
      try {
        const state = await this.admission.run(job.id);
        this.onOutput({ id: job.id, state });
      } finally {
        this.activeClaims--;
        this.publishStatus();
      }
    }
  }

  receive(upsert) {
    if (this.stopping || upsert.type !== 'notify') return;
    for (const msg of upsert.messages ?? []) {
      const text = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? '';
      if (!text.startsWith('/add ')) continue;
      if (!this.admission.runtimeState.accepting()) {
        this.onOutput({ command: 'add', result: 'paused' });
        continue;
      }
      const timestamp = Number(msg.messageTimestamp);
      const now = this.clock() / 1000;
      if (!Number.isFinite(timestamp) || now - timestamp > 300 || timestamp > now + 60) continue;
      const actor = msg.key?.fromMe
        ? this.session.socket.user?.lid ?? this.session.socket.user?.id
        : msg.key?.participant;
      this.activeCommands++;
      this.publishStatus();
      const task = this.admission.command({
        group: msg.key?.remoteJid,
        actor: normalizeJid(actor),
        messageId: msg.key?.id,
        text,
      }).then(result => {
        this.onOutput({ command: 'add', result });
      }).catch(() => {
        this.onOutput({ command: 'add', result: 'uncertain' });
      }).finally(() => {
        this.activeCommands--;
        this.commandTasks.delete(task);
        this.publishStatus();
      });
      this.commandTasks.add(task);
    }
  }

  handleDisconnect({ loggedOut = false } = {}) {
    if (loggedOut) {
      this.admission.runtimeState.updateControl({ session: 'needs_pairing' });
      this.lifecycle = 'needs_pairing';
      this.publishStatus();
    } else {
      this.fail('transport_disconnected', 'Transport connection failed');
    }
    if (this.session) void this.closeSession();
  }

  fail(event, message) {
    try { this.onOutput({ event }); } catch { }
    this.stop(new Error(message));
  }

  async closeSession() {
    if (this.sessionCloseTask) return this.sessionCloseTask;
    const session = this.session;
    this.session = null;
    if (!session) return Promise.resolve();
    this.sessionCloseTask = Promise.resolve().then(() => session.close()).catch(() => {
      this.onOutput({ event: 'session_close_failed' });
    });
    return this.sessionCloseTask;
  }

  wait(ms) {
    return new Promise(resolveWait => {
      const finish = () => {
        if (this.pendingWake === finish) this.pendingWake = null;
        this.timers.clearTimeout(timer);
        resolveWait();
      };
      const timer = this.timers.setTimeout(finish, ms);
      this.pendingWake = finish;
    });
  }

  async waitUntilStopped() {
    while (!this.stopping) await this.wait(this.pollMs);
  }

  stop(failure = null) {
    if (this.stopping) {
      if (failure && !this.failure) this.failure = failure;
      return;
    }
    this.stopping = true;
    this.failure = failure;
    this.stopRequestedAt = this.clock();
    this.forceExitTimer = this.timers.setTimeout(() => this.onDrainTimeout(), this.shutdownLimitMs);
    this.lifecycle = failure ? 'failed' : 'draining';
    try { this.publishStatus(); } catch { }
    this.pendingWake?.();
  }

  async shutdown() {
    this.lifecycle = 'draining';
    if (this.heartbeatTimer) this.timers.clearInterval(this.heartbeatTimer);
    try { this.publishStatus(); } catch { }
    const deadline = (this.stopRequestedAt ?? this.clock()) + this.shutdownLimitMs;
    const awaitBeforeDeadline = async promise => {
      const remaining = Math.max(0, deadline - this.clock());
      let timeout;
      const completed = await Promise.race([
        promise.then(() => true),
        new Promise(resolveTimeout => {
          timeout = this.timers.setTimeout(() => resolveTimeout(false), remaining);
        }),
      ]);
      this.timers.clearTimeout(timeout);
      return completed;
    };
    if (!await awaitBeforeDeadline(Promise.allSettled([...this.commandTasks]))) {
      throw this.drainTimeoutError();
    }
    if (!await awaitBeforeDeadline(this.closeSession())) {
      throw this.drainTimeoutError();
    }
    this.timers.clearTimeout(this.forceExitTimer);
    this.admission.close();
  }

  drainTimeoutError() {
    const error = new Error('Shutdown drain limit exceeded; interrupted jobs need owner review');
    error.code = 'DRAIN_TIMEOUT';
    return error;
  }
}

export function attachShutdownSignals(runtime, signalSource = process, onRepeatedSignal = () => {}) {
  let stopping = false;
  const handleSignal = () => {
    if (stopping) {
      onRepeatedSignal();
      return;
    }
    stopping = true;
    runtime.stop();
  };
  signalSource.on('SIGINT', handleSignal);
  signalSource.on('SIGTERM', handleSignal);
  return () => {
    signalSource.off('SIGINT', handleSignal);
    signalSource.off('SIGTERM', handleSignal);
  };
}
