// The page: give it the chat (zip / txt / pictures + copied messages) and it does everything by itself, in ONE request
// to the strong model with the text and the pictures (like a Claude chat): who is the shop, the start, the calculation.
// Then you talk to it («صحّح أو اسأل») and it fixes the calculation; the messages below can be fixed by hand.
// Logic lives in core.js; the prompts and rules live on the server (lib/ai.js).
import {
  esc, fmt, num, KIND, IMG, MEDIA, parse, prep, totals, exampleLine, trainingText,
  roleFromHistory, recordRoles, seedStats, decideRoles, transactions, equation, reconcile, expressionHtml,
  chatInput, cleanActions, pickWindow, wholeInput, readWhole,
} from './core.js';

const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mime = f => ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', gif: 'image/gif' })[f.split('.').pop().toLowerCase()] || 'application/octet-stream';
const show = (el, on = true) => $(el).classList.toggle('hide', !on);

/* ===== state ===== */
const DEF = { shop: [], shopStats: {}, runs: 0, keywords: [], rules: [], groups: {}, learned: '', segs: [], selfChecked: 0 };
const KEEP = 39;                    // newest corrections sent as they are; older ones are merged into one summary
let settings = structuredClone(DEF), examples = [], key = '';
let msgs = [], media = new Map(), shop = new Set(), senders = [], openIdx = -1, rows = [], busy = false, chatName = '', spent = 0;
let cp = null, startIdx = -1, opening = 0;  // the start; where the analysis starts (before it when checking a statement); the signed opening
// what you told it (kept when it reads the chat again): your start, your opening, your fixes per message
let pinnedStart = null, pinnedOpening = null, fixes = new Map(), talk = [];
const PICS = 'صور';                         // sender name of pasted / picked pictures (counted as the shop)
const has = f => media.has(f);

/* ===== server ===== */
const lsGet = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
class Unauthorized extends Error {}
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', 'x-app-key': key, ...(opts.headers || {}) } });
  if (res.status === 401) throw new Unauthorized();
  let v; try { v = JSON.parse(await res.text()); } catch { throw new Error('رد غير مفهوم من الخادم'); }
  if (!res.ok || v.error) { const e = new Error(v.error || 'خطأ ' + res.status); e.code = v.code || res.status; throw e; }
  return v;
}
/** Ask the AI to do one task. tier: fast (default) or strong. Retries once (longer after rate limits). */
async function ai(task, input, { image = null, images = null, tier = 'fast', training = trainingText(settings, examples) } = {}) {
  for (let t = 0; ; t++) {
    try {
      const v = await api('/api/analyze', { method: 'POST', body: JSON.stringify({ task, tier, training, input, image, ...(images ? { images } : {}) }) });
      spent += v.cost || 0;
      return v.data;
    } catch (e) {
      if (e instanceof Unauthorized) { showLogin('تغيّرت كلمة المرور، سجّل الدخول مجددًا.'); throw e; }
      if (t > 0 || [400, 402, 413, 422].includes(e.code)) throw e;          // trying again would not help
      await sleep(e.code === 429 || e.code === 529 ? 8000 : 1500);
    }
  }
}

/* ===== training storage (online, with a copy on this device) ===== */
let saving = Promise.resolve();
function persist(kind) {
  const body = kind === 'settings' ? settings : { list: examples };
  lsSet('wd_' + kind, body);
  saving = saving.then(() => api('/api/store?k=' + kind, { method: 'PUT', body: JSON.stringify(body) }))
    .then(() => { $('#store').textContent = 'محفوظ أونلاين.'; })
    .catch(() => { $('#store').textContent = 'محفوظ على هذا الجهاز فقط حتى يعود الاتصال.'; });
}
async function loadStore() {
  const [a, b] = await Promise.all([api('/api/store?k=settings'), api('/api/store?k=examples')]);
  const st = a.value || lsGet('wd_settings'), ex = (b.value || lsGet('wd_examples') || {}).list;
  if (st) settings = { ...DEF, ...st, keywords: st.keywords?.length ? [...st.keywords] : DEF.keywords };
  if (Array.isArray(ex)) examples = [...ex];
  $('#store').textContent = 'محفوظ أونلاين.';
  renderRules();
  setTimeout(mergeOld, 0);
}
function showLogin(msg) { show('#login'); $('#pwErr').textContent = msg || ''; show('#pwErr', !!msg); setTimeout(() => $('#pw').focus(), 50); }
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault(); key = $('#pw').value; show('#pwErr', false);
  try { await loadStore(); lsSet('wd_key', key); $('#pw').value = ''; show('#login', false); }
  catch (x) { $('#pwErr').textContent = x instanceof Unauthorized ? 'كلمة المرور خاطئة.' : 'الخادم غير متاح. تأكد من الاتصال بالإنترنت.'; show('#pwErr'); }
});
$('#logout').addEventListener('click', () => { try { localStorage.removeItem('wd_key'); } catch { /* ignore */ } key = ''; showLogin(); });

