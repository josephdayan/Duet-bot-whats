import { test } from 'node:test';
import assert from 'node:assert/strict';
import twilio from 'twilio';
import {
  computeTwilioSignature,
  isValidTwilioSignature,
  parseForm,
  parseInbound,
  buildSubject,
  buildEmail,
  downloadMedia,
  handleWebhook,
  isAllowedSender,
  parseAllowList,
  publicUrl,
  isTwilioMediaUrl,
} from '../lib/core.js';

const TOKEN = 'test_auth_token_123';
const SID = 'AC' + '0'.repeat(32);
const URL_ = 'https://whatsapp-forward.vercel.app/api/whatsapp';
const ENV = {
  TWILIO_ACCOUNT_SID: SID,
  TWILIO_AUTH_TOKEN: TOKEN,
  GMAIL_USER: 'me@example.com',
  GMAIL_APP_PASSWORD: 'x',
  ALLOWED_FROM: 'whatsapp:+5511999990000',
};
const silent = { info() {}, warn() {}, error() {} };

function formBody(params) {
  return new URLSearchParams(params).toString();
}

test('assinatura bate com a biblioteca oficial do Twilio', () => {
  const params = { Body: 'olá, tudo bem? & = +', From: 'whatsapp:+5511999990000', NumMedia: '0', MessageSid: 'SM1' };
  const ours = computeTwilioSignature(TOKEN, URL_, params);
  assert.equal(twilio.validateRequest(TOKEN, ours, URL_, params), true);
  assert.equal(isValidTwilioSignature(TOKEN, URL_, params, ours), true);
  assert.equal(isValidTwilioSignature(TOKEN, URL_, { ...params, Body: 'x' }, ours), false);
  assert.equal(isValidTwilioSignature(TOKEN, URL_, params, ''), false);
  assert.equal(isValidTwilioSignature('outro', URL_, params, ours), false);
});

test('parseInbound lê texto, mídia e flag de encaminhada', () => {
  const p = parseForm(
    formBody({
      MessageSid: 'MM1',
      From: 'whatsapp:+5511999990000',
      ProfileName: 'Joseph',
      Body: '',
      NumMedia: '2',
      MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC/Messages/MM1/Media/ME0',
      MediaContentType0: 'image/jpeg',
      MediaUrl1: 'https://api.twilio.com/2010-04-01/Accounts/AC/Messages/MM1/Media/ME1',
      MediaContentType1: 'application/pdf',
      Forwarded: 'true',
    }),
  );
  const m = parseInbound(p);
  assert.equal(m.media.length, 2);
  assert.equal(m.forwarded, true);
  assert.equal(buildSubject(m), '[WA fwd] imagem + documento (encaminhada)');
});

test('assunto usa prévia do texto e corta textos longos', () => {
  const m = parseInbound({ Body: 'a'.repeat(200), NumMedia: '0' });
  const s = buildSubject(m);
  assert.ok(s.startsWith('[WA fwd] aaa'));
  assert.ok(s.length < 90);
  assert.equal(buildSubject(parseInbound({ Body: 'Oi\n\nMarcelo', NumMedia: '0' })), '[WA fwd] Oi Marcelo');
  assert.equal(buildSubject(parseInbound({ NumMedia: '1', MediaUrl0: 'https://api.twilio.com/x', MediaContentType0: 'audio/ogg' })), '[WA fwd] áudio');
});

test('lista de remetentes autorizados aceita formatos variados', () => {
  const allow = parseAllowList('whatsapp:+55 11 99999-0000, +5521888880000');
  assert.equal(isAllowedSender('whatsapp:+5511999990000', allow), true);
  assert.equal(isAllowedSender('whatsapp:+5521888880000', allow), true);
  assert.equal(isAllowedSender('whatsapp:+5511000000000', allow), false);
  assert.equal(isAllowedSender('whatsapp:+5511999990000', []), false);
});

test('só baixa mídia de hosts do Twilio', () => {
  assert.equal(isTwilioMediaUrl('https://api.twilio.com/2010-04-01/x'), true);
  assert.equal(isTwilioMediaUrl('https://evil.com/api.twilio.com'), false);
  assert.equal(isTwilioMediaUrl('http://api.twilio.com/x'), false);
  assert.equal(isTwilioMediaUrl('https://api.twilio.com.evil.com/x'), false);
});

