import nodemailer, { Transporter } from 'nodemailer';
import { config } from '../config/env';

export interface SendEmailOptions {
  from?: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

export interface SendEmailResult {
  messageId: string;
  previewUrl: string | false;
  accepted: string[];
  rejected: string[];
}

export class EmailService {
  private transporter: Transporter;

  constructor() {
    this.transporter = nodemailer.createTransport({
      host: config.ethereal.host,
      port: config.ethereal.port,
      secure: config.ethereal.port === 465,
      auth: {
        user: config.ethereal.user,
        pass: config.ethereal.pass,
      },
      pool: true,
      maxConnections: config.workerConcurrency,
      maxMessages: 100,
    });
  }

  /**
   * Verify SMTP connection with the provider
   */
  public async verifyConnection(): Promise<boolean> {
    try {
      await this.transporter.verify();
      console.log(`SMTP connection to ${config.ethereal.host}:${config.ethereal.port} verified.`);
      return true;
    } catch (error) {
      const err = error as Error;
      console.error(`SMTP connection verification failed: ${err.message}`);
      throw error;
    }
  }

  /**
   * Send an email through the SMTP transporter and return delivery details & preview URL
   */
  public async sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
    const mailOptions = {
      from: options.from || config.ethereal.from,
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html || options.text,
    };

    const info = await this.transporter.sendMail(mailOptions);
    const previewUrl = nodemailer.getTestMessageUrl(info);

    return {
      messageId: info.messageId,
      previewUrl,
      accepted: (info.accepted as string[]) || [],
      rejected: (info.rejected as string[]) || [],
    };
  }

  /**
   * Gracefully close connection pool
   */
  public close(): void {
    this.transporter.close();
  }
}

export const emailService = new EmailService();