/* ===== 1. the file ===== */
$('#file').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  show('#err', false); media = new Map();
  $('#fileLabel').textContent = 'جارٍ فتح ' + f.name + ' …';
  try {
    let txt;
    if (/\.zip$/i.test(f.name) || /zip/.test(f.type)) {
      if (!window.JSZip) throw new Error('لم تُحمَّل مكتبة فك الضغط. حاول مرة أخرى.');
      const zip = await window.JSZip.loadAsync(f);
      const ents = Object.values(zip.files).filter(z => !z.dir && !z.name.includes('__MACOSX'));
      const chat = ents.find(z => /(^|\/)_chat\.txt$/i.test(z.name)) || ents.find(z => /\.txt$/i.test(z.name));
      if (!chat) throw new Error('لا يوجد ملف محادثة (.txt) داخل الملف.');
      txt = await chat.async('string');
      for (const z of ents) { const b = z.name.split('/').pop(); if (MEDIA.test(b)) media.set(b.toLowerCase(), z); }
    } else txt = await f.text();
    msgs = parse(txt);
    if (!msgs.length) throw new Error('هذا ليس ملف تصدير من واتساب.');
    chatName = f.name.replace(/\.(zip|txt)$/i, '').replace(/^WhatsApp Chat( with| -)?\s*/i, '');
    $('#fileLabel').textContent = `${f.name} · ${msgs.length} رسالة · ${[...media.keys()].filter(k => IMG.test(k)).length} صورة`;
    start();
  } catch (x) { $('#err').textContent = x.message || 'تعذّرت قراءة الملف.'; show('#err'); $('#fileLabel').textContent = 'ملف المحادثة (.zip)'; }
});

