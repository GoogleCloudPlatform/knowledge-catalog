// Main CLI entrypoint
//

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cac from 'cac';
import * as yaml from 'yaml';

import pkg from '../../package.json';
import {bind} from './bind';
import * as commands from './commands';
import * as mcp from './mcp';

declare const __KCMD_COMMIT__: string|undefined;
const BUILD_COMMIT =
    typeof __KCMD_COMMIT__ === 'string' && __KCMD_COMMIT__ ? `+${__KCMD_COMMIT__}` : '';
declare const __KCMD_VERSION__: string|undefined;
const CLI_VERSION =
    typeof __KCMD_VERSION__ === 'string' && __KCMD_VERSION__ ?
    __KCMD_VERSION__ :
    pkg.version;

declare const __KCMD_ENABLE_SEMANTIC__: boolean|undefined;
const ENABLE_SEMANTIC =
    typeof __KCMD_ENABLE_SEMANTIC__ === 'boolean' ?
    __KCMD_ENABLE_SEMANTIC__ :
    true;
const UNSUPPORTED_SEMANTIC_SCOPE_MESSAGE =
    'catalog.yaml names a semantic-model scope, which this version of kcmd does not support.';

function assertScopeSupported(basePath = '.'): void {
  if (ENABLE_SEMANTIC) return;
  const manifestPath = path.join(basePath, 'catalog.yaml');
  if (!fs.existsSync(manifestPath)) return;
  let parsed: unknown;
  try {
    parsed = yaml.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    // Malformed YAML is reported by CatalogManifest.load() downstream.
    return;
  }
  const scope = (parsed as {scope?: unknown}|null)?.scope;
  const isSemantic = (s: unknown): boolean =>
      typeof s === 'string' &&
      (s === 'semantic-model' || s.startsWith('semantic-model.'));
  if (isSemantic(scope) || (Array.isArray(scope) && scope.some(isSemantic))) {
    throw new Error(UNSUPPORTED_SEMANTIC_SCOPE_MESSAGE);
  }
}


// Runs a command and exits with the code it gives. An exception prints as an
// error and exits with 1.
async function run(command: () => Promise<number>): Promise<void> {
  let exitCode = 1;
  try {
    exitCode = await command();
  } catch (err: any) {
    console.error('Error:', err.message || err);
  }
  process.exit(exitCode);
}

const cli = cac.cac('kcmd').version(`${CLI_VERSION}${BUILD_COMMIT}`).help();
const initCmd = cli.command('init', 'Initialize a new catalog snapshot')
    .option(
        '--entry-group <id>',
        'Identifier of the EntryGroup (project.location.id)')
    .option(
        '--bigquery-dataset <id...>',
        'Identifier of the BigQuery dataset(s) (project.datasetId)')
    .option(
        '--kb <id>',
        'Identifier of the Knowledge Base EntryGroup (project.location.id)');
if (ENABLE_SEMANTIC) {
  initCmd.option(
      '--semantic-model <id>',
      'Semantic model scope as <projectId>.<locationId>.<entryGroupId>');
}
initCmd.option('--pull', 'Optionally pull catalog entries during initialization')
    .option(
        '--format <format>',
        'How the workspace stores entries on disk, recorded in catalog.yaml for pull and push. Only `okf` (an OKF bundle under bundle/) is accepted; omit for the scope\'s default layout')
    .action((options) => run(async () => {
      // Fail before commands.init(), whose error message lists --semantic-model.
      if (!ENABLE_SEMANTIC && !options.entryGroup && !options.bigqueryDataset &&
          !options.kb) {
        throw new Error('Must provide --entry-group, --bigquery-dataset, or --kb');
      }
      return commands.init(options);
    }));


cli.command('pull', 'Pull catalog entries')
    .option(
        '--dry-run',
        'Reconstruct and report only; do not write or delete files')
    .option(
        '--force-remove',
        ENABLE_SEMANTIC ?
            'Delete a differently-named local model or stale local OKF concept file not in Knowledge Catalog' :
            'Delete stale local OKF concept files not in Knowledge Catalog')
    .action((options) => run(async () => {
      assertScopeSupported();
      return commands.pull(options);
    }));

const pushCmd = cli.command('push', 'Push catalog entries')
    .option('--force', 'Has no effect');
if (ENABLE_SEMANTIC) {
  pushCmd
      .option(
          '--force-remove',
          'Delete Knowledge Catalog models in the entry group that this push does not include (removed/renamed models); semantic-model push only')
      .option(
          '--emit-expressions',
          'No longer supported; push publishes expression fields by default');
}
pushCmd
    .option(
        '--dry-run',
        'Run every check and show what would change, without applying anything')
    .option('--validate-only', 'Same as --dry-run');
