// Application entrypoint
//

// Ensure this happens first, before anything else is loaded.
import './util/patchpb.js';

import * as adk from '@google/adk';
import * as cac from 'cac';
import { enrichCommand, EnrichOptions } from './enrich.js';

// Suppress the overly noisy logging from the ADK
adk.setLogLevel(adk.LogLevel.WARN);

const cli = cac.cac('kcenrich').version('1.0.0').help();
cli.command('catalog', 'Enrich the metadata in the catalog')
   .option('--path <path>', 'Path to the catalog')
   .option('--config-path <path>', 'Path to the config directory')
   .action(async (options: EnrichOptions) => {
      console.log('Enriching catalog...');
      try {
        await enrichCommand(options);
      }
      catch (err: any) {
        console.error('Error:', err.message || err);
        process.exit(1);
      }
   });


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