/* ===== 1b. or: pictures + copied messages (paste, pick, drop, or forward to the phone and pick) ===== */
let inbox = [];                              // picture files in chat order
const picExt = f => ({ 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' })[f.type] || 'jpg';
function addPics(files) {
  const imgs = [...files].filter(f => /^image\//.test(f.type));
  if (!imgs.length) return;
  inbox.push(...imgs);
  $('#thumbs').innerHTML = inbox.map(f => `<img src="${URL.createObjectURL(f)}" alt="">`).join('');
  $('#picsLabel').textContent = `${inbox.length} صورة`;
  refreshPicsButtons();
}
function refreshPicsButtons() { const any = inbox.length || $('#pasteText').value.trim(); show('#usePics', !!any); show('#clearPics', !!any); }
// picked files: oldest first (screenshot time, then name: IMG_8517 before IMG_8518)
$('#pics').addEventListener('change', e => { addPics([...e.target.files].sort((a, b) => a.lastModified - b.lastModified || a.name.localeCompare(b.name, undefined, { numeric: true }))); e.target.value = ''; });
document.addEventListener('paste', e => { const f = [...(e.clipboardData?.files || [])]; if (f.length) { e.preventDefault(); addPics(f); } });
const drop = $('#picsDrop');
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag'); });
drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('drag'); addPics(e.dataTransfer.files); });
$('#pasteText').addEventListener('input', refreshPicsButtons);
$('#clearPics').addEventListener('click', () => { inbox = []; $('#thumbs').innerHTML = ''; $('#pasteText').value = ''; $('#picsLabel').textContent = 'صور'; refreshPicsButtons(); });
/** Copied messages first (they carry names and times), then the pictures in the order added. */
$('#usePics').addEventListener('click', () => {
  show('#err', false);
  const txt = $('#pasteText').value.trim();
  let list = txt ? parse(txt) : [];
  if (txt && !list.length) list = txt.split(/\n+/).map(t => t.trim()).filter(Boolean).map(t => ({ sender: 'رسالة منسوخة', ts: '', text: t }));
  media = new Map();
  inbox.forEach((f, k) => { const name = `pic-${k + 1}.${picExt(f)}`; media.set(name, { async: () => Promise.resolve(f) }); list.push({ sender: PICS, ts: 'صورة ' + (k + 1), text: name + ' (file attached)' }); });
  msgs = list.map((m, i) => ({ ...m, i }));
  if (!msgs.length) return;
  chatName = 'صور ورسائل';
  $('#fileLabel').textContent = `${msgs.length} رسالة (${inbox.length} صورة)`;
  start();
});


$('#again').addEventListener('click', () => $('#step1').classList.remove('loaded'));

/* ===== everything by itself: the whole chat in ONE request, read like a Claude chat reads it ===== */
let allRows = [], from = 0;
const MAX_IMAGES = 80, IMG_BUDGET = 4_400_000;           // what one request carries (the server accepts up to 4.6 MB of pictures)
/** A new chat: forget what was said about the previous one, then read it. */
function start() {
  $('#step1').classList.add('loaded');
  pinnedStart = null; pinnedOpening = null; fixes = new Map(); talk = [];
  $('#log').innerHTML = '';
  const cnt = new Map();
  for (const m of msgs) if (m.sender && !m.sys) cnt.set(m.sender, (cnt.get(m.sender) || 0) + 1);
  senders = [...cnt].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  analyze();
}
/** The pictures of the window as small JPEGs, newest first until the budget is used (each named by its message). */
async function packImages(list) {
  const out = []; let size = 0;
  for (const r of [...list].reverse()) {
    if (!r.img || out.length >= MAX_IMAGES) continue;
    try {
      await loadBlob(r);
      const data = await toB64(await shrink(r.blob, 1100, 0.7));
      if (size + data.length > IMG_BUDGET) break;
      size += data.length; out.push({ i: r.i, data });
    } catch { /* a picture that cannot be read is sent as «[صورة لم تُرفق]» */ }
  }
  return out.reverse();
}
const groupRules = () => settings.groups?.[chatName] || [];
/** Read the chat and calculate: one request to the strong model with the text, the pictures and what you told it. */
async function analyze() {
  if (busy) return;
  busy = true; spent = 0; lockTalk(); show('#retry', false);
  show('#sum'); show('#talk'); show('#step3'); show('#barBox'); $('#prog').style.width = '10%';
  try {
    allRows = msgs.map(m => prep(m, { shop, has }));
    from = pickWindow(allRows, { maxImages: MAX_IMAGES });
    const list = allRows.slice(from);
    $('#progText').textContent = `أجهّز ${list.filter(r => !r.sys).length} رسالة…`;
    const images = await packImages(list);
    $('#prog').style.width = '35%';
    $('#progText').textContent = 'أقرأ المحادثة وأحسب…';
    settings.shopStats = seedStats(settings.shopStats, settings.shop);
    const known = senders.filter(n => roleFromHistory(settings.shopStats, n) === 'shop' || shop.has(n));
    const input = wholeInput(list, {
      chat: chatName, sent: new Set(images.map(x => x.i)), groupRules: groupRules(), shopHint: known,
      start: pinnedStart, opening: pinnedOpening, fixes: [...fixes].map(([i, f]) => ({ i, ...f })),
    });
    const tick = setInterval(() => { const w = parseFloat($('#prog').style.width) || 35; $('#prog').style.width = Math.min(92, w + 2) + '%'; }, 1500);
    let v;
    try { v = readWhole(await ai('whole', input, { tier: 'strong', images }), { rows: allRows, senders }); }
    finally { clearInterval(tick); }
    // who is the shop: the model's reading (pictures pasted by you always count as the shop)
    shop = new Set([...v.shop, ...(senders.includes(PICS) ? [PICS] : [])]);
    if (!shop.size) shop = decideRoles(senders, settings.shopStats, null, { always: [PICS] }).shop;
    settings.shopStats = recordRoles(settings.shopStats, senders.filter(n => n !== PICS), shop);
    settings.shop = Object.keys(settings.shopStats).filter(n => roleFromHistory(settings.shopStats, n) === 'shop');
    settings.runs = (settings.runs || 0) + 1; persist('settings');
    // the result on the messages: what counts, and why
    const by = new Map(v.items.map(x => [x.i, x]));
    for (const r of allRows) {
      r.side = shop.has(r.sender) ? 'shop' : 'client';
      if (r.sys) continue;
      const x = by.get(r.i);
      r.state = 'done'; r.conf = 1; r.flag = false; delete r.start; delete r.partOf;
      if (x) { r.kind = x.kind; r.amount = x.amount; r.why = x.why; } else { r.kind = 'ignore'; if (!r.why) r.why = ''; }
      r.ai = { kind: r.kind, amount: r.amount };
    }
    openIdx = v.start.i ?? from - 1; startIdx = openIdx; opening = v.start.balance; cp = null;
    if (v.start.i != null) { const s0 = allRows[v.start.i]; s0.start = true; s0.kind = 'ignore'; s0.why = v.start.why; }
    reapplyFixes();
    if (pinnedOpening != null) opening = pinnedOpening;
    rows = allRows.slice(from);
    $('#progText').textContent = `قرأتُ ${list.filter(r => !r.sys).length} رسالة و${images.length} صورة · ≈ $${spent.toFixed(3)}`;
    if (v.summary) say(v.summary);
    if (!v.agrees) say(`⚠️ كتبتُ المجموع ${fmt(v.said)} لكن جمع العمليات ${fmt(v.total)}؛ المعروض هو جمع العمليات.`);
  } catch (e) {
    if (!(e instanceof Unauthorized)) { say(e.message || 'تعذّر الاتصال.'); show('#retry'); }
    $('#progText').textContent = '';
  } finally {
    busy = false; show('#barBox', false); unlockTalk(); render();
  }
}
$('#retry').addEventListener('click', () => analyze());

async function shrink(blob, max = 1600, q = 0.85) {   // a smaller JPEG: smaller upload, fewer image tokens, same reading
  try {
    const url = URL.createObjectURL(blob);
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
    return await new Promise(r => c.toBlob(b => r(b || blob), 'image/jpeg', q));
  } catch { return blob; }
}
const toB64 = blob => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = rej; fr.readAsDataURL(blob); });
async function loadBlob(r) {
  if (!r.blob) { const b = await media.get(r.file.toLowerCase()).async('blob'); r.blob = new Blob([b], { type: mime(r.file) }); r.url = URL.createObjectURL(r.blob); }
}

