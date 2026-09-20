/**
 * Generating an Agent Skill from a semantic model.
 *
 * An Agent Skill (agentskills.io) is a directory holding a `SKILL.md` -- YAML
 * frontmatter naming the skill, then Markdown telling an agent how to do
 * something. Clients load the frontmatter at startup and the body only when
 * the skill looks relevant, so the body has a budget: under 500 lines, and
 * under about 5,000 tokens. Anything longer goes in files the body points at,
 * which the agent reads only if it needs them.
 *
 * That budget decides the shape of what this emits. A model's actions carry
 * their parameters, the rules that gate them and the blast radius of each
 * call, and inlining all of it puts a page of detail about every action in
 * front of an agent that wanted one of them. So `SKILL.md` is a ROUTER: what
 * the model is, a one-line table of the actions, and the parts that are true
 * of every call. Each action's detail is a file under `references/`, named in
 * the table, read on demand. A model with thirty actions costs the same at
 * startup as a model with one.
 *
 * Nothing here decides what an action means. `modelTools` already turns a
 * model into the tools an agent is offered -- the tool name, the description
 * with the gating rules folded in, the typed parameters, and whether this
 * binding can run it -- and an agent calling through ADK or MCP reads exactly
 * those. A second derivation here would be a skill that describes a different
 * tool than the one that runs, so this module renders what `modelTools`
 * returns and derives nothing of its own beyond layout.
 *
 * The skill is written against the LOGICAL model, which is what makes it worth
 * generating once. An action's name, arguments, rules and blast radius are the
 * same wherever it is deployed, because an executor is a physical binding that
 * a profile supplies; only "Running an action" below reads the binding. Point
 * this at a different profile and one section changes.
 */

import {Action, AffectedConcept, Constraint, SemanticModel} from './ir';
import {ActionTool, modelTools} from './runtime/agent_tools';
import {Judge} from './runtime/judge';
import {SemanticRuntime} from './runtime/runtime';
import {storeLine} from './runtime/store';

/** One file of the generated package, at a path relative to the skill root. */
export interface SkillFile {
  /** Relative to the skill directory, POSIX-separated. `SKILL.md` is first. */
  path: string;
  text: string;
}

/** A generated skill: the directory name it must be written under, and why. */
export interface SkillPackage {
  /**
   * The skill's name, which is also the directory name it must be written
   * under. The two are required to match, so they come from one place.
   */
  name: string;
  files: SkillFile[];
  /**
   * What a reader should know about the skill that was generated -- a body
   * over its budget, a model that declares nothing to act on. Not errors:
   * every one of them still produces a skill, and the caller decides whether
   * it is the skill it wanted.
   */
  warnings: string[];
}

export interface GenerateSkillOptions {
  /** The model to describe, under the binding profile it was read with. */
  runtime: SemanticRuntime;
  /**
   * The skill's name, defaulting to the model's own in the form the spec
   * requires. Validated either way: a name the spec rejects is an error here
   * rather than a skill some clients silently skip.
   */
  name?: string;
  /**
   * Whether the agent this skill is written for holds a judge. It decides
   * whether a guarded action is described as runnable, exactly as it does for
   * `kcmd agent tools`. No model is called.
   */
  judge?: Judge;
}

/**
 * The skill for one model, as files a caller writes out.
 *
 * Returns an error only for a name the Agent Skills spec would reject. A model
 * with no actions is not an error -- it is a skill that says the model
 * declares nothing to act on, which is the honest thing to hand an agent --
 * but it is warned about, because it is rarely what the caller meant.
 */
export function generateSkill(opts: GenerateSkillOptions): SkillPackage|{
  error: string
}
{
  const {runtime} = opts;
  const model = runtime.model;
  const name = opts.name ?? skillNameFor(model.name);
  const nameError = whyNameIsInvalid(name);
  if (nameError) return {error: nameError};

  const {actions, instruction} = modelTools({runtime, judge: opts.judge});
  const warnings: string[] = [];
  if (!actions.length) {
    warnings.push(
        `Model '${model.name}' declares no actions, so the skill describes ` +
        `nothing an agent can do. Generated anyway.`);
  }

  const files: SkillFile[] = [{
    path: 'SKILL.md',
    text: skillDocument(name, runtime, actions, instruction),
  }];
  for (const tool of actions) {
    const action = actionFor(tool, model);
    if (!action) continue;
    files.push({
      path: referencePath(tool),
      text: referenceDocument(tool, action, model),
    });
  }

  warnings.push(...overBudget(files[0].text));
  return {name, files, warnings};
}


