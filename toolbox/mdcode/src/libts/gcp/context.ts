// Context variables for GCP API requests
//

import * as cp from 'child_process';

const GCLOUD_PROJECT_CMD = 'gcloud -q config get-value project';
const GCLOUD_LOCATION_CMD = 'gcloud -q config get-value compute/region';
const GCLOUD_TOKEN_CMD =
  'gcloud -q auth application-default print-access-token';

export class ApiContext {
  readonly project: string;
  readonly location: string;
  private _token: string;

  constructor(project: string, location: string, token: string) {
    this.project = project;
    this.location = location;
    this._token = token;
  }

  get token(): string {
    return this._token;
  }

  log(message: string, data?: any) {
    if (process.env.GCP_LOG) {
      console.log(`[GCP_LOG] ${message}`, data ? JSON.stringify(data) : '');
    }
  }

  static default(): ApiContext {
    // Creates an ApiContext instance using gcloud configuration

    const project = cp.execSync(GCLOUD_PROJECT_CMD).toString().trim();
    const location = cp.execSync(GCLOUD_LOCATION_CMD).toString().trim();
    const token = cp.execSync(GCLOUD_TOKEN_CMD).toString().trim();
    if (!project || !location || !token) {
      throw new Error(
        'Unable to retrieve project, location, or token. Ensure gcloud is configured.',
      );
    }

    return new ApiContext(project, location, token);
  }

  refresh() {
    this._token = cp.execSync(GCLOUD_TOKEN_CMD).toString().trim();
  }
}
