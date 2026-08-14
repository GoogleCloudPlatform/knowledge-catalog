// Main CLI entrypoint
//

import * as cac from 'cac';
import * as commands from './commands';
import * as mcp from './mcp';


const cli = cac.cac('kcmd').version('1.0.0').help();
cli.command('init', 'Initialize a new catalog snapshot')
   .option('--entry-group <id>', 'Identifier of the EntryGroup (project.location.id)')
   .option('--bigquery-dataset <id...>', 'Identifier of the BigQuery dataset(s) (project.datasetId)')
   .option('--kb <id>', 'Identifier of the Knowledge Base EntryGroup (project.location.id)')
   .option('--semantic-model <id>', 'Semantic model scope as <projectId>.<locationId>.<entryGroupId>')
   .option('--pull', 'Optionally pull catalog entries during initialization')
   .action(async (options) => {
      try {
        await commands.init(options);
      }
      catch (err: any) {
        console.error('Error:', err.message || err);
        process.exit(1);
      }
   });


cli.command('pull', 'Pull catalog entries')
   .action(async () => {
      let exitCode = 1;
      try {
        exitCode = await commands.pull();
      }
      catch (err: any) {
        console.error('Error:', err.message || err);
        exitCode = 1;
      }
      
      process.exit(exitCode);
   });

cli.command('push', 'Push catalog entries')
   .option('--force', 'Force push changes')
   .option('--force-remove', 'Delete Knowledge Catalog models in the entry group that this push does not include (removed/renamed models); semantic-model push only')
   .option('--emit-expressions', 'Emit SQL-expression fields not yet in the published Knowledge Catalog system-type templates (per-field schema semantics, metric expression); off by default, enable once the templates support them; semantic-model push only')
   .option('--validate-only', 'Only validate changes without applying')
   .option('--target <targets>', 'Semantic-model push destination(s): bq, kc, all (default), or a comma-separated list (e.g. bq,kc)')
   .option('--print', 'Print each pushed destination\'s generated artifact in its native format (BigQuery Graph SQL DDL, Knowledge Catalog entry plan); scope with --target (semantic-model push only)')
   .action(async (options) => {
      let exitCode = 1;
      try {
        exitCode = await commands.push(options);
      }
      catch (err: any) {
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
      }
      catch (err: any) {
        console.error('Error starting MCP server:', err.message || err);
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
