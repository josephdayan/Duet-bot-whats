import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import endpoint from '../api/whatsapp.js';
import { computeTwilioSignature } from '../lib/core.js';

test('entrada da Vercel atende GET e encaminha somente POST assinado e autorizado', async (t) => {
  const url = 'https://duet-bot-whats.example/api/whatsapp';
  const env = {
    TWILIO_ACCOUNT_SID: 'AC' + '0'.repeat(32),
    TWILIO_AUTH_TOKEN: 'test-token',
    GMAIL_USER: 'me@example.com',
    GMAIL_APP_PASSWORD: 'test-password',
    ALLOWED_FROM: 'whatsapp:+5511999990000',
    MAIL_TO: '',
    PUBLIC_URL: '',
    REPLY_ACK: '',
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const sent = [];
  t.mock.method(nodemailer, 'createTransport', () => ({ sendMail: async (mail) => sent.push(mail) }));
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'info', () => {});

  const health = await endpoint.fetch(new Request(url));
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'whatsapp-forward ok');

  const params = { AccountSid: env.TWILIO_ACCOUNT_SID, From: env.ALLOWED_FROM, Body: 'teste de encaminhamento', NumMedia: '0', MessageSid: 'SM-test' };
  const post = (fields, signature) => endpoint.fetch(new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature },
    body: new URLSearchParams(fields).toString(),
  }));
  assert.equal((await post(params, 'invalid')).status, 403);
  assert.equal(sent.length, 0);

  const blocked = { ...params, From: 'whatsapp:+5511000000000' };
  assert.equal((await post(blocked, computeTwilioSignature(env.TWILIO_AUTH_TOKEN, url, blocked))).status, 200);
  assert.equal(sent.length, 0);

  const accepted = await post(params, computeTwilioSignature(env.TWILIO_AUTH_TOKEN, url, params));
  assert.equal(accepted.status, 200);
  assert.match(accepted.headers.get('Content-Type'), /xml/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, env.GMAIL_USER);
  assert.equal(sent[0].subject, '[WA fwd] teste de encaminhamento');

  const unsupported = await endpoint.fetch(new Request(url, { method: 'DELETE' }));
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.get('Allow'), 'GET, HEAD, POST');
});
