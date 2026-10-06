import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Admission } from '../src/admission.mjs';
import { readHealth, writeStatusSnapshot } from '../src/runtime-state.mjs';
import { attachShutdownSignals, WorkerRuntime } from '../src/runtime.mjs';
import { main } from '../src/cli.mjs';

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'wpp-runtime-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('control state starts paused and survives an admission restart', t => {
  const directory = temporaryDirectory(t);
  const dbPath = join(directory, 'jobs.db');
  const first = new Admission({ dbPath, dataDir: directory, allowedGroups: [] });

  assert.deepEqual(first.runtimeState.readControl(), {
    version: 1,
    admission: 'paused',
    session: 'active',
  });
  assert.equal(first.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_control'").get(), undefined);
  assert.equal(existsSync(join(directory, 'runtime-state.sqlite')), true);
  first.runtimeState.updateControl({ admission: 'resumed' });
  first.close();

  const replacement = new Admission({ dbPath, dataDir: directory, allowedGroups: [] });
  t.after(() => replacement.close());
  assert.equal(replacement.runtimeState.readControl().admission, 'resumed');
});

test('paused work does not claim jobs or consume command receipts', async t => {
  const directory = temporaryDirectory(t);
  const group = '123456789@g.us';
  const phone = '+5511999999999';
  const actor = '5511777777777@s.whatsapp.net';
  const service = new Admission({
    dbPath: join(directory, 'jobs.db'),
    allowedGroups: [group],
    operators: [actor],
    socket: { groupMetadata: async () => ({ participants: [{ id: actor, admin: 'admin' }] }) },
  });
  t.after(() => service.close());
  const id = service.enqueue({ phone, group });

  assert.equal(await service.run(id), 'paused');
  assert.equal(service.state(id).state, 'queued');
  const command = { group, actor, messageId: 'paused-1', text: `/add ${phone}` };
  assert.equal(await service.command(command), 'paused');
  service.runtimeState.updateControl({ admission: 'resumed' });
  assert.equal(await service.command(command), id);
});

test('paused source import does not create jobs', async t => {
  const directory = temporaryDirectory(t);
  const dataDir = join(directory, 'data');
  const sourcePath = join(directory, 'source.json');
  const group = '123456789@g.us';
  writeFileSync(sourcePath, JSON.stringify([{ phone: '+5511999999999', group }]));
  await main(['ingest'], {
    WPP_DATA_DIR: dataDir,
    WPP_SOURCE: sourcePath,
    WPP_GROUPS: group,
  });
  const service = new Admission({ dbPath: join(dataDir, 'jobs.db'), allowedGroups: [group] });
  t.after(() => service.close());
  assert.equal(service.list().length, 0);
});

test('health accepts a fresh needs-pairing snapshot without exposing credentials', t => {
  const directory = temporaryDirectory(t);
  writeStatusSnapshot(directory, {
    instanceId: 'instance-test', lifecycle: 'needs_pairing',
    admission: 'paused', session: 'needs_pairing', activeClaims: 0,
  }, { now: 100_000, pid: 123, getProcessStartToken: () => 'start-a' });

  const health = readHealth(directory, {
    now: 105_000,
    isProcessAlive: pid => pid === 123,
    getProcessStartToken: () => 'start-a',
  });
  assert.deepEqual(health, {
    healthy: true,
    lifecycle: 'needs_pairing',
    admission: 'paused',
    session: 'needs_pairing',
    instanceId: 'instance-test',
    heartbeatAt: new Date(100_000).toISOString(),
  });
  assert.equal(JSON.stringify(health).includes('phone'), false);
});

test('health reads the snapshot without opening the jobs database', async t => {
  const directory = temporaryDirectory(t);
  writeStatusSnapshot(directory, {
    instanceId: 'health-only', lifecycle: 'ready',
    admission: 'paused', session: 'active', activeClaims: 0,
  });
  await main(['health'], { WPP_DATA_DIR: directory });
  assert.equal(existsSync(join(directory, 'jobs.db')), false);
});

