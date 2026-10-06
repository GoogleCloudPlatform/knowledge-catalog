// Main CLI entrypoint
//

import * as cac from 'cac';

import {bind} from './bind';
import * as commands from './commands';
import * as mcp from './mcp';


const cli = cac.cac('kcmd').version('1.0.0').help();
cli.command('init', 'Initialize a new catalog snapshot')
    .option(
        '--entry-group <id>',
        'Identifier of the EntryGroup (project.location.id)')
    .option(
        '--bigquery-dataset <id...>',
        'Identifier of the BigQuery dataset(s) (project.datasetId)')
    .option(
        '--kb <id>',
        'Identifier of the Knowledge Base EntryGroup (project.location.id)')
    .option(
        '--semantic-model <id>',
        'Semantic model scope as <projectId>.<locationId>.<entryGroupId>')
    .option('--pull', 'Optionally pull catalog entries during initialization')
    .action(async (options) => {
      let exitCode = 1;
      try {
        exitCode = await commands.init(options);
      } catch (err: any) {
        console.error('Error:', err.message || err);
        exitCode = 1;
      }

      process.exit(exitCode);
    });


cli.command('pull', 'Pull catalog entries')
    .option(
        '--dry-run',
        'Reconstruct and report only; do not write files (semantic-model scope)')
    .option(
        '--force-remove',
        'Delete a differently-named local model and replace it with the catalog\'s; without it, a pull that would leave two models in the entry group fails (semantic-model scope)')
    .action(async (options) => {
      let exitCode = 1;
      try {
        exitCode = await commands.pull(options);
      } catch (err: any) {
        console.error('Error:', err.message || err);
        exitCode = 1;
      }

      process.exit(exitCode);
    });

cli.command('push', 'Push catalog entries')
    .option('--force', 'Force push changes')
    .option(
        '--force-remove',
        'Delete Knowledge Catalog models in the entry group that this push does not include (removed/renamed models); semantic-model push only')
    .option(
        '--emit-expressions',
        'Emit SQL-expression fields not yet in the published Knowledge Catalog system-type templates (per-field schema semantics, metric expression); off by default, enable once the templates support them; semantic-model push only')
    .option('--validate-only', 'Only validate changes without applying')
    .option(
        '--dry-run',
        'The same as --validate-only: run every check and print the plan (with --print, the generated DDL), applying nothing')
    .option(
        '--no-metric-graphs',
        'Do not deploy the GRAPH_EXPAND metric graphs (one per fact entity, `<graph>__<fact>_metrics`) and fallback metric views next to each BigQuery graph; they are deployed by default (proposed); semantic-model push only')
    .option(
        '--no-profile',
        'Deploy the graph for no binding profile: publish only the logical model to Knowledge Catalog, leaving any deployed graph untouched; the graph is deployed by default for the default binding profile; semantic-model push only')
    .option(
        '--no-kc',
        'Skip the Knowledge Catalog metadata push and deploy only the graph; Knowledge Catalog is pushed by default; semantic-model push only')
    .option(
        '--print',
        'Print each pushed destination\'s generated artifact in its native format (BigQuery/Spanner Graph SQL DDL, Knowledge Catalog entry plan); semantic-model push only')
    .option(
        '--transpile',
        'Rewrite vendor-dialect (e.g. Snowflake/Databricks) expressions to GoogleSQL before deploying, filling target expressions the loader left unset; semantic-model push only')
    .option(
        '--profile [name]',
        'Deploy the graph for one binding profile (reads <model>.profiles/<name>.yaml); its deployment target selects the graph backend; defaults to default_profile, else the inline bindings; mutually exclusive with --all-profiles and --no-profile; semantic-model push only')
    .option(
        '--all-profiles',
        'Deploy the graph for every defined binding profile (plus the inline bindings when the document declares a target); Knowledge Catalog still records the default binding; mutually exclusive with --profile and --no-profile; semantic-model push only')
    .option(
        '--strict-profile',
        'Before each BigQuery graph deploy, profile the bound data as `kcmd profile` does and stop if the data contradicts any statement (proposed); read-only, so it also runs under --validate-only; semantic-model push only')
    .action(async (options) => {
      let exitCode = 1;
      try {
        exitCode = await commands.push(options);
      } catch (err: any) {
        console.error('Error:', err.message || err);
        exitCode = 1;
      }

      process.exit(exitCode);
    });


