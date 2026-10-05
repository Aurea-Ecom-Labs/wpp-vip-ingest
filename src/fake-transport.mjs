import { existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, closeSync } from 'node:fs';
import { watch } from 'node:fs';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';

function waitForFile(path) {
  if (existsSync(path)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    let watcher;
    const finish = error => {
      watcher?.close();
      if (error) reject(error);
      else resolve();
    };
    try {
      watcher = watch(directory, (_event, name) => {
        if (name && join(directory, name.toString()) === path && existsSync(path)) finish();
      });
      if (existsSync(path)) finish();
    } catch (error) {
      finish(error);
    }
  });
}

function saveCounts(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'w', 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8'); }
  finally { closeSync(fd); }
  renameSync(temporary, path);
}

export async function connectFake({ authDir, pair = false, onDisconnect = () => {} } = {}) {
  const dataDir = dirname(authDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const countsPath = join(dataDir, 'fake-transport.json');
  const counts = existsSync(countsPath)
    ? JSON.parse(readFileSync(countsPath, 'utf8')) : { externalWrites: 0, connections: 0 };
  counts.connections = (counts.connections ?? 0) + 1;
  saveCounts(countsPath, counts);
  const mode = process.env.WPP_FAKE_MODE ?? 'success';
  const participants = [
    { id: '100@lid', phoneNumber: '5511888888888@s.whatsapp.net', admin: 'admin' },
    { id: '300@lid', phoneNumber: '5511777777777@s.whatsapp.net', admin: 'admin' },
  ];
  const lidFor = jid => `${[...jid].reduce((hash, character) =>
    (hash * 31 + character.charCodeAt(0)) % 1_000_000_000_000_000, 7)}@lid`;
  const socket = {
    user: { id: '100@lid', lid: '100@lid' },
    ev: new EventEmitter(),
    async groupMetadata() { return { participants }; },
    async onWhatsApp(jid) { return [{ jid, exists: true, lid: lidFor(jid) }]; },
    async groupParticipantsUpdate(_group, [jid]) {
      counts.externalWrites++;
      saveCounts(countsPath, counts);
      if (mode === 'barrier') {
        mkdirSync(join(dataDir, 'faults'), { recursive: true, mode: 0o700 });
        writeFileSync(join(dataDir, 'faults', 'add-started'), 'started\n', { mode: 0o600 });
        await waitForFile(join(dataDir, 'faults', 'release-add'));
      }
      if (mode === 'error') throw new Error('Synthetic transport failure');
      if (mode === 'timeout') return new Promise(() => {});
      const invite = mode === 'invite403' || mode === 'invite200';
      const lid = lidFor(jid);
      if (!invite) participants.push({ id: lid, phoneNumber: jid });
      return [{
        jid: lid,
        status: mode === 'invite403' ? '403' : '200',
        content: {
          tag: 'participant',
          attrs: { phone_number: jid },
          ...(invite ? { content: [{ tag: 'add_request', attrs: { code: 'synthetic-only' } }] } : {}),
        },
      }];
    },
  };
  if (mode === 'logout' && !pair) onDisconnect({ reason: 'Synthetic logout', loggedOut: true });
  return { socket, async close() { socket.ev.removeAllListeners(); }, paired: pair };
}
