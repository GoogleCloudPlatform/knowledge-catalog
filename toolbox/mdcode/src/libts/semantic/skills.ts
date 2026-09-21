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
 * bound model into the action descriptors a skill needs -- the tool name, the
 * description with the gating rules folded in, the typed parameters, and
 * whether this binding can run it -- so this module renders what `modelTools`
 * returns and derives nothing of its own beyond layout.
 *
 * The skill is written against the LOGICAL model, which is what makes it worth
 * generating once. An action's name, arguments, rules and blast radius are the
 * same wherever it is deployed, because an executor is a physical binding that
 * a profile supplies. So every `references/` page is a fact about the model
 * and nothing else, and everything that reads the binding lives in `SKILL.md`:
 * the store, the executor kinds, which actions this deployment cannot run and
 * why, and the statements that perform each one, all gathered under "Running
 * an action", plus the snippet under "Finding a record" that reads the store
 * directly, which needs the store's kind and its coordinates. Point this at a
 * different profile and those move and the reference pages do not.
 *
 * Emitting the statements is what makes the skill sufficient rather than
 * merely informative. Nothing in this toolchain performs an action: kcmd has
 * no runtime, and an agent holding this skill has whatever tools its harness
 * gave it. If the skill described the action and withheld the SQL, an agent
 * would compose its own -- a write nobody declared, against rules nobody
 * checked. The statements are the largest thing in `SKILL.md` and a model with
 * many actions may push the body over budget; `overBudget` says so, and that
 * is the right trade to notice rather than the wrong one to avoid.
 *
 * Keeping that true takes some discipline: whether an action is RUNNABLE is a
 * binding fact wearing a logical name, and putting `tool.unavailable` on the
 * action's own page -- which reads naturally, and which this module did at
 * first -- quietly makes every page profile-specific.
 */

import {Action, AffectedConcept, Constraint, SemanticModel} from './ir';
import {ActionTool, modelTools, readableEntities} from './runtime/agent_tools';
import {dialectFor} from './runtime/dialect';
import {SemanticRuntime} from './runtime/runtime';
import {storeLine} from './runtime/store';
import {leadingDmlVerb} from './sql_identifiers';

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

  const {actions, instruction} = modelTools({runtime});
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
    // Worded as an obligation with a consequence rather than as advice. Under
    // a runtime that loads a reference page on demand -- which is what an
    // Agent Skills runtime is for -- the model decides whether to open it, and
    // a polite `read the page first` gets skipped often enough to matter: the
    // rules that gate an action live on that page and nowhere else, so a
    // skipped read is a guarded write performed without its guards.
    out.push(
        'Each action below has a reference page with the arguments it takes, ' +
        'the rules that gate it, and what it changes. Read an action\'s page ' +
        'before every call to it: the rules that decide whether the call may ' +
        'proceed are on that page and nowhere else, so calling without ' +
        'reading it means writing under rules you have not read.');
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
  out.push(...outcomeSection(runtime, actions));

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
// no resolve step to get it wrong in: a wrong key reaches the statement.
//
// And a statement is all it reaches. Nothing in this toolchain performs the
// write, so nothing checks the row count on the agent's behalf and refuses.
// What a wrong key then costs depends on the statement's verb, and the two
// cases are opposites: an UPDATE or a DELETE keyed to nothing changes nothing
// and says so in its row count, while an INSERT keyed to nothing lands a row
// whose reference is dangling and reports that as a row written. Telling an
// agent whose action inserts to read the row count would point it at the one
// number that cannot answer the question, so the verb decides which of these
// is said. The `sql` kind is the only one either can be said of, because the
// kinds that hand the write to another system cannot say what that system
// reports.
const KEY_MATCHES_NOTHING =
    ' A key that matches no record does not announce itself.';

const KEY_MATCHES_NOTHING_UPDATE =
    ' A statement that updates or deletes by key runs, matches nothing, ' +
    'writes nothing, and comes back reporting zero rows rather than an ' +
    'error. Read that count: a write that changed no rows did not happen, ' +
    'however well the call went, and reporting it as done is a mistake ' +
    'nothing else will catch.';

const KEY_MATCHES_NOTHING_INSERT =
    ' A statement that inserts is refused only where the store enforces that ' +
    'key as a foreign key. Where it does not, the row lands, the call reports ' +
    'a row written, and what the row refers to does not exist -- so read the ' +
    'record a key names before you write against it, because no row count ' +
    'will tell you afterwards.';

/**
 * What to say about a wrong key under this model, or nothing.
 *
 * Read from the leading verb of every statement a `sql` executor declares.
 * validate.ts already refuses to publish a statement whose first word is not
 * INSERT, UPDATE or DELETE, so an empty result here means the model binds no
 * SQL statement rather than one that could not be read -- and a verb that
 * cannot be read drops the sentence rather than guessing which half of it is
 * true.
 */
