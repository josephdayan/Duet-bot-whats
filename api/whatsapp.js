// Webhook do Twilio: "When a message comes in" -> https://<seu-projeto>.vercel.app/api/whatsapp
import nodemailer from 'nodemailer';
import { handleWebhook, publicUrl } from '../lib/core.js';

let transporter;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
  }
  return transporter;
}

export async function POST(request) {
  try {
    const result = await handleWebhook({
      url: publicUrl(request.url, request.headers, process.env.PUBLIC_URL),
      rawBody: await request.text(),
      signature: request.headers.get('x-twilio-signature') || '',
      env: process.env,
      sendMail: (mail) => getTransporter().sendMail(mail),
    });
    return new Response(result.body, { status: result.status, headers: { 'Content-Type': result.contentType } });
  } catch (err) {
    console.error('Falha ao encaminhar', err);
    return new Response('error', { status: 500, headers: { 'Content-Type': 'text/plain' } });
  }
}

export function GET() {
  return new Response('whatsapp-forward ok', { headers: { 'Content-Type': 'text/plain' } });
}
