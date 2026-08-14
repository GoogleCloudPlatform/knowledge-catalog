import * as cp from 'child_process';
import * as path from 'node:path';
import * as kcmd from 'kcmd';
import { YAML } from 'bun';

const context = kcmd.gcp.ApiContext.default();
const project = context.project;
const location = context.location;
const entryGroup = 'okf_ga4';

function dataplex(cmd: string, data: string|null=null) {
  cmd = 'gcloud dataplex ' + cmd + ` --project ${project} --location ${location}`;
  cp.execSync(cmd, { encoding: 'utf8', input: data ?? undefined, stdio: 'inherit'});
}

try {
  dataplex(`entry-groups create ${entryGroup}`);
  console.log(`Created empty entry group ${entryGroup}`);
  console.log();
}
catch {
  // Might already exist
}

try {
  dataplex(`aspect-types create okf --metadata-template-file-name=okf-aspect.json`);
  console.log('Created custom aspect type okf');
  console.log();
}
catch {
  // Already exists. Update rather than skip: a project left over from an
  // earlier run of this demo holds an older template, and pushing v0.2 signal
  // against it fails with an opaque "Unknown property" error. Dataplex rejects
  // backwards-incompatible template changes, so new fields in okf-aspect.json
  // must be appended with fresh indices; renumbering an existing field breaks
  // this update for everyone who already ran the demo.
  dataplex(`aspect-types update okf --metadata-template-file-name=okf-aspect.json`);
  console.log('Updated existing aspect type okf to the current template');
  console.log();
}

// A custom entry type, so a search can tell an OKF document apart from anything
// else in the project. It declares no required aspects: SPEC 8 index files
// carry no signal layer, so requiring the okf aspect would reject them.
const entryTypeFlags =
  '--display-name="OKF Document" ' +
  '--description="A document in an Open Knowledge Format bundle."';

try {
  dataplex(`entry-types create okf-bundle ${entryTypeFlags}`);
  console.log('Created custom entry type okf-bundle');
  console.log();
}
catch {
  dataplex(`entry-types update okf-bundle ${entryTypeFlags}`);
  console.log('Updated existing entry type okf-bundle');
  console.log();
}

const okfAspect = `${project}.${location}.okf`;
const okfEntryType = `${project}.${location}.okf-bundle`;

// Every markdown file in the bundle is published as okf-bundle, so the built-in
// generic type is gone from both lists. The list must stay non-empty: it is
// what keeps the entry group's own root entry, which belongs to no file, from
// being pulled down as one.
await Bun.file(path.join(process.cwd(), 'catalog.yaml')).write(YAML.stringify({
  scope: `kb.${project}.${location}.${entryGroup}`,
  snapshot: {
    entries: [
      okfEntryType
    ],
    aspects: [
      'dataplex-types.global.overview',
      okfAspect
    ]
  },
  publishing: {
    entries: [
      okfEntryType
    ],
    aspects: [
      'dataplex-types.global.overview',
      okfAspect
    ]
  }
}, null, 2));
console.log('Created catalog.yaml manifest');