if (ENABLE_SEMANTIC) {
  pushCmd
      .option(
          '--skip-source-check',
          'Skip the checks that every source names a table Knowledge Catalog knows about and that the BigQuery and BigLake tables of each profile share a location; a Cloud SQL, Spanner or third-party source is still looked up for its dialect; semantic-model push only')
      .option(
          '--no-metric-graphs',
          'Do not deploy the GRAPH_EXPAND metric graphs (one per fact entity, `<graph>__<fact>_metrics`) and fallback metric views next to each BigQuery graph; they are deployed by default (proposed); semantic-model push only')
      .option(
          '--no-profile',
          'No longer supported on push; use --no-deployment to skip database deployments, or --deployment <name> to select one')
      .option(
          '--no-kc',
          'No longer supported on push; every push publishes the model to Knowledge Catalog')
      .option(
          '--print',
          'Print each pushed destination\'s generated artifact in its native format (BigQuery/Spanner Graph SQL DDL, Knowledge Catalog entry plan); semantic-model push only')
      .option(
          '--transpile',
          'No longer supported on push; use kcmd import --transpile to translate SQL dialects in a model and each profile whose tables are all in BigQuery or BigLake')
      .option(
          '--profile [name]',
          'No longer supported on push; declare a deployment with profile: prod under deployments: and run kcmd push --deployment <name>')
      .option(
          '--all-profiles',
          'No longer supported on push; kcmd push deploys every entry under deployments: by default')
      .option(
          '--strict-profile',
          'Before each BigQuery graph deploy, profile the bound data as `kcmd profile` does and stop if the data contradicts any statement (proposed); read-only, so it also runs under --validate-only; semantic-model push only');
  // --emit-expressions, --no-profile, --no-kc, --profile and --all-profiles
  // stay registered only so push can say what replaces each: cac refuses an
  // unregistered option before push runs.
  pushCmd
      // The value is optional because --no-deployment defaults this option to
      // true, which cac reports as a missing value when the value is required.
      .option('--deployment [names...]', 'Deploy only these deployments, by name')
      .option(
          '--no-deployment', 'Publish to Knowledge Catalog only; deploy nothing');
}
pushCmd.action((options) => run(async () => {
  assertScopeSupported();
  const args = process.argv.slice(2);
  const deployment = commands.typedDeployment(args);
  // cac gives a bare --profile, or --profile= with no value, the same true
  // it gives an absent one, so read whether it was typed, as for
  // --deployment.
  const end = args.indexOf('--');
  const typed = end < 0 ? args : args.slice(0, end);
  const profile = options.profile === true &&
          typed.some(a => a === '--profile' || a.startsWith('--profile=')) ?
      '' :
      options.profile;
  return commands.push({...options, deployment, profile});
}));