test('downloadMedia usa Basic Auth, nomeia arquivos e pula o que é grande demais', async () => {
  const seen = [];
  const fakeFetch = async (url, opts) => {
    seen.push(opts.headers.Authorization);
    const size = url.endsWith('ME1') ? 30 : 10;
    return new Response(Buffer.alloc(size, 1), { status: 200 });
  };
  const media = [
    { index: 0, url: 'https://api.twilio.com/a/ME0', contentType: 'audio/ogg' },
    { index: 1, url: 'https://api.twilio.com/a/ME1', contentType: 'application/pdf' },
    { index: 2, url: 'https://example.com/ME2', contentType: 'image/png' },
  ];
  const { attachments, skipped } = await downloadMedia(media, { accountSid: SID, authToken: TOKEN, fetchImpl: fakeFetch, maxTotalBytes: 20 });
  assert.equal(seen[0], 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64'));
  assert.deepEqual(attachments.map((a) => a.filename), ['1-audio.ogg']);
  assert.equal(skipped.length, 2);
  assert.match(skipped[0].reason, /grande demais/);
  assert.match(skipped[1].reason, /fora do Twilio/);
});

test('downloadMedia registra falha sem derrubar o resto', async () => {
  const fakeFetch = async () => new Response('nope', { status: 404 });
  const { attachments, skipped } = await downloadMedia(
    [{ index: 0, url: 'https://api.twilio.com/a', contentType: 'image/jpeg' }],
    { accountSid: SID, authToken: TOKEN, fetchImpl: fakeFetch },
  );
  assert.equal(attachments.length, 0);
  assert.match(skipped[0].reason, /404/);
});

test('corpo do e-mail traz horário de São Paulo, remetente e anexos', () => {
  const msg = parseInbound({ Body: 'Segue a PI', From: 'whatsapp:+5511999990000', ProfileName: 'Joseph', NumMedia: '0', Forwarded: 'true', MessageSid: 'SM9' });
  const mail = buildEmail(msg, {
    attachments: [{ filename: '1-documento.pdf' }],
    skipped: [{ name: '2-video.mp4', reason: 'grande demais' }],
    receivedAt: new Date('2026-11-25T21:00:00Z'),
    from: 'x <me@example.com>',
    to: 'me@example.com',
  });
  assert.match(mail.text, /^Segue a PI/);
  assert.match(mail.text, /25\/11\/2026,? 18:00/);
  assert.match(mail.text, /Joseph \(\+5511999990000\)/);
  assert.match(mail.text, /autor original/);
  assert.match(mail.text, /Anexos: 1-documento\.pdf/);
  assert.match(mail.text, /Não anexado: 2-video\.mp4/);
});

test('localização vira link do Google Maps', () => {
  const msg = parseInbound({ NumMedia: '0', Latitude: '-23.56', Longitude: '-46.65', Label: 'FGV' });
  assert.equal(buildSubject(msg), '[WA fwd] localização');
  assert.match(buildEmail(msg, {}).text, /FGV — https:\/\/maps\.google\.com\/\?q=-23\.56,-46\.65/);
});

async function call(params, { env = ENV, signature, url = URL_ } = {}) {
  const sent = [];
  const rawBody = formBody(params);
  const sig = signature ?? computeTwilioSignature(env.TWILIO_AUTH_TOKEN || 'x', url, parseForm(rawBody));
  const res = await handleWebhook({
    url,
    rawBody,
    signature: sig,
    env,
    sendMail: async (m) => sent.push(m),
    fetchImpl: async () => new Response(Buffer.from('img'), { status: 200 }),
    now: () => new Date('2026-11-25T21:00:00Z'),
    log: silent,
  });
  return { res, sent };
}

test('webhook completo: texto + imagem viram um e-mail com anexo', async () => {
  const { res, sent } = await call({
    AccountSid: SID,
    MessageSid: 'MM1',
    From: 'whatsapp:+5511999990000',
    To: 'whatsapp:+14155238886',
    ProfileName: 'Joseph',
    Body: 'olha isso',
    NumMedia: '1',
    MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC/Messages/MM1/Media/ME0',
    MediaContentType0: 'image/jpeg',
  });
  assert.equal(res.status, 200);
  assert.equal(res.contentType, 'text/xml');
  assert.doesNotMatch(res.body, /<Message>/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'me@example.com');
  assert.equal(sent[0].subject, '[WA fwd] olha isso');
  assert.equal(sent[0].attachments[0].filename, '1-imagem.jpg');
});

test('webhook rejeita assinatura inválida e não manda e-mail', async () => {
  const { res, sent } = await call({ From: 'whatsapp:+5511999990000', Body: 'x', NumMedia: '0' }, { signature: 'forjada' });
  assert.equal(res.status, 403);
  assert.equal(sent.length, 0);
});

test('webhook ignora remetente não autorizado', async () => {
  const { res, sent } = await call({ From: 'whatsapp:+5511000000000', Body: 'spam', NumMedia: '0' });
  assert.equal(res.status, 200);
  assert.equal(sent.length, 0);
});

test('webhook rejeita outra conta Twilio', async () => {
  const { res, sent } = await call({ AccountSid: 'AC' + '1'.repeat(32), From: 'whatsapp:+5511999990000', Body: 'x', NumMedia: '0' });
  assert.equal(res.status, 403);
  assert.equal(sent.length, 0);
});

test('webhook devolve 500 se faltar configuração', async () => {
  const { res } = await call({ Body: 'x' }, { env: { TWILIO_AUTH_TOKEN: TOKEN } });
  assert.equal(res.status, 500);
});

test('REPLY_ACK=1 responde com ✓', async () => {
  const { res } = await call({ From: 'whatsapp:+5511999990000', Body: 'x', NumMedia: '0' }, { env: { ...ENV, REPLY_ACK: '1' } });
  assert.match(res.body, /<Message>✓ no e-mail<\/Message>/);
});

test('publicUrl usa cabeçalhos do proxy e respeita PUBLIC_URL', () => {
  const h = new Headers({ host: 'internal', 'x-forwarded-host': 'wa.vercel.app', 'x-forwarded-proto': 'https' });
  assert.equal(publicUrl('http://internal/api/whatsapp?a=1', h), 'https://wa.vercel.app/api/whatsapp?a=1');
  assert.equal(publicUrl('http://internal/api/whatsapp', h, 'https://x.y/api/whatsapp'), 'https://x.y/api/whatsapp');
});
