#!/usr/bin/env python3
"""An agent that knows nothing except how to load a skill and run SQL.

This file is the demo's whole client side. It has no idea what a semantic
model is, what an action is, what a guard is, or that binding profiles exist.
It does two things:

  1. Reads a generated skill directory -- `SKILL.md` and every page under
     `references/` -- and puts the bytes in the system prompt, unedited.
  2. Offers exactly one tool, `execute_sql`, which sends one statement to one
     database and returns what came back.

Everything else the agent appears to know -- which tables to read, which
statement performs a credit, that a credit over $25 needs a supervisor, that a
memo has to name what went wrong -- it knows because the skill said so. Point
it at a skill generated from a different model and it is a different agent,
with no edit to this file. That is the claim the demo exists to make, and the
reason to keep this file boring.

The two things it adds to the skill are marked in the code below: a short
preamble naming the tool the skill cannot know the name of, and the plumbing
that turns a JSON argument into a typed query parameter. Both are properties of
this harness rather than of the business, which is why they are here and not in
the model.

What this deliberately does NOT do is enforce anything. There is one general
`execute_sql` tool, so nothing in this process stops the model sending a
statement the model never declared. The skill does not make a bad write
impossible; it makes it impossible for the agent to say it did not know the
rules. An agent you want held to the rules mechanically needs a narrower tool
than this one -- one per action, with the statement fixed on the server side --
and that is a different demo.

Usage:

    python agent.py --skill ./skills/commerce \
        --project my-project --instance my-instance --database semantic_skill_demo \
        "Morgan Ellis was charged $4.50 shipping on order 12345 that should
         have been free. Credit it."

    python agent.py --skill ./skills/commerce --backend bigquery \
        --project my-project --dataset semantic_skill_demo \
        "..."
"""

import argparse
import decimal
import json
import os
import pathlib
import sys

from google import genai
from google.genai import types


# The only thing this harness tells the model that the skill does not.
#
# A skill is written to be portable, so it can name a dialect and a store but
# not the tool its holder will have -- it says "run a SELECT against it" and
# shows a shell command as one way. This names the way that is actually
# available here. It says nothing about commerce, credits or rules: those are
# the skill's business, and repeating any of them here would quietly move the
# model's own policy into this file, where the people who own the model cannot
# see it.
HARNESS_PREAMBLE = """\
You have one tool, `execute_sql`, which runs a single SQL statement against the
store the skill below describes and returns the result. Use it wherever the
skill tells you to read the store or to run a statement; ignore the shell
commands the skill shows, which are for a human at a terminal. Bind values with
named parameters rather than writing them into the statement text.

There is nobody to ask. This harness takes one request and prints one answer,
so a question back is a dead end: nothing will answer it and the run ends
there. Anything the store can tell you, read with `execute_sql` instead of
asking for it. If something is genuinely not in the request and not in the
store, say what is missing and stop -- that is an answer. Refusing, escalating
and asking for a fact nobody can supply are three different endings, and only
the first two are ones the skill provides for.

Everything after this line is the skill. Follow it.
"""


def load_skill(root: pathlib.Path) -> str:
    """The skill as one string: SKILL.md, then every reference page.

    A real Agent Skills runtime is lazier than this. It reads the frontmatter
    at startup, the body when the skill is chosen, and a reference page only
    when the agent opens it -- which is the point of splitting them. This reads
    everything up front, because for a model with one action the whole skill is
    a couple of pages, and a loader that fetched on demand would be the most
    interesting code in a file whose job is to be uninteresting.

    Each part is announced by the path the skill refers to it by, so a
    cross-reference in SKILL.md like `references/issue-credit.md` lands on
    something the model can see it has.
    """
    skill_md = root / 'SKILL.md'
    if not skill_md.is_file():
        sys.exit(f'{root} has no SKILL.md -- is that a generated skill '
                 f'directory? Run `kcmd skills-generate` first.')
    parts = [f'--- {skill_md.name} ---\n\n{skill_md.read_text()}']
    for page in sorted((root / 'references').glob('*.md')):
        rel = page.relative_to(root)
        parts.append(f'--- {rel} ---\n\n{page.read_text()}')
    return '\n\n'.join(parts)


# ---------------------------------------------------------------------------
# The stores. Each one runs a statement and says what happened, in words.
#
# These differ only in client library. Neither knows what it is running: the
# statement arrives as text from the model, which got it from the skill, which
# got it from the binding profile. That chain is the demo -- a table name
# appearing in this file would break it.
# ---------------------------------------------------------------------------


def _is_read(sql):
    """Whether to send this as a query or as a write.

    Crude on purpose: it is a dispatch decision inside one client, not a
    security boundary. Nothing here is deciding whether a write is allowed.
    """
    head = sql.lstrip().lstrip('(').lower()
    return head.startswith('select') or head.startswith('with')