if (ENABLE_SEMANTIC) {
  cli.command(
         'profiles',
         'List a semantic model\'s binding profiles, what each can answer, and what push would reject')
      .option(
          '--profile [name]',
          'Report only this binding profile; defaults to every profile the model declares')
      .option(
          '--print-store',
          'Print only the store the profile deploys to, on one line and nothing else, for a script to read: project/instance/database for Spanner, and the backend named ahead of the path for any other store')
      .action((options) => run(() => commands.profiles(options)));


  cli.command(
         'owl <action> [...files]',
         'OWL ontology tools (action: import one or more .ttl files of one ontology into an OSI model; local owl:imports are followed)')
      .option(
          '--out <path>',
          'Write the generated OSI document to this path instead of the semantic-model layout dir')
      .option(
          '--name <model>',
          'Name the generated model; defaults to the first file\'s stem (sales.owl.ttl -> sales)')
      .option(
          '--compact',
          'Emit compact flow YAML (primary_key: [id], inline field/relationship maps) instead of the default block layout')
      .option(
          '--prune-unbound [binding]',
          'Proposed: keep only the entities the binding gives a source, their ancestors and the defined entities over them, and print what was removed. The value is a binding profile (or a model document with inline bindings); the bare flag reads the model\'s profiles in this scope, else the <model>.profile.<name>.yaml files beside --out')
      .option(
          '--coverage [path]',
          'Proposed: write the coverage report (each construct read: compiled, hinted or dropped, with the reason) here instead of coverage.json beside the written model')
      .option('--no-coverage', 'Print no coverage summary and write no coverage report')
      .action(
          (action, files, options) =>
              run(() => commands.owl(action, files, options)));


  cli.command(
         'shacl <action> [...files]',
         'SHACL shape tools (action: import .ttl shapes into an existing model as constraints)')
      .option(
          '--into <path>',
          'The model document to add the constraints to (default: the --model model in the semantic-model layout)')
      .option(
          '--model <name>',
          'The model receiving the constraints (required without --into; with --into it confirms the document\'s one model)')
      .option(
          '--out <path>',
          'Write the updated document to this path instead of back to its source')
      .option(
          '--coverage [path]',
          'Proposed: write the coverage report (each shape and constraint component: compiled, hinted or dropped, with the reason) here instead of coverage.json beside the written model')
      .option('--no-coverage', 'Print no coverage summary and write no coverage report')
      .action(
          (action, files, options) =>
              run(() => commands.shacl(action, files, options)));


  cli.command(
         'import <file>',
         'Import a semantic model file, repairing a third-party file or converting a first-party one, into the flavor --flavor names')
      .option(
          '--input <who>',
          'Who wrote the file: third-party, a file another product wrote (default), or first-party, a file written for kcmd')
      .option('--flavor <flavor>', 'Flavor to write: ossie or google; required')
      .option(
          '--source-prefix <prefix>',
          'GCP resource name of the database whose tables complete each bare table name, such as bigquery.googleapis.com/projects/p/datasets/d, or the Knowledge Catalog entry group projects/p/locations/l/entryGroups/g whose table entries complete them by fullyQualifiedName')
      .option(
          '--transpile',
          'Add a BigQuery translation beside SQL in another dialect when it can translate the text, in the model file and in each GOOGLE block profile or profile file the import writes, when all the profile\'s tables are in BigQuery or BigLake; off by default')
      .option(
          '--out <path>',
          'A .yaml file to write the one output file to, or a directory to write each output file into; defaults to the semantic-model layout')
      .action((file, options) => run(() => commands.importModel(file, options)));


  cli.command(
         'skills-generate',
         'Write each model in the scope out as an Agent Skill: a SKILL.md an agent loads, with one reference file per action')
      .option(
          '--out <dir>',
          'Directory to write the skill directories under; each skill takes a directory of its own, named after the skill. Defaults to `skills`')
      .option(
          '--name <name>',
          'Name the skill, and so its directory; lowercase letters, digits and single hyphens. Defaults to the model\'s own name. Applies only to a scope with one model')
      .option(
          '--profile [name]',
          'Read the model under this binding profile, which is what the skill\'s one deployment-specific section describes; defaults to the inline bindings')
      .option(
          '--force',
          'Replace a skill that is already there, including deleting a reference file for an action the model no longer declares')
      .action((options) => run(() => commands.skillsGenerate(options)));


  cli.command(
         'validate',
         'Check the data the binding profile binds against the model\'s constraints (imported SHACL / OWL rules, keys, foreign keys): one violation-count query per rule. Writes the queries, runs them, and optionally publishes the results to Knowledge Catalog')
      .option('--target <target>', 'The engine to check on. Only `bigquery`')
      .option(
          '--profile [name]',
          'Check the tables this binding profile binds; defaults to the inline bindings')
      .option(
          '--out <dir>',
          'Directory for <model>.validation.sql, <model>.validation.json (the manifest) and <model>.results.json. Defaults to `validation`')
      .option(
          '--sql-only',
          'Write the queries and the manifest, and run nothing (also the behaviour when there are no credentials)')
      .option(
          '--examples <n>',
          'Violating keys to sample for each failing check (default 5; 0 skips the examples queries)')
      .option(
          '--location <location>',
          'BigQuery processing location for the query jobs (e.g. US); inferred from the tables when unset')
      .option(
          '--publish',
          'Write the results to Knowledge Catalog: a semantic-constraint-results aspect on each checked entity\'s entry (run `kcmd push` first)')
      .option(
          '--no-structural',
          'Check only the model\'s constraints, not its primary keys, unique keys and foreign keys')
      .action((options) => run(() => commands.validate(options)));


  cli.command(
         'test',
         '(Proposed) Contract tests generated from the model: the graph\'s is<Class> properties match the defined classes\' expressions, quantified paths over transitive relationships match a recursive SQL closure, and every validation query executes. Writes the tests, runs them read-only, and reports pass / fail')
      .option('--target <target>', 'The engine to test on. Only `bigquery`')
      .option(
          '--profile [name]',
          'Test the graph and tables this binding profile binds; defaults to the inline bindings')
      .option(
          '--out <dir>',
          'Directory for <model>.contract.sql, <model>.contract.json (the manifest) and <model>.contract-results.json. Defaults to `contract-tests`')
      .option(
          '--sql-only',
          'Write the tests and the manifest, and run nothing (also the behaviour when there are no credentials)')
      .option(
          '--location <location>',
          'BigQuery processing location for the query jobs (e.g. US); inferred from the tables when unset')
      .option(
          '--path-bound <k>',
          'The k of the quantified paths -[:p]->{1,k} the transitive-closure tests compare (default 10)')
      .action((options) => run(() => commands.contractTest(options)));


  cli.command(
         'profile',
         'Check the model\'s claims against the data the binding profile binds (proposed): keys identify rows, relationships keep their cardinality and reach a row, fields take their declared values, a unit\'s magnitudes agree across fields, a series keeps one scale over time, required fields are set. Each claim becomes a statement -- verified, unverified or contradicted -- with its evidence. Writes the queries, runs them (read-only), and optionally publishes the statements to Knowledge Catalog')
      .option('--target <target>', 'The engine to profile on. Only `bigquery`, the default')
      .option(
          '--profile [name]',
          'Profile the tables this binding profile binds; defaults to the inline bindings')
      .option(
          '--out <dir>',
          'Directory for profile.sql (the queries), profile.json (each statement\'s status and evidence) and profile.md (a summary table). Defaults to `profiling`')
      .option(
          '--sql-only',
          'Write profile.sql and run nothing (also the behaviour when there are no credentials)')
      .option(
          '--location <location>',
          'BigQuery processing location for the query jobs (e.g. US); inferred from the tables when unset')
      .option(
          '--project <project>',
          'Project the query jobs run and bill in; defaults to the gcloud project')
      .option('--label <key:value>', 'Label every query job; repeatable')
      .option('--strict', 'Exit 1 when the data contradicts any statement')
      .option(
          '--publish',
          'Write the statements to Knowledge Catalog: a semantic-profile-results aspect on each profiled entity\'s entry (run `kcmd push` first)')
      .option('--dry-run', 'With --publish: print the Knowledge Catalog requests; send nothing')
      .option(
          '--examples <n>',
          'Offending values to list per statement: repeated keys, orphaned foreign keys, values outside a declared set (default 5; 0 lists none)')
      .option(
          '--magnitude-orders <x>',
          'Units: how many orders of magnitude a field\'s median may sit from the median of the other fields with its unit and scale before it is flagged (default 2)')
      .option('--window-months <n>', 'Scale over time: the window length in months (default 3)')
      .option(
          '--shift-factor <x>',
          'Scale over time: the ratio between neighbouring windows\' medians that counts as a break (default 50)')
      .option(
          '--min-window-rows <n>',
          'Scale over time: the non-zero values a window needs to be compared at all (default 30)')
      .action((options) => run(() => commands.profile(options)));


  cli.command(
         'bind',
         '(Proposed) Propose a binding profile from the raw warehouse: score every concrete entity against every scanned table (name, key, field coverage), match fields to columns, profile the chosen tables and propose hydration (grain, resolve, normalize, derive_from; constraints with --enforce-constraints). Writes <model>.profile.<profile>.yaml and bind_report.md; exits 2 when something needs review')
      .option('--profile <name>', 'The binding profile to write (default `bigquery`)')
      .option('--scan <pattern>', 'The datasets to scan, as <project>.<dataset glob> (e.g. my-project.ps_*)')
      .option('--scan-file <file>', 'Read the scan from a file instead: a bind_scan.json, or an INFORMATION_SCHEMA.COLUMNS CSV export')
      .option('--model <file>', 'Bind this model document instead of the scope\'s; the profile is written beside it as <file stem>.profile.<profile>.yaml')
      .option('--from-catalog', 'Bind the model pulled from Knowledge Catalog (the scope\'s entry group) instead of the local documents')
      .option('--accept-review', 'Accept every review item: bind each needs-review entity to its best candidate and switch on the proposed normalize rules')
      .option('--enforce-constraints', 'Write `hydration.constraints: enforce` on every entity whose node view applies or reports one of the model\'s constraints: reads then see reject rules\' failing values withheld (or the row excluded, for a required field or the key) and every broken rule named in `_warnings`')
      .option('--no-profile-data', 'Do not profile the chosen tables (no hydration proposals)')
      .option('--exclude <glob>', 'Leave datasets matching this glob out of the scan; repeatable. The deployment target\'s dataset is always left out')
      .option('--include-views', 'Consider views as well as base tables')
      .option('--kc-search', 'Also search Knowledge Catalog for each entity\'s names (a 0.10 score signal)')
      .option('--deployment-target <uri>', 'The BigQuery graph target (bigquery.googleapis.com/projects/<p>/datasets/<d>/propertyGraphs/<g>) recorded under deployments: in <model>.yaml and excluded from the scan')
      .option('--location <location>', 'BigQuery location of the scanned datasets (default US)')
      .option('--project <project>', 'Project the query jobs run and bill in; defaults to the scanned project')
      .option('--label <key:value>', 'Label every query job; repeatable')
      .option('--out <dir>', 'Directory for bind_report.md and bind_scan.json (default: beside the model document)')
      .action((options) => run(() => bind(options)));


  cli.command(
         'glossary <action>',
         'Publish each model\'s `glossary` block as a Knowledge Catalog Business Glossary (action: push): the glossary, its categories and terms, `related` links between terms, and `definition` links from the BigQuery tables / columns and semantic entries the terms define. Idempotent; run after `kcmd push`')
      .option(
          '--profile [name]',
          'Resolve table bindings through this binding profile; defaults to the inline bindings')
      .option('--dry-run', 'Print the REST requests; send nothing')
      .option(
          '--prune-glossary',
          'Delete the terms and categories kcmd published for the model that the spec no longer declares')
      .option(
          '--project <project>',
          'Project that owns the glossary (default: the catalog.yaml source project)')
      .option('--location <location>', 'Glossary location (default: global)')
      .option(
          '--no-semantic-links',
          'Do not link terms to the semantic entity / metric entries kcmd publishes (BigQuery table links only)')
      .action((action, options) => run(() => commands.glossary(action, options)));
}


