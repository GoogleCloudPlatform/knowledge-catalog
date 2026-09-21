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
 * a profile supplies. So every `references/` page is a fact about the model
 * and nothing else, and everything that reads the binding lives in `SKILL.md`:
 * the store, the executor kinds, which actions this deployment cannot run and
 * why, and the command line to try one with, all gathered under "Running an
 * action", plus the snippet under "Finding a record" that reads the store
 * directly, which needs the store's kind and its coordinates. Point this at a
 * different profile and those move and the reference pages do not.
 *
 * Keeping that true takes some discipline: whether an action is RUNNABLE is a
 * binding fact wearing a logical name, and putting `tool.unavailable` on the
 * action's own page -- which reads naturally, and which this module did at
 * first -- quietly makes every page profile-specific.
 */

import {Action, AffectedConcept, Constraint, SemanticModel} from './ir';
import {ActionTool, modelTools} from './runtime/agent_tools';
import {dialectFor} from './runtime/dialect';
import {Judge} from './runtime/judge';
import {readableEntities} from './runtime/judge_store';
import {runFlags} from './runtime/run_action';
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
}

/**
 * Stands in for the judge the runtime supplies.
 *
 * A rule stated in words is settled by asking a judge, and the runtime asks it
 * before the transaction opens -- never the agent making the call, which would
 * be the constrained thing certifying itself. So a guarded action only ever
 * runs against a runtime that has one, and that is the runtime a skill
 * describes. Whether whoever ran `skills-generate` had a judge configured is a
 * fact about that invocation and about nothing the document is read against.
 *
 * `modelTools` asks only whether a judge is there. Generating a skill settles
 * no rule, so this throws if anything reaches it.
 */