/* ===== merging old corrections into one summary ===== */
let merging = false;
async function mergeOld() {
  const act = examples.filter(e => !e.merged);
  if (merging || act.length <= KEEP) return;
  merging = true; $('#exN').textContent = 'جارٍ دمج التصحيحات القديمة…';
  const old = act.slice(0, act.length - KEEP);
  try {
    const v = await ai('merge', `الخلاصة الحالية:\n${settings.learned || '(فارغة)'}\n\nتصحيحات جديدة:\n${old.map(exampleLine).join('\n')}`, { tier: 'strong', training: '' });
    const sum = String(v?.summary || '').trim();
    if (sum) { settings.learned = sum; old.forEach(e => { e.merged = true; }); persist('settings'); persist('examples'); }
  } catch { /* next time */ }
  merging = false; renderRules();
}


/* ===== your fixes (by talking, or by hand in the list) ===== */
/** Message i is really kind/amount: changed here, remembered for this chat, and taught for the next ones. */
function applyFix(i, kind, amount, note = '') {
  const r = allRows[i]; if (!r || r.sys) return;
  const before = { kind: r.ai?.kind, amount: r.ai?.amount };
  r.kind = kind; r.amount = kind === 'ignore' ? r.amount : num(amount); r.ok = true; r.flag = false; r.fixed = true; r.state = 'done'; r.why = note;
  fixes.set(i, { kind: r.kind, amount: r.amount, why: note });
  const k = chatName + '|' + msgs[i].ts + '|' + i;
  examples = examples.filter(e => e.key !== k);
  examples.push({ key: k, at: Date.now(), side: r.side, content: r.img ? 'صورة: ' + (r.summary || 'إيصال') + (r.text ? ' | تعليق: ' + r.text.slice(0, 120) : '') : (r.text || '').slice(0, 200), ai: before, fix: { kind: r.kind, amount: r.amount }, note });
  persist('examples'); renderRules(); mergeOld();
}
function reapplyFixes() {
  for (const [i, f] of fixes) { const r = allRows[i]; if (r) Object.assign(r, f, { ok: true, flag: false, fixed: true, state: 'done' }); }
}