cli.command('mcp', 'Run the Model Context Protocol (MCP) server')
    .option('--path <path>', 'Path to the catalog snapshot root directory')
    .action(async (options) => {
      try {
        assertScopeSupported(options.path ?? '.');
      } catch (err: any) {
        console.error('Error:', err.message || err);
        process.exit(1);
      }
      try {
        await mcp.startServer(options.path);
      } catch (err: any) {
        console.error('Error starting MCP server:', err.message || err);
        process.exit(1);
      }
    });


try {
  cli.parse();
} catch (err: any) {
  console.error('Error:', err.message || err);
  process.exit(1);
}

// When cac serves `--help` or `--version` itself it prints and then calls
// unsetMatchedCommand(), so a request that was answered arrives at the block
// below looking exactly like a command that was never found. Take it as
// handled: it has already printed, and asking for help is not an error.
//
// The cleared match is what makes it safe to exit here, so test for that
// rather than for the flag. cac serves `--version` only when no command
// matched; with one matched it runs the action instead and leaves the match
// in place, and since every action returns a promise, `cli.parse()` has
// returned while the action is still pending at its first await. Exiting on
// the flag alone would kill `kcmd push --version` mid-write and report success.
//
// It is not enough on its own, though. cac serves `--help` for a command it
// never found, so a typo'd verb with `--help` on it arrives here cleared in
// exactly the same way and would exit 0 -- a script that misspells a
// subcommand would read success. What separates the two is the verb the caller
// actually typed, which cac does not keep once it has cleared the match, so
// read it off `process.argv` rather than off `cli.args`. `cli.args` cannot
// answer this: cac strips a matched command's own name from it and clears the
// match in the same breath, so `owl import --help` arrives holding
// `import` and `bogusverb --help` holding `bogusverb`, and neither of those
// words names a command.
//
// The verb is the first token that is not a flag, not the first token: the
// flag may come first, and `kcmd --help bogusverb` still misspells a
// subcommand. Scanning is exact here because the only options cac takes ahead
// of a command are `--help` and `--version`, and neither swallows a value that
// could be mistaken for the verb.
const typed = process.argv.slice(2).find(arg => !arg.startsWith('-'));
const verbIsKnown =
    typed === undefined || cli.commands.some(c => c.name === typed);
if (!cli.matchedCommand && (cli.options.help || cli.options.version) &&
    verbIsKnown) {
  process.exit(0);
}

if (!cli.matchedCommand) {
  if (cli.args.length > 0) {
    console.error(`Error: Unknown command '${cli.args[0]}'`);
  }

  // cac has already printed usage if it was `--help` that got us here, and a
  // second copy of it under the error reads as two separate answers.
  if (!cli.options.help) cli.outputHelp();
  process.exit(1);
}