class SpannerStore:
    """Cloud Spanner, in the GoogleSQL dialect."""

    def __init__(self, project, instance, database):
        # Read before the client library is imported. Its built-in metrics
        # exporter writes to Cloud Monitoring on shutdown and, from a
        # workstation, usually fails -- printing a screenful of unrelated
        # error after the agent's answer. Nothing in the demo needs it.
        os.environ.setdefault('SPANNER_DISABLE_BUILTIN_METRICS', 'true')
        from google.cloud import spanner
        self.database = (spanner.Client(project=project)
                         .instance(instance)
                         .database(database))
        self.describe = f'Spanner {project}/{instance}/{database}'

    def run(self, sql, params):
        from google.cloud.spanner_v1 import param_types
        kinds = {
            bool: param_types.BOOL,
            int: param_types.INT64,
            float: param_types.FLOAT64,
            decimal.Decimal: param_types.NUMERIC,
            str: param_types.STRING,
        }
        typed = {k: kinds.get(type(v), param_types.STRING)
                 for k, v in params.items()}
        bind = {'params': params, 'param_types': typed} if params else {}
        if _is_read(sql):
            with self.database.snapshot() as snapshot:
                results = snapshot.execute_sql(sql, **bind)
                rows = list(results)
                names = [f.name for f in results.fields]
            return _render_rows(names, rows)
        # A single DML statement, in its own transaction. `run_in_transaction`
        # retries on abort, which is why the statement goes in as a function
        # rather than running once: Spanner may call it more than once and
        # commit the attempt that succeeds.
        changed = self.database.run_in_transaction(
            lambda txn: txn.execute_update(sql, **bind))
        return f'{changed} row(s) changed.'


class BigQueryStore:
    """BigQuery, in the GoogleSQL dialect.

    No default dataset is set, so every table a statement names has to be
    fully qualified -- which is exactly the condition the `bigquery` binding
    profile writes its statements under, and the reason they look the way they
    do. Setting one here would make statements work in the agent that fail the
    pre-flight `kcmd push` runs.
    """

    def __init__(self, project, dataset):
        from google.cloud import bigquery
        self.bigquery = bigquery
        self.client = bigquery.Client(project=project)
        self.describe = f'BigQuery {project}.{dataset}'

    def run(self, sql, params):
        bq = self.bigquery
        kinds = {
            bool: 'BOOL',
            int: 'INT64',
            float: 'FLOAT64',
            decimal.Decimal: 'NUMERIC',
            str: 'STRING',
        }
        job = self.client.query(sql, job_config=bq.QueryJobConfig(
            query_parameters=[
                bq.ScalarQueryParameter(k, kinds.get(type(v), 'STRING'), v)
                for k, v in params.items()
            ]))
        results = job.result()
        if job.num_dml_affected_rows is not None:
            return f'{job.num_dml_affected_rows} row(s) changed.'
        names = [f.name for f in results.schema]
        return _render_rows(names, [tuple(r.values()) for r in results])


MAX_ROWS = 50


def _render_rows(names, rows):
    """Rows as JSON the model can read, with a stated cap.

    The cap is announced rather than silent. A model shown 50 of 900 line
    items and told nothing will answer about the order as though it had seen
    all of them.
    """
    if not rows:
        return '0 rows.'
    shown = rows[:MAX_ROWS]
    body = json.dumps(
        [dict(zip(names, (_jsonable(v) for v in row))) for row in shown],
        indent=2)
    if len(rows) > MAX_ROWS:
        return (f'{len(rows)} rows, first {MAX_ROWS} shown. Narrow the query '
                f'if you need the rest.\n{body}')
    return f'{len(rows)} row(s).\n{body}'


def _jsonable(value):
    if isinstance(value, decimal.Decimal):
        # As a string, so a money value reaches the model with the digits it
        # has in the database rather than the nearest binary float to them.
        return str(value)
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


# ---------------------------------------------------------------------------
# The tool, and the loop.
# ---------------------------------------------------------------------------


EXECUTE_SQL = types.FunctionDeclaration(
    name='execute_sql',
    description=(
        'Run one SQL statement against the store and return the result. A '
        'SELECT returns its rows. An INSERT, UPDATE or DELETE returns the '
        'number of rows it changed -- read that number, because a statement '
        'that matched nothing changes zero rows and does not fail.'),
    parameters=types.Schema(
        type='OBJECT',
        properties={
            'sql': types.Schema(
                type='STRING',
                description=('One statement, in the dialect the skill names. '
                             'No trailing semicolon. Refer to values as named '
                             'parameters, @like_this.')),
            'params': types.Schema(
                type='STRING',
                description=('A JSON object giving a value for every named '
                             'parameter in `sql`, e.g. {"order": 12345, '
                             '"amount": 4.50}. Omit when there are none.')),
        },
        required=['sql'],
    ),
)