test('backup makes a consistent SQLite copy and protects copied credentials', async t => {
  const directory = temporaryDirectory(t);
  const dataDir = join(directory, 'data');
  const authDir = join(dataDir, 'auth');
  const sourcePath = join(directory, 'source.json');
  const destination = join(directory, 'backup');
  const group = '123456789@g.us';
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(authDir, 'creds.json'), '{"synthetic":true}', { mode: 0o600 });
  writeFileSync(sourcePath, '[]');
  const source = new Admission({ dbPath: join(dataDir, 'jobs.db'), dataDir, allowedGroups: [group] });
  source.enqueue({ phone: '+5511999999999', group });
  source.runtimeState.updateControl({ session: 'needs_pairing' });
  source.close();

  await main(['backup', destination], {
    WPP_DATA_DIR: dataDir,
    WPP_SOURCE: sourcePath,
    WPP_GROUPS: group,
    WPP_RUNTIME_MODE: 'container',
    WPP_LOCK_HELD: '1',
  });
  const copy = new Admission({ dbPath: join(destination, 'jobs.db'), dataDir: destination, allowedGroups: [group] });
  t.after(() => copy.close());
  assert.equal(copy.list().length, 1);
  assert.equal(copy.runtimeState.readControl().session, 'needs_pairing');
  assert.equal(copy.runtimeState.readControl().admission, 'paused');
  assert.equal(statSync(destination).mode & 0o777, 0o700);
  assert.equal(statSync(join(destination, 'jobs.db')).mode & 0o777, 0o600);
  assert.equal(statSync(join(destination, 'auth')).mode & 0o777, 0o700);
  assert.equal(statSync(join(destination, 'auth', 'creds.json')).mode & 0o777, 0o600);
});

test('backup refuses a destination inside the live data directory', async t => {
  const directory = temporaryDirectory(t);
  const dataDir = join(directory, 'data');
  const destination = join(dataDir, 'nested-backup');
  await assert.rejects(main(['backup', destination], {
    WPP_DATA_DIR: dataDir,
    WPP_RUNTIME_MODE: 'container',
    WPP_LOCK_HELD: '1',
  }), /outside the live data directory/);
  assert.equal(existsSync(destination), false);
});

test('health rejects stale snapshots and a replaced process identity', t => {
  const directory = temporaryDirectory(t);
  writeStatusSnapshot(directory, {
    instanceId: 'instance-old', lifecycle: 'ready',
    admission: 'resumed', session: 'active', activeClaims: 0,
  }, { now: 100_000, pid: 123, getProcessStartToken: () => 'start-a' });

  assert.equal(readHealth(directory, {
    now: 120_001,
    isProcessAlive: () => true,
    getProcessStartToken: () => 'start-a',
  }).healthy, false);
  const restarted = readHealth(directory, {
    now: 105_000,
    isProcessAlive: () => true,
    getProcessStartToken: () => 'start-b',
  });
  assert.equal(restarted.healthy, false);
  assert.equal(restarted.reason, 'process_restarted');
});

test('worker starts paused and processes one source job after resume', async t => {
  const directory = temporaryDirectory(t);
  const dataDir = join(directory, 'data');
  const sourcePath = join(directory, 'source.json');
  const group = '123456789@g.us';
  const phone = '+5511999999999';
  const pn = '5511999999999@s.whatsapp.net';
  writeFileSync(sourcePath, JSON.stringify([{ phone, group }]));
  const participants = [
    { id: '100@lid', phoneNumber: '5511888888888@s.whatsapp.net', admin: 'admin' },
  ];
  let writes = 0;
  let ready;
  let added;
  const workerReady = new Promise(resolveReady => { ready = resolveReady; });
  const jobAdded = new Promise(resolveAdded => { added = resolveAdded; });
  const runtime = new WorkerRuntime({
    dataDir,
    sourcePath,
    allowedGroups: [group],
    pollMs: 5,
    heartbeatMs: 20,
    onStatus: status => { if (status.lifecycle === 'ready') ready(status); },
    onOutput: result => { if (result.state === 'added') added(result); },
    transport: async () => ({
      socket: {
        user: { id: '100@lid' },
        ev: new EventEmitter(),
        async groupMetadata() { return { participants }; },
        async onWhatsApp() { return [{ jid: pn, exists: true, lid: '200@lid' }]; },
        async groupParticipantsUpdate() {
          writes++;
          participants.push({ id: '200@lid', phoneNumber: pn });
          return [{ jid: '200@lid', status: '200', content: { tag: 'participant', attrs: { phone_number: pn } } }];
        },
      },
      async close() {},
    }),
  });
  const running = runtime.run();
  t.after(async () => { runtime.stop(); await running; });

  await workerReady;
  assert.equal(readHealth(dataDir).healthy, true);
  assert.equal(writes, 0);
  const control = new Admission({ dbPath: join(dataDir, 'jobs.db'), dataDir, allowedGroups: [group] });
  control.runtimeState.updateControl({ admission: 'resumed' });
  control.close();

  const result = await jobAdded;
  assert.equal(result.state, 'added');
  assert.equal(writes, 1);
  runtime.stop();
  await running;
});

test('resume refuses invalid configuration and leaves control paused', async t => {
  const directory = temporaryDirectory(t);
  const env = {
    WPP_DATA_DIR: join(directory, 'data'),
    WPP_SOURCE: join(directory, 'missing-source.json'),
    WPP_GROUPS: '',
  };
  await assert.rejects(main(['resume'], env), /Set WPP_GROUPS/);
  const service = new Admission({ dbPath: join(env.WPP_DATA_DIR, 'jobs.db'), allowedGroups: [] });
  t.after(() => service.close());
  assert.equal(service.runtimeState.readControl().admission, 'paused');
});

