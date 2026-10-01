// The feedback Worker: what it accepts, what it refuses, and the email it sends.
//   node --test test/feedback.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { validate, buildEmail } from '../feedback/worker.js';

const SITE = 'https://drabzin.alirezaafshan.com';
const post = (body, { origin = SITE, ip = '1.2.3.4', type = 'application/json' } = {}) => new Request(`${SITE}/api/feedback`, {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { origin, 'content-type': type, 'cf-connecting-ip': ip, 'cf-ipcountry': 'IR' },
});
const env = () => {
  const sent = [];
  return { sent, TO: 'owner@example.com', FROM: 'drabzin@example.com', EMAIL: { send: async (m) => { sent.push(m); return { messageId: 'x' }; } } };
};

test('validate: a normal message passes, with unknown fields cleaned up', () => {
  const v = validate({ kind: 'idea', message: '  Tabs please  ', ease: 'easy', email: 'john@example.com', lang: 'fa', website: '' });
  assert.ok(v.ok);
  assert.deepEqual({ ...v.data, context: undefined }, { kind: 'idea', ease: 'easy', lang: 'fa', message: 'Tabs please', email: 'john@example.com', context: undefined, bot: false });
  const odd = validate({ kind: 'hack', message: 'hello', ease: 'x', lang: 'xx' });
  assert.equal(odd.data.kind, 'other'); assert.equal(odd.data.ease, ''); assert.equal(odd.data.lang, 'en');
});

test('validate: refuses empty or huge messages, bad emails and huge context', () => {
  assert.equal(validate({ message: 'hi' }).ok, false);
  assert.equal(validate({ message: 'x'.repeat(5001) }).ok, false);
  assert.equal(validate({ message: 'hello', email: 'not an email' }).ok, false);
  assert.equal(validate({ message: 'hello', email: 'a@b.c\r\nBcc: x@y.z' }).ok, false);
  assert.equal(validate({ message: 'hello', context: { big: 'x'.repeat(13000) } }).ok, false);
  assert.equal(validate(null).ok, false);
});

test('buildEmail: subject says what it is; body has the answers and the settings', () => {
  const v = validate({ kind: 'problem', message: 'The horse comes out empty\nsecond line', ease: 'hard', lang: 'fa', context: { settings: { level: 0.5 } } });
  const m = buildEmail(v.data, { country: 'IR', when: new Date('2026-10-01T12:00:00Z') });
  assert.equal(m.subject, '[Drabzin] Something does not work: The horse comes out empty…');
  assert.match(m.text, /How easy the app is: hard/);
  assert.match(m.text, /Reply to: no email given/);
  assert.match(m.text, /Page language: Persian/);
  assert.match(m.text, /"level": 0.5/);
  assert.match(m.text, /2026-10-01T12:00:00.000Z \(country: IR\)/);
});

test('worker: sends one email to TO, from FROM, replying to the visitor', async () => {
  const e = env();
  const r = await worker.fetch(post({ kind: 'question', message: 'Can it read PDF?', email: 'john@example.com', lang: 'en' }, { ip: '9.9.9.1' }), e);
  assert.equal(r.status, 200);
  assert.equal(e.sent.length, 1);
  assert.equal(e.sent[0].to, 'owner@example.com');
  assert.deepEqual(e.sent[0].from, { email: 'drabzin@example.com', name: 'Drabzin feedback' });
  assert.equal(e.sent[0].replyTo, 'john@example.com');
  assert.match(e.sent[0].subject, /^\[Drabzin\] A question: Can it read PDF\?/);
});

test('worker: other sites, other methods and non-JSON are refused; the honeypot is dropped quietly', async () => {
  const e = env();
  assert.equal((await worker.fetch(post({ message: 'hello' }, { origin: 'https://evil.example' }), e)).status, 403);
  assert.equal((await worker.fetch(new Request(`${SITE}/api/feedback`), e)).status, 405);
  assert.equal((await worker.fetch(post('message=hello', { type: 'application/x-www-form-urlencoded' }), e)).status, 415);
  assert.equal((await worker.fetch(post('{nope', {}), e)).status, 400);
  const bot = await worker.fetch(post({ message: 'buy now', website: 'http://spam' }, { ip: '9.9.9.2' }), e);
  assert.equal(bot.status, 200);
  assert.equal(e.sent.length, 0);
});

test('worker: a few messages per visitor, then 429', async () => {
  const e = env();
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await worker.fetch(post({ message: `message ${i}` }, { ip: '9.9.9.3' }), e)).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
  assert.equal(e.sent.length, 5);
});

test('worker: a failed send is reported, not hidden', async () => {
  const e = env();
  e.EMAIL.send = async () => { throw new Error('destination not verified'); };
  const r = await worker.fetch(post({ message: 'hello there' }, { ip: '9.9.9.4' }), e);
  assert.equal(r.status, 502);
});
