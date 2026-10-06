import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const image = process.env.WPP_TEST_IMAGE;
const requireDocker = process.env.WPP_REQUIRE_DOCKER_TESTS === '1';
const dockerAvailable = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' }).status === 0;
const testsEnabled = requireDocker || Boolean(image);

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: options.timeout ?? 30_000, ...options });
}

function mustRun(command, args, options = {}) {
  const result = run(command, args, options);
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function parseLines(text) {
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function createCase(t, { mode = 'success', rows = [], timeoutMs = 30_000 } = {}) {
  assert.ok(dockerAvailable, 'Docker daemon is required for container tests');
  assert.ok(image, 'Set WPP_TEST_IMAGE to the image under test');
  const directory = mkdtempSync(join(tmpdir(), 'wpp-container-test-'));
  const sourceDir = join(directory, 'source');
  mkdirSync(sourceDir, { recursive: true, mode: 0o700 });
  const sourcePath = join(sourceDir, 'source.json');
  writeFileSync(sourcePath, JSON.stringify(rows));
  const project = `wpp-test-${randomUUID().slice(0, 8)}`;
  const envPath = join(directory, 'compose.env');
  const context = {
    directory,
    sourceDir,
    sourcePath,
    project,
    envPath,
    workerId: null,
    frozenPid: null,
  };
  const setEnvironment = values => {
    const config = {
      WPP_IMAGE: image,
      WPP_DATA_VOLUME: `${project}-data`,
      WPP_GROUPS: '123456789@g.us',
      WPP_OPERATORS: '5511777777777@s.whatsapp.net',
      WPP_SOURCE_DIR: sourceDir,
      WPP_TRANSPORT: 'fake',
      WPP_FAKE_MODE: mode,
      WPP_ADMISSION_TIMEOUT_MS: String(timeoutMs),
      ...values,
    };
    writeFileSync(envPath, `${Object.entries(config).map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
  };
  context.setEnvironment = setEnvironment;
  setEnvironment({});
  context.composeArgs = args => [
    'compose', '--project-directory', root, '--env-file', envPath,
    '--project-name', project, '-f', join(root, 'compose.yaml'), ...args,
  ];
  context.compose = (...args) => run('docker', context.composeArgs(args));
  context.composeOk = (...args) => mustRun('docker', context.composeArgs(args));
  context.exec = (...args) => context.compose('exec', '-T', 'worker', ...args);
  context.execOk = (...args) => mustRun('docker', context.composeArgs(['exec', '-T', 'worker', ...args]));
  context.status = () => JSON.parse(context.execOk('node', 'src/cli.mjs', 'runtime-status'));
  context.jobs = () => parseLines(context.composeOk('run', '--rm', '--no-deps', 'worker', 'status'));
  context.waitFor = async (predicate, description, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await predicate();
        if (last) return last;
      } catch { }
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    assert.fail(`Timed out waiting for ${description}; last value: ${JSON.stringify(last)}`);
  };
  context.waitReady = async lifecycle => context.waitFor(() => {
    const status = context.status();
    return status.status?.lifecycle === lifecycle && status.health?.healthy ? status : null;
  }, `healthy ${lifecycle} worker`);
  context.counts = () => {
    const result = context.exec('node', '--input-type=module', '-e',
      "import {readFileSync} from 'node:fs'; process.stdout.write(readFileSync('/data/fake-transport.json','utf8'))");
    if (result.status === 0) return JSON.parse(result.stdout);
    const container = context.compose('ps', '-aq', 'worker').stdout.trim();
    if (!container) throw new Error(`No worker container for fake counts: ${result.stderr}`);
    const destination = join(directory, 'fake-transport.json');
    mustRun('docker', ['cp', `${container}:/data/fake-transport.json`, destination]);
    return JSON.parse(readFileSync(destination, 'utf8'));
  };
  context.atomicSourceWrite = rowsToWrite => {
    const temporary = `${sourcePath}.next`;
    writeFileSync(temporary, JSON.stringify(rowsToWrite));
    renameSync(temporary, sourcePath);
  };
  context.cleanup = () => {
    const id = context.compose('ps', '-q', 'worker').stdout.trim();
    const logDirectory = process.env.WPP_CONTAINER_LOG_DIR;
    if (logDirectory) {
      mkdirSync(logDirectory, { recursive: true });
      const logs = context.compose('logs', '--no-color', '--timestamps', 'worker');
      writeFileSync(join(logDirectory, `${project}.log`), `${logs.stdout}${logs.stderr}`);
    }
    if (id) {
      run('docker', ['exec', id, 'node', '--input-type=module', '-e',
        "import {mkdirSync,writeFileSync} from 'node:fs'; mkdirSync('/data/faults',{recursive:true}); writeFileSync('/data/faults/release-add','cleanup')"]);
      if (context.frozenPid) run('docker', ['kill', '--signal=CONT', id]);
    }
    context.compose('down', '--volumes', '--remove-orphans');
    rmSync(directory, { recursive: true, force: true });
  };
  t.after(context.cleanup);
  return context;
}

if (!testsEnabled) {
  test('container integration tests require WPP_TEST_IMAGE and Docker', { skip: true }, () => {});
} else {
  test('container starts paused, runs one addition, and sees atomic source updates', { timeout: 120_000 }, async t => {
    const ctx = createCase(t, {
      rows: [
        { phone: '+5511999999999', group: '123456789@g.us' },
        { phone: '+5511999999999', group: '123456789@g.us' },
      ],
    });
    assert.match(ctx.composeOk('run', '--rm', '--no-deps', 'worker', 'help'), /runtime-status/);
    const demo = JSON.parse(ctx.composeOk('run', '--rm', '--no-deps', 'worker', 'demo'));
    assert.equal(demo.state, 'added');
    assert.equal(demo.simulated, true);
    ctx.composeOk('up', '-d', 'worker');
    const status = await ctx.waitReady('ready');
    assert.equal(status.control.admission, 'paused');
    assert.equal(ctx.counts().externalWrites, 0);
    const composeConfig = JSON.parse(ctx.composeOk('config', '--format', 'json'));
    const sourceMount = composeConfig.services.worker.volumes.find(mount => mount.target === '/source');
    assert.equal(sourceMount.source, ctx.sourceDir);
    assert.equal(ctx.execOk('node', '--input-type=module', '-e',
      "import {existsSync} from 'node:fs'; process.stdout.write(String(existsSync('/source/source.json')))").trim(), 'true');
    const sourceWrite = ctx.exec('node', '--input-type=module', '-e',
      "import {writeFileSync} from 'node:fs'; try { writeFileSync('/source/source.json','[]'); process.exit(2) } catch (error) { if (error.code === 'EROFS') process.exit(0); process.exit(1) }");
    assert.equal(sourceWrite.status, 0, sourceWrite.stderr);
    assert.equal(ctx.composeOk('exec', '-T', 'worker', 'node', '-p', 'process.getuid()'), '1000');
    assert.deepEqual(JSON.parse(ctx.composeOk('exec', '-T', 'worker', 'node', '--input-type=module', '-e',
      "import {existsSync} from 'node:fs'; process.stdout.write(JSON.stringify(['/app/.env','/app/data','/app/auth','/app/source'].map(existsSync)))")),
    [false, false, false, false]);
    assert.notEqual(ctx.exec('node', '--input-type=module', '-e',
      "import {writeFileSync} from 'node:fs'; writeFileSync('/app/forbidden','x')").status, 0);
    ctx.execOk('node', 'src/cli.mjs', 'resume');
    await ctx.waitFor(() => ctx.jobs().some(job => job.state === 'added'), 'simulated addition');
    assert.equal(ctx.counts().externalWrites, 1);

    ctx.atomicSourceWrite([
      { phone: '+5511999999999', group: '123456789@g.us' },
      { phone: '+5511999999999', group: '123456789@g.us' },
      { phone: '+5511666666666', group: '123456789@g.us' },
    ]);
    await ctx.waitFor(() => ctx.jobs().filter(job => job.state === 'added').length === 2, 'second source addition');
    assert.equal(ctx.counts().externalWrites, 2);

    const statusFile = "import {readFileSync,writeFileSync} from 'node:fs'; const p='/data/runtime-status.json'; const s=JSON.parse(readFileSync(p,'utf8')); process.kill(s.pid,'SIGSTOP'); s.heartbeatAt=new Date(Date.now()-60000).toISOString(); writeFileSync(p,JSON.stringify(s)); process.stdout.write(String(s.pid));";
    const stoppedPid = ctx.execOk('node', '--input-type=module', '-e', statusFile);
    ctx.frozenPid = stoppedPid;
    const stale = ctx.exec('node', 'src/cli.mjs', 'health');
    assert.equal(stale.status, 1);
    assert.equal(JSON.parse(stale.stdout).reason, 'stale_heartbeat');
    ctx.execOk('node', '--input-type=module', '-e', `process.kill(${stoppedPid},'SIGCONT')`);
    ctx.frozenPid = null;
    await ctx.waitFor(() => ctx.status().health.healthy, 'fresh health after worker resumes');
  });

  test('privacy outcomes, transport errors, and timeouts remain stopped', { timeout: 180_000 }, async t => {
    for (const [mode, expected] of [
      ['invite403', 'invite_required'],
      ['invite200', 'invite_required'],
      ['error', 'uncertain'],
      ['timeout', 'uncertain'],
    ]) {
      await t.test(`${mode} -> ${expected}`, { timeout: 45_000 }, async subtest => {
        const ctx = createCase(subtest, {
          mode,
          timeoutMs: mode === 'timeout' ? 250 : 30_000,
          rows: [{ phone: '+5511999999999', group: '123456789@g.us' }],
        });
        ctx.composeOk('up', '-d', 'worker');
        await ctx.waitReady('ready');
        ctx.execOk('node', 'src/cli.mjs', 'resume');
        await ctx.waitFor(() => ctx.jobs().find(job => job.state === expected), `${expected} result`);
        assert.equal(ctx.counts().externalWrites, 1);
        assert.equal(ctx.jobs().filter(job => job.state === expected).length, 1);
      });
    }
  });

  test('logout survives restart and pairing clears only the session stop', { timeout: 120_000 }, async t => {
    const ctx = createCase(t, { mode: 'logout' });
    ctx.composeOk('up', '-d', 'worker');
    const blocked = await ctx.waitReady('needs_pairing');
    assert.equal(blocked.control.session, 'needs_pairing');
    assert.equal(blocked.control.admission, 'paused');
    assert.equal(ctx.counts().connections, 1);

    ctx.setEnvironment({ WPP_FAKE_MODE: 'success' });
    ctx.composeOk('restart', 'worker');
    await ctx.waitReady('needs_pairing');
    assert.equal(ctx.counts().connections, 1);
    ctx.composeOk('stop', 'worker');

    const pair = ctx.compose('run', '--rm', '--no-deps', 'worker', 'pair', '--transport=fake');
    assert.equal(pair.status, 0, `${pair.stdout}\n${pair.stderr}`);
    assert.match(pair.stdout, /"state":"paired"/);
    const paired = JSON.parse(ctx.composeOk('run', '--rm', '--no-deps', 'worker', 'runtime-status'));
    assert.equal(paired.control.session, 'active');
    assert.equal(paired.control.admission, 'paused');

    ctx.composeOk('up', '-d', '--force-recreate', 'worker');
    const ready = await ctx.waitReady('ready');
    assert.equal(ready.control.session, 'active');
    assert.equal(ready.control.admission, 'paused');
    assert.equal(ctx.counts().connections, 3);
  });

  test('exclusive ownership and forced replacement preserve uncertain work', { timeout: 120_000 }, async t => {
    const ctx = createCase(t, {
      mode: 'barrier',
      rows: [{ phone: '+5511999999999', group: '123456789@g.us' }],
    });
    ctx.composeOk('up', '-d', 'worker');
    await ctx.waitReady('ready');
    const before = ctx.counts().connections;
    const competing = ctx.compose('run', '--rm', '--no-deps', 'worker', 'worker', '--transport=fake');
    assert.equal(competing.status, 75, `${competing.stdout}\n${competing.stderr}`);
    assert.equal(ctx.counts().connections, before);

    ctx.execOk('node', 'src/cli.mjs', 'resume');
    await ctx.waitFor(() => ctx.exec('node', '-e',
      "process.exit(require('node:fs').existsSync('/data/faults/add-started')?0:1)").status === 0, 'in-flight barrier');
    const container = ctx.composeOk('ps', '-q', 'worker');
    mustRun('docker', ['kill', '--signal=KILL', container]);
    ctx.composeOk('up', '-d', '--force-recreate', 'worker');
    await ctx.waitReady('ready');
    assert.equal(ctx.jobs()[0].state, 'uncertain');
    assert.equal(ctx.counts().externalWrites, 1);
  });

  test('SIGTERM drains an active operation before the worker exits', { timeout: 120_000 }, async t => {
    const ctx = createCase(t, {
      mode: 'barrier',
      rows: [{ phone: '+5511999999999', group: '123456789@g.us' }],
    });
    ctx.composeOk('up', '-d', 'worker');
    await ctx.waitReady('ready');
    ctx.execOk('node', 'src/cli.mjs', 'resume');
    await ctx.waitFor(() => ctx.exec('node', '-e',
      "process.exit(require('node:fs').existsSync('/data/faults/add-started')?0:1)").status === 0, 'active operation');

    const stop = spawn('docker', ctx.composeArgs(['stop', '-t', '60', 'worker']), { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    stop.stdout.on('data', chunk => { stdout += chunk; });
    stop.stderr.on('data', chunk => { stderr += chunk; });
    const stopClosed = new Promise(resolveExit => stop.on('close', (code, signal) => resolveExit({ code, signal })));
    await ctx.waitFor(() => {
      try { return ctx.status().status?.lifecycle === 'draining'; }
      catch { return false; }
    }, 'draining status');
    ctx.execOk('node', '--input-type=module', '-e',
      "import {writeFileSync} from 'node:fs'; writeFileSync('/data/faults/release-add','release')");
    const exit = await stopClosed;
    assert.equal(exit.code, 0, `${stdout}\n${stderr}`);
    assert.equal(ctx.jobs()[0].state, 'added');
    assert.equal(ctx.counts().externalWrites, 1);
  });
}
