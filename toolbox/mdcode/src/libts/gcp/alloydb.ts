// API client for AlloyDB, covering the one call the semantic runtime needs:
// listing a cluster's instances, to find the primary instance a connection to
// one of the cluster's databases goes through.

import * as api from './api';
import * as context from './context';


// An AlloyDB instance. `name` is the full resource name,
// `projects/<p>/locations/<l>/clusters/<c>/instances/<i>`. `instanceType` is
// `PRIMARY`, `READ_POOL` or `SECONDARY`.
export interface Instance {
  name?: string;
  instanceType?: string;
  state?: string;
  [key: string]: any;
}


interface InstanceList {
  instances?: Instance[];
  nextPageToken?: string;
}


export class AlloyDbClient extends api.ApiClient {
  constructor(ctx: context.ApiContext) {
    super('https://alloydb.googleapis.com', 'v1', ctx);
  }

  // Lists every instance in a cluster. Follows nextPageToken until exhausted
  // and returns the flat list. A non-200 on any page aborts and is returned
  // as-is. Throws when the server repeats a page token, which would otherwise
  // never end.
  async listInstances(project: string, location: string, cluster: string):
      Promise<api.ApiResult<Instance[]>> {
    const parent = `projects/${project}/locations/${location}/clusters/${
        cluster}/instances`;
    const instances: Instance[] = [];
    let pageToken: string|undefined = undefined;
    const seen = new Set<string>();
    do {
      const res: api.ApiResult<InstanceList> =
          await this._get<InstanceList>(parent, {pageToken});
      if (res.status != 200) {
        return {status: res.status, message: res.message};
      }
      instances.push(...(res.result?.instances ?? []));
      pageToken = res.result?.nextPageToken;
      if (pageToken && seen.has(pageToken)) {
        throw new Error(
            `the AlloyDB API returned page token '${pageToken}' twice`);
      }
      if (pageToken) seen.add(pageToken);
    } while (pageToken);
    return {status: 200, result: instances};
  }
}
