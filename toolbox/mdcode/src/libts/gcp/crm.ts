// API client for Cloud Resource Manager
//

import * as api from './api';
import * as context from './context';


export interface Project {
  name: string;
  projectId: string;
  [key: string]: any;
}


const PROJECT_NUM_TO_ID_CACHE = new Map<string, string>();
PROJECT_NUM_TO_ID_CACHE.set('655216118709', 'dataplex-types');


export class ResourceManagerClient extends api.ApiClient {

  constructor(ctx: context.ApiContext) {
    super('https://cloudresourcemanager.googleapis.com', 'v3', ctx);
  }

  async getProject(project: string): Promise<api.ApiResult<Project>> {
    const name = `projects/${project}`;
    return await this._get(name);
  }
}

export async function fixProject(resource: string, ctx: context.ApiContext): Promise<string> {
  // projects/<project_id> or projects/<project_number> -> projects/<project_id>

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
    resource = parts.join('/');
  }

  return resource;
}

const PROJECT_ID_TO_NUM_CACHE = new Map<string, string>();
PROJECT_ID_TO_NUM_CACHE.set('dataplex-types', '655216118709');

export function tryGetProjectNumber(projectId: string): string | undefined {
  return PROJECT_ID_TO_NUM_CACHE.get(projectId);
}

export async function toProjectNumber(resource: string, ctx: context.ApiContext): Promise<string> {
  if (!resource.includes('/')) {
    let num = PROJECT_ID_TO_NUM_CACHE.get(resource);
    if (!num) {
      const res = await new ResourceManagerClient(ctx).getProject(resource);
      if (res.status === 200 && res.result?.name) {
        const nameParts = res.result.name.split('/');
        num = nameParts[nameParts.length - 1];
      }
    }

    if (num) {
      PROJECT_ID_TO_NUM_CACHE.set(resource, num);
      return num;
    }
    return resource;
  }

  const parts = resource.split('/');
  if (parts.length > 1 && !/^\d+$/.test(parts[1])) {
    const projectId = parts[1];
    let num = PROJECT_ID_TO_NUM_CACHE.get(projectId);
    if (!num) {
      const res = await new ResourceManagerClient(ctx).getProject(projectId);
      if (res.status === 200 && res.result?.name) {
        const nameParts = res.result.name.split('/');
        num = nameParts[nameParts.length - 1];
      }
    }

    if (num) {
      PROJECT_ID_TO_NUM_CACHE.set(projectId, num);
      parts[1] = num;
    }
    resource = parts.join('/');
  }

  return resource;
}

