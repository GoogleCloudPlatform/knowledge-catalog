// Agent Extensions
//

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as adk from '@google/adk';

// Track all active MCP sessions globally to allow automatic failsafe runner clean-up
const activeMcpSessions = new Set<any>();

// Track MCP client sessions per MCPSessionManager using a WeakMap for targeted toolset clean-up
const mcpManagerSessions = new WeakMap<any, any[]>();

const originalCreateSession = adk.MCPSessionManager.prototype.createSession;
adk.MCPSessionManager.prototype.createSession = async function (this: any) {
  const session = await originalCreateSession.call(this);
  
  // Record globally for automatic runner clean-up
  activeMcpSessions.add(session);
  
  // Record per-manager for targeted toolset close
  let sessions = mcpManagerSessions.get(this);
  if (!sessions) {
    sessions = [];
    mcpManagerSessions.set(this, sessions);
  }
  sessions.push(session);
  
  return session;
};

async function cleanUpMcpSessions(): Promise<void> {
  for (const session of activeMcpSessions) {
    try {
      await session.close();
    }
    catch (error) {
      // Ignore close errors
    }
  }
  activeMcpSessions.clear();
}

// Patch MCPToolset's close() method to support manual closing
(adk as any).MCPToolset.prototype.close = async function (this: any): Promise<void> {
  // MCPToolset extends BaseToolset which requires the close() method to
  // release resources. Currently, the framework leaves it empty. If the
  // framework is updated to call .close() automatically inside agents, or
  // if a developer decides to manually close the tools as they did before,
  // calling toolset.close() will now actually clean up the background child
  // processes.
  const sessions = mcpManagerSessions.get(this.mcpSessionManager);
  if (sessions) {
    for (const session of sessions) {
      try {
        await session.close();
        activeMcpSessions.delete(session);
      }
      catch (error) {
        // Ignore close errors
      }
    }
    sessions.length = 0;
  }
};

// Patch adk.Runner to automatically clean up sessions when execution completes
const originalRunEphemeral = (adk as any).Runner.prototype.runEphemeral;
(adk as any).Runner.prototype.runEphemeral = function (this: any, ...args: any[]) {
  // The ADK Runner currently does not call close() on its agent's toolsets
  // when an execution turn completes. Because of this framework limitation,
  // even if the close() method on MCPToolset is implemented correctly, the
  // sessions would still leak unless the developer explicitly writes a finally
  // block in their CLI code to loop through all tools and close them.

  const generator = originalRunEphemeral.apply(this, args);
  return (async function* () {
    try {
      yield* generator;
    }
    finally {
      await cleanUpMcpSessions();
    }
  })();
};

const originalRunAsync = (adk as any).Runner.prototype.runAsync;
(adk as any).Runner.prototype.runAsync = function (this: any, ...args: any[]) {
  // The ADK Runner currently does not call close() on its agent's toolsets
  // when an execution turn completes. Because of this framework limitation,
  // even if the close() method on MCPToolset is implemented correctly, the
  // sessions would still leak unless the developer explicitly writes a finally
  // block in their CLI code to loop through all tools and close them.

  const generator = originalRunAsync.apply(this, args);
  return (async function* () {
    try {
      yield* generator;
    }
    finally {
      await cleanUpMcpSessions();
    }
  })();
};

export class ExtensibleAgent extends adk.LlmAgent {
  private _toolsLoaded = false;

  constructor(options: adk.LlmAgentConfig) {
    super(options);
  }

  override async canonicalTools(context?: adk.ReadonlyContext): Promise<adk.BaseTool[]> {
    if (!this._toolsLoaded && context) {
      const toolsPath = context.state.get('toolsPath') as string;
      const mcpTools = await loadMcpTools(toolsPath);
      const skills = await loadSkills(toolsPath);

      this._toolsLoaded = true;
      this.tools = [...this.tools, ...mcpTools, ...skills];
    }

    return super.canonicalTools(context);
  }
}

function expandEnvVars(str: string): string {
  return str.replace(/\$(\w+)|\${(\w+)}/g, (_, m1, m2) => {
    const varName = m1 || m2;
    return process.env[varName] || '';
  });
}

async function loadMcpTools(configPath: string): Promise<adk.MCPToolset[]> {
  const mcpConfigPath = path.join(configPath, 'mcp.json');
  const stat = await fs.promises.stat(mcpConfigPath);
  if (!stat.isFile()) {
    return [];
  }

  try {
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
    console.warn(`Warning: Failed to load mcp.json: ${error.message}`);
    return [];
  }
}

async function loadSkills(configPath: string): Promise<adk.SkillToolset[]> {
  const skillsBasePath = path.join(configPath, 'skills');
  const stat = await fs.promises.stat(skillsBasePath);
  if (!stat.isDirectory()) {
    return [];
  }

  try {
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
    console.warn(`Warning: Failed to load skills: ${error.message}`);
    return [];
  }
}