// ---------------------------------------------------------------------------
// The name, which is also the directory name.
// ---------------------------------------------------------------------------

/**
 * A model name in the form the spec requires: 1-64 characters of lowercase
 * `a-z0-9-`, with no leading, trailing or doubled hyphen.
 *
 * `Commerce` and `commerce_demo` are both ordinary model names and neither is
 * a legal skill name, so this is a conversion rather than a check. What it
 * cannot fix -- a name with no alphanumeric character in it at all -- falls
 * through to the validator, which says so.
 */
export function skillNameFor(modelName: string): string {
  return modelName.replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64)
      .replace(/-+$/, '');
}

/**
 * Why this name is not a legal skill name, or undefined if it is.
 *
 * Worth being strict about here rather than leaving to the client. A skill
 * whose `name` does not match its directory is loaded by a lenient client and
 * SKIPPED by a strict one -- the Agent Plugins spec requires a client to skip
 * a non-conformant skill -- so the failure shows up as a skill that quietly
 * does nothing on somebody else's machine. This generator names the directory
 * from the same string it writes into the frontmatter, so the pair cannot
 * disagree; the rest is the character rules.
 */
export function whyNameIsInvalid(name: string): string|undefined {
  if (!name) return `a skill name cannot be empty.`;
  if (name.length > 64) {
    return `skill name '${name}' is ${name.length} characters; the maximum ` +
        `is 64.`;
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    return `skill name '${name}' is not valid: use lowercase letters, ` +
        `digits and single hyphens, starting and ending with a letter or a ` +
        `digit.`;
  }
  return undefined;
}


// ---------------------------------------------------------------------------
// SKILL.md: the router.
// ---------------------------------------------------------------------------

// The most a client reads before deciding the skill is relevant.
const MAX_DESCRIPTION = 1024;
// What the spec recommends a body stay under. Both are advisory in the sense
// that nothing rejects a longer one; what a longer one costs is context, on
// every request, whether or not the skill is used.
const MAX_BODY_LINES = 500;
const MAX_BODY_TOKENS = 5000;

