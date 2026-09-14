// The demo agent, in full. There is no second file.
//
//   bun agent.ts "Find the order for Morgan Ellis
//                 (morgan.ellis@example.com) that was placed on Labor Day. It
//                 was supposed to get free shipping but we had a glitch and
//                 the customer got charged. Please issue them a credit to
//                 offset the charge."
//
// Nothing here mentions credits, orders, database tables or an operations desk.
// Four steps: create the runtime, derive the tools, adapt them to ADK, run.
// Point it at another semantic model and it is another agent, with no edit to
// this file. That is the property it exists to test -- so the moment something
// about this business has to be written here, the model was missing it and the
// fix belongs there.

import {FunctionTool, InMemoryRunner, LlmAgent} from '@google/adk';
import {Type} from '@google/genai';

import {callableTools, modelTools} from '../../../src/libts/semantic/runtime/agent_tools';
import {createSemanticRuntimes} from '../../../src/libts/semantic/runtime/runtime';
import {closeStore} from '../../../src/libts/semantic/runtime/store';

// 1. Build the runtime exactly as `kcmd` builds it -- same directory, same
//    merge, same warnings -- which pairs the model with the store it says it
//    lives in. Neither the database nor the project is named here.
//
//    DEMO_PROFILE picks which binding profile to read, the way `kcmd
//    --profile` does, and defaults to the one catalog.yaml names. It selects a
//    deployment, not a backend: this file never learns whether the profile it
//    got points at Spanner or at AlloyDB, and the run is the same either way.
const runtimes = await createSemanticRuntimes(
    {path: import.meta.dir, profile: process.env.DEMO_PROFILE});
if ('error' in runtimes) throw new Error(runtimes.error);
const [runtime] = runtimes;
if (!runtime.store) throw new Error(runtime.storeError);

// ADK reaches Gemini through Vertex with the credentials and the project the
// store calls already use, so the binding profile is still the only place
// that says where this runs. Set before the agent is built, because the client
// reads them then.
process.env.GOOGLE_GENAI_USE_ENTERPRISE ??= 'true';
process.env.GOOGLE_CLOUD_PROJECT ??= runtime.store.project;
process.env.GOOGLE_CLOUD_LOCATION ??= 'us-central1';

// 2. Derive what the model offers, and keep what this binding can serve.
//    `kcmd agent tools` prints all of it before a language model is involved.
const {callable, withheld, instruction} =
    callableTools(modelTools({runtime}));
for (const tool of withheld) {
  console.error(`(withheld) ${tool.name}: ${tool.unavailable}`);
}

// 3. Adapt each one to ADK. A derived parameter already carries a JSON type and
//    a description, which is the whole of a function declaration -- so this
//    changes the shape and none of the content.
const tools = callable.map(
    tool => new FunctionTool({
      name: tool.name,
      description: tool.description,
      parameters: {
        type: Type.OBJECT,
        properties: Object.fromEntries(tool.parameters.map(p => [
          p.name, {type: p.type.toUpperCase() as Type, description: p.description}
        ])),
        required: tool.parameters.filter(p => p.required).map(p => p.name),
      },
      // ADK types the argument as `unknown` because a tool's schema decides its
      // shape, and the schema above is always an object.
      execute: (args: unknown) => tool.invoke(args as Record<string, unknown>),
    }));

// 4. Run, printing each call and each answer so the transcript shows which
//    tools the agent chose and what the store said back.
//
// The instruction is the model's, not this file's: what this business asks of
// anything acting on it is in `ai_context` in commerce.yaml, and how to use a
// derived tool comes from the derivation. The one thing added is today's date.
// "Labor Day" resolves to 2026-09-07 only with a clock, which a language model
// does not have -- and that is a fact about when this runs rather than about
// commerce, so it belongs here and not in the model.
const agent = new LlmAgent({
  name: 'model_agent',
  model: process.env.DEMO_MODEL ?? 'gemini-2.5-flash',
  instruction: `${instruction}\n\nToday is ${
      new Date().toISOString().slice(0, 10)}.`,
  tools,
});

const prompt = process.argv.slice(2).join(' ');
if (!prompt) {
  console.error(`Give the agent something to do, in quotes. Derived from ${
      runtime.model.name}: ${callable.map(t => t.name).join(', ')}`);
  process.exit(2);
}

const runner = new InMemoryRunner({agent});
for await (const event of runner.runEphemeral(
               {userId: 'demo', newMessage: {parts: [{text: prompt}]}})) {
  for (const part of event.content?.parts ?? []) {
    if (part.text) console.log(part.text);
    if (part.functionCall) {
      console.log(`  -> ${part.functionCall.name}(${
          JSON.stringify(part.functionCall.args)})`);
    }
    if (part.functionResponse) {
      console.log(`  <- ${JSON.stringify(part.functionResponse.response)}`);
    }
  }
}

// Under the Spanner profile this does nothing and could be left out. Under the
// AlloyDB one it closes a pool of PostgreSQL connections, and without it the
// open sockets keep the event loop alive and the agent never exits.
await closeStore(runtime.store);
