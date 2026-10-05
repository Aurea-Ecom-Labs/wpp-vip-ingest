import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Admission, normalizeJid } from './admission.mjs';
import { readSource } from './source.mjs';
import { connect } from './baileys.mjs';

const [action = 'help', ...args] = process.argv.slice(2);
const dataDir = resolve(process.env.WPP_DATA_DIR ?? 'data');
const allowedGroups = (process.env.WPP_GROUPS ?? '').split(',').filter(Boolean);
const operators = (process.env.WPP_OPERATORS ?? '').split(',').filter(Boolean);
const sourcePath = resolve(process.env.WPP_SOURCE ?? join(dataDir, 'source.json'));
const output = obj => console.log(JSON.stringify(obj));
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const lockPath = join(dataDir, 'worker.lock');
function lock() {
  try { mkdirSync(lockPath); } catch { throw new Error('Session lock exists. Stop the other process; remove a stale lock only after checking it'); }
  return () => rmSync(lockPath, { recursive: true });
}
function local(socket = {}, botIds = []) {
  return new Admission({ dbPath: join(dataDir, 'jobs.db'), socket, allowedGroups, botIds, operators });
}
async function main() {
  if (action === 'help') {
    console.log('Commands: demo | pair | worker | ingest [source.json] | status | groups | check JOB | retry JOB "human review note"'); return;
  }
  if (action === 'demo') {
    const group = '123456789@g.us', phone = '+5511999999999', pn = '5511999999999@s.whatsapp.net';
    const participants = [{ id: '100@lid', admin: 'admin' }];
    const socket = { groupMetadata: async () => ({ participants }), onWhatsApp: async () => [{ jid: pn, exists: true }],
      groupParticipantsUpdate: async () => { participants.push({ id: '200@lid', phoneNumber: pn });
        return [{ jid: '200@lid', status: '200', content: { tag: 'participant', attrs: { phone_number: pn } } }]; } };
    const service = new Admission({ socket, allowedGroups: [group], botIds: ['100@lid'] });
    try { const id = service.enqueue({ phone, group }); output({ id, state: await service.run(id), simulated: true }); }
    finally { service.close(); } return;
  }
  if (['ingest','status'].includes(action)) {
    const service = local();
    try {
      if (action === 'ingest') for (const row of readSource(args[0] ?? sourcePath, allowedGroups)) output({ id: service.enqueue(row) });
      else for (const job of service.list()) output(job);
    } finally { service.close(); } return;
  }
  if (!['pair','worker','groups','check','retry'].includes(action)) throw new Error('Unknown command');
  const release = lock(); let session, service, stopped = false, disconnected = false, timer, wake;
  const stop = async () => { stopped = true; clearTimeout(timer); wake?.(); await session?.close(); };
  process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
  try {
    session = await connect({ authDir: join(dataDir, 'auth'), pair: action === 'pair',
      onDisconnect: ({ reason, loggedOut }) => { disconnected = true; console.error(reason); process.exitCode = loggedOut ? 0 : 1; void stop(); } });
    if (action === 'pair') { console.log('Paired. Start the worker separately.'); return; }
    if (action === 'groups') { for (const meta of Object.values(await session.socket.groupFetchAllParticipating())) output({ group: meta.id, subject: meta.subject }); return; }
    service = local(session.socket, [session.socket.user?.id, session.socket.user?.lid].filter(Boolean));
    if (action === 'check') { output({ id: args[0], membership: await service.check(args[0]) }); return; }
    if (action === 'retry') { output({ id: args[0], state: await service.retry(args[0], args.slice(1).join(' ')) }); return; }
    if (!allowedGroups.length) throw new Error('Set WPP_GROUPS');
    service.recoverInterrupted();
    const commandTasks = new Set();
    session.socket.ev.on('messages.upsert', upsert => {
      if (stopped || upsert.type !== 'notify') return;
      for (const msg of upsert.messages ?? []) {
        const text = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? '';
        if (!text.startsWith('/add ')) continue;
        const timestamp = Number(msg.messageTimestamp);
        if (!Number.isFinite(timestamp) || Date.now() / 1000 - timestamp > 300 || timestamp > Date.now() / 1000 + 60) continue;
        const actor = msg.key?.fromMe ? session.socket.user?.lid ?? session.socket.user?.id : msg.key?.participant;
        const task = service.command({ group: msg.key?.remoteJid, actor: normalizeJid(actor), messageId: msg.key?.id, text })
          .then(result => output({ command: 'add', result })).catch(() => output({ command: 'add', result: 'uncertain' }));
        commandTasks.add(task); task.finally(() => commandTasks.delete(task));
      }
    });
    while (!stopped) {
      if (existsSync(sourcePath)) {
        try { for (const row of readSource(sourcePath, allowedGroups)) service.enqueue(row); }
        catch { console.error('Source validation failed. No rows imported from this snapshot.'); }
      }
      for (const job of service.list().filter(j => j.state === 'queued').slice(0, 10)) {
        if (stopped || disconnected) break;
        output({ id: job.id, state: await service.run(job.id) });
      }
      if (!stopped) await new Promise(resolveWait => { wake = resolveWait; timer = setTimeout(resolveWait, 10_000); });
      wake = undefined;
    }
    await Promise.allSettled(commandTasks);
  } finally { await stop(); service?.close(); release(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
