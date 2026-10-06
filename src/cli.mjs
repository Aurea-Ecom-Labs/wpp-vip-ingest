import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, join, relative, sep, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Admission, normalizeJid } from './admission.mjs';
import { readSource } from './source.mjs';
import { connect } from './baileys.mjs';
import { connectFake } from './fake-transport.mjs';
import { attachShutdownSignals, WorkerRuntime, validateRuntimeConfiguration } from './runtime.mjs';
import { readHealth, readStatusSnapshot, runtimeProcessIsAlive } from './runtime-state.mjs';

const output = value => console.log(JSON.stringify(value));
function parseArguments(argv, env) {
  let transport = env.WPP_TRANSPORT === 'fake' ? 'fake' : 'live';
  const args = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--transport') {
      transport = argv[++index];
      continue;
    }
    if (argv[index].startsWith('--transport=')) {
      transport = argv[index].slice('--transport='.length);
      continue;
    }
    args.push(argv[index]);
  }
  if (!['live', 'fake'].includes(transport)) throw new Error('Transport must be live or fake');
  return { action: args[0] ?? 'help', args: args.slice(1), transport };
}

function configFromEnv(env) {
  const dataDir = resolve(env.WPP_DATA_DIR ?? 'data');
  return {
    dataDir,
    sourcePath: resolve(env.WPP_SOURCE ?? join(dataDir, 'source.json')),
    allowedGroups: (env.WPP_GROUPS ?? '').split(',').filter(Boolean),
    operators: (env.WPP_OPERATORS ?? '').split(',').filter(Boolean),
  };
}

function openAdmission(config, env) {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  return new Admission({
    dbPath: join(config.dataDir, 'jobs.db'),
    dataDir: config.dataDir,
    allowedGroups: config.allowedGroups,
    operators: config.operators,
    timeoutMs: Number(env.WPP_ADMISSION_TIMEOUT_MS) || 30_000,
  });
}

function requireLiveRuntime(action, transport, env) {
  if (transport === 'fake' && action !== 'backup') return;
  if (env.WPP_RUNTIME_MODE !== 'container' || env.WPP_LOCK_HELD !== '1') {
    throw new Error(`Live ${action} runs only through Docker Compose; see docs/docker.md`);
  }
}

function selectedTransport(name) {
  return name === 'fake' ? connectFake : connect;
}

