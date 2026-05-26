// Application entrypoint
//

// Ensure this happens first, before anything else is loaded.
import './utils/patchpb';
import './utils/patchadk';

import * as adk from '@google/adk';
import * as cac from 'cac';
import { enrichCommand } from './enrich/command.js';

// Suppress the overly noisy logging from the ADK
adk.setLogLevel(adk.LogLevel.WARN);

const cli = cac.cac('kcagent').version('1.0.0').help();
cli.command('enrich', 'Enrich the metadata catalog')
   .option('--catalog-path <path>', 'Path to the metadata catalog')
   .option('--tools-path <path>', 'Path to the config directory')
   .option('--prompt-path <path>', 'Path to the prompt file')
   .action(enrichCommand);


function main() {
  cli.parse();

  if (!cli.matchedCommand) {
    if (cli.args.length > 0) {
      console.error(`Error: Unknown command '${cli.args[0]}'`);
    }

    cli.outputHelp();
    process.exit(1);
  }
}


main();
