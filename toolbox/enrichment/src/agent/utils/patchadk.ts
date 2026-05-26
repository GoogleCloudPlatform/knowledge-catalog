// ADK Patches for MCP Toolset and Runner
// https://github.com/google/adk-js/issues/377
//

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
