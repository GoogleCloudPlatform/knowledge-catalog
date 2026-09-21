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
       'action-list',
       'List what a semantic model declares as runnable: parameters, executor, guards, blast radius, and the command that runs each one')
    .option(
        '--profile [name]',
        'Read the model under this binding profile; its deployment target names the database the action runs against; defaults to default_profile, else the inline bindings')
    .action(async (options) => {
      let exitCode = 1;
      try {
        exitCode = await commands.actionList(options);
      } catch (err: any) {
        console.error('Error:', err.message || err);
        exitCode = 1;
      }

      process.exit(exitCode);
    });


cli.command(
       'action-run <name>',
       'Run one of a semantic model\'s actions against the store its deployment target names; the guards it declares are NOT checked')
    .option(
        '--arg <name=value...>',
        'Bind one action parameter; repeat the flag for each one')
    .option(
        '--profile [name]',
        'Read the model under this binding profile; its deployment target names the database the action runs against; defaults to default_profile, else the inline bindings')
    .action(async (name, options) => {
      let exitCode = 1;
      try {
        exitCode = await commands.actionRun(name, options);
      } catch (err: any) {
        console.error('Error:', err.message || err);
        exitCode = 1;
      }

      process.exit(exitCode);
    });


cli.command(
       'agent-tools',
       'List what an agent holding this semantic model is offered')
    .option(
        '--profile [name]',
        'Read the model under this binding profile; defaults to default_profile, else the inline bindings')
    .action(async (options) => {
      let exitCode = 1;
      try {
        exitCode = await commands.agentTools(options);
      } catch (err: any) {
        console.error('Error:', err.message || err);
        exitCode = 1;
      }

      process.exit(exitCode);
    });


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
        'Read the model under this binding profile, which is what the skill\'s one deployment-specific section describes; defaults to default_profile, else the inline bindings')
    .option(
        '--force',
        'Replace a skill that is already there, including deleting a reference file for an action the model no longer declares')
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
// match in the same breath, so `action-run IssueCredit --help` arrives holding
// `IssueCredit` and `bogusverb --help` holding `bogusverb`, and neither of those
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
