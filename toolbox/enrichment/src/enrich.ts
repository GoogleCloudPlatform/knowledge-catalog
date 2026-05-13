// Enrichment process
//

import * as adk from '@google/adk';
import { rootAgent } from './agent.js';
import * as fs from 'fs';
import * as kcmd from 'kcmd';

export interface EnrichOptions {
  path: string;
  configPath: string;
}

export async function enrichCommand(options: EnrichOptions) {
  const context = kcmd.gcp.ApiContext.default();
  const catalog = await kcmd.CatalogSnapshot.fromPath(options.path, context);

  try {
    const stats = await fs.promises.stat(options.configPath);
    if (!stats.isDirectory()) {
      console.error(`Error: ${options.configPath} is not a directory.`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`Error accessing config file: ${(error as Error).message}`);
    process.exit(1);
  }

  const runner = new adk.InMemoryRunner({
    agent: rootAgent,
    appName: 'kcenrich',
  });

  const entries = await catalog.listEntries();

  for (const [index, entry] of entries.entries()) {
    console.log(`Processing: ${entry}`);

    const events = runner.runEphemeral({
      userId: 'cli-user',
      newMessage: {
        role: 'user',
        parts: [{ text: entry }],
      },
    });

    for await (const event of events) {
      if (adk.isFinalResponse(event)) {
        const text = adk.stringifyContent(event);
        if (text.trim()) {
          console.log(`[Agent]: ${text}`);
        }
      }
    }
  }
}
