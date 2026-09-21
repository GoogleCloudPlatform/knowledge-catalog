// Behavior specification for generating an Agent Skill from a model.
//
// Three claims are under test.
//
// The first is conformance. A skill whose frontmatter breaks the Agent Skills
// rules is loaded by a lenient client and SKIPPED by a strict one, so it fails
// on somebody else's machine and not on the author's. Generating it is what
// makes it correct by construction, and these tests are what say so.
//
// The second is shape. `SKILL.md` is a router: a line per action, the parts
// true of every call, and nothing else. The detail belongs in `references/`,
// read only when an agent has decided it wants that action. A generator that
// inlines everything spends the body budget on actions nobody asked about.
//
// The third is that the skill is about the MODEL. An action's arguments, the
// rules that gate it and what it changes are the same wherever it is deployed,
// because an executor is a physical binding. So pointing the generator at a
// different database has to leave every reference page byte-identical, and
// that is checked here rather than asserted in a comment.
//
// Nothing here opens a database. Generating a skill is pure.

import {describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';

import * as spanner from '../../../src/libts/gcp/spanner';
import {Action, SemanticModel} from '../../../src/libts/semantic/ir';
import {loadModels} from '../../../src/libts/semantic/loader';
import {SemanticRuntime} from '../../../src/libts/semantic/runtime/runtime';
import {generateSkill, skillNameFor, whyNameIsInvalid} from '../../../src/libts/semantic/skills';

const FIXTURES = path.join(__dirname, 'fixtures');

function loadFixtureModel(name: string): SemanticModel {
  return loadModels(fs.readFileSync(path.join(FIXTURES, name), 'utf8'))
      .models[0];
}

// A model paired with a store. Nothing here calls the store; it is there
// because a runtime that has none describes every action as unrunnable, which
// is its own case below.
function rt(model: SemanticModel, over: Partial<SemanticRuntime> = {}):
    SemanticRuntime {
  return {
    model,
    document: 'test',
    store: {
      kind: 'spanner',
      name: 'projects/p/instances/i/databases/d',
      project: 'p',
      instance: 'i',
      database: 'd',
      client: {} as spanner.SpannerDataClient,
    },
    profile: 'default',
    entryGroup: 'eg',
    ...over,
  };
}

// The fixture's action is performed by MCP, which the runtime will not wrap.
// Most tests here want the case an agent actually meets, so they give it a
// `sql` executor and no guard.
const RUNNABLE: Partial<Action> = {
  executor: {
    kind: 'sql',
    sql: {statements: ['UPDATE orders SET o_totalprice = 0 WHERE 1 = 0']},
  },
  guards: [],
};

function withAction(
    model: SemanticModel, over: Partial<Action>): SemanticModel {
  const [action] = model.actions!;
  return {...model, actions: [{...action, ...over}]};
}

// The files, keyed by path, which is how every test below reads them.
function generate(runtime: SemanticRuntime, name?: string) {
  const out = generateSkill({runtime, name});
  if ('error' in out) throw new Error(out.error);
  const files = Object.fromEntries(out.files.map(f => [f.path, f.text]));
  return {...out, files};
}

function frontmatter(document: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(document);
  expect(match).not.toBeNull();
  return yaml.parse(match![1]) as Record<string, unknown>;
}

function body(document: string): string {
  return document.replace(/^---\n[\s\S]*?\n---\n/, '');
}


describe('the skill name', () => {
  test('a model name becomes a name the spec accepts', () => {
    expect(skillNameFor('commerce')).toBe('commerce');
    expect(skillNameFor('IssueCredit')).toBe('issue-credit');
    expect(skillNameFor('commerce_demo')).toBe('commerce-demo');
    expect(skillNameFor('Sales Orders')).toBe('sales-orders');
    // A name that is punctuation at both ends keeps neither.
    expect(skillNameFor('__sales__')).toBe('sales');
  });

  test('every converted name passes the validator', () => {
    for (const authored
             of ['commerce', 'IssueCredit', 'commerce_demo', 'Sales Orders',
                 'A', 'x'.repeat(200)]) {
      expect(whyNameIsInvalid(skillNameFor(authored))).toBeUndefined();
    }
  });

  test('a name a strict client would skip is refused, not emitted', () => {
    // Each of these loads under a lenient client and is skipped inside a
    // plugin, which is the failure this generator exists to make impossible.
    for (const bad
             of ['MySkill', 'my_skill', '-leading', 'trailing-',
                 'double--hyphen', '', 'x'.repeat(65)]) {
      expect(whyNameIsInvalid(bad)).toBeTruthy();
    }
  });

  test(
      'the name the caller passes is checked before anything is written',
      () => {
        const model = loadFixtureModel('actions_place_order.yaml');
        const out = generateSkill({runtime: rt(model), name: 'MySkill'});
        expect(out).toHaveProperty('error');
        expect((out as {error: string}).error).toContain('MySkill');
      });

  test('the package names the directory it must be written under', () => {
    const model = loadFixtureModel('actions_place_order.yaml');
    // The frontmatter name and the directory name are required to match, so
    // the generator reports one string and the caller uses it for both.
    const out = generate(rt(model));
    expect(out.name).toBe('sales');
    expect(frontmatter(out.files['SKILL.md']).name).toBe(out.name);
  });
});


describe('SKILL.md frontmatter', () => {
  const model = loadFixtureModel('actions_place_order.yaml');
  const out = generate(rt(withAction(model, RUNNABLE)));
  const fm = frontmatter(out.files['SKILL.md']);

  test('carries only the fields the spec defines', () => {
    // The field set is closed: the reference validator errors on a seventh
    // key, so a generator that invents one produces a skill that fails to
    // validate. Nothing the model has to say needs a new field.
    expect(Object.keys(fm).sort()).toEqual(['description', 'name']);
  });

  test(
      'the description says what the model is and when to reach for it', () => {
        const description = fm['description'] as string;
        expect(description).toContain(model.description!);
        // The authored action name in the model.
        expect(description).toContain('PlaceOrder');
        expect(description.length).toBeLessThanOrEqual(1024);
      });

  test('a description over the limit is cut rather than emitted long', () => {
    const wordy = {...model, description: 'word '.repeat(400)};
    const fmLong = frontmatter(generate(rt(wordy)).files['SKILL.md']);
    expect((fmLong['description'] as string).length).toBeLessThanOrEqual(1024);
  });

  test('what survives the cut is the part a client routes on', () => {
    // Cutting the joined string would drop the acts and the "use when" -- the
    // two parts that make this line a routing decision -- and leave a
    // description that still reads well and no longer says what it is for.
    const wordy = {
      ...withAction(model, RUNNABLE),
      description: 'word '.repeat(400),
    };
    const long =
        frontmatter(generate(rt(wordy)).files['SKILL.md'])['description'] as
        string;
    expect(long.length).toBeLessThanOrEqual(1024);
    expect(long).toContain('PlaceOrder');
    expect(long).toContain('Use when');
  });

  test('a name YAML 1.1 would read as a boolean is quoted', () => {
    // `name: no` loads as `false` in the parsers most non-JS clients use, so
    // the name no longer equals its directory and a strict client skips the
    // skill -- the one failure this generator exists to make impossible.
    const skill = generate(rt({...model, name: 'No'})).files['SKILL.md'];
    expect(skill).toContain('name: "no"');
    expect(skill).not.toContain('name: no\n');
  });
});


describe('SKILL.md is a router', () => {
  const model = loadFixtureModel('actions_place_order.yaml');
  const out = generate(rt(withAction(model, RUNNABLE)));
  const skill = out.files['SKILL.md'];

  test('one row per action, pointing at the file with the detail', () => {
    expect(skill).toContain('`PlaceOrder`');
    expect(skill).toContain('`references/place-order.md`');
    expect(out.files['references/place-order.md']).toBeTruthy();
  });

  test('the per-argument detail is in the reference, not the router', () => {
    // The anti-pattern this shape exists to avoid: a body that spends the
    // budget describing arguments of actions the agent did not ask about.
    const reference = out.files['references/place-order.md'];
    expect(reference).toContain('| `quantity` |');
    expect(skill).not.toContain('| `quantity` |');
  });

  test('the model\'s own guidance travels with the skill', () => {
    // What the business wants said to an agent acting on it is a property of
    // the model, so it belongs in the skill rather than in whoever wrote the
    // agent. The fixture states none, so this one does.
    const spoken = 'You are working an internal operations desk.';
    const stated = withAction(model, RUNNABLE);
    const withGuidance = generate(rt({
                           ...stated,
                           aiContext: {instructions: spoken},
                         })).files['SKILL.md'];
    expect(withGuidance).toContain(spoken);
    // And the part that is true of any model's tools, which an agent reading
    // only the model's words would not be told.
    expect(skill).toContain('Never invent an identifier.');
  });

  test('the body stays inside the budget a client reads it against', () => {
    expect(body(skill).split('\n').length).toBeLessThan(500);
    expect(Math.ceil(body(skill).length / 4)).toBeLessThan(5000);
    expect(out.warnings).toEqual([]);
  });

  test(
      'how a refusal, a warning and an unknown outcome differ is stated',
      () => {
        // An agent that reads a refusal as a retry, or a warning as nothing, is
        // wrong in the same way against every model, so every skill says it.
        expect(skill).toContain('Refused.');
        expect(skill).toContain('Unknown.');
        expect(skill).toContain('warnings');
      });

  test('a model with no actions still yields a skill, and says so', () => {
    const readOnly = generate(rt({...model, actions: []}));
    expect(readOnly.files['SKILL.md']).toContain('no actions');
    expect(readOnly.warnings.join(' ')).toContain('no actions');
    expect(Object.keys(readOnly.files)).toEqual(['SKILL.md']);
  });
});


describe('an action reference', () => {
  const model = loadFixtureModel('actions_place_order.yaml');
  const out = generate(rt(withAction(model, RUNNABLE)));
  const reference = out.files['references/place-order.md'];

  test('names the action the author named, not only the tool', () => {
    // Both, once. An agent meets one or the other depending on whether it was
    // handed a CLI or a framework's tool list.
    expect(reference).toContain('# PlaceOrder');
    expect(reference).toContain('`place_order`');
  });

  test(
      'a projected argument reads as the field, a declared one as itself',
      () => {
        // `customer` projects from `customer.c_custkey` and `quantity` states
        // its own type, and the table does not say which is which -- by the
        // time an agent reads this, both are one scalar to pass. What the
        // projection buys is the wording: the field's datatype and the
        // field's description, rather than an author restating them here and
        // drifting from the column.
        expect(reference).toContain(
            '| `customer` | integer | yes | The customer\'s account number. |');
        expect(reference).toContain('| `quantity` | integer | yes |');
      });

  test('carries the action\'s own guidance for a caller', () => {
    expect(reference).toContain(
        model.actions![0].aiContext!.instructions!.trim());
  });

  test(
      'what the call changes is listed, including what the model left vague',
      () => {
        expect(reference).toContain(
            '| `orders` | `create` | `o_orderkey`, `o_totalprice` |');
        expect(reference).toContain(
            '| `orders_to_customer` | `create` | unspecified |');
        // The bare-name shorthand says the concept is touched and does not say
        // how. Inventing a verb for it here would make the page claim more than
        // the model does.
        expect(reference).toContain(
            '| `customer` | unspecified | unspecified |');
      });
});


describe('the rules on a reference page', () => {
  const model = loadFixtureModel('actions_place_order.yaml');
  // Both a rule that stops the write and one that does not, so the page has
  // to tell them apart.
  const guarded = withAction(model, {
    ...RUNNABLE,
    guards: ['OrderWithinCustomerCredit', 'OrderWithinStandingLimit'],
  });
  const reference = generate(rt(guarded)).files['references/place-order.md'];

  test('each rule carries its words and its consequence', () => {
    expect(reference).toContain('### OrderWithinCustomerCredit');
    expect(reference).toContain('On violation: `reject`');
    expect(reference).toContain('must not exceed the credit this customer has');
    expect(reference).toContain('ask for a credit review');
  });

  test('an advisory rule is listed and marked as one', () => {
    const advisory = {
      ...guarded,
      constraints: guarded.constraints!.map(
          c => c.name === 'OrderWithinStandingLimit' ?
              {...c, onViolation: 'warn' as const} :
              c),
    };
    const page = generate(rt(advisory)).files['references/place-order.md'];
    // The tool description names only the gating rules, and is right to. A
    // reference page has room for the distinction, so it makes it rather than
    // dropping a rule the caller will hear from.
    expect(page).toContain('### OrderWithinStandingLimit (advisory)');
    expect(page).toContain('lets the write through');
  });

  test('a rule the action does not name is not listed', () => {
    // A constraint no action names is catalogued and inert. Listing it would
    // tell a caller it will be checked.
    expect(reference).not.toContain('PositiveQuantity');
  });
});


describe('when the runtime would refuse the call', () => {
  const model = loadFixtureModel('actions_place_order.yaml');

  test('a guarded action is runnable, because the runtime settles it', () => {
    // The guard is settled in words, which is the runtime's job and not the
    // reading agent's: an agent that judged its own call would be the
    // constrained thing certifying itself. So the skill is written for a
    // runtime that has a judge, and carries no flag about one.
    const out = generate(rt(withAction(model, {executor: RUNNABLE.executor})));
    expect(out.files['SKILL.md']).not.toContain('--judge');
    expect(out.files['SKILL.md'])
        .toContain('puts the action\'s guards to a judge');
    expect(out.warnings.join(' ')).not.toContain('runnable');
  });

  test('an executor the runtime cannot roll back is reported as such', () => {
    // The fixture's own MCP executor: the write would commit in a system this
    // runtime does not control.
    const out = generate(rt(withAction(model, {guards: []})));
    expect(out.files['SKILL.md']).toContain('MCP');
    expect(out.files['references/place-order.md'])
        .not.toContain('Not runnable');
  });

  test(
      'a skill that can run nothing warns rather than passing silently', () => {
        // It still loads, still costs context on every request, and still names
        // the model as the write path in frontmatter a client reads before the
        // body. A caller who did not mean to make one has to be told. The
        // fixture's own MCP executor is the case: the runtime will not wrap a
        // write it could not roll back.
        const out = generate(rt(model));
        expect(out.warnings.join(' ')).toContain('runnable');
        expect(out.warnings.join(' ')).toContain('Running an action');
      });

  test(
      'a skill for a model nothing here can run says so in the binding section',
      () => {
        const skill = generate(rt(model)).files['SKILL.md'];
        expect(skill).toContain('No action in this model can be run');
      });

  test('a profile that binds no store says where the skill stands', () => {
    const skill = generate(rt(withAction(model, RUNNABLE), {
                    store: undefined,
                    storeError: 'no deployment target.',
                  })).files['SKILL.md'];
    expect(skill).toContain('Store: none.');
  });
});


describe('what a key matching nothing costs', () => {
  const model = loadFixtureModel('actions_place_order.yaml');

  // The model-level instruction tells an agent never to invent an identifier,
  // and this skill offers only the write side. Saying where a key comes from
  // instead does not depend on the model declaring any entities.
  const noEntities: SemanticModel = {
    ...model,
    entities: [],
    actions: [{...model.actions![0], ...RUNNABLE} as Action],
  };

  test('still says where a key has to come from', () => {
    const out = generate(rt(noEntities)).files['SKILL.md'];
    expect(out).toContain('## Finding a record');
    expect(out).toContain('This skill offers writes, not reads.');
    expect(out).toContain('the key has to come from somewhere else');
  });

  test('a sql executor promises the refusal it performs', () => {
    // Every argument is a scalar, so a wrong key reaches the statement rather
    // than failing a resolve ahead of it. This runtime runs the statement, so
    // it can say what happens next: no rows written, action failed, rolled
    // back. An agent that does not know this hedges on a call that is safe to
    // get wrong.
    expect(generate(rt(noEntities)).files['SKILL.md'])
        .toContain('costs you the call rather than the data');
  });

  test('another kind does not promise what it does not perform', () => {
    // The fixture's own executor is MCP. Another system does the write, and
    // nothing here knows whether that system refuses a statement matching no
    // row -- so the section is still emitted, without the promise.
    const out = generate(rt(model)).files['SKILL.md'];
    expect(out).toContain('## Finding a record');
    expect(out).not.toContain('costs you the call rather than the data');
  });
});


describe('the binding is one section', () => {
  const model = loadFixtureModel('actions_place_order.yaml');

  // Two deployments of one model: different databases, and different DML,
  // which is what a second binding profile supplies.
  const here = withAction(model, RUNNABLE);
  const there = withAction(model, {
    executor: {
      kind: 'sql',
      sql: {statements: ['UPDATE sales_order SET amount = 0 WHERE 1 = 0']},
    },
    guards: [],
  });
  const first = generate(rt(here, {profile: 'spanner'}));
  const second = generate(rt(there, {
    profile: 'alloydb',
    store: {
      kind: 'spanner',
      name: 'projects/q/instances/j/databases/e',
      project: 'q',
      instance: 'j',
      database: 'e',
      client: {} as spanner.SpannerDataClient,
    },
  }));

  test('a reference page does not change when the deployment does', () => {
    // The whole argument for generating this from the logical model: what an
    // action is, what gates it and what it changes are the same in both
    // databases, so the page an agent reads before calling is the same bytes.
    expect(second.files['references/place-order.md'])
        .toBe(first.files['references/place-order.md']);
  });

  test('nor when the deployment cannot run the action at all', () => {
    // The case the two profiles above cannot reach, because both bind a
    // working Spanner store. Whether an action is RUNNABLE is a binding fact
    // wearing a logical name, so putting the reason on the action's own page
    // -- which reads naturally, and which this module did at first -- makes
    // every page profile-specific and the claim above false.
    const storeless = generate(rt(here, {
      profile: 'unbound',
      store: undefined,
      storeError: 'no deployment target.',
    }));
    expect(storeless.files['references/place-order.md'])
        .toBe(first.files['references/place-order.md']);
    // Not silently dropped: it moved to the section that owns the binding.
    expect(storeless.files['SKILL.md']).toContain('Store: none.');
  });

  test('no physical name reaches the skill', () => {
    // The statements name tables and columns the model does not. A skill that
    // leaked them would describe one deployment while claiming to describe
    // the model.
    for (const text of Object.values(second.files)) {
      expect(text).not.toContain('sales_order');
    }
  });

  test('what does change is named as the deployment-specific part', () => {
    expect(first.files['SKILL.md']).toContain('profile `spanner`');
    expect(second.files['SKILL.md']).toContain('profile `alloydb`');
    expect(first.files['SKILL.md']).toContain('`p/i/d`');
    expect(second.files['SKILL.md']).toContain('`q/j/e`');
  });
});


describe('text that would otherwise break the output', () => {
  const model = loadFixtureModel('actions_place_order.yaml');

  test('a description with a colon and a quote stays parseable YAML', () => {
    // The failure this guards against is silent: the frontmatter parses as
    // something else, or fails to parse, and the skill never loads.
    const awkward = {
      ...withAction(model, RUNNABLE),
      description: 'Sales: orders, "returns" and \\ other things',
    };
    const fm = frontmatter(generate(rt(awkward)).files['SKILL.md']);
    expect(fm['description'])
        .toContain('Sales: orders, "returns" and \\ other');
  });

  test('a multi-line description arrives on one line', () => {
    const wrapped = {
      ...withAction(model, RUNNABLE),
      description: 'Sales orders\nwrapped over\nthree lines',
    };
    const document = generate(rt(wrapped)).files['SKILL.md'];
    const fm = frontmatter(document);
    expect(fm['description'])
        .toContain('Sales orders wrapped over three lines');
  });

  test('a pipe in a description does not split a table row', () => {
    const piped = withAction(model, {...RUNNABLE, description: 'a | b | c'});
    const skill = generate(rt(piped)).files['SKILL.md'];
    const row = skill.split('\n').find(l => l.includes('`PlaceOrder`'))!;
    // Three cells, however many pipes the author wrote.
    expect(row.replace(/\\\|/g, '').split('|').filter(Boolean)).toHaveLength(3);
  });

  test('a pipe in a default does not shift the argument table', () => {
    // The Default cell was the one built without escaping, so a default
    // containing a pipe moved every column after it by one -- on the page the
    // skill tells an agent to read before making the call.
    const piped = withAction(model, {
      ...RUNNABLE,
      parameters: [{name: 'mode', type: 'string', default: 'a|b'}],
    });
    const page = generate(rt(piped)).files['references/place-order.md'];
    const row = page.split('\n').find(l => l.includes('`mode`'))!;
    const header = page.split('\n').find(l => l.startsWith('| Name |'))!;
    expect(row.replace(/\\\|/g, '').split('|').length)
        .toBe(header.split('|').length);
  });

  test('a pipe in an action name does not split a table row', () => {
    // `action.name` is `z.string()`, and a pipe in one splits the row even
    // inside backticks -- in the router table an agent reads to pick a page.
    const piped =
        withAction(model, {...RUNNABLE, name: 'Place|Order'} as never);
    const skill = generate(rt(piped)).files['SKILL.md'];
    const header = skill.split('\n').find(l => l.startsWith('| Action |'))!;
    const row = skill.split('\n').find(l => l.startsWith('| `Place'))!;
    expect(row.replace(/\\\|/g, '').split('|').length)
        .toBe(header.split('|').length);
  });

  test('a pipe in an affected concept does not split a table row', () => {
    // Same for the blast-radius table on the reference page: concept and field
    // names are as unconstrained as the action's own.
    const piped = withAction(model, {
      ...RUNNABLE,
      affects: [{concept: 'a|b', operation: 'create', fields: ['x|y']}],
    });
    const page = generate(rt(piped)).files['references/place-order.md'];
    const header = page.split('\n').find(l => l.startsWith('| Concept |'))!;
    const row = page.split('\n').find(l => l.startsWith('| `a'))!;
    expect(row.replace(/\\\|/g, '').split('|').length)
        .toBe(header.split('|').length);
  });

  test('an action name cannot write outside the skill directory', () => {
    // An action name is a free string -- `actionSchema.name` is `z.string()`
    // and nothing checks its characters -- and it used to reach the filesystem
    // as a path component, so `../../..` escaped `--out` entirely.
    const nasty = withAction(
        model, {...RUNNABLE, name: '../../../../tmp/pwned'} as never);
    for (const file of Object.keys(generate(rt(nasty)).files)) {
      expect(file).not.toContain('..');
      expect(path.normalize(path.join('/skills/x', file)))
          .toStartWith('/skills/x/');
    }
  });
});


// -- Golden corpus: the whole generated skill, reviewable as files. --
//
// Every test above asserts one claim and says why it holds. None of them shows
// the document. So a change to the layout -- where a section sits, how a row is
// worded, what the command block contains -- reaches a reviewer as a diff of
// string concatenation in `skills.ts`, which is not something you can read the
// output off. Every defect the first review round found was of that kind. These
// goldens put the generated files themselves in the diff.
//
// The corpus is one fixture under three bindings. One fixture because
// `actions_place_order.yaml` is the only one in the tree carrying actions and
// constraints; three bindings because the binding is the axis this emitter has
// to be invariant to. Each writes its own `SKILL.md`, and all three are checked
// against ONE reference-page golden -- that shared file IS the claim that an
// action's page is a fact about the model. Break it and one assertion fails,
// naming the binding that moved it.
//
//   Regenerate after an intentional change:
//     UPDATE_GOLDENS=1 npx bun test ./tests/libts/semantic/skills.test.ts
describe('a description that does not fit', () => {
  const model = loadFixtureModel('actions_place_order.yaml');

  function manyActions(count: number): SemanticModel {
    const actions: Action[] = [];
    for (let i = 0; i < count; i++) {
      actions.push(
          {...model.actions![0], ...RUNNABLE, name: `LongishActionName${i}`} as
          Action);
    }
    return {...model, actions};
  }

  test('the acts are cut down, not the sentence naming the write side', () => {
    // Sixty action names overrun 1,024 characters on the list alone. Cutting
    // the finished description to length instead would take off the sentence a
    // client routes on and leave the list ending part-way through a name that
    // does not exist.
    const description =
        frontmatter(generate(rt(manyActions(60))).files['SKILL.md'])
            .description as string;
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description)
        .toContain(
            'Use when a request asks to change this data rather than only read ' +
            'it.');
    expect(description).toContain(' more.');
    // The count is of what the model declares, not of what is listed, so a
    // partial list reads as one.
    expect(description).toContain('Declares 60 actions:');
  });

  test('dropping a name never lengthens the sentence', () => {
    // `and 1 more` is ten characters, and the name it stands in for may be
    // fewer: dropping the last of two short names makes the sentence longer
    // than the list it came from. Taking that step and then cutting to the
    // limit cuts the longer of the two, so the description loses characters of
    // the first name the limit never asked for and ends part-way through
    // `and 1 more` -- an abridgement marker reading as the tail of a name.
    //
    // The sizes are what make that visible rather than arbitrary. The first
    // name has to very nearly fill the budget, so the two forms already differ
    // where the cut lands; the second has to be short enough to trigger the
    // step and long enough to push the list over.
    const twoNames: SemanticModel = {
      ...model,
      actions: [
        {...model.actions![0], ...RUNNABLE, name: 'A'.repeat(925)} as Action,
        {...model.actions![0], ...RUNNABLE, name: 'BBBBBBB'} as Action,
      ],
    };
    const description =
        frontmatter(generate(rt(twoNames)).files['SKILL.md']).description as
        string;
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).not.toContain('and 1');
    expect(description)
        .toContain(
            'Use when a request asks to change this data rather than only read ' +
            'it.');
  });

  test('a list that fits is not abridged', () => {
    const description =
        frontmatter(generate(rt(manyActions(3))).files['SKILL.md'])
            .description as string;
    expect(description)
        .toContain(
            'Declares 3 actions: LongishActionName0, LongishActionName1, ' +
            'LongishActionName2.');
    expect(description).not.toContain(' more.');
  });
});


