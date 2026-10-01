// Cloudflare Worker "drabzin-feedback" on the route drabzin.alirezaafshan.com/api/feedback:
// turns the page's feedback form into an email to the app's maker.
//
// Bindings (set at upload, not in this file):
//   EMAIL  send_email, restricted to the one verified Email Routing destination
//   TO     that same address (plain text): the only recipient this Worker ever sends to
//   FROM   the sender, an address on alirezaafshan.com (Email Routing is on for that domain)
// Sending to a verified destination needs no API key and costs nothing. Deploying: see README.md
// ("Feedback email").
//
// Guards: same-site Origin only, JSON only, size limits, a honeypot field (bots fill it; we say
// "sent" and drop it), and a per-visitor limit of a few messages per 10 minutes.

const SITE = 'https://drabzin.alirezaafshan.com';
const KINDS = { problem: 'Something does not work', idea: 'An idea or a wish', question: 'A question', other: 'Something else' };
const EASE = { '': 'no answer', easy: 'easy', ok: 'OK', hard: 'hard' };
const LANGS = { en: 'English', fa: 'Persian', ar: 'Arabic', ur: 'Urdu', hi: 'Hindi' };
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const LIMIT = 5, WINDOW_MS = 10 * 60 * 1000;
const seen = new Map();   // visitor -> recent send times (this isolate only: a speed bump, not a wall)

// Checks the form; returns { ok: true, data } or { ok: false, status, error }.
export function validate(body) {
  if (!body || typeof body !== 'object') return { ok: false, status: 400, error: 'bad request' };
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (message.length < 3 || message.length > 5000) return { ok: false, status: 400, error: 'message length' };
  if (email && (email.length > 200 || !EMAIL_RE.test(email))) return { ok: false, status: 400, error: 'email' };
  const context = body.context && typeof body.context === 'object' ? body.context : null;
  if (context && JSON.stringify(context).length > 12000) return { ok: false, status: 400, error: 'context too big' };
  return {
    ok: true,
    data: {
      kind: KINDS[body.kind] ? body.kind : 'other',
      ease: EASE[body.ease] != null ? body.ease : '',
      lang: LANGS[body.lang] ? body.lang : 'en',
      message, email, context,
      bot: typeof body.website === 'string' && body.website.trim() !== '',
    },
  };
}

// The email: a subject that says what it is, then the answers, then the app's details.
export function buildEmail(d, { country = '', when = new Date() } = {}) {
  const firstLine = d.message.split('\n')[0].slice(0, 60);
  const subject = `[Drabzin] ${KINDS[d.kind]}: ${firstLine}${d.message.length > firstLine.length ? '…' : ''}`;
  const lines = [
    `What it is about: ${KINDS[d.kind]}`,
    `How easy the app is: ${EASE[d.ease]}`,
    `Reply to: ${d.email || 'no email given'}`,
    `Page language: ${LANGS[d.lang]}${d.lang !== 'en' ? ' (the message may be in that language)' : ''}`,
    '',
    'Message:',
    d.message,
    '',
  ];
  if (d.context) lines.push('Settings and result (sent by the app; no picture):', JSON.stringify(d.context, null, 2), '');
  lines.push(`Sent from ${SITE} on ${when.toISOString()}${country ? ` (country: ${country})` : ''}.`);
  return { subject, text: lines.join('\n') };
}

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return json(405, { ok: false, error: 'POST only' });
    if (request.headers.get('origin') !== SITE) return json(403, { ok: false, error: 'wrong site' });
    if (!(request.headers.get('content-type') || '').includes('application/json')) return json(415, { ok: false, error: 'JSON only' });
    const raw = await request.text();
    if (raw.length > 20000) return json(413, { ok: false, error: 'too big' });
    let body;
    try { body = JSON.parse(raw); } catch { return json(400, { ok: false, error: 'bad JSON' }); }
    const v = validate(body);
    if (!v.ok) return json(v.status, { ok: false, error: v.error });
    if (v.data.bot) return json(200, { ok: true });

    const who = request.headers.get('cf-connecting-ip') || 'unknown', now = Date.now();
    const recent = (seen.get(who) || []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= LIMIT) return json(429, { ok: false, error: 'too many' });
    recent.push(now);
    seen.set(who, recent);
    if (seen.size > 5000) seen.clear();

    const { subject, text } = buildEmail(v.data, { country: request.headers.get('cf-ipcountry') || '' });
    try {
      await env.EMAIL.send({
        to: env.TO,
        from: { email: env.FROM, name: 'Drabzin feedback' },
        ...(v.data.email ? { replyTo: v.data.email } : {}),
        subject, text,
      });
    } catch (err) {
      console.error('send failed:', err?.message || err);
      return json(502, { ok: false, error: 'could not send' });
    }
    return json(200, { ok: true });
  },
};
