// Tools and Skills Loader
//

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as adk from '@google/adk';


function expandEnvVars(str: string): string {
  return str.replace(/\$(\w+)|\${(\w+)}/g, (_, m1, m2) => {
    const varName = m1 || m2;
    return process.env[varName] || '';
  });
}

export async function loadMcpTools(configPath: string): Promise<adk.MCPToolset[]> {
  const mcpConfigPath = path.join(configPath, 'mcp.json');

  try {
    const stat = await fs.promises.stat(mcpConfigPath);
    if (!stat.isFile()) {
      return [];
    }
    const content = await fs.promises.readFile(mcpConfigPath, 'utf-8');
    const config = JSON.parse(content);
    const toolsets: adk.MCPToolset[] = [];
    const mcpServers = config.mcpServers || {};

    for (const [_, serverConfig] of Object.entries(mcpServers) as [string, any][]) {
      if (serverConfig.command) {
        const command = expandEnvVars(serverConfig.command);
        const args = (serverConfig.args || []).map((arg: string) => expandEnvVars(arg));
        const env = serverConfig.env
          ? Object.fromEntries(
            Object.entries(serverConfig.env).map(([k, v]) => [k, expandEnvVars(String(v))])
          )
          : undefined;
        const timeout = typeof serverConfig.timeout === 'number' ? serverConfig.timeout : undefined;

        toolsets.push(
          new adk.MCPToolset({
            type: 'StdioConnectionParams',
            serverParams: { command, args, env },
            timeout
          })
        );
      }
      else if (serverConfig.httpUrl) {
        const url = expandEnvVars(serverConfig.httpUrl);
        const timeout = typeof serverConfig.timeout === 'number' ? serverConfig.timeout : undefined;

        toolsets.push(
          new adk.MCPToolset({
            type: 'StreamableHTTPConnectionParams',
            url,
            timeout
          })
        );
      }
    }
    return toolsets;
  }
  catch (error: any) {
    if (error?.code !== 'ENOENT') {
      // ENOENT simply means the optional mcp.json isn't present.
      console.warn(`Warning: Failed to load mcp.json: ${error.message}`);
    }
    return [];
  }
}

export async function loadSkills(configPath: string): Promise<adk.SkillToolset[]> {
  const skillsBasePath = path.join(configPath, 'skills');

  try {
    const stat = await fs.promises.stat(skillsBasePath);
    if (!stat.isDirectory()) {
      return [];
    }
    const skillsMap = await adk.loadAllSkillsInDir(skillsBasePath);
    if (Object.keys(skillsMap).length === 0) {
      return [];
    }

    return [
      new adk.SkillToolset(skillsMap, {
        codeExecutor: new adk.UnsafeLocalCodeExecutor()
      })
    ];
  }
  catch (error: any) {
    if (error?.code !== 'ENOENT') {
      // ENOENT simply means the optional skills/ directory isn't present.
      console.warn(`Warning: Failed to load skills: ${error.message}`);
    }
    return [];
  }
}
