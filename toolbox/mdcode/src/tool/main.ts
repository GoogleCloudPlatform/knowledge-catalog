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


cli.command(
       'action <command> [name]',
       'Semantic model actions (command: `list` what the model declares, or `run` one against its store)')
    .option(
        '--arg <name=value...>',
        'Bind one action parameter; repeat the flag for each one (`run` only)')
    .option(
        '--profile [name]',
        'Read the model under this binding profile; its deployment target names the database the action runs against; defaults to default_profile, else the inline bindings')
    .option(
        '--store',
        'Print only where a run would land: project/instance/database for Spanner, and the backend named ahead of the path for any other store (`list` only)')
    .option(
        '--judge [model]',
        'Settle guards the model states in words by asking Gemini on Vertex AI, naming a model or taking the default; without it, an action guarded by such a rule is refused rather than run unchecked (`run` only)')
    .option(
        '--judge-location <region>',
        'Ask the judge in this Vertex AI region, which is where the argument values are sent; defaults to us-central1 (`run` only)')
    .option(
        '--judge-reads-store',
        'Let the judge read the model\'s own tables while it decides, so a rule stated in words can compare the call against what is recorded; costs one model call more per guard and needs --judge (`run` only)')
    .action(async (command, name, options) => {
      let exitCode = 1;
      try {
        exitCode = await commands.action(command, name, options);
      } catch (err: any) {
        console.error('Error:', err.message || err);
        exitCode = 1;
      }

      process.exit(exitCode);
    });


cli.command(
       'agent <command>',
       'Agent bindings for a semantic model (command: `tools`, what an agent is offered)')
    .option(
        '--profile [name]',
        'Read the model under this binding profile; defaults to default_profile, else the inline bindings')
    .option(
        '--judge [model]',
        'List what an agent holding a judge is offered, naming a Gemini model or taking the default; without it, an action guarded by a rule stated in words is marked NOT RUNNABLE. No model is called either way')
    .action(async (command, options) => {
      let exitCode = 1;
      try {
        exitCode = await commands.agent(command, options);
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
if (!cli.matchedCommand && (cli.options.help || cli.options.version)) {
  process.exit(0);
}

if (!cli.matchedCommand) {
  if (cli.args.length > 0) {
    console.error(`Error: Unknown command '${cli.args[0]}'`);
  }

  cli.outputHelp();
  process.exit(1);
}