function keyRiskSentence(runtime: SemanticRuntime): string {
  const verbs = new Set<string>();
  for (const action of runtime.model.actions ?? []) {
    const executor = action.executor;
    if (executor?.kind !== 'sql') continue;
    for (const statement of executor.sql.statements) {
      const verb = leadingDmlVerb(statement);
      if (verb) verbs.add(verb);
    }
  }
  const cases: string[] = [];
  if (verbs.has('UPDATE') || verbs.has('DELETE')) {
    cases.push(KEY_MATCHES_NOTHING_UPDATE);
  }
  if (verbs.has('INSERT')) cases.push(KEY_MATCHES_NOTHING_INSERT);
  if (!cases.length) return '';
  return KEY_MATCHES_NOTHING + cases.join('');
}

// How to read, said as a statement first and a command second. See the comment
// at its use.
const READ_WITH_SELECT =
    'To read the store directly, run a `SELECT` against it. If a shell is ' +
    'what you have:';

// What this skill does not offer, said once rather than discovered per call.
//
// The instruction above tells an agent never to invent an identifier, and this
// skill offers only the write side -- so where a key has to come from is named
// here, along with how to read the store directly when one is bound.
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
  // The last sentences are a claim about how a write fails, and only a `sql`
  // executor's statement is here to be read. They are dropped rather than the
  // section with them: the instruction above still tells an agent never to
  // invent an identifier, and saying where a key comes from is the answer to
  // that whichever kind performs the write.
  out.push(
      'This skill offers writes, not reads. When you are given a name or a ' +
      'description where an action wants a key, the key has to come from ' +
      'somewhere else: ask the caller, or read the store directly.' +
      keyRiskSentence(runtime));
  out.push('');
  // Reading is stated as a SELECT against the store, and the CLI below is one
  // way to send it rather than the way. Whatever holds this skill may already
  // have a way to run SQL, and a skill cannot know what it is called; a lead
  // that goes straight to a shell command tells such a holder to shell out
  // when it has a better tool in hand.
  if (runtime.store?.kind === 'spanner') {
    const s = runtime.store;
    out.push(READ_WITH_SELECT);
    out.push('');
    out.push('```bash');
    out.push(`gcloud spanner databases execute-sql ${s.database} \\`);
    out.push(`  --instance=${s.instance} --project=${s.project} \\`);
    out.push(`  --sql='SELECT ...'`);
    out.push('```');
    out.push('');
  } else if (runtime.store?.kind === 'bigquery') {
    const s = runtime.store;
    out.push(READ_WITH_SELECT);
    out.push('');
    out.push('```bash');
    out.push(`bq query --use_legacy_sql=false --project_id=${
        s.project} --dataset_id=${s.dataset} \\`);
    out.push(`  'SELECT ...'`);
    out.push('```');
    out.push('');
  } else if (runtime.store?.kind === 'alloydb') {
    const s = runtime.store;
    out.push(
        `To read the store directly, run a \`SELECT\` against it. This skill ` +
        `supplies no canned CLI command for AlloyDB; if a shell is what you ` +
        `have, connect to \`${s.project}/${s.location}/${s.cluster}/${
            s.instance}/${s.database}\` via \`psql\` or the AlloyDB Auth ` +
        `Proxy.`);
    out.push('');
  }
  if (runtime.store) {
    out.push(...readableSchema(runtime));
  }
  return out;
}


