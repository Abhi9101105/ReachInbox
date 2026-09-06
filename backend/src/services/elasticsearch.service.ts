import { Client } from '@elastic/elasticsearch';
import { config } from '../config/env';
import { prisma } from '../config/prisma';

export interface EmailDocument {
  id: string;
  userId: string;
  senderEmail: string;
  recipient: string;
  subject: string;
  body: string;
  status: string;
  scheduledAt: string;
  sentAt?: string | null;
  providerMessageId?: string | null;
  errorMessage?: string | null;
  attemptCount: number;
  rateLimitDeferrals: number;
  createdAt: string;
  updatedAt: string;
}

export interface EmailDocumentInput {
  id: string;
  userId: string;
  senderEmail: string;
  recipient: string;
  subject: string;
  body: string;
  status: string;
  scheduledAt: Date | string;
  sentAt?: Date | string | null;
  providerMessageId?: string | null;
  errorMessage?: string | null;
  attemptCount?: number;
  rateLimitDeferrals?: number;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export interface SearchEmailsParams {
  q?: string;
  status?: string;
  recipient?: string;
  senderEmail?: string;
  fromDate?: string | Date;
  toDate?: string | Date;
  page?: number;
  limit?: number;
  sortBy?: 'scheduledAt' | 'sentAt' | 'createdAt' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
}

export interface SearchEmailsResult {
  success: boolean;
  data: EmailDocument[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface BulkIndexResult {
  total: number;
  indexed: number;
  failed: number;
  errors: Array<{ id: string; error: string }>;
  tookMs: number;
}

export interface ReindexResult {
  success: boolean;
  totalRecords: number;
  successfullyIndexed: number;
  failures: number;
  errors: Array<{ id: string; error: string }>;
  tookMs: number;
}

export class ElasticsearchService {
  private client: Client;
  private indexName: string;

  constructor() {
    this.indexName = config.elasticsearch.index;
    this.client = new Client({
      node: config.elasticsearch.url,
      auth: config.elasticsearch.apiKey ? { apiKey: config.elasticsearch.apiKey } : undefined,
      maxRetries: 3,
      requestTimeout: 10000,
    });
  }

  /**
   * Initialize Elasticsearch connection and ensure the email index exists.
   */
  async init(): Promise<boolean> {
    try {
      const ping = await this.client.ping();
      if (!ping) {
        console.warn('[Elasticsearch] Ping returned false.');
        return false;
      }

      await this.ensureIndex();
      console.log(`[Elasticsearch] Connected and initialized index: "${this.indexName}"`);
      return true;
    } catch (err) {
      console.warn(`[Elasticsearch] Initialization warning (offline/unavailable): ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Check Elasticsearch cluster health and response latency.
   */
  async healthCheck(): Promise<{
    status: 'connected' | 'disconnected';
    latencyMs?: number;
    clusterStatus?: string;
    error?: string;
  }> {
    const start = Date.now();
    try {
      const health = await this.client.cluster.health({});
      const latencyMs = Date.now() - start;
      return {
        status: 'connected',
        latencyMs,
        clusterStatus: health.status,
      };
    } catch (err) {
      return {
        status: 'disconnected',
        error: (err as Error).message,
      };
    }
  }

  /**
   * Create index with explicit mappings if it doesn't already exist.
   */
  async ensureIndex(): Promise<void> {
    try {
      const exists = await this.client.indices.exists({ index: this.indexName });
      if (!exists) {
        await this.client.indices.create({
          index: this.indexName,
          settings: {
            number_of_shards: 1,
            number_of_replicas: 0,
            analysis: {
              analyzer: {
                email_analyzer: {
                  type: 'custom',
                  tokenizer: 'uax_url_email',
                  filter: ['lowercase'],
                },
              },
            },
          },
          mappings: {
            properties: {
              id: { type: 'keyword' },
              userId: { type: 'keyword' },
              senderEmail: {
                type: 'text',
                analyzer: 'email_analyzer',
                fields: {
                  keyword: { type: 'keyword' },
                },
              },
              recipient: {
                type: 'text',
                analyzer: 'email_analyzer',
                fields: {
                  keyword: { type: 'keyword' },
                },
              },
              subject: {
                type: 'text',
                fields: {
                  keyword: { type: 'keyword', ignore_above: 256 },
                },
              },
              body: { type: 'text' },
              status: { type: 'keyword' },
              scheduledAt: { type: 'date' },
              sentAt: { type: 'date' },
              providerMessageId: { type: 'keyword' },
              errorMessage: { type: 'text' },
              attemptCount: { type: 'integer' },
              rateLimitDeferrals: { type: 'integer' },
              createdAt: { type: 'date' },
              updatedAt: { type: 'date' },
            },
          },
        });
        console.log(`[Elasticsearch] Created index "${this.indexName}" with explicit mapping.`);
      }
    } catch (err) {
      console.warn(`[Elasticsearch] Failed to ensure index: ${(err as Error).message}`);
    }
  }

  /**
   * Transform an email entity into an Elasticsearch document format.
   */
  private formatDocument(email: EmailDocumentInput): EmailDocument {
    return {
      id: email.id,
      userId: email.userId,
      senderEmail: email.senderEmail,
      recipient: email.recipient,
      subject: email.subject,
      body: email.body,
      status: email.status,
      scheduledAt: new Date(email.scheduledAt).toISOString(),
      sentAt: email.sentAt ? new Date(email.sentAt).toISOString() : null,
      providerMessageId: email.providerMessageId || null,
      errorMessage: email.errorMessage || null,
      attemptCount: email.attemptCount ?? 0,
      rateLimitDeferrals: email.rateLimitDeferrals ?? 0,
      createdAt: email.createdAt ? new Date(email.createdAt).toISOString() : new Date().toISOString(),
      updatedAt: email.updatedAt ? new Date(email.updatedAt).toISOString() : new Date().toISOString(),
    };
  }

  /**
   * Index or upsert an individual email document.
   * Document ID is deterministic: equal to email.id.
   * Resilient: Errors are caught and logged so callers never fail because of Elasticsearch.
   */
  async indexEmail(email: EmailDocumentInput, refresh: boolean = false): Promise<boolean> {
    try {
      const doc = this.formatDocument(email);
      await this.client.index({
        index: this.indexName,
        id: email.id,
        document: doc,
        refresh: refresh ? 'wait_for' : false,
      });
      return true;
    } catch (err) {
      console.warn(`[Elasticsearch] Failed to index email ${email.id}: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Delete an email document from the index.
   */
  async deleteEmail(emailId: string): Promise<boolean> {
    try {
      await this.client.delete({
        index: this.indexName,
        id: emailId,
      });
      return true;
    } catch (err) {
      console.warn(`[Elasticsearch] Failed to delete email ${emailId}: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Bulk index multiple email documents with chunking and error reporting.
   */
  async bulkIndexEmails(
    emails: EmailDocumentInput[],
    chunkSize = 500
  ): Promise<BulkIndexResult> {
    const startTime = Date.now();
    let indexed = 0;
    let failed = 0;
    const errors: Array<{ id: string; error: string }> = [];

    if (emails.length === 0) {
      return { total: 0, indexed: 0, failed: 0, errors: [], tookMs: 0 };
    }

    try {
      await this.ensureIndex();

      for (let i = 0; i < emails.length; i += chunkSize) {
        const chunk = emails.slice(i, i + chunkSize);
        const operations = chunk.flatMap((email) => [
          { index: { _index: this.indexName, _id: email.id } },
          this.formatDocument(email),
        ]);

        const response = await this.client.bulk({
          operations,
          refresh: true,
        });

        if (response.errors) {
          for (const item of response.items) {
            const action = item.index || item.create || item.update;
            if (action && action.error) {
              failed++;
              errors.push({
                id: action._id || 'unknown',
                error: action.error.reason || JSON.stringify(action.error),
              });
            } else {
              indexed++;
            }
          }
        } else {
          indexed += chunk.length;
        }
      }
    } catch (err) {
      console.error(`[Elasticsearch] Bulk indexing exception: ${(err as Error).message}`);
      failed = emails.length - indexed;
      errors.push({ id: 'bulk-fatal', error: (err as Error).message });
    }

    return {
      total: emails.length,
      indexed,
      failed,
      errors,
      tookMs: Date.now() - startTime,
    };
  }

  /**
   * Reindex all emails from PostgreSQL to Elasticsearch.
   */
  async reindexFromDatabase(): Promise<ReindexResult> {
    const startTime = Date.now();
    try {
      const emails = await prisma.email.findMany();
      const bulkResult = await this.bulkIndexEmails(emails);

      return {
        success: bulkResult.failed === 0,
        totalRecords: bulkResult.total,
        successfullyIndexed: bulkResult.indexed,
        failures: bulkResult.failed,
        errors: bulkResult.errors,
        tookMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        totalRecords: 0,
        successfullyIndexed: 0,
        failures: 0,
        errors: [{ id: 'database-read-error', error: (err as Error).message }],
        tookMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Search emails with full-text queries, exact filters, date ranges, and pagination.
   */
  async searchEmails(params: SearchEmailsParams): Promise<SearchEmailsResult> {
    const page = Math.max(1, params.page || 1);
    const limit = Math.min(100, Math.max(1, params.limit || 20));
    const from = (page - 1) * limit;
    const sortBy = params.sortBy || 'scheduledAt';
    const sortOrder = params.sortOrder || 'desc';

    const mustClauses: unknown[] = [];
    const filterClauses: unknown[] = [];

    // Full-text query across searchable fields
    if (params.q && params.q.trim().length > 0) {
      const queryStr = params.q.trim();
      mustClauses.push({
        multi_match: {
          query: queryStr,
          fields: [
            'subject^3',
            'subject.keyword^3',
            'body^2',
            'recipient^3',
            'recipient.keyword^3',
            'senderEmail^2',
            'senderEmail.keyword^2',
          ],
          type: 'best_fields',
          fuzziness: 'AUTO',
        },
      });
    } else {
      mustClauses.push({ match_all: {} });
    }

    // Exact status filter
    if (params.status) {
      filterClauses.push({
        term: { status: params.status.toUpperCase() },
      });
    }

    // Exact recipient filter
    if (params.recipient) {
      filterClauses.push({
        term: { 'recipient.keyword': params.recipient },
      });
    }

    // Exact sender filter
    if (params.senderEmail) {
      filterClauses.push({
        term: { 'senderEmail.keyword': params.senderEmail },
      });
    }

    // Date range filter
    if (params.fromDate || params.toDate) {
      const range: { gte?: string; lte?: string } = {};
      if (params.fromDate) {
        range.gte = new Date(params.fromDate).toISOString();
      }
      if (params.toDate) {
        range.lte = new Date(params.toDate).toISOString();
      }
      filterClauses.push({
        range: { scheduledAt: range },
      });
    }

    try {
      const response = await this.client.search<EmailDocument>({
        index: this.indexName,
        from,
        size: limit,
        query: {
          bool: {
            must: mustClauses as any,
            filter: filterClauses as any,
          },
        },
        sort: [
          { [sortBy]: { order: sortOrder } },
          { _score: { order: 'desc' } },
        ] as any,
      });

      const totalHits = typeof response.hits.total === 'number'
        ? response.hits.total
        : (response.hits.total?.value || 0);

      const items: EmailDocument[] = response.hits.hits
        .map((hit) => hit._source)
        .filter((doc): doc is EmailDocument => Boolean(doc));

      return {
        success: true,
        data: items,
        pagination: {
          page,
          limit,
          total: totalHits,
          totalPages: Math.ceil(totalHits / limit),
        },
      };
    } catch (err) {
      console.warn(`[Elasticsearch] Search query failed: ${(err as Error).message}`);
      return {
        success: false,
        data: [],
        pagination: {
          page,
          limit,
          total: 0,
          totalPages: 0,
        },
      };
    }
  }

  /**
   * Reset the index (delete and recreate with mappings). Test-only.
   */
  async resetIndex(): Promise<void> {
    try {
      const exists = await this.client.indices.exists({ index: this.indexName });
      if (exists) {
        await this.client.indices.delete({ index: this.indexName });
      }
      await this.ensureIndex();
    } catch (err) {
      console.warn(`[Elasticsearch] Reset index warning: ${(err as Error).message}`);
    }
  }

  /**
   * Graceful shutdown of Elasticsearch client.
   */
  async close(): Promise<void> {
    try {
      await this.client.close();
      console.log('[Elasticsearch] Client closed cleanly.');
    } catch (err) {
      console.warn(`[Elasticsearch] Error closing client: ${(err as Error).message}`);
    }
  }
}

export const elasticsearchService = new ElasticsearchService();