async function waitForDrain(config, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = readStatusSnapshot(config.dataDir);
    const health = readHealth(config.dataDir);
    if (!runtimeProcessIsAlive(config.dataDir)) return 'worker_not_running';
    if (health.healthy && status?.admission === 'paused' &&
        status.activeClaims === 0 && status.activeCommands === 0) {
      return 'drained';
    }
    if (status?.lifecycle === 'failed' && status.admission === 'paused' &&
        status.activeClaims === 0 && status.activeCommands === 0) {
      return 'drained';
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error('Admission is paused, but the worker did not drain before the limit');
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { action, args, transport } = parseArguments(argv, env);
  const config = configFromEnv(env);

  if (action === 'help') {
    console.log('Commands: demo | pair | worker | ingest [source.json] | status | groups | check JOB | retry JOB "human review note" | health | pause | resume | runtime-status | backup DIRECTORY');
    return;
  }
  if (action === 'demo') {
    const group = '123456789@g.us', phone = '+5511999999999', pn = '5511999999999@s.whatsapp.net';
    const participants = [{ id: '100@lid', admin: 'admin' }];
    const socket = {
      groupMetadata: async () => ({ participants }),
      onWhatsApp: async () => [{ jid: pn, exists: true }],
      groupParticipantsUpdate: async () => {
        participants.push({ id: '200@lid', phoneNumber: pn });
        return [{ jid: '200@lid', status: '200', content: { tag: 'participant', attrs: { phone_number: pn } } }];
      },
    };
    const service = new Admission({ socket, allowedGroups: [group], botIds: ['100@lid'] });
    try {
      service.runtimeState.updateControl({ admission: 'resumed' });
      const id = service.enqueue({ phone, group });
      output({ id, state: await service.run(id), simulated: true });
    } finally { service.close(); }
    return;
  }

  if (action === 'health') {
    const health = readHealth(config.dataDir);
    output(health);
    if (!health.healthy) process.exitCode = 1;
    return;
  }

  if (action === 'worker') {
    requireLiveRuntime(action, transport, env);
    const runtime = new WorkerRuntime({
      ...config,
      transport: selectedTransport(transport),
      admissionTimeoutMs: Number(env.WPP_ADMISSION_TIMEOUT_MS) || 30_000,
      onOutput: output,
      onDrainTimeout: () => process.exit(1),
    });
    const removeSignals = attachShutdownSignals(runtime, process,
      () => output({ event: 'shutdown_already_in_progress' }));
    try { await runtime.run(); }
    finally { removeSignals(); }
    return;
  }

  if (['pair', 'groups', 'check', 'retry', 'backup'].includes(action)) {
    requireLiveRuntime(action, transport, env);
  }

  const service = openAdmission(config, env);
  try {
    if (action === 'runtime-status') {
      output({
        control: service.runtimeState.readControl(),
        status: readStatusSnapshot(config.dataDir),
        health: readHealth(config.dataDir),
        processCurrent: runtimeProcessIsAlive(config.dataDir),
        jobCounts: service.countStates(),
      });
      return;
    }
    if (action === 'backup') {
      const destination = resolve(args[0] ?? '');
      if (!args[0]) throw new Error('Set a backup destination directory');
      const realDataDir = realpathSync(config.dataDir);
      const realDestination = join(realpathSync(dirname(destination)), basename(destination));
      const dataRelative = relative(realDataDir, realDestination);
      const destinationRelative = relative(realDestination, realDataDir);
      const destinationInsideData = !dataRelative.startsWith(`..${sep}`) && dataRelative !== '..';
      const dataInsideDestination = !destinationRelative.startsWith(`..${sep}`) && destinationRelative !== '..';
      if (destinationInsideData || dataInsideDestination) {
        throw new Error('Backup destination must be outside the live data directory');
      }
      mkdirSync(destination, { mode: 0o700 });
      chmodSync(destination, 0o700);
      const databaseBackup = join(destination, 'jobs.db');
      const escaped = databaseBackup.replaceAll("'", "''");
      service.db.exec(`VACUUM INTO '${escaped}'`);
      chmodSync(databaseBackup, 0o600);
      const runtimeBackup = join(destination, 'runtime-state.sqlite');
      service.runtimeState.backupTo(runtimeBackup);
      chmodSync(runtimeBackup, 0o600);
      const authSource = join(config.dataDir, 'auth');
      if (existsSync(authSource)) {
        const inspectTree = path => {
          for (const name of readdirSync(path)) {
            const child = join(path, name);
            const info = lstatSync(child);
            if (info.isSymbolicLink()) throw new Error('Auth backup does not accept symbolic links');
            if (info.isDirectory()) inspectTree(child);
            else if (!info.isFile()) throw new Error('Auth backup only accepts regular files');
          }
        };
        inspectTree(authSource);
        cpSync(authSource, join(destination, 'auth'), { recursive: true, errorOnExist: true });
        const secureTree = path => {
          for (const name of readdirSync(path)) {
            const child = join(path, name), info = lstatSync(child);
            chmodSync(child, info.isDirectory() ? 0o700 : 0o600);
            if (info.isDirectory()) secureTree(child);
          }
        };
        chmodSync(join(destination, 'auth'), 0o700);
        secureTree(join(destination, 'auth'));
      }
      output({ backup: 'completed', files: existsSync(join(destination, 'auth'))
        ? ['jobs.db', 'runtime-state.sqlite', 'auth'] : ['jobs.db', 'runtime-state.sqlite'] });
      return;
    }
    if (action === 'pause') {
      const control = service.runtimeState.updateControl({ admission: 'paused' });
      const drain = await waitForDrain(config);
      output({ admission: control.admission, drain });
      return;
    }
    if (action === 'resume') {
      const control = service.runtimeState.readControl();
      if (control.session === 'needs_pairing') throw new Error('Pair the session before resuming admission');
      validateRuntimeConfiguration({
        allowedGroups: config.allowedGroups,
        sourcePath: config.sourcePath,
        requireSource: true,
      });
      const health = readHealth(config.dataDir);
      if (!health.healthy || !runtimeProcessIsAlive(config.dataDir) ||
          health.lifecycle !== 'ready' || health.session !== 'active') {
        throw new Error('Worker readiness is missing or stale; keep admission paused');
      }
      const next = service.runtimeState.updateControl({ admission: 'resumed' });
      output({ admission: next.admission, lifecycle: health.lifecycle, session: next.session });
      return;
    }
    if (action === 'ingest') {
      if (!service.runtimeState.accepting()) {
        output({ result: 'paused' });
        return;
      }
      for (const row of readSource(args[0] ?? config.sourcePath, config.allowedGroups)) {
        const id = service.enqueueIfAccepting(row);
        if (!id) {
          output({ result: 'paused' });
          break;
        }
        output({ id });
      }
      return;
    }
    if (action === 'status') {
      for (const job of service.list()) output(job);
      return;
    }
    if (!['pair', 'groups', 'check', 'retry'].includes(action)) throw new Error('Unknown command');
    if (action !== 'pair' && service.runtimeState.readControl().session === 'needs_pairing') {
      throw new Error('Session needs pairing; stop the worker and run pair');
    }

    let loggedOutDuringCommand = false;
    const session = await selectedTransport(transport)({
      authDir: join(config.dataDir, 'auth'),
      pair: action === 'pair',
      onDisconnect: ({ loggedOut }) => {
        if (loggedOut) {
          loggedOutDuringCommand = true;
          service.runtimeState.updateControl({ session: 'needs_pairing' });
        }
      },
    });
    try {
      if (action === 'pair') {
        // Report success only after close has flushed credential writes.
      } else {
        service.socket = session.socket;
        service.botIds = new Set([session.socket.user?.id, session.socket.user?.lid].filter(Boolean).map(normalizeJid));
        if (action === 'groups') {
          for (const meta of Object.values(await session.socket.groupFetchAllParticipating())) {
            output({ group: meta.id, subject: meta.subject });
          }
        }
        if (action === 'check') output({ id: args[0], membership: await service.check(args[0]) });
        if (action === 'retry') output({ id: args[0], state: await service.retry(args[0], args.slice(1).join(' ')) });
      }
    } finally {
      await session.close();
      if (action === 'pair' && !loggedOutDuringCommand) {
        service.runtimeState.updateControl({ session: 'active', admission: 'paused' });
      }
    }
    if (action === 'pair') {
      if (loggedOutDuringCommand) throw new Error('Pairing ended in needs_pairing; admission remains paused');
      output({ state: 'paired', admission: 'paused' });
    }
  } finally {
    service.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.message);
    if (error.code === 'DRAIN_TIMEOUT') process.exit(1);
    process.exitCode = 1;
  });
}
