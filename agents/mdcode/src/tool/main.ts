// Main CLI entrypoint
//

import * as cac from 'cac';
import * as commands from './commands';
import * as mcp from './mcp';

const cli = cac.cac('kcmd').version('1.0.0').help();
cli
  .command('init', 'Initialize a new catalog snapshot')
  .option(
    '--entry-group <id>',
    'Identifier of the EntryGroup (project.location.id)',
  )
  .option(
    '--bigquery-dataset <id...>',
    'Identifier of the BigQuery dataset(s) (project.datasetId)',
  )
  .option(
    '--biglake-namespace <id>',
    'Identifier of the BigLake namespace (project.catalog.namespace)',
  )
  .option(
    '--iceberg',
    'Specify that the BigLake namespace is an Iceberg catalog',
  )
  .option(
    '--kb <id>',
    'Identifier of the Knowledge Base EntryGroup (project.location.id)',
  )
  .option('--glossary <id>', 'Identifier of the Glossary (project.location.id)')
  .option('--pull', 'Optionally pull catalog entries during initialization')
  .option(
    '--format <format>',
    'On-disk layout: standard (default) | documents | okf',
  )
  .action(async (options) => {
    try {
      await commands.init(options);
    } catch (err: any) {
      console.error('Error:', err.message || err);
      process.exit(1);
    }
  });

cli
  .command('pull', 'Pull catalog entries')
  .option('--dry-run', 'Perform a dry run without modifying local files')
  .option(
    '--format <format>',
    'On-disk layout override: standard | documents | okf',
  )
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

cli
  .command('push', 'Push catalog entries')
  .option('--force', 'Force push changes')
  .option('--validate-only', 'Only validate changes without applying')
  .option('--dry-run', 'Perform a dry run without publishing to service')
  .option(
    '--format <format>',
    'On-disk layout override: standard | documents | okf',
  )
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

cli
  .command('mcp', 'Run the Model Context Protocol (MCP) server')
  .option('--path <path>', 'Path to the catalog snapshot root directory')
  .action(async (options) => {
    try {
      await mcp.startServer(options.path);
    } catch (err: any) {
      console.error('Error starting MCP server:', err.message || err);
      process.exit(1);
    }
  });

cli
  .command('reference', 'Pull reference resource entries')
  .option(
    '--format <format>',
    'On-disk layout override: standard | documents | okf',
  )
  .action(async (options) => {
    try {
      await commands.reference(options);
    } catch (err: any) {
      console.error('Error:', err.message || err);
      process.exit(1);
    }
  });

cli.parse();

if (!cli.matchedCommand) {
  if (cli.args.length > 0) {
    console.error(`Error: Unknown command '${cli.args[0]}'`);
  }

  cli.outputHelp();
  process.exit(1);
}
