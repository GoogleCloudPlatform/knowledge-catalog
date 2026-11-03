// API Client base class
//

import * as context from './context';


export interface ApiResult<T> {
  status: number;
  result?: T;
  // For a failed response, the message errorMessage reads from its body.
  message?: string;
  // For a failed response, its whole body.
  body?: string;
}

export interface ApiClientOptions {
  retryDelayMs?: number;
}

export interface RequestOptions {
  retry?: boolean;
}

const TRANSIENT_TRIES = 4;
const TRANSIENT_DELAY_CAP_MS = 5000;
const MAX_MESSAGE_LENGTH = 2000;

// The message in a failed response's body: a Google API error's
// LocalizedMessage detail, which Spanner leaves unescaped, or else its
// `error.message`. Any other body comes back trimmed and cut to 2,000
// characters.
export function errorMessage(body: string): string {
  const text = body.trim();
  try {
    const error = JSON.parse(text)?.error;
    const details = Array.isArray(error?.details) ? error.details : [];
    const localized = details.find((d: any) =>
        d?.['@type']?.endsWith('LocalizedMessage') && isText(d.message));
    const message = localized?.message ?? error?.message;
    if (isText(message)) return message.trim();
  } catch {
    // Not JSON, such as a proxy's HTML error page.
  }
  return text.length > MAX_MESSAGE_LENGTH ?
      `${text.slice(0, MAX_MESSAGE_LENGTH)}...` : text;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

export function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

function transientDelayMs(configured?: number): number {
  if (configured !== undefined && Number.isFinite(configured) && configured >= 0) {
    return configured;
  }
  const raw = process.env.GCP_RETRY_DELAY_MS;
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 500;
}

function jitteredDelay(delayMs: number): number {
  return delayMs > 0 ? Math.round(delayMs * (0.5 + Math.random() * 0.5)) : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}


export class ApiClient {
  private readonly _endpoint: string;
  private readonly _pathPrefix: string;
  private readonly _context: context.ApiContext;
  private readonly _retryDelayMs?: number;

  constructor(endpoint: string, pathPrefix: string, context: context.ApiContext,
              options: ApiClientOptions = {}) {
    this._endpoint = endpoint;
    this._pathPrefix = pathPrefix;
    this._context = context;
    this._retryDelayMs = options.retryDelayMs;
  }

  get context(): context.ApiContext {
    return this._context;
  }

  // Only reads retry: a write that 5xxs may still have landed on the server.
  async _get<T>(resourceName: string,
                 queryParams?: Record<string, any>,
                 options?: RequestOptions): Promise<ApiResult<T>> {
    const url = `${this._endpoint}/${this._pathPrefix}/${resourceName}`;
    return this._requestRetry('GET', url, queryParams, undefined,
                              options?.retry !== false);
  }

  async _post<T>(resourceName: string,
                 body: any,
                 queryParams?: Record<string, any>): Promise<ApiResult<T>> {
    const url = `${this._endpoint}/${this._pathPrefix}/${resourceName}`;
    return this._requestRetry('POST', url, queryParams, body);
  }

  async _patch<T>(resourceName: string,
                  body: any,
                  queryParams?: Record<string, any>): Promise<ApiResult<T>> {
    const url = `${this._endpoint}/${this._pathPrefix}/${resourceName}`;
    return this._requestRetry('PATCH', url, queryParams, body);
  }

  async _delete<T>(resourceName: string,
                   queryParams?: Record<string, any>): Promise<ApiResult<T>> {
    const url = `${this._endpoint}/${this._pathPrefix}/${resourceName}`;
    return this._requestRetry('DELETE', url, queryParams);
  }

  private async _requestRetry<T>(method: string,
                                 url: string,
                                 queryParams?: Record<string, any>,
                                 body?: any,
                                 retryTransient = false): Promise<ApiResult<T>> {
    if (queryParams) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(queryParams)) {
        if (value !== undefined) {
          if (Array.isArray(value)) {
            value.forEach(v => params.append(key, String(v)));
          }
          else {
            params.append(key, String(value));
          }
        }
      }
      const queryString = params.toString();
      if (queryString) {
        url += `?${queryString}`;
      }
    }

    const tries = retryTransient ? TRANSIENT_TRIES : 1;
    let delayMs = transientDelayMs(this._retryDelayMs);
    let response!: Response;
    for (let attempt = 0; attempt < tries; attempt++) {
      if (attempt > 0) {
        await sleep(jitteredDelay(delayMs));
        delayMs = Math.min(delayMs * 2, TRANSIENT_DELAY_CAP_MS);
      }

      this._context.log(`${method} ${url}{body ? '\n' : ''}`, body);

      response = await this._requestCore(url, { method, body });
      if (response.status === 401) {
        this.context.refresh();
        response = await this._requestCore(url, { method, body });
      }
      if (!isTransientStatus(response.status)) break;
    }

    const result: ApiResult<T> = { status: response.status };
    if (!response.ok) {
      result.body = await response.text();
      result.message = errorMessage(result.body);
    }
    else {
      result.result = await response.json() as T;
    }

    this._context.log(`${response.status}:${result.body ?? ''}\n`, result.result);
    return result;
  }

  private async _requestCore(url: string, options: any): Promise<Response> {
    const headers = {
      ...options.headers,
      'Authorization': `Bearer ${this._context.token}`,
      'Content-Type': 'application/json'
    };

    return fetch(url, {
      ...options,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  }
}
