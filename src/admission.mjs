import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

export function phoneJid(phone) {
  if (!/^\+[1-9]\d{7,14}$/.test(phone ?? '')) throw new Error('Use a full international number');
  return phone.slice(1) + '@s.whatsapp.net';
}
export const normalizeJid = jid => typeof jid === 'string' ? jid.replace(/:\d+@/, '@') : '';
const ids = p => [p?.id, p?.jid, p?.phoneNumber, p?.lid, p?.content?.attrs?.jid,
  p?.content?.attrs?.phone_number, p?.content?.attrs?.lid].filter(Boolean).map(normalizeJid);
export function hasInvite(node) {
  return node?.tag === 'add_request' || (Array.isArray(node?.content) && node.content.some(hasInvite));
}
export function jobId(group, phone) {
  return createHash('sha256').update(JSON.stringify([group, phone])).digest('hex').slice(0, 24);
}

// Consent belongs to the business. Every source entry is accepted as authorized.
// No consent database, callback, reference, or version exists in this service.
export class Admission {
  constructor({ dbPath = ':memory:', socket, allowedGroups, botIds = [], operators = [], timeoutMs = 30_000 }) {
    this.db = new DatabaseSync(dbPath);
    this.socket = socket; this.allowedGroups = new Set(allowedGroups);
    this.botIds = new Set(botIds.map(normalizeJid)); this.operators = new Set(operators.map(normalizeJid));
    this.timeoutMs = timeoutMs;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, group_id TEXT NOT NULL, phone TEXT NOT NULL,
        state TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
        attempt_count INTEGER NOT NULL DEFAULT 0, review_note TEXT,
        UNIQUE(group_id, phone));
      CREATE TABLE IF NOT EXISTS attempts (
        job_id TEXT, attempt INTEGER, state TEXT, detail TEXT, recorded_at TEXT);
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, job_id TEXT);
      CREATE TABLE IF NOT EXISTS mappings (phone_jid TEXT PRIMARY KEY, lid TEXT UNIQUE);`);
  }
  recoverInterrupted() {
    // Call only after acquiring exclusive worker ownership.
    this.db.exec("UPDATE jobs SET state='uncertain', detail='Process stopped during an attempt; human review required' WHERE state='in_flight'");
  }
  enqueue({ phone, group }) {
    phoneJid(phone);
    if (!this.allowedGroups.has(group) || !/^\d[\d-]*@g\.us$/.test(group)) throw new Error('Group is not allowed');
    const id = jobId(group, phone);
    this.db.prepare("INSERT OR IGNORE INTO jobs(id,group_id,phone,state) VALUES(?,?,?,'queued')").run(id, group, phone);
    return id;
  }
  state(id) { return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id); }
  list() { return this.db.prepare('SELECT * FROM jobs ORDER BY rowid').all(); }
  finish(id, state, detail = '') {
    this.db.prepare('UPDATE jobs SET state=?, detail=? WHERE id=?').run(state, detail, id);
    const job = this.state(id);
    this.db.prepare('INSERT INTO attempts VALUES(?,?,?,?,?)').run(id, job.attempt_count, state, detail, new Date().toISOString());
    return state;
  }
  remember(p) {
    const aliases = ids(p), pn = aliases.find(x => /^\d+@s\.whatsapp\.net$/.test(x)), lid = aliases.find(x => /^\d+@lid$/.test(x));
    if (!pn || !lid) return;
    const byPn = this.db.prepare('SELECT lid FROM mappings WHERE phone_jid=?').get(pn);
    const byLid = this.db.prepare('SELECT phone_jid FROM mappings WHERE lid=?').get(lid);
    if ((byPn && byPn.lid !== lid) || (byLid && byLid.phone_jid !== pn)) throw new Error('Identity mapping conflict');
    this.db.prepare('INSERT OR IGNORE INTO mappings VALUES(?,?)').run(pn, lid);
  }
  aliases(jid) {
    const normalized = normalizeJid(jid), values = new Set([normalized]);
    const row = this.db.prepare('SELECT phone_jid,lid FROM mappings WHERE phone_jid=? OR lid=?').get(normalized, normalized);
    if (row) { values.add(row.phone_jid); values.add(row.lid); }
    return values;
  }
  matches(p, jid) { const known = this.aliases(jid); return ids(p).some(x => known.has(x)); }
  member(meta, jid) { return meta.participants.some(p => this.matches(p, jid)); }
  async call(fn) {
    let timer;
    try { return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Operation timed out')), this.timeoutMs);
    })]); } finally { clearTimeout(timer); }
  }
  async metadata(group) {
    const meta = await this.call(() => this.socket.groupMetadata(group));
    if (!Array.isArray(meta?.participants)) throw new Error('Invalid group metadata');
    for (const p of meta.participants) this.remember(p);
    return meta;
  }
  async command({ group, actor, messageId, text, type = 'notify' }) {
    if (type !== 'notify') return 'ignored';
    const match = /^\/add (\+[1-9]\d{7,14})$/.exec(text ?? '');
    if (!match || !messageId) return 'invalid_command';
    if (!this.allowedGroups.has(group)) return 'not_authorized';
    let meta;
    try { meta = await this.metadata(group); } catch { return 'uncertain'; }
    if (![...this.operators].some(op => this.aliases(op).has(normalizeJid(actor))) ||
      !meta.participants.some(p => this.matches(p, actor) && ['admin','superadmin'].includes(p.admin))) return 'not_authorized';
    const receipt = `${group}:${messageId}`, seen = this.db.prepare('SELECT job_id FROM receipts WHERE id=?').get(receipt);
    if (seen) return this.state(seen.job_id).state;
    const id = this.enqueue({ group, phone: match[1] });
    this.db.prepare('INSERT OR IGNORE INTO receipts VALUES(?,?)').run(receipt, id);
    return id; // Worker performs the write. No customer-group acknowledgement or DM.
  }
  async run(id, { dryRun = false } = {}) {
    const job = this.state(id);
    if (!job) throw new Error('Unknown job');
    if (job.state !== 'queued') return job.state;
    if (!dryRun) {
      const claim = this.db.prepare("UPDATE jobs SET state='in_flight', attempt_count=attempt_count+1 WHERE id=? AND state='queued'").run(id);
      if (!claim.changes) return this.state(id).state;
    }
    const done = (state, detail = '') => dryRun ? state : this.finish(id, state, detail);
    try {
      const pn = phoneJid(job.phone), meta = await this.metadata(job.group_id);
      if (!meta.participants.some(p => [...this.botIds].some(id => this.matches(p, id)) && ['admin','superadmin'].includes(p.admin)))
        return done('bot_not_admin');
      if (this.member(meta, pn)) return done('already_member');
      const found = await this.call(() => this.socket.onWhatsApp(pn));
      if (!Array.isArray(found)) return done('uncertain', 'Invalid number lookup result');
      for (const p of found) this.remember(p);
      const registered = found.filter(p => p.exists && this.matches(p, pn));
      if (registered.length !== 1) return done(found.some(p => p.exists) ? 'uncertain' : 'not_registered');
      const mapping = this.socket.signalRepository?.lidMapping;
      if (typeof mapping?.getLIDForPN === 'function') {
        const lid = await this.call(() => mapping.getLIDForPN(pn));
        if (lid) this.remember({ jid: pn, lid });
      }
      if (dryRun) return 'would_add';
      const results = await this.call(() => this.socket.groupParticipantsUpdate(job.group_id, [pn], 'add'));
      if (!Array.isArray(results)) return done('uncertain', 'Invalid participant response');
      for (const p of results) this.remember(p);
      const matching = results.filter(p => this.matches(p, pn));
      if (matching.length !== 1) return done('uncertain', 'Missing or ambiguous participant result');
      const result = matching[0];
      // Invite evidence takes priority even if the API reports status 200.
      if (hasInvite(result.content)) return done('invite_required', 'Direct addition did not complete; no invitation sent');
      const status = String(result.status ?? 'unknown'), nodeError = result.content?.attrs?.error;
      if (status !== '200' || (nodeError && String(nodeError) !== '200'))
        return done('uncertain', `Participant status ${status}; human review required`);
      const after = await this.metadata(job.group_id);
      return this.member(after, pn) ? done('added') : done('uncertain', 'Response reported success, but membership is not confirmed');
    } catch (error) { return done('uncertain', error?.message === 'Operation timed out' ? 'Operation timed out; human review required' : 'Operation failed; human review required'); }
  }
  // Read-only membership check explicitly requested by a human. Never sends an add.
  async check(id) {
    const job = this.state(id); if (!job) throw new Error('Unknown job');
    try { return this.member(await this.metadata(job.group_id), phoneJid(job.phone)) ? 'present' : 'absent'; }
    catch { return 'uncertain'; }
  }
  async retry(id, reviewNote) {
    if (typeof reviewNote !== 'string' || reviewNote.trim().length < 5) throw new Error('A human review note is required');
    const job = this.state(id); if (!job) throw new Error('Unknown job');
    if (job.state === 'invite_required') throw new Error('Invitation-required jobs cannot be retried');
    if (job.state !== 'uncertain') throw new Error('Only uncertain jobs can be reviewed for retry');
    const membership = await this.check(id);
    if (membership === 'present') return this.finish(id, 'already_member', 'Human review confirmed current membership');
    if (membership !== 'absent') throw new Error('Membership is still uncertain');
    this.db.prepare("UPDATE jobs SET state='queued', review_note=? WHERE id=? AND state='uncertain'").run(reviewNote.trim(), id);
    return 'queued';
  }
  close() { this.db.close(); }
}
