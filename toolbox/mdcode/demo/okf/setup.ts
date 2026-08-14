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

const okfAspect = `${project}.${location}.okf`;

await Bun.file(path.join(process.cwd(), 'catalog.yaml')).write(YAML.stringify({
  scope: `kb.${project}.${location}.${entryGroup}`,
  snapshot: {
    entries: [
      'dataplex-types.global.generic'
    ],
    aspects: [
      'dataplex-types.global.generic',
      'dataplex-types.global.overview',
      okfAspect
    ]
  },
  publishing: {
    entries: [
      'dataplex-types.global.generic'
    ],
    aspects: [
      'dataplex-types.global.generic',
      'dataplex-types.global.overview',
      okfAspect
    ]
  }
}, null, 2));
console.log('Created catalog.yaml manifest');
