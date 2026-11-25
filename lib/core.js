// Lógica pura do bot: validação da assinatura do Twilio, leitura da mensagem,
// download das mídias e montagem do e-mail. Sem dependências externas, para testar fácil.
import crypto from 'node:crypto';

export const SUBJECT_PREFIX = '[WA fwd]';
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024; // Gmail aceita 25 MB; deixamos folga para o base64

/**
 * Valida o cabeçalho X-Twilio-Signature (HMAC-SHA1 da URL + parâmetros POST ordenados).
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function computeTwilioSignature(authToken, url, params) {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => {
      const value = params[key];
      const values = Array.isArray(value) ? [...value].sort() : [value];
      return acc + values.map((v) => key + v).join('');
    }, url);
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

export function isValidTwilioSignature(authToken, url, params, signature) {
  if (!authToken || !signature) return false;
  const expected = Buffer.from(computeTwilioSignature(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** Converte o corpo x-www-form-urlencoded do Twilio num objeto simples. */
export function parseForm(text) {
  const params = {};
  for (const [k, v] of new URLSearchParams(text)) {
    if (k in params) params[k] = [].concat(params[k], v);
    else params[k] = v;
  }
  return params;
}

export function parseAllowList(raw) {
  return (raw || '')
    .split(',')
    .map((s) => normalizeNumber(s))
    .filter(Boolean);
}

export function normalizeNumber(s) {
  const digits = String(s || '').replace(/[^\d]/g, '');
  return digits ? `+${digits}` : '';
}

export function isAllowedSender(from, allowList) {
  return allowList.length > 0 && allowList.includes(normalizeNumber(from));
}

const EXT_BY_TYPE = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/vcard': 'vcf',
  'text/x-vcard': 'vcf',
};

export function kindOf(contentType) {
  const t = (contentType || '').split(';')[0].trim().toLowerCase();
  if (t.startsWith('image/')) return 'imagem';
  if (t.startsWith('audio/')) return 'áudio';
  if (t.startsWith('video/')) return 'vídeo';
  if (t.includes('vcard')) return 'contato';
  return 'documento';
}

export function extensionFor(contentType) {
  const t = (contentType || '').split(';')[0].trim().toLowerCase();
  return EXT_BY_TYPE[t] || t.split('/')[1]?.replace(/[^a-z0-9]/g, '') || 'bin';
}

/** Lê os campos que interessam do webhook de entrada do WhatsApp. */
export function parseInbound(params) {
  const num = Math.max(0, Math.min(10, parseInt(params.NumMedia || '0', 10) || 0));
  const media = [];
  for (let i = 0; i < num; i++) {
    const url = params[`MediaUrl${i}`];
    if (url) media.push({ index: i, url, contentType: params[`MediaContentType${i}`] || 'application/octet-stream' });
  }
  return {
    messageSid: params.MessageSid || params.SmsMessageSid || '',
    from: params.From || '',
    to: params.To || '',
    profileName: params.ProfileName || '',
    waId: params.WaId || '',
    body: (params.Body || '').trim(),
    forwarded: params.Forwarded === 'true',
    frequentlyForwarded: params.FrequentlyForwarded === 'true',
    latitude: params.Latitude || '',
    longitude: params.Longitude || '',
    address: params.Address || '',
    locationLabel: params.Label || '',
    repliedTo: params.OriginalRepliedMessageSid || '',
    media,
  };
}

/** Só aceita URLs de mídia do próprio Twilio, para nunca mandar as credenciais para outro host. */
export function isTwilioMediaUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'api.twilio.com' || u.hostname.endsWith('.twilio.com'));
  } catch {
    return false;
  }
}

/**
 * Baixa cada mídia com Basic Auth (AccountSid:AuthToken). O Twilio redireciona para um link
 * assinado em outro host; o fetch do Node descarta o Authorization nesse redirecionamento.
 */