const ASSUMED_JUDGE: Judge = {
  name: 'the judge the runtime supplies',
  decide: () => {
    throw new Error('generating a skill must not ask a judge');
  },
};


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

  const {actions, instruction} = modelTools({runtime, judge: ASSUMED_JUDGE});
  const warnings: string[] = [];
  if (!actions.length) {
    warnings.push(
        `Model '${model.name}' declares no actions, so the skill describes ` +
        `nothing an agent can do. Generated anyway.`);
  } else if (!actions.some(t => t.runnable)) {
    // A skill whose every action is blocked still loads, still costs context
    // on every request, and still advertises the model as the write path in
    // frontmatter a client reads before the body. Saying so is the difference
    // between an artifact the caller chose and one they did not notice.
    warnings.push(
        `No action in '${model.name}' is runnable under profile '${
            runtime.profile}', so the skill describes ${actions.length} action${
            actions.length === 1 ? '' : 's'} and can ` +
        `run none of them. "Running an action" in the skill gives the ` +
        `reason for each.`);
  }

  const paths = referencePaths(actions);
  const files: SkillFile[] = [{
    path: 'SKILL.md',
    text: skillDocument(name, runtime, actions, instruction, paths),
  }];
  for (const tool of actions) {
    const action = actionFor(tool, model);
    if (!action) continue;
    files.push({
      path: paths.get(tool.actionName)!,
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
    instruction: string, paths: Map<string, string>): string {
  const model = runtime.model;
  const out: string[] = [];
  out.push('---');
  // Quoted, though the name's alphabet is only `[a-z0-9-]`. YAML 1.1 reads
  // `no`, `on`, `y` and an all-digit name as a boolean or an integer, so a
  // model named `No` would emit `name: no` and load as `false` in the parsers
  // most non-JS clients use -- a name that no longer equals its directory,
  // which is the one failure this generator exists to make impossible.
  out.push(`name: ${yamlString(name)}`);
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
      // The action's OWN description, not the tool's. `toolDescription`
      // composes description, instructions, the gating-rules block and the
      // refusal sentence in that order, so an action that declares no
      // description would put its instructions -- or the literal "Calling this
      // will not work" -- into the column a client scans to pick a page.
      const summary = firstLine(actionFor(tool, model)?.description ?? '');
      out.push(`| \`${cell(tool.actionName)}\` | ${
          cell(summary || `Runs ${tool.actionName}.`)} | \`${
          paths.get(tool.actionName)}\` |`);
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

  out.push(...readSideSection(runtime, actions));
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
const USE_WHEN =
    'Use when a request asks to change this data rather than only read it.';

// The acts a model declares, named, in at most `budget` characters.
//
// Enough actions overrun the budget on this sentence alone. Names come off the
// end until it fits, rather than the whole description being cut to length,
// because the cut lands on whatever happens to be at 1,024 characters: the
// sentence saying this is the write side goes, and the list it leaves behind
// ends part-way through a name that does not exist. The count stays exact, so
// a partial list reads as one.
function actsSentence(actions: ActionTool[], budget: number): string {
  const head =
      `Declares ${actions.length} action${actions.length === 1 ? '' : 's'}: `;
  const names = actions.map(t => t.actionName);
  let sentence = `${head}${names.join(', ')}.`;
  for (let shown = names.length - 1; shown >= 1; shown--) {
    if (sentence.length <= budget) return sentence;
    const dropped = `${head}${names.slice(0, shown).join(', ')}, and ${
        names.length - shown} more.`;
    // Dropping a name does not always shorten the sentence: `and 1 more` is
    // ten characters and the name it stands in for may be fewer, so with short
    // names the abridged form runs longer than the full list. Keep whichever
    // is shorter, or a step taken for room ends up costing it -- and the cut
    // below would then be made in the longer of the two.
    if (dropped.length < sentence.length) sentence = dropped;
  }
  // Nothing left to drop and it still does not fit, so cut it and let the
  // sentence after this one carry the routing signal.
  return sentence.length <= budget ? sentence : truncate(sentence, budget);
}

function descriptionFor(model: SemanticModel, actions: ActionTool[]): string {
  // What makes this line a routing decision is the part after the author's
  // prose: which acts the model offers, and that it is the write side. So the
  // budget is spent from the front. Truncating the joined string instead would
  // let a long model description push both out and leave a description that
  // reads well and no longer says what the skill is for.
  const fixed = actions.length ?
      `${actsSentence(actions, MAX_DESCRIPTION - USE_WHEN.length - 1)} ${
          USE_WHEN}` :
      `Declares no actions; it describes the data, and changes none.`;
  const prose = model.description?.trim() || `The ${model.name} model.`;
  const subject = sentenceEnd(collapse(prose));
  const room = MAX_DESCRIPTION - fixed.length - 1;
  if (subject.length <= room) return `${subject} ${fixed}`;
  // Nothing of the subject fits: the acts are what a client routes on, so they
  // are what survives. `fixed` is built to the limit, so it needs no cut here.
  if (room < 8) return fixed;
  return `${truncate(subject, room)} ${fixed}`;
}

// Cut to a length in characters without splitting a surrogate pair -- a lone
// half is not valid UTF-8 and reaches the file as U+FFFD -- and without
// leaving a half-word where a space was close by.
function truncate(text: string, max: number): string {
  let end = max - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  const cut = text.slice(0, end);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// What a key that matches nothing costs, which is the question an agent has
// once it is told to go and find one. Every argument is a scalar, so there is
// no resolve step to get it wrong in: a wrong key reaches the statement. This
// runtime performs the writes of a `sql` executor itself and refuses one that
// reports no rows, rolling the transaction back; the kinds that hand the write
// to another system cannot say what that system does, so they do not say it.
const KEY_MATCHES_NOTHING =
    ' A key that matches no record costs you the call rather than the data: ' +
    'a statement that writes no rows fails the action and rolls the whole ' +
    'transaction back, so nothing is half-applied and nothing is silently ' +
    'skipped. Guessing a key is therefore safe to be wrong about, and not ' +
    'safe to be right about by accident.';

// What this skill does not offer, said once rather than discovered per call.
//
// The instruction above tells an agent to look a record up rather than invent
// an identifier, which is right, and this skill has no way to do it: the
// derived lookups are a read path nothing on the command line calls. Leaving
// that out would leave an agent following an instruction to use a tool that is
// not here, so it is named, along with what does work.
function readSideSection(
    runtime: SemanticRuntime, actions: ActionTool[]): string[] {
  // Every sentence below is about supplying a key to an action, so a model
  // with none has nothing to read a key FOR. Without this the skill says the
  // model declares nothing to call and then closes on a shell recipe into the
  // live store, which is the last and most concrete thing in the file.
  if (!actions.length) return [];
  const out: string[] = [];
  out.push('## Finding a record');
  out.push('');
  // The last sentence is a promise about how a write fails, and only the
  // `sql` kind is executed by this runtime and can be promised. It is dropped
  // rather than the section with it: the instruction above still sends an
  // agent to lookup tools this skill does not have, and saying where a key
  // comes from is the answer to that whichever kind performs the write.
  const performedHere =
      distinctKinds(runtime.model.actions ?? []).includes('sql');
  out.push(
      'This skill offers writes, not reads. When you are given a name or a ' +
      'description where an action wants a key, the key has to come from ' +
      'somewhere else: ask the caller, or read the store directly.' +
      (performedHere ? KEY_MATCHES_NOTHING : ''));
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
    out.push(...readableSchema(runtime));
  }
  return out;
}


// The tables that snippet can name, listed rather than left to be discovered.
//
// Without this an agent given `--sql='SELECT ...'` knows there is a store and
// nothing about its shape, so it spends its first turns querying
// INFORMATION_SCHEMA -- which it did, twice, before reading a row. The model
// already holds the answer: the binding profile says which table each entity
// is and which column each field is, and `readableEntities` is the same
// derivation a reading judge is shown, so the schema here and the schema the
// judge writes against cannot drift apart.
//
// Both names appear, and which is which is spelled out rather than implied.
// The rest of the skill is written in the model's names and a statement has to
// contain the store's, so an agent reading this has to cross between them --
// and `customer_id is Customer.customerId` does not say which side goes in the
// SQL. Given exactly that, an agent wrote `o.customerId`, got a name-not-found
// error, and fell back to INFORMATION_SCHEMA anyway. So the column is labelled
// `column` and the sentence above says the quoted name is the one to write.
function readableSchema(runtime: SemanticRuntime): string[] {
  const dialect = dialectFor(runtime.store);
  const readable = readableEntities(runtime, dialect);
  if (!readable.length) return [];
  const out: string[] = [];
  out.push(
      `Those are ${dialect.name} statements. These tables are the whole of ` +
      'what there is to read, and the names to write in a statement are the ' +
      'table and column names below -- not the model\'s own names, which ' +
      'follow each column for cross-reference:');
  out.push('');
  out.push('```');
  for (const {entity, table, fields} of readable) {
    out.push(`${entity.name} -> table ${table}`);
    for (const field of fields) {
      // The field's own description carries what a coded column's values are
      // -- `item, tax, fee, or credit` -- and an agent that has to guess them
      // filters on a value the column never holds and gets an empty answer
      // back, which reads like the record not existing.
      const says = field.description?.trim();
      out.push(`  column ${dialect.quote(field.column)} (${field.type}) = ${
          entity.name}.${field.name}${
          says ? `. ${says.replace(/\s+/g, ' ')}` : ''}`);
    }
  }
  out.push('```');
  out.push('');
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
  out.push('');

  // The reasons live here rather than on each action's page, and that is the
  // whole point of this section. `tool.unavailable` is partly a fact about the
  // binding -- a profile that binds no store, or binds one the runtime cannot
  // write -- so printing it per page would make every page change when the
  // profile does, and the claim above would be false.
  const blocked = actions.filter(t => !t.runnable);
  if (blocked.length) {
    out.push(
        blocked.length === actions.length ?
            `No action in this model can be run under this profile:` :
            `Not runnable under this profile:`);
    out.push('');
    for (const tool of blocked) {
      out.push(`- \`${tool.actionName}\` -- ${
          sentenceEnd(collapse(tool.unavailable ?? 'no reason given'))}`);
    }
    out.push('');
  }

  if (blocked.length === actions.length) {
    out.push('Report that rather than retrying.');
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
  // `runLine` is the runtime's own answer, and it is asked rather than
  // reproduced. Which arguments a call requires is a rule this module got
  // wrong when it derived it itself, listing every parameter as if required.
  // A line that is certain to be refused is worse than no line, so there is
  // one copy of the rule.
  const flags = action ? runFlags(action) : null;
  if (flags) {
    // The head is rebuilt so a name that needs shell quoting gets it --
    // nothing constrains what is in an action name, and this is a block meant
    // to be copied and run -- and `--profile` goes first because it picks the
    // binding the rest of the line is about. The flags come from `runFlags`
    // already separated, so a name containing ' --' cannot put a piece of
    // itself among them. Joined rather than pushed line by line: an action
    // with no flags at all would otherwise end on a continuation with nothing
    // after it.
    const parts = [
      `kcmd action-run ${shellArg(example.actionName)}`,
      `--profile ${shellArg(runtime.profile)}`,
      ...flags,
    ];
    out.push('```bash');
    out.push(parts.join(' \\\n  '));
    out.push('```');
    out.push('');
  }
  // Said wherever ANY action in the model states a rule, not just the one the
  // example line happens to name. The line is a template an agent adapts to
  // whichever action it means to call, so keying the caveat to the example
  // would drop it from a model whose first runnable action is unguarded and
  // whose second is not -- leaving the reference page's "settled before
  // anything is written" as the only thing said about running a guarded call.
  // An agent that tried the line, saw it commit, and took that for the rules
  // holding would have drawn the one conclusion this command cannot support.
  const anyGuarded = (runtime.model.actions ?? []).some(a => a.guards?.length);
  if (anyGuarded) {
    out.push(
        'That command line settles no guard, for this action or any other ' +
        'in this model. It names whatever rules the action it runs states, ' +
        'and runs the write regardless, so it answers whether the call ' +
        'binds and the write lands, and nothing about whether the rules ' +
        'hold. The runtime your framework calls is what settles them.');
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

/**
 * Where each action's page goes, keyed by the action's authored name.
 *
 * An action name is a free string: `actionSchema.name` is `z.string()` and
 * validation checks the guards, the parameters and the blast radius but never
 * the name's characters. So a name is not a path component. Slugging it to the
 * same `[a-z0-9-]` alphabet the skill name uses makes a traversal structurally
 * impossible rather than filtered for -- `../../../.bashrc` has nowhere to go
 * once the separators and the dots are not in the alphabet.
 *
 * Slugging is lossy, so two names can arrive at one slug. They are numbered in
 * declaration order, because the alternative is two actions sharing a page and
 * the second silently overwriting the first.
 */
function referencePaths(actions: ActionTool[]): Map<string, string> {
  const paths = new Map<string, string>();
  const taken = new Set<string>();
  for (const tool of actions) {
    const base = skillNameFor(tool.actionName) || 'action';
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    taken.add(slug);
    paths.set(tool.actionName, `references/${slug}.md`);
  }
  return paths;
}

// A bare token the shell passes through untouched, or a single-quoted one.
// The action name reaches a ```bash block an agent is meant to copy and run,
// and nothing upstream constrains what is in it.
function shellArg(text: string): string {
  return /^[A-Za-z0-9._-]+$/.test(text) ? text :
                                          `'${text.replace(/'/g, `'\\''`)}'`;
}

function referenceDocument(
    tool: ActionTool, action: Action, model: SemanticModel): string {
  const out: string[] = [];
  out.push(`# ${action.name}`);
  out.push('');
  // Both names, once, here. `action.name` is what `kcmd action-run` takes and
  // what every command line in this package uses; `tool.name` is what the same
  // action is called when a framework hands it over as a tool. An agent meets
  // one or the other depending on how it was wired, and a page that showed
  // only one would be wrong for half of them.
  out.push(
      `Action \`${action.name}\` of the \`${model.name}\` model. As a ` +
      `tool it is named \`${tool.name}\`.`);
  out.push('');
  if (action.description) {
    out.push(paragraph(action.description));
    out.push('');
  }
  // Whether this binding can run it is NOT here. It is a fact about the
  // deployment, and the deployment is described in one place -- "Running an
  // action" in SKILL.md. Repeating it per page would make every page change
  // when the profile does, which is the property this split exists to keep.

  out.push('## Arguments');
  out.push('');
  if (tool.parameters.length) {
    const hasDefault = tool.parameters.some(p => p.default !== undefined);
    out.push(`| Name | Type | Required |${
        hasDefault ? ' Default |' : ''} What to pass |`);
    out.push(`| --- | --- | --- |${hasDefault ? ' --- |' : ''} --- |`);
    for (const p of tool.parameters) {
      // Escaped like every other cell: a default is an arbitrary YAML value,
      // and a pipe in one shifts every column after it by one for the rest of
      // the row -- on the page the skill tells an agent to read before calling.
      const def = hasDefault ?
          ` ${
              p.default === undefined ?
                  '' :
                  `\`${cell(JSON.stringify(p.default))}\``} |` :
          '';
      out.push(`| \`${cell(p.name)}\` | ${cell(p.type ?? 'no type')} | ${
          p.required ? 'yes' : 'no'} |${def} ${cell(p.description)} |`);
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
  // Concept and field names are unconstrained strings, and a pipe in one
  // splits the row even inside backticks -- every column after it shifts by
  // one, on a page the skill tells an agent to read before calling.
  const op = a.operation ? `\`${cell(a.operation)}\`` : 'unspecified';
  const fields = a.fields?.length ?
      a.fields.map(f => `\`${cell(f)}\``).join(', ') :
      (a.operation === 'delete' ? 'the whole record' : 'unspecified');
  return `| \`${cell(a.concept)}\` | ${op} | ${fields} |`;
}


// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function actionFor(tool: ActionTool, model: SemanticModel): Action|undefined {
  return (model.actions ?? []).find(a => a.name === tool.actionName);
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