describe('golden skill: the fixture generates these exact files', () => {
  const model = loadFixtureModel('actions_place_order.yaml');

  // Two things vary across the three cases and nothing else does: the
  // executor the action carries, and whether the profile bound a store. Each
  // golden is named for its pair, so the axis reads off the filename.
  //
  //   sql_bound     sql executor, store bound      -- runs
  //   sql_unbound   sql executor, no store         -- nothing to run against
  //   mcp           mcp executor, store bound      -- store is fine, the write
  //                                                   cannot be rolled back
  //
  // The fourth pair is not here on purpose: an unbound profile refuses every
  // action whatever its executor, so mcp_unbound would re-check sql_unbound.
  //
  // The fixture performs PlaceOrder over MCP, which `kcmd` does not wrap, so
  // the two `sql` cases swap the executor in. Guards are untouched throughout
  // -- `guardedSql` changes the executor and nothing else.
  const guardedSql = withAction(model, {
    executor: {
      kind: 'sql',
      sql: {statements: ['UPDATE orders SET o_totalprice = 0 WHERE 1 = 0']},
    },
  });

  const CASES = [
    {
      // The case an agent actually meets: bound to a store, so the guarded
      // action is runnable and the section carries a command line.
      golden: 'actions_place_order.sql_bound.skill.golden.md',
      runtime: rt(guardedSql),
    },
    {
      // The same action under a profile that binds no store. Calling one
      // needs a store, so nothing here runs -- and the snippet that reads the
      // store directly goes too, which is the one thing a binding changes
      // outside "Running an action".
      golden: 'actions_place_order.sql_unbound.skill.golden.md',
      runtime: rt(guardedSql, {store: undefined}),
    },
    {
      // The authored MCP executor, still bound to a store. Reads work and the
      // `gcloud` snippet stays; only the write is refused, because it would
      // commit outside the transaction. The one case whose executor kind is
      // not `sql`, so it is what checks that the reference page does not move
      // when the executor does.
      golden: 'actions_place_order.mcp.skill.golden.md',
      runtime: rt(model),
    },
  ];

  const REFERENCE = 'actions_place_order.skill_reference.golden.md';

  // `write` is false for every case but the first, so `UPDATE_GOLDENS` cannot
  // paper over a reference page that moved: the first case re-blesses it and
  // the rest compare against what it wrote.
  function check(name: string, actual: string, write: boolean): void {
    const golden = path.join(FIXTURES, name);
    if (process.env.UPDATE_GOLDENS && write) {
      fs.writeFileSync(golden, actual);
      return;
    }
    if (!fs.existsSync(golden)) {
      throw new Error(
          `missing golden ${name} \u2014 run UPDATE_GOLDENS=1 to create it`);
    }
    expect(actual).toBe(fs.readFileSync(golden, 'utf8'));
  }

  CASES.forEach(({golden, runtime}, index) => {
    test(golden, () => {
      const out = generateSkill({runtime});
      if ('error' in out) throw new Error(out.error);
      const files = Object.fromEntries(out.files.map(f => [f.path, f.text]));
      expect(Object.keys(files).sort()).toEqual([
        'SKILL.md',
        'references/place-order.md',
      ]);
      check(golden, files['SKILL.md'], true);
      check(REFERENCE, files['references/place-order.md'], index === 0);
    });
  });
});