test('health and resume reject a fresh snapshot from a process that is no longer alive', async t => {
  const directory = temporaryDirectory(t);
  const dataDir = join(directory, 'data');
  const sourcePath = join(directory, 'source.json');
  const group = '123456789@g.us';
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(sourcePath, '[]');
  writeStatusSnapshot(dataDir, {
    instanceId: 'dead-worker', lifecycle: 'ready',
    admission: 'paused', session: 'active', activeClaims: 0,
  }, { pid: 99999999 });
  const env = { WPP_DATA_DIR: dataDir, WPP_SOURCE: sourcePath, WPP_GROUPS: group };

  const health = readHealth(dataDir);
  assert.equal(health.healthy, false);
  assert.equal(health.reason, 'process_stopped');
  await assert.rejects(main(['resume'], env), /readiness is missing or stale/);
  const service = new Admission({ dbPath: join(dataDir, 'jobs.db'), dataDir, allowedGroups: [group] });
  t.after(() => service.close());
  assert.equal(service.runtimeState.readControl().admission, 'paused');
});

test('native live worker is retired before it opens local data', async t => {
  const directory = temporaryDirectory(t);
  await assert.rejects(main(['worker'], {
    WPP_DATA_DIR: join(directory, 'data'),
    WPP_GROUPS: '123456789@g.us',
  }), /Live worker runs only through Docker Compose/);
  assert.equal(existsSync(join(directory, 'data')), false);
});

test('repeated shutdown signals keep the first bounded drain in control', () => {
  const signals = new EventEmitter();
  let stopCount = 0, repeatCount = 0;
  const detach = attachShutdownSignals({ stop: () => { stopCount++; } }, signals, () => { repeatCount++; });
  signals.emit('SIGTERM');
  signals.emit('SIGINT');
  assert.equal(stopCount, 1);
  assert.equal(repeatCount, 1);
  detach();
});

test('logout before ready persists pairing and blocks future connections', async t => {
  const directory = temporaryDirectory(t);
  const dataDir = join(directory, 'data');
  const sourcePath = join(directory, 'source.json');
  const group = '123456789@g.us';
  writeFileSync(sourcePath, JSON.stringify([]));
  let connections = 0;
  let needsPairing;
  const blocked = new Promise(resolveBlocked => { needsPairing = resolveBlocked; });
  const first = new WorkerRuntime({
    dataDir, sourcePath, allowedGroups: [group], pollMs: 5, heartbeatMs: 20,
    onStatus: status => { if (status.lifecycle === 'needs_pairing') needsPairing(status); },
    transport: async ({ onDisconnect }) => {
      connections++;
      onDisconnect({ loggedOut: true });
      throw new Error('Synthetic close before ready');
    },
  });
  const firstRun = first.run();
  await blocked;
  assert.equal(readHealth(dataDir).healthy, true);
  assert.equal(first.admission.runtimeState.readControl().session, 'needs_pairing');
  first.stop();
  await firstRun;

  const replacement = new WorkerRuntime({
    dataDir, sourcePath, allowedGroups: [group], pollMs: 5, heartbeatMs: 20,
    transport: async () => { connections++; throw new Error('Must not reconnect'); },
  });
  const replacementRun = replacement.run();
  t.after(async () => { replacement.stop(); await replacementRun; });
  assert.equal(replacement.admission.runtimeState.readControl().admission, 'paused');
  assert.equal(replacement.admission.runtimeState.readControl().session, 'needs_pairing');
  assert.equal(connections, 1);
  replacement.stop();
  await replacementRun;
});

test('non-logout connection failure exits for the Compose restart policy', async t => {
  const directory = temporaryDirectory(t);
  const dataDir = join(directory, 'data');
  const sourcePath = join(directory, 'source.json');
  writeFileSync(sourcePath, '[]');
  const events = [];
  const runtime = new WorkerRuntime({
    dataDir,
    sourcePath,
    allowedGroups: ['123456789@g.us'],
    heartbeatMs: 20,
    onOutput: event => events.push(event),
    transport: async () => { throw new Error('Synthetic network failure'); },
  });

  await assert.rejects(runtime.run(), /Transport connection failed/);
  assert.ok(events.some(event => event.event === 'transport_connect_failed'));
  const control = new Admission({
    dbPath: join(dataDir, 'jobs.db'),
    dataDir,
    allowedGroups: ['123456789@g.us'],
  });
  t.after(() => control.close());
  assert.equal(control.runtimeState.readControl().admission, 'paused');
});