def call_tool(store, args):
    """Run one `execute_sql` call and return what to tell the model.

    An error comes back as text rather than as an exception, because a
    rejected statement is something the agent should read and act on -- the
    codelab leans on this when a column name is wrong.
    """
    sql = (args.get('sql') or '').strip().rstrip(';')
    if not sql:
        return 'Error: no statement given.'
    try:
        # `parse_float=Decimal` is the whole of this harness's opinion about
        # money: a JSON `4.50` becomes Decimal('4.50') and reaches the database
        # as the NUMERIC it is, rather than as the nearest double to it.
        params = json.loads(args.get('params') or '{}',
                            parse_float=decimal.Decimal)
    except json.JSONDecodeError as err:
        return f'Error: `params` is not valid JSON: {err}'
    if not isinstance(params, dict):
        return 'Error: `params` must be a JSON object of name to value.'
    # Everything the agent sends is echoed, because watching it is the demo.
    # A parameter prints as the type it will be bound as, so that a number
    # sent as a string -- which is how an identifier comparison silently
    # matches nothing -- is visible here rather than only in the row count.
    print(f'\n  [sql] {sql}')
    if params:
        printable = {k: _jsonable(v) for k, v in params.items()}
        print(f'  [params] {json.dumps(printable)}')
    try:
        out = store.run(sql, params)
    except Exception as err:  # noqa: BLE001 -- the model is the error handler.
        out = f'Error: {type(err).__name__}: {err}'
    shown = out if len(out) <= 400 else f'{out.splitlines()[0]} [...]'
    print(f'  [result] {shown}\n')
    return out


MAX_TURNS = 12


def main():
    ap = argparse.ArgumentParser(description='Run one request against a skill.')
    ap.add_argument('request', help='What to ask the agent to do.')
    ap.add_argument('--skill', required=True, type=pathlib.Path,
                    help='A skill directory written by `kcmd skills-generate`.')
    ap.add_argument('--backend', default='spanner',
                    choices=['spanner', 'bigquery'],
                    help='Which store the skill was generated against.')
    ap.add_argument('--project', required=True)
    ap.add_argument('--instance', help='Spanner instance.')
    ap.add_argument('--database', help='Spanner database.')
    ap.add_argument('--dataset', help='BigQuery dataset.')
    ap.add_argument('--model', default='gemini-2.5-pro')
    ap.add_argument('--location', default='global',
                    help='Vertex AI location for the model.')
    args = ap.parse_args()

    if args.backend == 'spanner':
        if not (args.instance and args.database):
            ap.error('--backend spanner needs --instance and --database')
        store = SpannerStore(args.project, args.instance, args.database)
    else:
        if not args.dataset:
            ap.error('--backend bigquery needs --dataset')
        store = BigQueryStore(args.project, args.dataset)

    skill = load_skill(args.skill)
    print(f'Skill: {args.skill} ({len(skill)} characters)')
    print(f'Store: {store.describe}')
    print(f'Model: {args.model} ({args.location})')
    print(f'\n> {args.request}')

    client = genai.Client(vertexai=True, project=args.project,
                          location=args.location)
    config = types.GenerateContentConfig(
        system_instruction=HARNESS_PREAMBLE + '\n' + skill,
        tools=[types.Tool(function_declarations=[EXECUTE_SQL])],
        temperature=0,
    )
    contents = [types.Content(role='user',
                              parts=[types.Part(text=args.request)])]

    for _ in range(MAX_TURNS):
        response = client.models.generate_content(
            model=args.model, contents=contents, config=config)
        candidate = response.candidates[0]
        if not candidate.content or not candidate.content.parts:
            print('\nThe model returned nothing. '
                  f'Finish reason: {candidate.finish_reason}.')
            return 1
        contents.append(candidate.content)
        calls = [p.function_call for p in candidate.content.parts
                 if p.function_call]
        if not calls:
            print(f'\n{(response.text or "").strip()}')
            return 0
        # Text alongside a tool call is the model narrating what it is about
        # to do. Worth showing: in this demo it is where the agent says which
        # rule it is checking, and how it read the rule.
        for part in candidate.content.parts:
            if part.text and part.text.strip():
                print(f'\n{part.text.strip()}')
        contents.append(types.Content(role='user', parts=[
            types.Part.from_function_response(
                name=call.name,
                response={'result': call_tool(store, dict(call.args or {}))})
            for call in calls
        ]))

    print(f'\nStopped after {MAX_TURNS} turns without a final answer.')
    return 1


if __name__ == '__main__':
    sys.exit(main())
