import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Admission, phoneJid } from '../src/admission.mjs';
import { readSource } from '../src/source.mjs';

const group = '123456789@g.us', phone = '+5511999999999', pn = phoneJid(phone), lid = '200@lid';
function fixture(t, mode = 'ok', options = {}) {
  let adds = 0, reads = 0;
  const participants = [{ id: '100@lid', phoneNumber: '5511888888888@s.whatsapp.net', admin: 'admin' },
    { id: '300@lid', phoneNumber: '5511777777777@s.whatsapp.net', admin: 'admin' }];
  const socket = {
    async groupMetadata() { reads++; if (mode === 'metadata_error') throw new Error('500'); return { participants }; },
    async onWhatsApp() { if (mode === 'lookup_error') throw new Error('500'); return [{ jid: pn, exists: mode !== 'not_registered', lid }]; },
    async groupParticipantsUpdate() {
      adds++;
      if (mode === 'throw') throw new Error('500');
      if (mode === 'timeout') { participants.push({ id: lid, phoneNumber: pn }); return new Promise(() => {}); }
      if (mode === 'empty') return [];
      if (mode === 'unmatched') return [{ jid: '999@lid', status: '200' }];
      const node = { tag: 'participant', attrs: { jid: lid, phone_number: pn } };
      if (mode.startsWith('invite')) node.content = [{ tag: 'add_request', attrs: { code: 'SECRET', expiration: '100' } }];
      if (!['invite403','invite200','403','500','delayed','conflicting_error'].includes(mode)) participants.push({ id: lid, phoneNumber: pn });
      if (mode === 'conflicting_error') node.attrs.error = '500';
      return [{ jid: lid, status: ['403','500','invite403'].includes(mode) ? mode === '500' ? '500' : '403' : '200', content: node }];
    }
  };
  const service = new Admission({ socket, allowedGroups: [group], botIds: ['5511888888888@s.whatsapp.net'],
    operators: ['5511777777777@s.whatsapp.net'], timeoutMs: 15, ...options });
  t.after(() => service.close());
  const id = service.enqueue({ phone, group });
  return { service, id, socket, participants, adds: () => adds, reads: () => reads };
}
test('source accepts only number and group without consent metadata', t => {
  const dir = mkdtempSync(join(tmpdir(),'wpp-source-')); t.after(() => rmSync(dir,{recursive:true}));
  const path = join(dir,'source.json'); writeFileSync(path, JSON.stringify([{ phone, group }]));
  assert.deepEqual(readSource(path,[group]), [{phone,group}]);
  writeFileSync(path, JSON.stringify([{ phone, group, consentVersion: 'v1' }]));
  assert.throws(() => readSource(path,[group]), /only phone and group/);
});
test('invalid source fails before any submission', t => {
  const dir = mkdtempSync(join(tmpdir(),'wpp-source-')); t.after(() => rmSync(dir,{recursive:true}));
  const path = join(dir,'source.json'); writeFileSync(path, JSON.stringify([{ phone, group },{ phone: 'bad', group }]));
  assert.throws(() => readSource(path,[group]));
});
test('reject incomplete numbers, letters and wrong groups', t => {
  assert.throws(() => phoneJid('11999999999')); assert.throws(() => phoneJid('+55abc11999999999'));
  const f = fixture(t); assert.throws(() => f.service.enqueue({ phone, group:'999@g.us' }));
});
test('authorized source reaches confirmed addition', async t => {
  const f = fixture(t); assert.equal(await f.service.run(f.id), 'added'); assert.equal(f.adds(),1);
});
test('duplicate source never re-adds', async t => {
  const f = fixture(t); assert.equal(f.service.enqueue({phone,group}),f.id);
  await f.service.run(f.id); assert.equal(await f.service.run(f.id),'added'); assert.equal(f.adds(),1);
});
test('concurrent attempts claim one write', async t => {
  const f = fixture(t); await Promise.all([f.service.run(f.id),f.service.run(f.id)]); assert.equal(f.adds(),1);
});
test('LID membership uses phone mapping without guessing digits', async t => {
  const f = fixture(t); f.service.remember({jid:pn,lid}); f.participants.push({id:lid});
  assert.equal(await f.service.run(f.id),'already_member'); assert.equal(f.adds(),0);
  assert.equal(f.service.matches({id:'5511999999999@lid'},pn),false);
});
test('conflicting identity mappings stop', t => {
  const f = fixture(t); f.service.remember({jid:pn,lid}); assert.throws(() => f.service.remember({jid:pn,lid:'999@lid'}),/conflict/);
});
test('socket PN/LID mapping matches a LID-only participant result', async t => {
  const f = fixture(t,'unmatched');
  f.socket.signalRepository = {lidMapping:{getLIDForPN: async value => value === pn ? lid : null}};
  f.socket.groupParticipantsUpdate = async () => {
    f.participants.push({id:lid}); return [{jid:lid,status:'200'}];
  };
  assert.equal(await f.service.run(f.id),'added');
});
test('bot admin loss blocks the write', async t => {
  const f = fixture(t); f.participants[0].admin = null; assert.equal(await f.service.run(f.id),'bot_not_admin'); assert.equal(f.adds(),0);
});
test('not registered result does not write', async t => {
  const f = fixture(t,'not_registered'); assert.equal(await f.service.run(f.id),'not_registered'); assert.equal(f.adds(),0);
});
test('dry run leaves queued state and never writes', async t => {
  const f = fixture(t); assert.equal(await f.service.run(f.id,{dryRun:true}),'would_add'); assert.equal(f.service.state(f.id).state,'queued'); assert.equal(f.adds(),0);
});
for (const mode of ['throw','timeout','empty','unmatched','403','500','delayed','conflicting_error','metadata_error','lookup_error']) {
  test(`${mode} remains uncertain without automatic retry`, async t => {
    const f = fixture(t,mode); assert.equal(await f.service.run(f.id),'uncertain'); const reads = f.reads(), adds = f.adds();
    assert.equal(await f.service.run(f.id),'uncertain'); assert.equal(f.reads(),reads); assert.equal(f.adds(),adds);
  });
}
for (const mode of ['invite403','invite200']) {
  test(`${mode} returns invite_required and stops`, async t => {
    const f = fixture(t,mode); assert.equal(await f.service.run(f.id),'invite_required');
    assert.equal(await f.service.run(f.id),'invite_required'); assert.equal(f.adds(),1);
    assert.equal(JSON.stringify(f.service.state(f.id)).includes('SECRET'),false);
    await assert.rejects(f.service.retry(f.id,'Checked by an operator'),/cannot be retried/);
  });
}
test('command accepts PN operator mapped to LID; duplicate message stays stopped', async t => {
  const f = fixture(t); const cmd = {group,actor:'300@lid',messageId:'m1',text:'/add '+phone};
  assert.equal(await f.service.command(cmd),f.id); await f.service.run(f.id);
  assert.equal(await f.service.command(cmd),'added'); assert.equal(f.adds(),1);
});
test('unauthorized and history commands do not write', async t => {
  const f = fixture(t); const cmd = {group,actor:'999@lid',messageId:'m1',text:'/add '+phone};
  assert.equal(await f.service.command(cmd),'not_authorized'); assert.equal(await f.service.command({...cmd,type:'append'}),'ignored'); assert.equal(f.adds(),0);
});
test('human retry requires note and an absent membership check', async t => {
  const f = fixture(t,'throw'); await f.service.run(f.id);
  await assert.rejects(f.service.retry(f.id,''),/review note/);
  assert.equal(await f.service.retry(f.id,'Checked on both clients; member absent'),'queued'); assert.equal(f.adds(),1);
});
test('human check after timeout detects membership without resend', async t => {
  const f = fixture(t,'timeout'); await f.service.run(f.id); assert.equal(await f.service.check(f.id),'present');
  assert.equal(await f.service.retry(f.id,'Checked on the phone; member present'),'already_member'); assert.equal(f.adds(),1);
});
test('human retry refuses an uncertain membership check', async t => {
  const f = fixture(t,'throw'); await f.service.run(f.id); f.socket.groupMetadata = async () => { throw new Error('500'); };
  await assert.rejects(f.service.retry(f.id,'Checked on the phone'),/still uncertain/); assert.equal(f.adds(),1);
});
test('restart preserves uncertain jobs and recovers interrupted claims', async t => {
  const dir = mkdtempSync(join(tmpdir(),'wpp-restart-')); t.after(() => rmSync(dir,{recursive:true}));
  const dbPath = join(dir,'jobs.db'); const f = fixture(t,'throw',{dbPath}); await f.service.run(f.id);
  const other = new Admission({dbPath,socket:f.socket,allowedGroups:[group]}); t.after(() => other.close());
  assert.equal(await other.run(f.id),'uncertain');
  other.db.prepare("UPDATE jobs SET state='in_flight' WHERE id=?").run(f.id); other.recoverInterrupted();
  assert.equal(other.state(f.id).state,'uncertain'); assert.equal(f.adds(),1);
});
test('CLI demo smoke run uses simulated transport', () => {
  const result = JSON.parse(execFileSync(process.execPath,['src/cli.mjs','demo'],{cwd:new URL('..',import.meta.url),encoding:'utf8'}));
  assert.equal(result.state,'added'); assert.equal(result.simulated,true);
});
