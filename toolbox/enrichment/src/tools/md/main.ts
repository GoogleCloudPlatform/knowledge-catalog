// MCP Application Entrypoint for Markdown fileset tool
//

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cac from 'cac';
import { MarkdownFileset } from './fileset';
import { runServer } from './server';


async function main() {
  const cli = cac.cac('md-fileset').version('1.0.0').help();
  cli.option('--dir <dir>', 'Root directory for the markdown fileset');

  const parsed = cli.parse(process.argv);
  if (parsed.options.help || parsed.options.version) {
    return;
  }
  if (!parsed.options.dir) {
    console.error('Error: --dir option is required');
    cli.outputHelp();
    process.exit(1);
  }

  const root = path.resolve(parsed.options.dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`Error: Root directory "${root}" does not exist or is not a directory.`);
    process.exit(1);
  }

  const fileset = new MarkdownFileset(root);
  await runServer(fileset);
}

main();
