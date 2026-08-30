// Main CLI entrypoint
//

import * as cac from 'cac';

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
        '--no-graph',
        'Skip the graph deploy and publish only the logical model to Knowledge Catalog; the graph is deployed by default to the backend each model\'s deployment target names; semantic-model push only')
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
        '--profile <name>',
        'Binding profile whose physical bindings feed the graph leg (reads <model>.profiles/<name>.yaml); its deployment target selects the graph backend; defaults to default_profile, else the inline bindings; mutually exclusive with --all-profiles; semantic-model push only')
    .option(
        '--all-profiles',
        'Deploy the graph once per defined binding profile (plus the inline bindings when the document declares a target); Knowledge Catalog still records the default binding; mutually exclusive with --profile; semantic-model push only')
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
    .action(async () => {
      let exitCode = 1;
      try {
        exitCode = await commands.profiles();
      } catch (err: any) {
        console.error('Error:', err.message || err);
        exitCode = 1;
      }

      process.exit(exitCode);
    });


cli.command(
       'owl <action> <file>',
       'OWL ontology tools (action: import a .ttl ontology into an OSI model)')
    .option(
        '--out <path>',
        'Write the generated OSI document to this path instead of the semantic-model layout dir')
    .option(
        '--compact',
        'Emit compact flow YAML (primary_key: [id], inline field/relationship maps) instead of the default block layout')
    .action(async (action, file, options) => {
      let exitCode = 1;
      try {
        exitCode = await commands.owl(action, file, options);
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

if (!cli.matchedCommand) {
  if (cli.args.length > 0) {
    console.error(`Error: Unknown command '${cli.args[0]}'`);
  }

  cli.outputHelp();
  process.exit(1);
}
