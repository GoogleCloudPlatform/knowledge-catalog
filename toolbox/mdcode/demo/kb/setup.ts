import * as cp from 'child_process';
import * as path from 'node:path';
import * as kcmd from 'kcmd';
import { YAML } from 'bun';

const context = kcmd.gcp.ApiContext.default();
const project = context.project;
const location = context.location;
const entryGroup = 'demo_kb';
const genericResource = 'projects/dataplex-types/locations/global/entryTypes/generic';

function dataplex(cmd: string, data: string|null=null) {
  cmd = 'gcloud dataplex ' + cmd + ` --project ${project} --location ${location}`;
  cp.execSync(cmd, { encoding: 'utf8', input: data ?? undefined, stdio: 'inherit'});
}

function createEntry(name: string, displayName: string, description: string) {
  dataplex(`entries create --entry-group ${entryGroup} ` +
           `--entry-type ${genericResource} ` +
           `--entry-source-display-name "${displayName}" ` +
           `--entry-source-description "${description}" ` +
           `--entry-source-labels usage=demo,sample=true ` +
           `--aspects /tmp/aspects.json ` +
           name)
}

const aspectsFile = Bun.file('/tmp/aspects.json');
await aspectsFile.write(JSON.stringify({
  'dataplex-types.global.generic': {
    aspectType: 'dataplex-types.global.generic',
    data: {}
  },
  'dataplex-types.global.overview': {
    aspectType: 'dataplex-types.global.overview',
    data: {
      content: '# Placeholder Content\n\nLorem ipsum dolor met',
      contentType: 'MARKDOWN'
    }
  }
}));

try {
  dataplex(`entry-groups create ${entryGroup}`);
  createEntry('index', 'Index', 'Demo knowledge base index of top-level sections');
  createEntry('tags/tag1', 'Tag 1', 'First tag');
  createEntry('tags/tag2', 'Tag 2', 'Second tag');
  createEntry('topic1', 'Topic 1', 'Initial placeholder topic');
  createEntry('dir/index', 'Index', 'Some contents in a directory');
  createEntry('dir/topic1', 'Topic 1', 'Some topic 1');
  createEntry('dir/topic2', 'Topic 2', 'Some topic 2');
  createEntry('dir/topic3', 'Topic 3', 'Some topic 3');

  console.log('Created catalog knowledge base entries');
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
      'dataplex-types.global.overview'
    ]
  },
  publishing: {
    entries: [
      'dataplex-types.global.generic'
    ],
    aspects: [
      'dataplex-types.global.overview'
    ]
  }
}, null, 2));
console.log('Created catalog.yaml manifest');
