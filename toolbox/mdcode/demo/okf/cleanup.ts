import * as cp from 'child_process';
import * as kcmd from 'kcmd';
import { manifestEntryGroup, rejectArgs } from './okf';

const context = kcmd.gcp.ApiContext.default();
const project = context.project;
const location = context.location;

// The entry group to delete comes from the manifest setup.ts wrote, so cleanup
// can only ever undo this demo's own setup.
rejectArgs();
const entryGroup = manifestEntryGroup(process.cwd());

// Arguments go to gcloud as an argv array rather than a shell string, so a name
// read out of the manifest is never word-split or interpreted by a shell.
function dataplex(args: string[], data: string|null=null) {
  const argv = [...args, '--project', project, '--location', location];
  cp.execFileSync('gcloud', argv, { encoding: 'utf8', input: data ?? undefined, stdio: 'inherit'});
}

// `-q` skips the confirmation prompt, so this is the only chance to notice that
// the deletion is aimed at the wrong entry group.
console.log(
  `About to delete entry group ${entryGroup} in ${project}/${location}. ` +
  `If this is not the entry group you meant, abort now.`
);

dataplex(['-q', 'dataplex', 'entry-groups', 'delete', entryGroup]);
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
