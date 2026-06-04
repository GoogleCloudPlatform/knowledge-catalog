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

await Bun.file(path.join(process.cwd(), 'catalog.yaml')).write(YAML.stringify({
  scope: `kb.${project}.${location}.${entryGroup}`,
  snapshot: {
    entries: [
      'dataplex-types.global.generic'
    ],
    aspects: [
      'dataplex-types.global.generic',
      'dataplex-types.global.overview'
    ]
  },
  publishing: {
    entries: [
      'dataplex-types.global.generic'
    ],
    aspects: [
      'dataplex-types.global.generic',
      'dataplex-types.global.overview'
    ]
  }
}, null, 2));
console.log('Created catalog.yaml manifest');
