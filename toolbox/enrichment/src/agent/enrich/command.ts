// Enrichment process
//

import * as fs from 'node:fs';
import * as adk from '@google/adk';
import * as kcmd from 'kcmd';
import { rootAgent } from './agent.js';

export interface EnrichOptions {
  catalogPath: string;
  toolsPath: string;
  promptPath: string;
}

export async function enrichCommand(options: EnrichOptions) {
  console.log('Enriching metadata...');

  let stat = await fs.promises.stat(options.catalogPath);
  if (!stat.isDirectory()) {
    console.error(`Error: ${options.catalogPath} is not a directory.`);
    process.exit(1);
  }
  stat = await fs.promises.stat(options.toolsPath);
  if (!stat.isDirectory()) {
    console.error(`Error: ${options.toolsPath} is not a directory.`);
    process.exit(1);
  }
  stat = await fs.promises.stat(options.promptPath);
  if (!stat.isFile()) {
    console.error(`Error: ${options.promptPath} is not a file.`);
    process.exit(1);
  }

  const commonPrompt = await fs.promises.readFile(options.promptPath, 'utf-8');

  const context = kcmd.gcp.ApiContext.default();
  const catalog = await kcmd.CatalogSnapshot.fromPath(options.catalogPath, context);

  const runner = new adk.InMemoryRunner({
    agent: rootAgent,
    appName: 'kcagent'
  });

  const entryNames = await catalog.listEntries();
  for (const name of entryNames) {
    console.log(`Processing: ${name}`);
    const entry = await catalog.lookupEntry(name);
    if (!entry) {
      console.error(`Error: Entry ${name} not found.`);
      continue;
    }

    const events = runner.runEphemeral({
      userId: 'cli-user',
      newMessage: {
        role: 'user',
        parts: [{ text: createPrompt(entry, commonPrompt) }]
      },
      stateDelta: {
        toolsPath: options.toolsPath
      }
    });

    for await (const event of events) {
      const structuredEvents = adk.toStructuredEvents(event);
      for (const se of structuredEvents) {
        if (se.type === adk.EventType.THOUGHT) {
          if (se.content?.trim()) {
            console.log(`\x1b[90m[Thought]: ${se.content.trim()}\x1b[0m`);
          }
        }
        else if (se.type === adk.EventType.CONTENT) {
          if (se.content?.trim()) {
            console.log(`\x1b[1;30m[Agent] ${se.content.trim()}\x1b[0m`);
          }
        }
        else if (se.type === adk.EventType.TOOL_CALL) {
          console.log(`\x1b[30m[Tool Invoke] ${se.call.name}\n${JSON.stringify(se.call.args || {})}\x1b[0m`);
        }
        else if (se.type === adk.EventType.TOOL_RESULT) {
          console.log(`\x1b[30m[Tool Result] ${se.result.name}\n${JSON.stringify(se.result.response || {})}\x1b[0m`);
        }
      }
    }
  }
}


function createPrompt(entry: kcmd.Entry, commonPrompt: string): string {
  const lines: string[] = [];

  lines.push(`Asset: ${entry.name}`);

  const schema = entry.aspects?.['dataplex-types.global.schema'];
  if (schema) {
    lines.push('Schema:');
    lines.push(JSON.stringify(schema.fields, null, 2));
  }

  const overview = entry.aspects?.['dataplex-types.global.overview'];
  if (overview) {
    lines.push('Existing Documentation');
    lines.push(overview.content);
  }
  else {
    lines.push('No existing documentation found');
  }

  lines.push('');
  lines.push(commonPrompt);

  return lines.join('\n');
}
