#!/usr/bin/env node
// Слияние базы со старого сервера в базу нового. Ничего не удаляет на новом сервере.
//   node merge-old.js <старый db.json> <новый db.json> [папка файлов старого] [папка файлов нового]          — только отчёт
//   node merge-old.js <старый db.json> <новый db.json> [папка файлов старого] [папка файлов нового] --apply  — слить
// Перед --apply остановите новый сервер (systemctl stop ahazang) — иначе он перезапишет базу своей копией.
'use strict';
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2).filter((a) => a !== '--apply');
const APPLY = process.argv.includes('--apply');
const [oldFile, newFile, oldFiles, newFiles] = args;
if (!oldFile || !newFile) { console.log('Использование: node merge-old.js старый/db.json новый/db.json [старые/files] [новые/files] [--apply]'); process.exit(1); }
const O = JSON.parse(fs.readFileSync(oldFile, 'utf8')), N = JSON.parse(fs.readFileSync(newFile, 'utf8'));
for (const db of [O, N]) { db.users ||= {}; db.tokens ||= {}; db.msgs ||= {}; db.reads ||= {}; db.files ||= {}; db.reports ||= []; }

const fmt = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) : '—');
const lastTs = (list) => (list && list.length ? Math.max(...list.map((m) => m.ts || 0)) : 0);
const rep = { newUsers: [], conflicts: [], keyDiff: [], chats: [], msgs: 0, files: 0, filesMissing: 0, tokens: 0 };
const numTaken = new Set(Object.values(N.users).map((u) => u.num).filter(Boolean));
const union = (a, b) => [...new Set([...(a || []), ...(b || [])])];

// ---------- пользователи ----------
for (const [k, ou] of Object.entries(O.users)) {
  const nu = N.users[k];
  if (!nu) {
    const u = JSON.parse(JSON.stringify(ou));
    if (u.num && numTaken.has(u.num)) { rep.conflicts.push(`${ou.login}: номер ${u.num} на новом занят — получит новый номер`); delete u.num; }
    if (u.num) numTaken.add(u.num);
    rep.newUsers.push(`${ou.login} (создан ${fmt(ou.created)})`);
    N.users[k] = u;
    continue;
  }
  if (ou.hash !== nu.hash) rep.conflicts.push(`${ou.login}: пароль на старом и новом разный — оставляем пароль нового`);
  if (ou.pub && nu.pub && ou.pub !== nu.pub) rep.keyDiff.push(ou.login);
  if (ou.pub && !nu.pub) { nu.pub = ou.pub; nu.wrapped = ou.wrapped; nu.salt = ou.salt; nu.iv = ou.iv; }
  for (const f of ['contacts', 'requests', 'sent', 'blocked', 'subs', 'voip']) if (Array.isArray(ou[f]) || Array.isArray(nu[f])) nu[f] = union(nu[f], ou[f]);
  if (ou.book) nu.book = { ...ou.book, ...(nu.book || {}) };
}

// ---------- сообщения ----------
for (const [pk, olist] of Object.entries(O.msgs)) {
  const nlist = N.msgs[pk] || [], ids = new Set(nlist.map((m) => m.id));
  const add = olist.filter((m) => !ids.has(m.id));
  if (!add.length) continue;
  rep.msgs += add.length;
  rep.chats.push(`${pk.replace('|', ' ↔ ')}: +${add.length} сообщ. (последнее на старом ${fmt(lastTs(olist))}, на новом ${fmt(lastTs(nlist))})`);
  N.msgs[pk] = nlist.concat(add).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  if (O.reads[pk] && !N.reads[pk]) N.reads[pk] = O.reads[pk];
}

// ---------- файлы ----------
for (const [id, meta] of Object.entries(O.files)) {
  if (N.files[id]) continue;
  const src = oldFiles && path.join(oldFiles, id);
  if (!src || !fs.existsSync(src)) { rep.filesMissing++; continue; }
  rep.files++;
  if (APPLY && newFiles) { fs.mkdirSync(newFiles, { recursive: true }); fs.copyFileSync(src, path.join(newFiles, id)); }
  N.files[id] = meta;
}

// ---------- входы (чтобы после обновления приложения не вводить пароль заново) ----------
for (const [t, k] of Object.entries(O.tokens)) if (!N.tokens[t] && N.users[k]) { N.tokens[t] = k; rep.tokens++; }
const rids = new Set(N.reports.map((r) => JSON.stringify(r)));
for (const r of O.reports) if (!rids.has(JSON.stringify(r))) N.reports.push(r);

// ---------- отчёт ----------
console.log(`Старый: ${Object.keys(O.users).length} польз., ${Object.values(O.msgs).reduce((n, l) => n + l.length, 0)} сообщ., последнее ${fmt(Math.max(0, ...Object.values(O.msgs).map(lastTs)))}`);
console.log(`Новый:  ${Object.keys(JSON.parse(fs.readFileSync(newFile, 'utf8')).users || {}).length} польз.`);
console.log(`\nЕсть только на старом — пользователи (${rep.newUsers.length}):`); rep.newUsers.forEach((s) => console.log('  + ' + s));
console.log(`\nПереписки, где на старом есть сообщения, которых нет на новом (${rep.chats.length}, всего ${rep.msgs}):`); rep.chats.forEach((s) => console.log('  + ' + s));
console.log(`\nФайлы: перенесём ${rep.files}${rep.filesMissing ? `, не найдено на диске ${rep.filesMissing}` : ''}; входов: ${rep.tokens}`);
if (rep.conflicts.length) { console.log('\nОсобые случаи:'); rep.conflicts.forEach((s) => console.log('  ! ' + s)); }
if (rep.keyDiff.length) console.log(`\n! У ${rep.keyDiff.join(', ')} ключи шифрования на старом и новом разные: сообщения со старого в переписках с ними могут не расшифроваться.`);

if (APPLY) {
  fs.copyFileSync(newFile, newFile + '.before-merge-' + Date.now());
  fs.writeFileSync(newFile, JSON.stringify(N));
  console.log('\nГОТОВО: база нового сервера обновлена (копия прежней — рядом, *.before-merge-*). Запустите сервер: systemctl start ahazang');
} else console.log('\nЭто только отчёт. Чтобы слить — добавьте --apply (сервер перед этим остановите).');
