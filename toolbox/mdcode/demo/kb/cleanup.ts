import * as cp from 'child_process';
import * as kcmd from 'kcmd';

const context = kcmd.gcp.ApiContext.default();
const project = context.project;
const location = context.location;
const entryGroup = 'demo_kb';

function dataplex(cmd: string, data: string | null = null) {
  cmd =
    'gcloud -q dataplex ' +
    cmd +
    ` --project ${project} --location ${location}`;
  cp.execSync(cmd, {
    encoding: 'utf8',
    input: data ?? undefined,
    stdio: 'inherit',
  });
}

dataplex(`entry-groups delete ${entryGroup}`);
console.log('Deleted catalog knowledge base entries');
console.log();