cli.command(
       'profiles',
       'List a semantic model\'s binding profiles and what each can answer')
    .option(
        '--profile [name]',
        'Report only this binding profile; defaults to every profile the model declares')
    .option(
        '--print-store',
        'Print only the store the profile deploys to, on one line and nothing else, for a script to read: project/instance/database for Spanner, and the backend named ahead of the path for any other store')
    .action(async (options) => {
      let exitCode = 1;
      try {
        exitCode = await commands.profiles(options);
      } catch (err: any) {
        console.error('Error:', err.message || err);
        exitCode = 1;
      }

      process.exit(exitCode);
    });


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
        'Proposed: keep only the entities the binding gives a source, their ancestors and the defined entities over them, and print what was removed. The value is a binding profile (or a model document with inline bindings); the bare flag reads the model\'s profiles in this scope, else <model>.profiles/ beside --out')
    .option(
        '--coverage <path>',
        'Proposed: write the coverage report (each construct read: compiled, hinted or dropped, with the reason) here instead of coverage.json beside the written model')
    .option('--no-coverage', 'Print no coverage summary and write no coverage report')
    .action(async (action, files, options) => {
      let exitCode = 1;
      try {
        exitCode = await commands.owl(action, files, options);
      } catch (err: any) {
        console.error('Error:', err.message || err);
        exitCode = 1;
      }

      process.exit(exitCode);
    });


cli.command(
       'shacl <action> [...files]',
       'SHACL shape tools (action: import .ttl shapes into an existing model as constraints)')
    .option(
        '--into <path>',
        'The model document to add the constraints to (default: the --model model in the semantic-model layout)')
    .option(
        '--model <name>',
        'The model receiving the constraints (required without --into, or when the document declares several)')
    .option(
        '--out <path>',
        'Write the updated document to this path instead of back to its source')
    .option(
        '--coverage <path>',
        'Proposed: write the coverage report (each shape and constraint component: compiled, hinted or dropped, with the reason) here instead of coverage.json beside the written model')
    .option('--no-coverage', 'Print no coverage summary and write no coverage report')
    .action(async (action, files, options) => {
      let exitCode = 1;
      try {
        exitCode = await commands.shacl(action, files, options);
      } catch (err: any) {
        console.error('Error:', err.message || err);
        exitCode = 1;
      }

      process.exit(exitCode);
    });


cli.command(
       'skills-generate',
       'Write each model in the scope out as an Agent Skill: a SKILL.md an agent loads, with reference files it reads on demand (one per action, or per entity in query mode)')
    .option(
        '--out <dir>',
        'Directory to write the skill directories under; each skill takes a directory of its own, named after the skill. Defaults to `skills`')
    .option(
        '--name <name>',
        'Name the skill, and so its directory; lowercase letters, digits and single hyphens. Defaults to the model\'s own name. Applies only to a scope with one model')
    .option(
        '--profile [name]',
        'Read the model under this binding profile, which is what the skill\'s one deployment-specific section describes; defaults to default_profile, else the inline bindings')
    .option(
        '--mode <mode>',
        'act (default): a router over the model\'s actions. query: an index for answering questions over the BigQuery property graph (GQL, GRAPH_EXPAND metrics, SQL). both: one skill with the two')
    .option(
        '--extra-scope <dir>',
        'Query mode: another catalog scope (a directory with catalog.yaml) whose BigQuery graph the skill should also point at, e.g. a metrics slice for GRAPH_EXPAND. Repeatable')
    .option(
        '--location <location>',
        'Query mode: the BigQuery location to name in the skill (the model does not record it)')
    .option(
        '--no-metric-graphs',
        'Query mode: read metrics on the main graph only, not on the GRAPH_EXPAND metric graphs and fallback views `kcmd push` deploys next to it (for a graph pushed with --no-metric-graphs)')
    .option(
        '--force',
        'Replace a skill that is already there, including deleting a reference file the model no longer produces')
    .action(async (options) => {
      let exitCode = 1;
      try {
        exitCode = await commands.skillsGenerate(options);
      } catch (err: any) {
        console.error('Error:', err.message || err);
        exitCode = 1;
      }

      process.exit(exitCode);
    });


cli.command(
       'validate',
       'Check the data the binding profile binds against the model\'s constraints (imported SHACL / OWL rules, keys, foreign keys): one violation-count query per rule. Writes the queries, runs them, and optionally publishes the results to Knowledge Catalog')
    .option('--target <target>', 'The engine to check on. Only `bigquery`')
    .option(
        '--profile [name]',
        'Check the tables this binding profile binds; defaults to default_profile, else the inline bindings')
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
    .action(async (options) => {
      let exitCode = 1;
      try {
        exitCode = await commands.validate(options);
      } catch (err: any) {
        console.error('Error:', err.message || err);
        exitCode = 1;
      }

      process.exit(exitCode);
    });


