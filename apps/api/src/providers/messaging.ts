import { form, httpJson } from './http.js';
import type { EmailProvider, SmsProvider } from './types.js';

export class ResendEmailProvider implements EmailProvider {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}
  async send(i: { to: string; subject: string; text: string }) {
    const { body } = await httpJson('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [i.to], subject: i.subject, text: i.text }),
    });
    if (!body?.id) throw new Error('Resend did not return a message id');
    return { messageId: body.id as string };
  }
}

export class TwilioSmsProvider implements SmsProvider {
  constructor(
    private readonly sid: string,
    private readonly token: string,
    private readonly from: string,
  ) {}
  async send(i: { to: string; body: string }) {
    const { body } = await httpJson(`https://api.twilio.com/2010-04-01/Accounts/${this.sid}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${this.sid}:${this.token}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form({ To: i.to, From: this.from, Body: i.body }),
    });
    if (!body?.sid) throw new Error('Twilio did not return a message sid');
    return { messageId: body.sid as string };
  }
}
