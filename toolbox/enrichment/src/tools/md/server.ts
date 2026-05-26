// MCP Server implementation
//

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MarkdownFileset } from './fileset';

async function handleToolCall(action: () => Promise<any>) {
  try {
    const result = await action();
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return {
      content: [{ type: 'text' as const, text }]
    };
  }
  catch (error: any) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: error.message }]
    };
  }
}

export async function runServer(fileset: MarkdownFileset) {
  const server = new McpServer({
    name: 'md-fileset',
    version: '1.0.0'
  });

  server.registerTool('list_fileset_contents', {
      description: 'List the markdown documents in the fileset.',
      inputSchema: {
        path: z.string().optional().default('')
               .describe('Optional relative path within the markdown fileset to list.'),
      },
    },
    async ({ path: relativePath = '' }) => {
      return handleToolCall(() => fileset.listContents(relativePath));
    });

  server.registerTool('search_fileset_contents', {
      description: 'Search for a text query (regex supported) within the markdown files.',
      inputSchema: {
        query: z.string().describe('The search string or regular expression.'),
        path: z.string().optional().default('')
               .describe('Optional relative path of the sub directory to search within.'),
      },
    },
    async ({ query, path: relativePath = '' }) => {
      return handleToolCall(() => fileset.searchContents(query, relativePath));
    });

  server.registerTool('read_fileset_file', {
      description: 'Read the contents of a file in the markdown fileset.',
      inputSchema: {
        path: z.string().describe('Relative path to the file.'),
      },
    },
    async ({ path: relativePath }) => {
      return handleToolCall(() => fileset.readFile(relativePath));
    });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
