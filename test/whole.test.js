// The whole chat in one request: which messages, how they are written for the model, how its answer is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickWindow, wholeInput, readWhole, parse, prep } from '../public/core.js';
import { buildRequest, validate, keyProblem } from '../lib/ai.js';

const rowsOf = txt => parse(txt).map(m => prep(m, { shop: new Set(), has: f => /^img-/i.test(f) }));
const chat = rowsOf(`[15/11/2026, 10:21:33 AM] المحل: بدايتنا ١٢ الف
[15/11/2026, 10:24:00 AM] أحمد: ابعتلي 5000
[15/11/2026, 10:25:00 AM] المحل: IMG-1.jpg (file attached)
[15/11/2026, 11:00:00 AM] أحمد: حولتلك 2000
[15/11/2026, 12:00:00 PM] أحمد: IMG-2.jpg (file attached)`);

test('the newest messages that fit one request', () => {
  assert.equal(pickWindow(chat), 0);
  assert.equal(pickWindow(chat, { maxImages: 1 }), 3);          // the older picture does not fit
  assert.equal(pickWindow(chat, { maxMsgs: 2 }), 3);
});

test('the model reads every message, which pictures are attached, the group rules and your fixes', () => {
  const t = wholeInput(chat, { chat: 'جروب المريم', sent: new Set([2]), groupRules: ['يضاف ١٪ على كل تحويل'], shopHint: ['المحل'], start: 0, fixes: [{ i: 3, kind: 'received', amount: 2000 }] });
  assert.match(t, /المحادثة: جروب المريم/);
  assert.match(t, /1\. يضاف ١٪ على كل تحويل/);
  assert.match(t, /حدّد البداية: الرسالة #0/);
  assert.match(t, /#3 = استلمنا منه 2000/);
  assert.match(t, /#2 \| .* \| المحل \| \[صورة #2 مرفقة\]/);
  assert.match(t, /#4 \| .* \| أحمد \| \[صورة لم تُرفق\]/);
  assert.match(t, /#0 \| .* \| المحل \| بدايتنا 12 الف/);
});

test('the answer: only real messages and amounts; the total is checked against the operations', () => {
  const v = readWhole({ shop: ['المحل', 'غريب'], start: { i: 0, balance: 12000, why: '«بدايتنا»' }, total: 15000,
    items: [{ i: 2, kind: 'sent', amount: 5000, why: 'إيصال' }, { i: 3, kind: 'received', amount: 2000, why: 'دفع' }, { i: 99, kind: 'sent', amount: 1, why: '' }, { i: 2, kind: 'sent', amount: 5000, why: 'مكرر' }, { i: 4, kind: 'sent', amount: 0, why: '' }], summary: 'بدأتُ من ١٢٬٠٠٠' },
  { rows: chat, senders: ['المحل', 'أحمد'] });
  assert.deepEqual(v.shop, ['المحل']);
  assert.equal(v.items.length, 2);
  assert.equal(v.total, 15000); assert.equal(v.agrees, true);
  assert.equal(readWhole({ start: { i: null, balance: 0 }, items: [{ i: 2, kind: 'sent', amount: 5000 }], total: 9999 }, { rows: chat, senders: [] }).agrees, false);
});

test('the request: strong model, high effort, every picture named by its message', () => {
  const req = buildRequest(validate({ task: 'whole', tier: 'strong', input: 'الرسائل', images: [{ i: 2, data: 'aGk=' }, { i: 4, data: 'aGk=' }] }));
  assert.equal(req.model, 'claude-sonnet-5-5');
  assert.equal(req.output_config.effort, 'high');
  const c = req.messages[0].content;
  assert.deepEqual(c.slice(1).map(b => b.type === 'text' ? b.text : 'IMG'), ['صورة الرسالة #2:', 'IMG', 'صورة الرسالة #4:', 'IMG']);
  assert.throws(() => validate({ task: 'whole', images: [{ i: 'x', data: 'a' }] }), /bad images/);
  assert.throws(() => validate({ task: 'whole', images: Array.from({ length: 101 }, (_, i) => ({ i, data: 'a' })) }), /bad images/);
});

test('a key ID pasted instead of the key says so', () => {
  assert.match(keyProblem('apikey_01A5LcrRQ4kzavngLWLxyqLf'), /رقم تعريف المفتاح/);
});
