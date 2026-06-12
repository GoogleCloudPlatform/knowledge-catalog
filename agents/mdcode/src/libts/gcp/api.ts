// API Client base class
//

import * as context from './context';

export interface ApiResult<T> {
  status: number;
  result?: T;
  message?: string;
}

export class ApiClient {
  private readonly _endpoint: string;
  private readonly _pathPrefix: string;
  private readonly _context: context.ApiContext;

  constructor(
    endpoint: string,
    pathPrefix: string,
    context: context.ApiContext,
  ) {
    this._endpoint = endpoint;
    this._pathPrefix = pathPrefix;
    this._context = context;
  }

  get context(): context.ApiContext {
    return this._context;
  }

  async _get<T>(
    resourceName: string,
    queryParams?: Record<string, any>,
  ): Promise<ApiResult<T>> {
    const url = `${this._endpoint}/${this._pathPrefix}/${resourceName}`;
    return this._requestRetry('GET', url, queryParams);
  }

  async _post<T>(
    resourceName: string,
    body: any,
    queryParams?: Record<string, any>,
  ): Promise<ApiResult<T>> {
    const url = `${this._endpoint}/${this._pathPrefix}/${resourceName}`;
    return this._requestRetry('POST', url, queryParams, body);
  }

  async _patch<T>(
    resourceName: string,
    body: any,
    queryParams?: Record<string, any>,
  ): Promise<ApiResult<T>> {
    const url = `${this._endpoint}/${this._pathPrefix}/${resourceName}`;
    return this._requestRetry('PATCH', url, queryParams, body);
  }

  async _delete<T>(
    resourceName: string,
    queryParams?: Record<string, any>,
  ): Promise<ApiResult<T>> {
    const url = `${this._endpoint}/${this._pathPrefix}/${resourceName}`;
    return this._requestRetry('DELETE', url, queryParams);
  }

  private async _requestRetry<T>(
    method: string,
    url: string,
    queryParams?: Record<string, any>,
    body?: any,
  ): Promise<ApiResult<T>> {
    if (queryParams) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(queryParams)) {
        if (value !== undefined) {
          if (Array.isArray(value)) {
            value.forEach((v) => params.append(key, String(v)));
          } else {
            params.append(key, String(value));
          }
        }
      }
      const queryString = params.toString();
      if (queryString) {
        url += `?${queryString}`;
      }
    }

    this._context.log(`${method} ${url}{body ? '\n' : ''}`, body);

    let response = await this._requestCore(url, {method, body});
    if (response.status === 401) {
      this.context.refresh();
      response = await this._requestCore(url, {method, body});
    }

    const result: ApiResult<T> = {status: response.status};
    if (!response.ok) {
      result.message = await response.text();
    } else {
      result.result = (await response.json()) as T;
    }

    this._context.log(
      `${response.status}:${result.message ?? ''}\n`,
      result.result,
    );
    return result;
  }

  private async _requestCore(url: string, options: any): Promise<Response> {
    const headers = {
      ...options.headers,
      'Authorization': `Bearer ${this._context.token}`,
      'Content-Type': 'application/json',
    };

    return fetch(url, {
      ...options,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  }
}
