import * as cp from 'child_process';
import * as path from 'node:path';
import * as kcmd from 'kcmd';
import { YAML } from 'bun';

const context = kcmd.gcp.ApiContext.default();
const project = context.project;
const dataset = `${project}.demo_ecommerce`;
const sql = `
CREATE SCHEMA IF NOT EXISTS \`${dataset}\`
OPTIONS (
  location = 'US',
  labels = [('usage', 'demo')]
);


CREATE TABLE IF NOT EXISTS \`${dataset}.events\`
PARTITION BY event_date_dt
AS
SELECT
  *,
  PARSE_DATE('%Y%m%d', event_date) AS event_date_dt
FROM
  \`bigquery-public-data.ga4_obfuscated_sample_ecommerce.events_*\`;
`;

cp.execSync('bq query --use_legacy_sql=false', {
  encoding: 'utf8',
  input: sql,
  stdio: 'inherit',
});
console.log(`Created demo BigQuery resources in dataset ${dataset}`);
console.log();


await Bun.file(path.join(process.cwd(), 'catalog.yaml')).write(YAML.stringify({
  scope: `bq-dataset.${dataset}`,
  snapshot: {
    entries: [
      'dataplex-types.global.bigquery-dataset',
      'dataplex-types.global.bigquery-table',
      'dataplex-types.global.bigquery-view'
    ],
    aspects: [
      'dataplex-types.global.overview'
    ]
  },
  publishing: {
    entries: [
      'dataplex-types.global.bigquery-dataset',
      'dataplex-types.global.bigquery-table',
      'dataplex-types.global.bigquery-view'
    ],
    aspects: [
      'dataplex-types.global.overview'
    ]
  }
}, null, 2));
console.log('Created catalog.yaml manifest');
