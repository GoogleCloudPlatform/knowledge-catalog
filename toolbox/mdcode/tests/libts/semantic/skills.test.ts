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
        // The name `kcmd action run` takes, which is the name every command
        // line in the package uses.
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

  test('the router names the action the way the command line does', () => {
    // The index and the one executable instruction have to agree. Naming the
    // row `place_order` while the command reads `kcmd action run PlaceOrder`
    // sends an agent that routed off the table to an action the CLI rejects.
    const row = skill.split('\n').find(l => l.includes('references/'))!;
    const named = row.split('|')[1].trim().replace(/`/g, '');
    expect(skill).toContain(`kcmd action run ${named}`);
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

  test('the command line it offers is one that would run', () => {
    // Every continuation has a line after it. An action with no parameters is
    // the case that gets this wrong: the command ends on a trailing backslash
    // and does nothing, in the one place the skill says what to run.
    const noArgs =
        generate(rt(withAction(model, {...RUNNABLE, parameters: []})));
    const lines = noArgs.files['SKILL.md'].split('\n');
    const start = lines.findIndex(l => l.startsWith('kcmd action run'));
    expect(start).toBeGreaterThan(-1);
    const end = lines.indexOf('```', start);
    expect(end).toBeGreaterThan(start);
    for (let i = start; i < end - 1; i++) expect(lines[i]).toEndWith('\\');
    expect(lines[end - 1]).not.toEndWith('\\');
    expect(lines[end - 1].trim()).not.toBe('');
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

  test('an entity argument asks for a reference, a scalar for its type', () => {
    expect(reference).toContain('| `customer` | string | yes |');
    expect(reference).toContain('more than one does');
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
    // runtime that has a judge, and the command line it prints says `--judge`.
    const out = generate(rt(withAction(model, {executor: RUNNABLE.executor})));
    expect(out.files['SKILL.md']).toContain('--judge');
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
      'a skill for a model nothing here can run does not offer a command',
      () => {
        const skill = generate(rt(model)).files['SKILL.md'];
        expect(skill).toContain('No action in this model can be run');
        expect(skill).not.toContain('kcmd action run');
      });

  test('a profile that binds no store says where the skill stands', () => {
    const skill = generate(rt(withAction(model, RUNNABLE), {
                    store: undefined,
                    storeError: 'no deployment target.',
                  })).files['SKILL.md'];
    expect(skill).toContain('Store: none.');
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

  test('an action name that needs shell quoting gets it', () => {
    // The command block is meant to be copied and run. A bare name with a
    // space silently becomes a different action plus a stray positional.
    const spaced =
        withAction(model, {...RUNNABLE, name: 'Place Order'} as never);
    const skill = generate(rt(spaced)).files['SKILL.md'];
    expect(skill).toContain(`kcmd action run 'Place Order'`);
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
describe('golden skill: the fixture generates these exact files', () => {
  const model = loadFixtureModel('actions_place_order.yaml');

  // The fixture performs PlaceOrder over MCP, which `kcmd` does not wrap. `sql`
  // is what an agent usually meets, so two variants swap it in. The third keeps
  // the authored executor, which is what makes it worth having: a different
  // executor kind, the same reference page.
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
      golden: 'actions_place_order.skill.golden.md',
      runtime: rt(guardedSql),
    },
    {
      // A profile that binds no store. Calling an action needs one, so nothing
      // here runs.
      golden: 'actions_place_order.no_store.skill.golden.md',
      runtime: rt(guardedSql, {store: undefined}),
    },
    {
      // The authored MCP executor.
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