function skillDocument(
    name: string, runtime: SemanticRuntime, actions: ActionTool[],
    instruction: string): string {
  const model = runtime.model;
  const out: string[] = [];
  out.push('---');
  out.push(`name: ${name}`);
  out.push(`description: ${yamlString(descriptionFor(model, actions))}`);
  out.push('---');
  out.push('');
  out.push(`# ${model.name}`);
  out.push('');
  if (model.description) {
    out.push(paragraph(model.description));
    out.push('');
  }

  out.push('## What you can do here');
  out.push('');
  if (actions.length) {
    out.push(
        'Each action below has a reference page with the arguments it takes, ' +
        'the rules that gate it, and what it changes. Read the page for an ' +
        'action before you call it.');
    out.push('');
    out.push('| Action | What it does | Reference |');
    out.push('| --- | --- | --- |');
    for (const tool of actions) {
      const summary = firstLine(tool.description) || tool.actionName;
      out.push(`| \`${tool.name}\` | ${cell(summary)} | \`${
          referencePath(tool)}\` |`);
    }
  } else {
    out.push(
        `This model declares no actions, so there is nothing here to call. ` +
        `It describes what ${model.name} means; it does not offer a way to ` +
        `change it.`);
  }
  out.push('');

  out.push('## How this model wants to be used');
  out.push('');
  out.push(paragraph(instruction));
  out.push('');

  out.push(...readSideSection(runtime));
  out.push(...runningSection(runtime, actions));
  out.push(...outcomeSection(actions));

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/**
 * The line a client reads at startup to decide whether to open the skill.
 *
 * It has to answer "is this about my request", so it names the subject and the
 * acts, and says plainly that this is the write side. Truncated to the spec's
 * limit rather than allowed to run over, because a description a strict client
 * rejects is a skill that never loads at all.
 */
function descriptionFor(model: SemanticModel, actions: ActionTool[]): string {
  const subject = model.description?.trim() || `The ${model.name} model.`;
  const parts = [sentenceEnd(collapse(subject))];
  if (actions.length) {
    parts.push(`Declares ${actions.length} action${
        actions.length === 1 ? '' :
                               's'}: ${actions.map(t => t.name).join(', ')}.`);
    parts.push(
        `Use when a request asks to change this data rather than only read it.`);
  } else {
    parts.push(`Declares no actions; it describes the data, and changes none.`);
  }
  const text = parts.join(' ');
  return text.length <= MAX_DESCRIPTION ?
      text :
      `${text.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…`;
}

// What this skill does not offer, said once rather than discovered per call.
//
// The instruction above tells an agent to look a record up rather than invent
// an identifier, which is right, and this skill has no way to do it: the
// derived lookups are a read path nothing on the command line calls. Leaving
// that out would leave an agent following an instruction to use a tool that is
// not here, so it is named, along with what does work.
function readSideSection(runtime: SemanticRuntime): string[] {
  const entities = runtime.model.entities ?? [];
  if (!entities.length) return [];
  const out: string[] = [];
  out.push('## Finding a record');
  out.push('');
  out.push(
      'This skill offers writes, not reads. When you are given a name or a ' +
      'description where an action wants a key, the key has to come from ' +
      'somewhere else: ask the caller, or read the store directly. An action ' +
      'argument typed as an entity will also accept text that identifies ' +
      'exactly one record, and the call fails when nothing matches or more ' +
      'than one does -- that is the one read this skill can do for you, and ' +
      'it is part of making the call rather than a step before it.');
  out.push('');
  if (runtime.store?.kind === 'spanner') {
    const s = runtime.store;
    out.push('To read the store directly:');
    out.push('');
    out.push('```bash');
    out.push(`gcloud spanner databases execute-sql ${s.database} \\`);
    out.push(`  --instance=${s.instance} --project=${s.project} \\`);
    out.push(`  --sql='SELECT ...'`);
    out.push('```');
    out.push('');
  }
  return out;
}

/**
 * The one section that is about this deployment rather than about the model.
 *
 * Everything above is true of the model wherever it runs. This is the part a
 * second profile would change, which is why it is one section and not a
 * sentence in each action's page: regenerating against another binding
 * rewrites here and nowhere else.
 */
function runningSection(
    runtime: SemanticRuntime, actions: ActionTool[]): string[] {
  if (!actions.length) return [];
  const out: string[] = [];
  out.push('## Running an action');
  out.push('');
  out.push(
      `Everything above is true of this model wherever it is deployed. This ` +
      `section is not: it describes the binding this skill was generated ` +
      `from, which is profile \`${runtime.profile}\`.`);
  out.push('');
  out.push(
      runtime.store ? `- Store: \`${storeLine(runtime.store)}\`` :
                      `- Store: none. ${runtime.storeError ?? ''}`.trim());
  const kinds = distinctKinds(runtime.model.actions ?? []);
  if (kinds.length) {
    out.push(`- Executor: ${kinds.map(k => `\`${k}\``).join(', ')}`);
  }
  const blocked = actions.filter(t => !t.runnable);
  if (blocked.length) {
    out.push(
        `- Not runnable here: ${blocked.map(t => `\`${t.name}\``).join(', ')}`);
  }
  out.push('');

  if (blocked.length === actions.length) {
    out.push(
        `No action in this model can be run under this profile. The reasons ` +
        `are on each action's reference page. Report that rather than ` +
        `retrying.`);
    out.push('');
    return out;
  }

  // Said plainly, because the alternative is an agent wiring a production
  // call to a command whose flags are a debugging surface.
  out.push(
      '`kcmd` is a command line for inspecting and debugging a model, not ' +
      'the runtime an agent should call in production. Use it to try a call ' +
      'and to see what a refusal says. An agent that runs continuously ' +
      'should be handed these actions as tools by its own framework, which ' +
      'reaches the same runtime.');
  out.push('');
  const example = actions.find(t => t.runnable)!;
  const action = actionFor(example, runtime.model);
  // Assembled as parts and joined, rather than pushed line by line, because an
  // action with no parameters would otherwise end the command on a line
  // continuation with nothing after it -- a command line that does not run,
  // in the one place the skill is telling an agent what to run.
  const parts = [`kcmd action run ${example.actionName}`];
  parts.push(`--profile ${runtime.profile}`);
  if (needsJudge(action)) parts.push('--judge');
  const args = (action?.parameters ?? []).map(p => `--arg ${p.name}=<value>`);
  if (args.length) parts.push(args.join(' '));
  out.push('```bash');
  out.push(parts.join(' \\\n  '));
  out.push('```');
  out.push('');
  if (needsJudge(action)) {
    out.push(
        '`--judge` is what settles the rules stated in words. Without it a ' +
        'guarded action is refused rather than run unchecked. A rule about ' +
        'something on record rather than in the arguments also needs ' +
        '`--judge-reads-store`, which lets the judge read the model\'s own ' +
        'tables while it decides.');
    out.push('');
  }
  return out;
}

