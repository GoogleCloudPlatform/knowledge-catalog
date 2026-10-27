// Context variables for GCP API requests
//

import * as cp from 'child_process';

const GCLOUD_PROJECT_CMD = 'gcloud -q config get-value project';
const GCLOUD_LOCATION_CMD = 'gcloud -q config get-value compute/region';
const GCLOUD_TOKEN_CMD = 'gcloud -q auth application-default print-access-token';

export class ApiContext {
  private _project: string;
  private _location: string;
  private _token: string;
  // Set only on a context from deferred() that has not read gcloud's
  // configuration yet. It stays set when reading fails, so every later read
  // fails the same way instead of returning empty values.
  private _pending?: () => void;

  constructor(project: string, location: string, token: string) {
    this._project = project;
    this._location = location;
    this._token = token;
  }

  get project(): string {
    this._settle();
    return this._project;
  }

  get location(): string {
    this._settle();
    return this._location;
  }

  get token(): string {
    this._settle();
    return this._token;
  }

  log(message: string, data?: any) {
    if (process.env.GCP_LOG) {
      console.log(`[GCP_LOG] ${message}`, data ? JSON.stringify(data) : '');
    }
  }

  static default(): ApiContext {
    // Creates an ApiContext instance using gcloud configuration
    const {project, location, token} = readGcloudConfig();
    return new ApiContext(project, location, token);
  }

  // A context that reads gcloud's configuration only when a request first
  // needs the project, the location or the token. A command that never makes a
  // request, such as one that reads a local workspace, then runs no gcloud
  // command and needs no credentials. Reading fails with the same error as
  // default(), at first use.
  static deferred(): ApiContext {
    const ctx = new ApiContext('', '', '');
    ctx._pending = () => {
      const {project, location, token} = readGcloudConfig();
      ctx._project = project;
      ctx._location = location;
      ctx._token = token;
    };
    return ctx;
  }

  refresh() {
    if (this._pending) {
      // Not read yet: the first read fetches a fresh token anyway.
      this._settle();
      return;
    }
    this._token = cp.execSync(GCLOUD_TOKEN_CMD).toString().trim();
  }

  private _settle(): void {
    if (!this._pending) return;
    this._pending();
    this._pending = undefined;
  }
}

function readGcloudConfig(): {project: string; location: string; token: string} {
  const project = cp.execSync(GCLOUD_PROJECT_CMD).toString().trim();
  const location = cp.execSync(GCLOUD_LOCATION_CMD).toString().trim();
  const token = cp.execSync(GCLOUD_TOKEN_CMD).toString().trim();
  if (!project || !location || !token) {
    throw new Error('Unable to retrieve project, location, or token. Ensure gcloud is configured.');
  }
  return {project, location, token};
}