cli.command(
       'test',
       '(Proposed) Contract tests generated from the model: the graph\'s is<Class> properties match the defined classes\' expressions, quantified paths over transitive relationships match a recursive SQL closure, and every validation query executes. Writes the tests, runs them read-only, and reports pass / fail')
    .option('--target <target>', 'The engine to test on. Only `bigquery`')
    .option(
        '--profile [name]',
        'Test the graph and tables this binding profile binds; defaults to default_profile, else the inline bindings')
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
    .action(async (options) => {
      let exitCode = 1;
      try {
        exitCode = await commands.contractTest(options);
      } catch (err: any) {
        console.error('Error:', err.message || err);
        exitCode = 1;
      }

      process.exit(exitCode);
    });


cli.command(
       'profile',
       'Check the model\'s claims against the data the binding profile binds (proposed): keys identify rows, relationships keep their cardinality and reach a row, fields take their declared values, a unit\'s magnitudes agree across fields, a series keeps one scale over time, required fields are set. Each claim becomes a statement -- verified, unverified or contradicted -- with its evidence. Writes the queries, runs them (read-only), and optionally publishes the statements to Knowledge Catalog')
    .option('--target <target>', 'The engine to profile on. Only `bigquery`, the default')
    .option(
        '--profile [name]',
        'Profile the tables this binding profile binds; defaults to default_profile, else the inline bindings')
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
    .action(async (options) => {
      let exitCode = 1;
      try {
        exitCode = await commands.profile(options);
      } catch (err: any) {
        console.error('Error:', err.message || err);
        exitCode = 1;
      }

      process.exit(exitCode);
    });


cli.command(
       'bind',
       '(Proposed) Propose a binding profile from the raw warehouse: score every concrete entity against every scanned table (name, key, field coverage), match fields to columns, profile the chosen tables and propose hydration (grain, resolve, normalize, derive_from). Writes <model>.profiles/<profile>.yaml and bind_report.md; exits 2 when something needs review')
    .option('--profile <name>', 'The binding profile to write (default `bigquery`)')
    .option('--scan <pattern>', 'The datasets to scan, as <project>.<dataset glob> (e.g. my-project.ps_*)')
    .option('--scan-file <file>', 'Read the scan from a file instead: a bind_scan.json, or an INFORMATION_SCHEMA.COLUMNS CSV export')
    .option('--model <file>', 'Bind this model document instead of the scope\'s; the profile is written to <file stem>.profiles/ beside it')
    .option('--from-catalog', 'Bind the model pulled from Knowledge Catalog (the scope\'s entry group) instead of the local documents')
    .option('--accept-review', 'Accept every review item: bind each needs-review entity to its best candidate and switch on the proposed normalize rules')
    .option('--no-profile-data', 'Do not profile the chosen tables (no hydration proposals)')
    .option('--exclude <glob>', 'Leave datasets matching this glob out of the scan; repeatable. The deployment target\'s dataset is always left out')
    .option('--include-views', 'Consider views as well as base tables')
    .option('--kc-search', 'Also search Knowledge Catalog for each entity\'s names (a 0.10 score signal)')
    .option('--deployment-target <uri>', 'The deployment target the profile declares; defaults to the existing profile\'s, else the model\'s')
    .option('--location <location>', 'BigQuery location of the scanned datasets (default US)')
    .option('--project <project>', 'Project the query jobs run and bill in; defaults to the scanned project')
    .option('--label <key:value>', 'Label every query job; repeatable')
    .option('--out <dir>', 'Directory for bind_report.md and bind_scan.json (default: the profile\'s directory)')
    .action(async (options) => {
      let exitCode = 1;
      try {
        exitCode = await bind(options);
      } catch (err: any) {
        console.error('Error:', err.message || err);
        exitCode = 1;
      }

      process.exit(exitCode);
    });


cli.command(
       'glossary <action>',
       'Publish each model\'s `glossary` block as a Knowledge Catalog Business Glossary (action: push): the glossary, its categories and terms, `related` links between terms, and `definition` links from the BigQuery tables / columns and semantic entries the terms define. Idempotent; run after `kcmd push`')
    .option(
        '--profile [name]',
        'Resolve table bindings through this binding profile; defaults to default_profile, else the inline bindings')
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
    .action(async (action, options) => {
      let exitCode = 1;
      try {
        exitCode = await commands.glossary(action, options);
      } catch (err: any) {
        console.error('Error:', err.message || err);
        exitCode = 1;
      }

      process.exit(exitCode);
    });


cli.command('mcp', 'Run the Model Context Protocol (MCP) server')
    .option('--path <path>', 'Path to the catalog snapshot root directory')
    .action(async (options) => {
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
// in place, and since every action is async, `cli.parse()` has returned while
// the action is still pending at its first await. Exiting on the flag alone
// would kill `kcmd push --version` mid-write and report success.
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
