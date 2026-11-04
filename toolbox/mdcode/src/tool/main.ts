// Main CLI entrypoint
//

import * as cac from 'cac';

import pkg from '../../package.json';
import * as commands from './commands';
import * as mcp from './mcp';

declare const __KCMD_COMMIT__: string|undefined;
const BUILD_COMMIT =
    typeof __KCMD_COMMIT__ === 'string' && __KCMD_COMMIT__ ? `+${__KCMD_COMMIT__}` : '';


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

const cli = cac.cac('kcmd').version(`${pkg.version}${BUILD_COMMIT}`).help();
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
    .option(
        '--format <format>',
        'How the workspace stores entries on disk, recorded in catalog.yaml for pull and push. Only `okf` (an OKF bundle under bundle/) is accepted; omit for the scope\'s default layout')
    .action((options) => run(() => commands.init(options)));


cli.command('pull', 'Pull catalog entries')
    .option(
        '--dry-run',
        'Reconstruct and report only; do not write or delete files (semantic-model and OKF layouts)')
    .option(
        '--force-remove',
        'Delete a differently-named local model or stale local OKF concept file not in Knowledge Catalog')
    .action((options) => run(() => commands.pull(options)));

cli.command('push', 'Push catalog entries')
    .option('--force', 'Has no effect')
    .option(
        '--force-remove',
        'Delete Knowledge Catalog models in the entry group that this push does not include (removed/renamed models); semantic-model push only')
    .option(
        '--emit-expressions',
        'No longer supported on push; set KC_V2_ASPECTS=1 to publish expression fields')
    .option(
        '--dry-run',
        'Run every check and show what would change, without applying anything')
    .option('--validate-only', 'Same as --dry-run')
    .option(
        '--skip-source-check',
        'Skip the checks that every source names a table Knowledge Catalog knows about and that the BigQuery and BigLake tables of each profile share a location; a Cloud SQL, Spanner or third-party source is still looked up for its dialect; semantic-model push only')
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
    // The value is optional because --no-deployment defaults this option to
    // true, which cac reports as a missing value when the value is required.
    .option('--deployment [names...]', 'Deploy only these deployments, by name')
    .option(
        '--no-deployment', 'Publish to Knowledge Catalog only; deploy nothing')
    // --emit-expressions, --no-profile, --no-kc, --profile and --all-profiles
    // stay registered only so push can say what replaces each: cac refuses an
    // unregistered option before push runs.
    .action((options) => run(async () => {
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
       'owl <action> <file>',
       'OWL ontology tools (action: import a .ttl ontology into an OSI model)')
    .option(
        '--out <path>',
        'Write the generated OSI document to this path instead of the semantic-model layout dir')
    .option(
        '--compact',
        'Emit compact flow YAML (primary_key: [id], inline field/relationship maps) instead of the default block layout')
    .action(
        (action, file, options) =>
            run(() => commands.owl(action, file, options)));


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
        'Add a BigQuery translation beside SQL in another dialect, in the model file and in each GOOGLE block profile or profile file the import writes, when all the profile\'s tables are in BigQuery or BigLake; off by default')
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