// The tables a SELECT can name, listed rather than left to be discovered.
//
// Without this an agent knows there is a store and nothing about its shape, so
// it spends its first turns querying INFORMATION_SCHEMA. The model already
// holds the answer: the binding profile says which table each entity is and
// which column each field is, and `readableEntities` derives both from the
// profile in the store's SQL dialect (GoogleSQL or PostgreSQL).
function readableSchema(runtime: SemanticRuntime): string[] {
  const dialect = dialectFor(runtime.store);
  const readable = readableEntities(runtime, dialect);
  if (!readable.length) return [];
  const out: string[] = [];
  const hasSnippet =
      runtime.store?.kind === 'spanner' || runtime.store?.kind === 'bigquery';
  const lead = hasSnippet ? `Those are ${dialect.name} statements.` :
                            `Write ${dialect.name} statements.`;
  // "table" is not claimed of the source, only of the column. A profile binds
  // an entity to whatever the store will answer a SELECT about, and a view is
  // an ordinary choice -- a field the model describes as derived is a view
  // column wherever it is honest about it. Calling one a table in the line an
  // agent reads before writing a statement is a small lie for no gain.
  // One rule for every line, stated once: write what is left of the `=`. The
  // entity line used to read `Order -> Orders` while the column lines under it
  // read `column order_id ... = Order.orderId` -- the name to write first on
  // one line and second on the next, with nothing saying which. An agent
  // reading the block top-down picked the wrong side of the arrow and sent
  // `FROM `Order``, which is the model's name and not a table.
  out.push(
      `${lead} These are the whole of ` +
      'what there is to read. On every line below, the name to write in a ' +
      'statement is to the left of the `=`, and the model\'s own name for ' +
      'the same thing follows it for cross-reference:');
  out.push('');
  out.push('```');
  for (const {entity, table, fields} of readable) {
    out.push(`${table} = ${entity.name}`);
    for (const field of fields) {
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
  for (const tool of actions.filter(t => t.runnable)) {
    const ex = actionFor(tool, runtime.model)?.executor;
    if (!ex) continue;
    if (ex.kind === 'mcp') {
      out.push(`- \`${tool.actionName}\` (\`${tool.name}\`): MCP tool \`${
          ex.mcp.tool}\` on \`${ex.mcp.server}\``);
    } else if (ex.kind === 'rest') {
      out.push(`- \`${tool.actionName}\` (\`${tool.name}\`): HTTP \`${
          ex.rest.method}\` \`${ex.rest.endpoint}\``);
    } else if (ex.kind === 'grpc') {
      out.push(`- \`${tool.actionName}\` (\`${tool.name}\`): gRPC \`${
          ex.grpc.service}/${ex.grpc.method}\``);
    }
  }
  out.push('');

  // The reasons live here rather than on each action's page, and that is the
  // whole point of this section. `tool.unavailable` is partly a fact about the
  // binding -- a profile that binds no store leaves a `sql` action with
  // nothing to run against -- so printing it per page would make every page
  // change when the profile does, and the claim above would be false.
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

  out.push(...statementsSection(runtime, actions));
  return out;
}

/**
 * The SQL each runnable `sql` action is, verbatim from the binding profile.
 *
 * Without this the skill tells an agent what an action means and leaves it to
 * invent the write, which is the failure this whole design is against: the
 * statement a profile author wrote has been checked against the store at push
 * time, and one an agent composes has not been checked by anybody.
 *
 * Verbatim matters. The statements are handed to the store as written --
 * nothing translates the model's field names into the binding's the way a
 * metric's expression is translated -- so what is printed here is what has to
 * run. Only the parameter values are the caller's to supply.
 */
function statementsSection(
    runtime: SemanticRuntime, actions: ActionTool[]): string[] {
  const sqlActions: Array<{tool: ActionTool, statements: string[]}> = [];
  for (const tool of actions.filter(t => t.runnable)) {
    const ex = actionFor(tool, runtime.model)?.executor;
    if (ex?.kind !== 'sql') continue;
    const statements = ex.sql.statements.filter(s => s.trim());
    if (statements.length) sqlActions.push({tool, statements});
  }
  if (!sqlActions.length) return [];

  const dialect = dialectFor(runtime.store);
  const several = sqlActions.some(a => a.statements.length > 1);
  const out: string[] = [];
  out.push(
      `To perform one of these, run its ${dialect.name} below against that ` +
      `store with the call's arguments bound to the named parameters. Run ` +
      `what is written and nothing else: this is what the model says the ` +
      `action is, and a statement composed instead of this one is a write ` +
      `nobody declared and no rule was written against.`);
  out.push('');
  if (several) {
    // Said only when it can arise. A list is ordered, and that is all it is:
    // whether the backend commits several statements as one unit is the
    // backend's and the caller's business, not something declaring them here
    // arranged. An action that must be all-or-nothing is written as one
    // statement -- see the actions guide.
    out.push(
        'Where an action lists more than one statement, run them in the ' +
        'order given. Nothing here makes them one commit: if the store can ' +
        'run them in a transaction, do that, and if a later one fails say ' +
        'plainly which earlier ones already landed.');
    out.push('');
  }
  for (const {tool, statements} of sqlActions) {
    out.push(`### ${tool.actionName}`);
    out.push('');
    out.push('```sql');
    // Exactly as authored, and no terminator added. What is in this block has
    // to be what reaches the store: a semicolon appended for looks is a
    // character the author did not write, and some clients refuse one.
    // Statements are separated by a blank line rather than punctuation,
    // because they are separate calls.
    out.push(statements.map(s => s.trim()).join('\n\n'));
    out.push('```');
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
function outcomeSection(
    runtime: SemanticRuntime, actions: ActionTool[]): string[] {
  if (!actions.length) return [];
  // A row count is the `sql` kind's evidence and nobody else's. Where another
  // system performs the write, what comes back is whatever that system chose
  // to report, which may carry no count at all -- and asking an agent for a
  // number it was never given gets an invented one.
  const counted = distinctKinds(runtime.model.actions ?? []).includes('sql');
  const applied = counted ?
      '- **Applied.** The write landed. Say what changed, and say how many ' +
          'rows changed.' :
      '- **Applied.** The write landed. Say what changed, and say what the ' +
          'system that performed it reported.';
  const unsure = counted ? 'If you sent a statement and cannot tell whether ' +
          'it landed' :
                           'If you made the call and cannot tell whether it ' +
          'landed';
  return [
    '## How a call ends',
    '',
    'Settle every rule that gates an action before you perform it, not ' +
        'after. A rule settled afterwards is not a gate: the write has ' +
        'landed and there is nothing left for the rule to prevent. Refusing ' +
        'first is what makes a refusal cost nothing.',
    '',
    'A call ends in one of these. Do not collapse them into worked and did ' +
        'not work:',
    '',
    applied,
    // The escalate sentence says what does *not* happen, because the gap it
    // closes is one an agent fills in by itself. Told only that a person has
    // to decide, a model reports the call as submitted for review -- "I have
    // added the credit and it will be reviewed", with a projected new total,
    // after issuing no statement at all. Nothing here queues anything: there
    // is no pending state to be in, and a caller told their request is
    // awaiting approval waits for an approval nobody will ever be asked for.
    '- **Refused.** You did not perform the write, and the reason says why. ' +
        'Repeat the reason plainly. If it says a person has to decide, say ' +
        'so and stop -- you cannot approve it yourself, and rephrasing the ' +
        'request to get past a rule is the one thing you must not do. ' +
        'Needing a decision does not record the request anywhere: nothing ' +
        'is queued, nobody is notified, and no approval is pending. Say ' +
        'that the change did not happen and what the caller must do to ' +
        'have it made, and never report it as submitted or awaiting review.',
    '- **Applied with warnings.** The change landed and an advisory rule ' +
        'still went unmet. Report both. Reporting only the success tells the ' +
        'caller the write met every rule the model states, which is the one ' +
        'thing it did not.',
    '',
    `${unsure}, that is a fourth thing and not a failure: say so, and say ` +
        'what to read to find out. Do not try it again. A retry that succeeds ' +
        'where the first attempt may also have succeeded leaves two of ' +
        'whatever the caller asked for one of.',
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

function referenceDocument(
    tool: ActionTool, action: Action, model: SemanticModel): string {
  const out: string[] = [];
  out.push(`# ${action.name}`);
  out.push('');
  // Both names, once, here. `action.name` is the authored action name in the
  // model; `tool.name` is what the same action is called when a framework hands
  // it over as a tool. An agent meets one or the other depending on how it was
  // wired, and a page that showed only one would be wrong for half of them.
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
    // Both extra columns are conditional, because a table with a column that
    // is empty on every row costs width on a page an agent reads under a
    // budget and says nothing.
    const hasFrom = tool.parameters.some(p => p.from);
    out.push(`| Name | Type | Required |${hasDefault ? ' Default |' : ''}${
        hasFrom ? ' Identifies |' : ''} What to pass |`);
    out.push(`| --- | --- | --- |${hasDefault ? ' --- |' : ''}${
        hasFrom ? ' --- |' : ''} --- |`);
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
      const from = hasFrom ? ` ${p.from ? `\`${cell(p.from)}\`` : ''} |` : '';
      out.push(`| \`${cell(p.name)}\` | ${cell(p.type ?? 'no type')} | ${
          p.required ? 'yes' : 'no'} |${def}${from} ${cell(p.description)} |`);
    }
    if (hasFrom) {
      out.push('');
      out.push(
          'An argument with something in **Identifies** is the key of a ' +
          'record that has to exist already. Find it; do not invent it. ' +
          '"Finding a record" in SKILL.md says where to look.');
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
        violationGloss(rule.onViolation)}`);
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

// What each `on_violation` word asks of whoever is holding the skill.
//
// Glossed for all three, not just `warn`. `warn` was glossed alone because it
// is the surprising one -- a rule that does not stop the call -- but the other
// two are only self-evident to a reader who already knows the vocabulary, and
// the reader this page is written for is a model deciding what to do next. The
// difference between `escalate` and `reject` is the difference between
// stopping and stopping permanently, and a page that leaves it to be inferred
// gets an agent that offers to try again.
function violationGloss(effect: string|undefined): string {
  switch (effect) {
    case 'warn':
      return ' -- this one reports and lets the write through.';
    case 'escalate':
      return ' -- a call that does not satisfy it is for a person to decide. ' +
          'Stop and say so; do not approve it yourself.';
    case 'reject':
      return ' -- a call that does not satisfy it must not be performed at ' +
          'all. There is nobody to refer it to.';
    default:
      return '';
  }
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