/**
 * What the runtime guarantees about a call, which is what an agent has to know
 * to report one honestly.
 *
 * Constant text, and deliberately so: these are facts about how actions run,
 * not about this model. An agent that treats a refusal as a retry, or a
 * warning as nothing, gets them wrong in the same way against every model.
 */
function outcomeSection(actions: ActionTool[]): string[] {
  if (!actions.length) return [];
  return [
    '## What happens when you call one',
    '',
    'Every rule is settled before the write opens a transaction. So a ' +
        'refusal leaves the store exactly as it was, and no rule ever sees ' +
        'the write it gates. There is nothing to undo after a refusal.',
    '',
    'A call comes back in one of three states, and they are not two:',
    '',
    '- **Applied.** The write landed. Say what changed.',
    '- **Refused.** The write did not happen, and the reason says why. ' +
        'Repeat the reason plainly. If it says a person has to decide, say ' +
        'so and stop -- you cannot approve it yourself, and rephrasing the ' +
        'request to get past a rule is the one thing you must not do.',
    '- **Unknown.** The statements ran and the commit could not report its ' +
        'outcome. The write may or may not have landed. Do not retry: say ' +
        'that the outcome is unknown and what to check.',
    '',
    'A call can also come back applied **and** carry warnings. That means ' +
        'the change landed and a rule still went unmet, or went unchecked. ' +
        'Report both. Reporting only the success tells the caller the write ' +
        'met every rule the model states, which is the one thing it did not.',
    '',
  ];
}


// ---------------------------------------------------------------------------
// references/<action>.md: the detail, read on demand.
// ---------------------------------------------------------------------------

function referencePath(tool: ActionTool): string {
  return `references/${tool.name.replace(/_/g, '-')}.md`;
}

function referenceDocument(
    tool: ActionTool, action: Action, model: SemanticModel): string {
  const out: string[] = [];
  out.push(`# ${tool.name}`);
  out.push('');
  out.push(`Action \`${action.name}\` of the \`${model.name}\` model.`);
  out.push('');
  if (action.description) {
    out.push(paragraph(action.description));
    out.push('');
  }
  if (!tool.runnable && tool.unavailable) {
    out.push(`> **Not runnable under this binding.** ${
        collapse(tool.unavailable)} Report that rather than retrying.`);
    out.push('');
  }

  out.push('## Arguments');
  out.push('');
  if (tool.parameters.length) {
    const hasDefault = tool.parameters.some(p => p.default !== undefined);
    out.push(`| Name | Type | Required |${
        hasDefault ? ' Default |' : ''} What to pass |`);
    out.push(`| --- | --- | --- |${hasDefault ? ' --- |' : ''} --- |`);
    for (const p of tool.parameters) {
      const def = hasDefault ? ` ${
                                   p.default === undefined ?
                                       '' :
                                       `\`${JSON.stringify(p.default)}\``} |` :
                               '';
      out.push(`| \`${p.name}\` | ${p.type} | ${p.required ? 'yes' : 'no'} |${
          def} ${cell(p.description)} |`);
    }
  } else {
    out.push('This action takes no arguments.');
  }
  out.push('');

  const instructions = action.aiContext?.instructions?.trim();
  if (instructions) {
    out.push('## How to call it');
    out.push('');
    out.push(paragraph(instructions));
    out.push('');
  }

  out.push(...rulesSection(action, model));
  out.push(...affectsSection(action));
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/**
 * The rules, including the ones that do not stop the call.
 *
 * `toolDescription` names only the gating rules, and is right to: telling a
 * caller it is "gated" by a rule that lets every write through is a claim the
 * runtime does not honour. A reference page is the other audience. Someone
 * reading it wants to know what will be said about the call as well as what
 * will stop it, so an advisory rule appears here and is marked as advisory --
 * which is the same honesty in a place that has room for the distinction.
 */
