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

// Returns the project number of `project`, which is a project ID or number.
// Uses the number `fixProject` already resolved for this ID when there is one.
// Returns undefined when Cloud Resource Manager does not give it, for example
// when the caller lacks `resourcemanager.projects.get`.
export async function projectNumber(project: string,
                                    ctx: context.ApiContext): Promise<string|undefined> {
  if (/^\d+$/.test(project)) return project;
  for (const [number, id] of PROJECT_NUM_TO_ID_CACHE) {
    if (id === project) return number;
  }
  try {
    const res = await new ResourceManagerClient(ctx).getProject(project);
    // A project's resource name is `projects/<project number>`.
    const number = res.status == 200 ? res.result?.name?.split('/')[1] : undefined;
    return number && /^\d+$/.test(number) ? number : undefined;
  } catch {
    return undefined;
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