export async function downloadMedia(media, { accountSid, authToken, fetchImpl = fetch, maxTotalBytes = MAX_TOTAL_ATTACHMENT_BYTES }) {
  const attachments = [];
  const skipped = [];
  let total = 0;
  const auth = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  for (const m of media) {
    const name = `${m.index + 1}-${kindOf(m.contentType)}.${extensionFor(m.contentType)}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (!isTwilioMediaUrl(m.url)) {
      skipped.push({ name, reason: 'URL de mídia fora do Twilio' });
      continue;
    }
    try {
      const res = await fetchImpl(m.url, { headers: { Authorization: auth }, redirect: 'follow' });
      if (!res.ok) {
        skipped.push({ name, reason: `Twilio respondeu ${res.status}` });
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (total + buf.length > maxTotalBytes) {
        skipped.push({ name, reason: `grande demais (${(buf.length / 1048576).toFixed(1)} MB) para anexar no Gmail` });
        continue;
      }
      total += buf.length;
      attachments.push({ filename: name, content: buf, contentType: m.contentType });
    } catch (err) {
      skipped.push({ name, reason: `falha no download (${err.message})` });
    }
  }
  return { attachments, skipped };
}

export function formatSaoPaulo(date) {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

function preview(text, max = 70) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

export function buildSubject(msg) {
  let what;
  if (msg.body) what = preview(msg.body);
  else if (msg.media.length) {
    const kinds = [...new Set(msg.media.map((m) => kindOf(m.contentType)))];
    what = kinds.join(' + ');
  } else if (msg.latitude) what = 'localização';
  else what = '(mensagem vazia)';
  const tag = msg.forwarded || msg.frequentlyForwarded ? ' (encaminhada)' : '';
  return `${SUBJECT_PREFIX} ${what}${tag}`;
}

export function buildEmail(msg, { attachments = [], skipped = [], receivedAt = new Date(), from, to }) {
  const lines = [];
  lines.push(msg.body || '(sem texto)');
  lines.push('');
  lines.push('---');
  lines.push(`Recebido: ${formatSaoPaulo(receivedAt)} (horário de São Paulo)`);
  lines.push(`Enviado por: ${msg.profileName || '?'} (${normalizeNumber(msg.from) || msg.from})`);
  if (msg.frequentlyForwarded) lines.push('Encaminhada: sim, muitas vezes');
  else if (msg.forwarded) lines.push('Encaminhada: sim (o WhatsApp não informa o autor original)');
  if (msg.latitude && msg.longitude) {
    const label = [msg.locationLabel, msg.address].filter(Boolean).join(', ');
    lines.push(`Localização: ${label ? label + ' — ' : ''}https://maps.google.com/?q=${msg.latitude},${msg.longitude}`);
  }
  if (attachments.length) lines.push(`Anexos: ${attachments.map((a) => a.filename).join(', ')}`);
  for (const s of skipped) lines.push(`Não anexado: ${s.name}: ${s.reason}`);
  if (msg.messageSid) lines.push(`Twilio MessageSid: ${msg.messageSid}`);
  return {
    from,
    to,
    subject: buildSubject(msg),
    text: lines.join('\n'),
    attachments,
  };
}

const TWIML_EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const TWIML_ACK = '<?xml version="1.0" encoding="UTF-8"?><Response><Message>✓ no e-mail</Message></Response>';

/**
 * Processa uma requisição do webhook. Todas as dependências externas entram por parâmetro.
 * Retorna { status, body, contentType }.
 */
export async function handleWebhook({ url, rawBody, signature, env, sendMail, fetchImpl = fetch, now = () => new Date(), log = console }) {
  const params = parseForm(rawBody);
  const authToken = env.TWILIO_AUTH_TOKEN;
  const accountSid = env.TWILIO_ACCOUNT_SID;
  if (!authToken || !accountSid || !env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    log.error('Configuração incompleta: faltam variáveis de ambiente.');
    return { status: 500, body: 'missing configuration', contentType: 'text/plain' };
  }
  if (!isValidTwilioSignature(authToken, url, params, signature)) {
    log.warn('Assinatura do Twilio inválida', { url });
    return { status: 403, body: 'invalid signature', contentType: 'text/plain' };
  }
  if (params.AccountSid && params.AccountSid !== accountSid) {
    return { status: 403, body: 'wrong account', contentType: 'text/plain' };
  }
  const msg = parseInbound(params);
  const allow = parseAllowList(env.ALLOWED_FROM);
  if (!isAllowedSender(msg.from, allow)) {
    log.warn('Remetente fora da lista ALLOWED_FROM; ignorado.', { from: normalizeNumber(msg.from).slice(0, -4) + '****' });
    return { status: 200, body: TWIML_EMPTY, contentType: 'text/xml' };
  }
  const { attachments, skipped } = await downloadMedia(msg.media, { accountSid, authToken, fetchImpl });
  const mail = buildEmail(msg, {
    attachments,
    skipped,
    receivedAt: now(),
    from: `WhatsApp → Gmail <${env.GMAIL_USER}>`,
    to: env.MAIL_TO || env.GMAIL_USER,
  });
  await sendMail(mail);
  log.info('E-mail enviado', { sid: msg.messageSid, attachments: attachments.length, skipped: skipped.length });
  return { status: 200, body: env.REPLY_ACK === '1' ? TWIML_ACK : TWIML_EMPTY, contentType: 'text/xml' };
}

/** Reconstrói a URL pública que o Twilio chamou (usada na assinatura). */
export function publicUrl(requestUrl, headers, override) {
  if (override) return override;
  const u = new URL(requestUrl);
  const host = headers.get('x-forwarded-host') || headers.get('host') || u.host;
  const proto = (headers.get('x-forwarded-proto') || u.protocol.replace(':', '')).split(',')[0].trim();
  return `${proto}://${host}${u.pathname}${u.search}`;
}