/* ===== talking to it ===== */
function say(text, me = false) {
  talk.push({ me, text });
  $('#log').insertAdjacentHTML('beforeend', `<div class="say ${me ? 'me' : 'ai'}">${esc(text)}</div>`);
  show('#talk');
}
function lockTalk() { $('#askBtn').disabled = true; }
function unlockTalk() { $('#askBtn').disabled = false; }
$('#ask').addEventListener('submit', async e => {
  e.preventDefault();
  const said = $('#askIn').value.trim(); if (!said || busy) return;
  $('#askIn').value = ''; say(said, true); lockTalk();
  $('#log').insertAdjacentHTML('beforeend', '<div class="say ai wait" id="thinking">…</div>');
  let v;
  try {
    const c = totals(rows, opening, openIdx), fc = finalCalc();
    v = await ai('chat', chatInput({
      rows: allRows, shopNames: senders.filter(n => shop.has(n)), clientNames: senders.filter(n => !shop.has(n)),
      start: openIdx >= 0 && allRows[openIdx]?.start ? { i: openIdx, ts: msgs[openIdx]?.ts } : null, opening,
      calc: `${fc.eq.text.replace(/\n/g, ' ')} (${c.debt >= 0 ? 'على العميل' : 'للعميل'})`,
      closings: [], history: talk.slice(0, -1), said,
    }), { tier: 'strong' });
  } catch (x) { $('#thinking')?.remove(); say(x.message || 'تعذّر الاتصال.'); unlockTalk(); return; }
  $('#thinking')?.remove();
  const acts = cleanActions(v?.actions, { rows: allRows, senders });
  let again = false, newStart = null;
  for (const a of acts) {
    if (a.type === 'remember') {
      const t = String(a.text).trim();
      if (a.scope === 'group') { settings.groups = { ...(settings.groups || {}), [chatName]: [...groupRules(), t] }; again = true; }   // applied now: read again with it
      else settings.rules.push(t);
      persist('settings'); renderRules();
    }
    if (a.type === 'side') { if (a.side === 'shop') shop.add(a.sender); else shop.delete(a.sender); again = true; }
    if (a.type === 'fix') applyFix(a.i, a.kind, a.amount, said);
    if (a.type === 'start') { newStart = a.i; pinnedOpening = null; }
    if (a.type === 'opening') pinnedOpening = num(a.amount);
  }
  if (newStart != null) pinnedStart = newStart;
  say(String(v?.reply || (acts.length ? 'تم.' : 'لم أفهم، وضّح أكثر.')));
  if (again || newStart != null) await analyze();
  else { if (pinnedOpening != null) opening = pinnedOpening; unlockTalk(); render(); }
});

