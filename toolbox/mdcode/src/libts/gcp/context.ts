// Context variables for GCP API requests
//

import * as cp from 'child_process';

const GCLOUD_PROJECT_CMD = 'gcloud -q config get-value project';
const GCLOUD_LOCATION_CMD = 'gcloud -q config get-value compute/region';
const GCLOUD_TOKEN_CMD = 'gcloud -q auth application-default print-access-token';

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
    // Location: an explicit KC_LOCATION wins, then gcloud's compute/region, then
    // `global` (Knowledge Catalog's default location). An unset compute/region
    // is common (BigQuery-only users never set it) and must not block commands
    // such as `push --no-kc` or `skills-generate` that do not need a region.
    const location = process.env.KC_LOCATION ||
        cp.execSync(GCLOUD_LOCATION_CMD, {stdio: ['ignore', 'pipe', 'ignore']}).toString().trim() ||
        'global';
    const token = cp.execSync(GCLOUD_TOKEN_CMD).toString().trim();
    if (!project || !token) {
      throw new Error('Unable to retrieve project or token. Ensure gcloud is configured.');
    }

    return new ApiContext(project, location, token);
  }

  refresh() {
    this._token = cp.execSync(GCLOUD_TOKEN_CMD).toString().trim();
  }
}
