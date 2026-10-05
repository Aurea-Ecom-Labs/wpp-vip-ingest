import { readFileSync } from 'node:fs';
import { phoneJid } from './admission.mjs';
export function readSource(path, allowedGroups) {
  const rows = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(rows)) throw new Error('Source must be a JSON array');
  // Validate the complete snapshot before submitting any entry.
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        Object.keys(row).some(k => !['phone','group'].includes(k))) throw new Error('Source accepts only phone and group');
    phoneJid(row.phone);
    if (!allowedGroups.includes(row.group) || !/^\d[\d-]*@g\.us$/.test(row.group)) throw new Error('Invalid source group');
  }
  return rows;
}