/* ===== results ===== */
/** The final calculation (as the shop writes it) and, for a statement, how it matches the chat. */
function finalCalc() {
  const after = transactions(rows, { after: openIdx });
  if (!cp?.terms) return { eq: equation(opening, after) };
  const rec = reconcile({ terms: cp.terms, total: cp.stated }, transactions(rows, { before: openIdx }), { midway: startIdx < 0 });
  return { rec, eq: after.length ? equation(opening, after) : rec.eq };
}
/** Only what matters: ✓ when the statement matches, otherwise what is wrong. */
function renderCheck(rec) {
  const n = v => '⁦' + (v < 0 ? '−' : '') + fmt(Math.abs(v)) + '⁩';   // isolated left-to-right number
  if (!rec) return '';
  const miss = rec.items.filter(x => x.status === 'missing'), out = [];
  if (rec.matches && !miss.length && !rec.extra.length && rec.arithmeticOk) out.push('✓ الكشف مطابق للمحادثة');
  if (miss.length) out.push(`⚠️ في الكشف وليست في المحادثة: ${miss.map(x => n(x.amount)).join('، ')}`);
  if (rec.extra.length) out.push(`⚠️ في المحادثة وليست في الكشف: ${rec.extra.map(x => n(x.amount)).join('، ')}`);
  if (!rec.arithmeticOk) out.push('⚠️ جمع الكشف نفسه خاطئ');
  if (!rec.matches) out.push(`⚠️ حسابي ${n(rec.eq.total)} والكشف ${n(rec.stated)}`);
  if (rec.before.length) out.push(`قبل بداية المحادثة: ${rec.before.map(n).join('، ')}`);
  return out.join('\n');
}
let showAll = false;
function render() {
  const c = totals(rows, opening, openIdx), fc = finalCalc();
  $('#eq').innerHTML = expressionHtml(fc.eq.terms, fc.eq.total); $('#eqTotal').textContent = fmt(fc.eq.total);
  $('#check').textContent = renderCheck(fc.rec); show('#check', !!fc.rec);
  const tag = new Map();
  if (fc.rec) { for (const it of fc.rec.items) for (const i of it.found || []) tag.set(i, '✓ في الكشف'); for (const x of fc.rec.extra) tag.set(x.i, '⚠️ ليست في الكشف'); }
  for (const r of rows) r.tag = tag.get(r.i) || (r.partOf != null ? `ضمن #${r.partOf}` : '');
  $('#debt').textContent = fmt(Math.abs(c.debt)) + ' ج.م';
  $('#debtLabel').textContent = c.debt >= 0 ? 'على العميل' : 'للعميل عندنا';
  const names = s => s.join('، ') || '—', st = cp ?? (openIdx >= 0 ? { i: openIdx } : null);
  $('#facts').textContent = `المحل: ${names(senders.filter(n => shop.has(n)))} · البداية: ${st && msgs[st.i] ? msgs[st.i].ts : 'أول المحادثة'}`;
  const vis = rows.filter(r => !r.sys && !r.start && (showAll || (r.kind !== 'ignore' && r.partOf == null) || r.fixed || r.state !== 'done'));
  $('#list').innerHTML = vis.length ? vis.map(card).join('') : '<p class="note">لا توجد معاملات.</p>';
}
/** What it understood, in one line: «+5,000 أرسلنا له» / «−8,000 استلمنا منه» / «ليست من الحساب». */
const understood = r => {
  if (r.state === 'pending') return '…';
  if (r.state === 'error') return r.why;
  if (r.start) return 'بداية الحساب';
  if (r.partOf != null) return `ضمن #${r.partOf}`;
  if (r.kind === 'ignore' || !(r.amount > 0)) return 'ليست من الحساب';
  return { n: (r.kind === 'sent' ? '+' : '−') + fmt(r.amount), t: KIND[r.kind] };
};
// the sign stays in front of its number inside Arabic text
const gotHtml = g => (typeof g === 'string' ? esc(g) : `<bdi dir="ltr">${g.n}</bdi> ${esc(g.t)}`);
let editing = null;                                  // the message opened for a fix (tap it)
function card(r) {
  const open = editing === r.i && r.state !== 'pending';
  const seg = ['sent', 'received', 'ignore'].map(k => `<button data-k="${k}" aria-pressed="${r.kind === k}">${KIND[k]}</button>`).join('');
  const cls = r.state === 'error' ? 'flag' : r.kind === 'sent' ? 'is-sent' : r.kind === 'received' ? 'is-rec' : '';
  return `<article class="row ${cls}${open ? ' open' : ''}" data-i="${r.i}" data-act="edit">
<header><span class="who ${r.side}">${r.side === 'shop' ? 'المحل' : 'العميل'} · ${esc(r.sender)}</span><time>#${r.i} · ${esc(r.ts)}</time></header>
${r.url ? `<button class="thumb" data-act="zoom" aria-label="كبّر"><img src="${r.url}" alt="صورة"></button>` : r.img ? '<p class="note">صورة…</p>' : ''}
${r.text ? `<p class="msg">${esc(r.text)}</p>` : ''}
<div class="got"><b>${gotHtml(understood(r))}</b>${r.fixed ? ' <em>· صحّحتَه</em>' : ''}${r.tag ? ` <em>· ${esc(r.tag)}</em>` : ''}</div>
${open ? `<div class="ai">${esc(r.why)}</div><div class="ctl"><div class="seg">${seg}</div><input class="amt" inputmode="decimal" value="${r.amount ?? ''}" placeholder="المبلغ" aria-label="المبلغ"></div>` : ''}
${r.state === 'error' ? '<div class="acts"><button class="ghost" data-act="retry">أعِد</button></div>' : ''}
</article>`;
}
const rowOf = el => { const a = el.closest('[data-i]'); return a && rows.find(r => r.i === Number(a.dataset.i)); };
$('#list').addEventListener('click', async e => {
  const r = rowOf(e.target); if (!r) return;
  const k = e.target.closest('[data-k]');
  if (k) { if (r.kind !== k.dataset.k) applyFix(r.i, k.dataset.k, r.amount); render(); return; }
  if (e.target.closest('.ctl')) return;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'zoom') { $('#zoom img').src = r.url; $('#zoom').style.display = 'flex'; return; }
  if (act === 'edit') { editing = editing === r.i ? null : r.i; render(); }
});
$('#list').addEventListener('change', e => {
  if (!e.target.classList.contains('amt')) return; const r = rowOf(e.target); if (!r) return;
  const v = num(e.target.value); if (v !== r.amount) applyFix(r.i, r.kind === 'ignore' && v > 0 ? (r.side === 'shop' ? 'sent' : 'received') : r.kind, v); render();
});
$('#allBtn').addEventListener('click', () => { showAll = !showAll; $('#allBtn').setAttribute('aria-pressed', showAll); render(); });
$('#zoom').addEventListener('click', () => { $('#zoom').style.display = 'none'; });
$('#copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(finalCalc().eq.text); $('#copy').textContent = 'تم النسخ ✓'; } catch { $('#copy').textContent = 'النسخ غير متاح'; }
  setTimeout(() => { $('#copy').textContent = 'انسخ الحساب'; }, 2000);
});

