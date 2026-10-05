import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const LIFECYCLE_STATES = Object.freeze([
  'starting', 'connecting', 'ready', 'draining', 'needs_pairing', 'failed',
]);

const controlSchema = `
  CREATE TABLE IF NOT EXISTS runtime_control (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    version INTEGER NOT NULL CHECK(version = 1),
    admission TEXT NOT NULL CHECK(admission IN ('paused', 'resumed')),
    session TEXT NOT NULL CHECK(session IN ('active', 'needs_pairing')),
    updated_at TEXT NOT NULL
  );
  INSERT OR IGNORE INTO runtime_control(singleton, version, admission, session, updated_at)
    VALUES(1, 1, 'paused', 'active', CURRENT_TIMESTAMP);
`;

export class RuntimeStateStore {
  constructor(dataDir) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, 'runtime-state.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.db.exec(controlSchema);
  }

  readControl() {
    const { version, admission, session } = this.db.prepare(
      'SELECT version, admission, session FROM runtime_control WHERE singleton=1',
    ).get();
    return { version, admission, session };
  }

  updateControl(changes) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) ||
        Object.keys(changes).some(key => !['admission', 'session'].includes(key))) {
      throw new Error('Invalid runtime control update');
    }
    if (changes.admission !== undefined && !['paused', 'resumed'].includes(changes.admission)) {
      throw new Error('Invalid admission mode');
    }
    if (changes.session !== undefined && !['active', 'needs_pairing'].includes(changes.session)) {
      throw new Error('Invalid session state');
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.readControl();
      const next = { ...current, ...changes };
      if (next.session === 'needs_pairing') next.admission = 'paused';
      if (next.session === 'needs_pairing' && changes.admission === 'resumed') {
        throw new Error('Pair the session before resuming admission');
      }
      this.db.prepare(`UPDATE runtime_control
        SET admission=?, session=?, updated_at=CURRENT_TIMESTAMP WHERE singleton=1`)
        .run(next.admission, next.session);
      const result = this.readControl();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  withControlLock(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation(this.readControl());
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  accepting() {
    const state = this.readControl();
    return state.admission === 'resumed' && state.session === 'active';
  }

  backupTo(destination) {
    const escaped = destination.replaceAll("'", "''");
    this.db.exec(`VACUUM INTO '${escaped}'`);
  }

  close() {
    this.db.close();
  }
}

export class MemoryRuntimeStateStore {
  constructor() {
    this.state = { version: 1, admission: 'paused', session: 'active' };
  }

  readControl() {
    return { ...this.state };
  }

  updateControl(changes) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) ||
        Object.keys(changes).some(key => !['admission', 'session'].includes(key))) {
      throw new Error('Invalid runtime control update');
    }
    if (changes.admission !== undefined && !['paused', 'resumed'].includes(changes.admission)) {
      throw new Error('Invalid admission mode');
    }
    if (changes.session !== undefined && !['active', 'needs_pairing'].includes(changes.session)) {
      throw new Error('Invalid session state');
    }
    const next = { ...this.state, ...changes };
    if (next.session === 'needs_pairing') next.admission = 'paused';
    if (next.session === 'needs_pairing' && changes.admission === 'resumed') {
      throw new Error('Pair the session before resuming admission');
    }
    this.state = next;
    return this.readControl();
  }

  withControlLock(operation) {
    return operation(this.readControl());
  }

  accepting() {
    return this.state.admission === 'resumed' && this.state.session === 'active';
  }

  close() {}
}

function processStartToken(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

function writeJsonAtomically(path, value) {
  const directory = join(path, '..');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const dirFd = openSync(directory, 'r');
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}

export function writeStatusSnapshot(dataDir, status, {
  now = Date.now(), pid = process.pid, getProcessStartToken = processStartToken,
} = {}) {
  if (!status || !LIFECYCLE_STATES.includes(status.lifecycle) ||
      !['paused', 'resumed'].includes(status.admission) ||
      !['active', 'needs_pairing'].includes(status.session) ||
      typeof status.instanceId !== 'string' || !status.instanceId) {
    throw new Error('Invalid runtime status');
  }
  const snapshot = {
    version: 1,
    instanceId: status.instanceId,
    pid,
    processStartToken: getProcessStartToken(pid),
    lifecycle: status.lifecycle,
    admission: status.admission,
    session: status.session,
    activeClaims: Number.isSafeInteger(status.activeClaims) ? status.activeClaims : 0,
    activeCommands: Number.isSafeInteger(status.activeCommands) ? status.activeCommands : 0,
    heartbeatAt: new Date(now).toISOString(),
  };
  writeJsonAtomically(join(dataDir, 'runtime-status.json'), snapshot);
  return snapshot;
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

export function runtimeProcessIsAlive(dataDir) {
  try {
    const status = JSON.parse(readFileSync(join(dataDir, 'runtime-status.json'), 'utf8'));
    if (!Number.isSafeInteger(status.pid) || !processIsAlive(status.pid)) return false;
    return status.processStartToken === null ||
      processStartToken(status.pid) === status.processStartToken;
  } catch {
    return false;
  }
}

export function readStatusSnapshot(dataDir) {
  try {
    const status = JSON.parse(readFileSync(join(dataDir, 'runtime-status.json'), 'utf8'));
    if (status.version !== 1 || typeof status.instanceId !== 'string' ||
        !LIFECYCLE_STATES.includes(status.lifecycle) ||
        !['paused', 'resumed'].includes(status.admission) ||
        !['active', 'needs_pairing'].includes(status.session)) return null;
    return {
      version: status.version,
      instanceId: status.instanceId,
      lifecycle: status.lifecycle,
      admission: status.admission,
      session: status.session,
      activeClaims: Number.isSafeInteger(status.activeClaims) ? status.activeClaims : 0,
      activeCommands: Number.isSafeInteger(status.activeCommands) ? status.activeCommands : 0,
      heartbeatAt: status.heartbeatAt,
    };
  } catch {
    return null;
  }
}

export function readHealth(dataDir, {
  now = Date.now(),
  staleAfterMs = 15_000,
} = {}) {
  const path = join(dataDir, 'runtime-status.json');
  if (!existsSync(path)) return { healthy: false, lifecycle: 'unknown', reason: 'missing_status' };
  let status;
  try { status = JSON.parse(readFileSync(path, 'utf8')); }
  catch { return { healthy: false, lifecycle: 'unknown', reason: 'invalid_status' }; }

  const heartbeat = Date.parse(status.heartbeatAt);
  const fresh = Number.isFinite(heartbeat) && now >= heartbeat && now - heartbeat <= staleAfterMs;
  const valid = status.version === 1 && typeof status.instanceId === 'string' &&
    LIFECYCLE_STATES.includes(status.lifecycle) && ['paused', 'resumed'].includes(status.admission) &&
    ['active', 'needs_pairing'].includes(status.session);
  const healthy = valid && fresh && status.lifecycle !== 'failed';
  const reason = !valid ? 'invalid_status' : !fresh ? 'stale_heartbeat' :
    status.lifecycle === 'failed' ? 'worker_failed' : undefined;
  return {
    healthy,
    lifecycle: valid ? status.lifecycle : 'unknown',
    admission: valid ? status.admission : undefined,
    session: valid ? status.session : undefined,
    instanceId: valid ? status.instanceId : undefined,
    heartbeatAt: fresh ? status.heartbeatAt : undefined,
    ...(reason ? { reason } : {}),
  };
}
