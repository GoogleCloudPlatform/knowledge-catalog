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

// The okf aspect type and the okf-bundle entry type are scoped to the project
// and location, not to this demo's entry group, so any other OKF bundle in the
// project is typed by them too. Deleting them here would strip the signal layer
// from bundles this demo does not own, and Dataplex refuses to delete a type
// that entries still reference.
console.log(
  `Left aspect type ${project}.${location}.okf and entry type ` +
  `${project}.${location}.okf-bundle in place (shared across OKF bundles). To remove them:\n` +
  `  gcloud dataplex aspect-types delete okf --project ${project} --location ${location}\n` +
  `  gcloud dataplex entry-types delete okf-bundle --project ${project} --location ${location}`
);