function rulesSection(action: Action, model: SemanticModel): string[] {
  const byName = new Map((model.constraints ?? []).map(c => [c.name, c]));
  const rules = (action.guards ?? [])
                    .map(n => byName.get(n))
                    .filter((c): c is Constraint => c !== undefined);
  if (!rules.length) return [];

  const out: string[] = [];
  out.push('## Rules that apply to this call');
  out.push('');
  out.push(
      'Each is settled before anything is written, from the attempted call ' +
      'and, where the rule is about something on record, the record.');
  out.push('');
  for (const rule of rules) {
    const advisory = rule.onViolation === 'warn';
    out.push(`### ${rule.name}${advisory ? ' (advisory)' : ''}`);
    out.push('');
    out.push(`On violation: \`${rule.onViolation ?? 'unspecified'}\`${
        advisory ? ' -- this one reports and lets the write through.' : ''}`);
    out.push('');
    const judgment = rule.judgment?.trim();
    if (judgment) {
      out.push(paragraph(judgment).split('\n').map(l => `> ${l}`).join('\n'));
      out.push('');
    }
    const desc = rule.description?.trim();
    if (desc) {
      out.push(`If it does not hold: ${sentenceEnd(collapse(desc))}`);
      out.push('');
    }
  }
  return out;
}

// What the call reaches, as the model declares it. Coarse on purpose where the
// author left it coarse: an entry with no operation says the concept is
// touched and does not say how, and inventing a verb for it here would make
// the page say more than the model does.
function affectsSection(action: Action): string[] {
  const affects = action.affects ?? [];
  if (!affects.length) return [];
  const out: string[] = [];
  out.push('## What it changes');
  out.push('');
  out.push('| Concept | Operation | Fields |');
  out.push('| --- | --- | --- |');
  for (const a of affects) out.push(affectsRow(a));
  out.push('');
  return out;
}

function affectsRow(a: AffectedConcept): string {
  const op = a.operation ? `\`${a.operation}\`` : 'unspecified';
  const fields = a.fields?.length ?
      a.fields.map(f => `\`${f}\``).join(', ') :
      (a.operation === 'delete' ? 'the whole record' : 'unspecified');
  return `| \`${a.concept}\` | ${op} | ${fields} |`;
}


// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function actionFor(tool: ActionTool, model: SemanticModel): Action|undefined {
  return (model.actions ?? []).find(a => a.name === tool.actionName);
}

// A judge is what settles a rule stated in words, so an action names one in
// its command line exactly when it is guarded by a rule that stops the write.
// An advisory rule is still put to a judge, but an action guarded only by
// advisory rules runs without one, so it does not ask for the flag.
function needsJudge(action: Action|undefined): boolean {
  return !!action?.guards?.length;
}

function distinctKinds(actions: Action[]): string[] {
  const kinds = new Set<string>();
  for (const a of actions) {
    if (a.executor) kinds.add(a.executor.kind);
  }
  return [...kinds].sort();
}

// The spec's budgets are about what a body costs the agent that loads it, so
// what is measured is the body rather than the file: frontmatter is read at
// startup and is accounted for by its own limits.
function overBudget(document: string): string[] {
  const body = document.replace(/^---\n[\s\S]*?\n---\n/, '');
  const warnings: string[] = [];
  const lines = body.split('\n').length;
  if (lines > MAX_BODY_LINES) {
    warnings.push(`SKILL.md body is ${lines} lines, over the ${
        MAX_BODY_LINES}-line guidance. Move detail into references/.`);
  }
  // Four characters to the token is the usual rough count. Approximate on
  // purpose: the point is to notice a body that has outgrown the router shape,
  // and being exact about it would mean shipping a tokenizer.
  const tokens = Math.ceil(body.length / 4);
  if (tokens > MAX_BODY_TOKENS) {
    warnings.push(`SKILL.md body is roughly ${tokens} tokens, over the ${
        MAX_BODY_TOKENS}-token guidance. Move detail into references/.`);
  }
  return warnings;
}

/** A YAML double-quoted scalar, on one line, safe for any description. */
function yamlString(text: string): string {
  return `"${collapse(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Folded YAML and hand-wrapped prose both arrive with newlines in them. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Markdown reads a newline inside a table cell as the end of the row. */
function cell(text: string): string {
  return collapse(text).replace(/\|/g, '\\|');
}

/** Keeps the author's paragraphs and drops their line wrapping. */
function paragraph(text: string): string {
  return text.trim().split(/\n\s*\n/).map(collapse).join('\n\n');
}

function firstLine(text: string): string {
  return collapse(text.split(/\n\s*\n/)[0] ?? '');
}

function sentenceEnd(text: string): string {
  return !text || /[.!?]$/.test(text) ? text : `${text}.`;
}
