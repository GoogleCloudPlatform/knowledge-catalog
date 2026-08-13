import * as cp from 'child_process';
import * as kcmd from 'kcmd';

const context = kcmd.gcp.ApiContext.default();
const project = context.project;
const location = context.location;
const entryGroup = 'okf_ga4';

function dataplex(cmd: string, data: string|null=null) {
  cmd = 'gcloud -q dataplex ' + cmd + ` --project ${project} --location ${location}`;
  cp.execSync(cmd, { encoding: 'utf8', input: data ?? undefined, stdio: 'inherit'});
}

dataplex(`entry-groups delete ${entryGroup}`);
console.log(`Deleted entry group ${entryGroup}`);

// The okf aspect type is scoped to the project and location, not to this demo's
// entry group, so any other OKF bundle in the project attaches its signal layer
// to the same type. Deleting it here would strip that signal from bundles this
// demo does not own.
console.log(
  `Left aspect type ${project}.${location}.okf in place (shared across OKF bundles). ` +
  `To remove it: gcloud dataplex aspect-types delete okf --project ${project} --location ${location}`
);