/* ===== what it learned (rules you told it, your fixes, lessons it found itself) ===== */
function renderRules() {
  const g = groupRules().map((x, k) => `<li><span>${esc(x)} <small class="note">(${esc(chatName)})</small></span><button class="ghost" data-gdel="${k}" aria-label="احذف">حذف</button></li>`);
  $('#rules').innerHTML = g.join('') + settings.rules.map((x, k) => `<li><span>${esc(x)}</span><button class="ghost" data-del="${k}" aria-label="احذف">حذف</button></li>`).join('');
  $('#exN').textContent = [examples.length ? `${examples.length} تصحيحًا` : '', settings.selfChecked ? `راجعتُ ${settings.selfChecked} فترة بنفسي` : ''].filter(Boolean).join(' · ');
  $('#learned').value = settings.learned; show('#learned', !!settings.learned);
}
$('#rules').addEventListener('click', e => {
  const g = e.target.closest('[data-gdel]');
  if (g) { const l = groupRules().filter((_, k) => k !== Number(g.dataset.gdel)); settings.groups = { ...(settings.groups || {}), [chatName]: l }; persist('settings'); renderRules(); return; }
  const b = e.target.closest('[data-del]'); if (!b) return; settings.rules.splice(Number(b.dataset.del), 1); persist('settings'); renderRules();
});
$('#learned').addEventListener('change', () => { settings.learned = $('#learned').value.trim(); persist('settings'); renderRules(); });

/* ===== start ===== */
renderRules();
key = lsGet('wd_key') || '';
if (!key) showLogin();
else loadStore().catch(e => { if (e instanceof Unauthorized) showLogin('تغيّرت كلمة المرور، سجّل الدخول مجددًا.'); else $('#store').textContent = 'الخادم غير متاح الآن.'; });
