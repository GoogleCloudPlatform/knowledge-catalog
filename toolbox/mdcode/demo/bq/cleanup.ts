import * as cp from 'child_process';
import * as kcmd from 'kcmd';

const context = kcmd.gcp.ApiContext.default();
const project = context.project;
const dataset = `${project}.demo_ecommerce`;
const sql = `
DROP SCHEMA IF EXISTS \`${dataset}\` CASCADE;
`;

cp.execSync('bq query --use_legacy_sql=false', {
  encoding: 'utf8',
  input: sql,
  stdio: 'inherit',
});
console.log(`Deleted demo BigQuery resources in dataset ${dataset}`);
console.log();
