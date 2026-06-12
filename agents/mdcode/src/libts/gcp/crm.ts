// API client for Cloud Resource Manager
//

import * as api from './api';
import * as context from './context';

export interface Project {
  name: string;
  projectId: string;
  projectNumber: string;
  [key: string]: any;
}

const PROJECT_NUM_TO_ID_CACHE = new Map<string, string>();
PROJECT_NUM_TO_ID_CACHE.set('655216118709', 'dataplex-types');

const PROJECT_ID_TO_NUM_CACHE = new Map<string, string>();
PROJECT_ID_TO_NUM_CACHE.set('dataplex-types', '655216118709');

export class ResourceManagerClient extends api.ApiClient {
  constructor(ctx: context.ApiContext) {
    // USE V1 because V3 Project resource does NOT contain projectNumber field.
    super('https://cloudresourcemanager.googleapis.com', 'v1', ctx);
  }

  async getProject(project: string): Promise<api.ApiResult<Project>> {
    const name = `projects/${project}`;
    return await this._get(name);
  }
}

export async function projectNumber(
  id: string,
  ctx: context.ApiContext,
): Promise<string> {
  const cached = PROJECT_ID_TO_NUM_CACHE.get(id);
  if (cached) {
    return cached;
  }
  if (/^\d+$/.test(id)) {
    return id;
  }
  const res = await new ResourceManagerClient(ctx).getProject(id);
  const num = res.status === 200 ? res.result?.projectNumber : '';
  if (num) {
    PROJECT_ID_TO_NUM_CACHE.set(id, num.toString());
    PROJECT_NUM_TO_ID_CACHE.set(num.toString(), id);
    return num.toString();
  }
  return id;
}

export async function fixProject(
  resource: string,
  ctx: context.ApiContext,
): Promise<string> {
  // projects/<project_id> or projects/<project_number> -> projects/<project_id>

  if (!resource.startsWith('projects/')) {
    return resource;
  }

  const parts = resource.split('/');
  if (/^\d+$/.test(parts[1])) {
    let id = PROJECT_NUM_TO_ID_CACHE.get(parts[1]);
    if (!id) {
      const res = await new ResourceManagerClient(ctx).getProject(parts[1]);
      id = res.status == 200 ? res.result?.projectId : '';
    }

    if (id) {
      PROJECT_NUM_TO_ID_CACHE.set(parts[1], id);
      parts[1] = id;
    }
  }

  return parts.join('/');
}

export async function fixProjectToNumber(
  resource: string,
  ctx: context.ApiContext,
): Promise<string> {
  // projects/<project_id> or projects/<project_number> -> projects/<project_number>

  if (!resource.startsWith('projects/')) {
    return resource;
  }

  const parts = resource.split('/');
  const num = await projectNumber(parts[1], ctx);
  parts[1] = num;

  return parts.join('/');
}