test('pause during an addition drains it and leaves later jobs queued', async t => {
  const directory = temporaryDirectory(t);
  const dataDir = join(directory, 'data');
  const sourcePath = join(directory, 'source.json');
  const group = '123456789@g.us';
  const phones = ['+5511999999999', '+5511888888888'];
  writeFileSync(sourcePath, JSON.stringify(phones.map(phone => ({ phone, group }))));
  const participants = [{ id: '100@lid', admin: 'admin' }];
  let releaseAddition;
  let addStarted;
  let writeCount = 0;
  const started = new Promise(resolveStarted => { addStarted = resolveStarted; });
  const release = new Promise(resolveRelease => { releaseAddition = resolveRelease; });
  let ready;
  let additionFinished;
  const workerReady = new Promise(resolveReady => { ready = resolveReady; });
  const firstAddition = new Promise(resolveFinished => { additionFinished = resolveFinished; });
  const runtime = new WorkerRuntime({
    dataDir, sourcePath, allowedGroups: [group], pollMs: 5, heartbeatMs: 20,
    onStatus: status => { if (status.lifecycle === 'ready') ready(status); },
    onOutput: result => { if (result.state === 'added') additionFinished(result); },
    transport: async () => ({
      socket: {
        user: { id: '100@lid' },
        ev: new EventEmitter(),
        async groupMetadata() { return { participants }; },
        async onWhatsApp(jid) {
          const lid = jid.includes('999999999') ? '200@lid' : '201@lid';
          return [{ jid, exists: true, lid }];
        },
        async groupParticipantsUpdate(_group, [jid]) {
          writeCount++;
          addStarted();
          await release;
          const lid = jid === '5511999999999@s.whatsapp.net' ? '200@lid' : '201@lid';
          participants.push({ id: lid, phoneNumber: jid });
          return [{ jid: lid, status: '200', content: { tag: 'participant', attrs: { phone_number: jid } } }];
        },
      },
      async close() {},
    }),
  });
  const running = runtime.run();
  t.after(async () => { runtime.stop(); await running; });
  await workerReady;
  const control = new Admission({ dbPath: join(dataDir, 'jobs.db'), dataDir, allowedGroups: [group] });
  t.after(() => control.close());
  control.runtimeState.updateControl({ admission: 'resumed' });
  await started;

  const pausing = main(['pause'], {
    WPP_DATA_DIR: dataDir,
    WPP_SOURCE: sourcePath,
    WPP_GROUPS: group,
  });
  assert.equal(control.runtimeState.readControl().admission, 'paused');
  releaseAddition();
  await pausing;
  await firstAddition;
  runtime.stop();
  await running;

  assert.equal(writeCount, 1);
  assert.deepEqual(control.list().map(job => job.state), ['added', 'queued']);
});

test('shutdown deadline leaves an interrupted addition uncertain without resend', async t => {
  const directory = temporaryDirectory(t);
  const dataDir = join(directory, 'data');
  const sourcePath = join(directory, 'source.json');
  const group = '123456789@g.us';
  const phone = '+5511999999999';
  const pn = '5511999999999@s.whatsapp.net';
  writeFileSync(sourcePath, JSON.stringify([{ phone, group }]));
  let started;
  let timedOut;
  let writes = 0;
  const addStarted = new Promise(resolveStarted => { started = resolveStarted; });
  const drainExpired = new Promise(resolveExpired => { timedOut = resolveExpired; });
  const runtime = new WorkerRuntime({
    dataDir, sourcePath, allowedGroups: [group], pollMs: 5, heartbeatMs: 20,
    admissionTimeoutMs: 100, shutdownLimitMs: 20,
    onDrainTimeout: () => timedOut(),
    transport: async () => ({
      socket: {
        user: { id: '100@lid' },
        ev: new EventEmitter(),
        async groupMetadata() { return { participants: [{ id: '100@lid', admin: 'admin' }] }; },
        async onWhatsApp() { return [{ jid: pn, exists: true, lid: '200@lid' }]; },
        async groupParticipantsUpdate() { writes++; started(); return new Promise(() => {}); },
      },
      async close() {},
    }),
  });
  const running = runtime.run();
  t.after(async () => { runtime.stop(); await running; });
  await new Promise(resolveReady => {
    const wait = status => status.lifecycle === 'ready' && resolveReady();
    const prior = runtime.onStatus;
    runtime.onStatus = status => { prior(status); wait(status); };
    wait(runtime.status ?? {});
  });
  const control = new Admission({ dbPath: join(dataDir, 'jobs.db'), dataDir, allowedGroups: [group] });
  t.after(() => control.close());
  control.runtimeState.updateControl({ admission: 'resumed' });
  await addStarted;
  runtime.stop();
  await drainExpired;
  await running;

  assert.equal(writes, 1);
  assert.equal(control.list()[0].state, 'uncertain');
});
