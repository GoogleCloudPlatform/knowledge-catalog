#!/usr/bin/env python3
"""An agent that knows nothing except how to load a skill and run SQL.

It reads a generated skill directory into the system prompt, unedited, and
offers one tool: `execute_sql`. There is no table name, no statement and no
rule in this file -- everything it appears to know about commerce, it read.
Point it at a skill generated from a different model and it is a different
agent, with nothing here changed. Step 6 of the README makes that argument and
step 10 says what it does not buy; steps 7 and 8 have the invocations, and
`--help` has the flags.
"""

import argparse
import decimal
import json
import os
import pathlib
import re
import sys

from google import genai
from google.genai import types


# The only thing this harness tells the model that the skill does not: the name
# of the tool it has. A skill is portable, so it can name a dialect and a store
# but not the tooling its holder will have. Nothing about commerce belongs
# here -- that would move the model's own policy into this file, where the
# people who own the model cannot see it.
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
    """SKILL.md and every reference page, as one string.

    A real Agent Skills runtime reads a reference page only when the agent
    opens it, which is the point of splitting them. This reads everything up
    front: for a model with one action the whole skill is a couple of pages,
    and a loader that fetched on demand would be the most interesting code in
    a file whose job is to be uninteresting.
    """
    skill_md = root / 'SKILL.md'
    if not skill_md.is_file():
        sys.exit(f'{root} has no SKILL.md -- is that a generated skill '
                 f'directory? Run `kcmd skills-generate` first.')
    # Each part is announced by the path the skill refers to it by, so a
    # cross-reference like `references/issue-credit.md` lands on something the
    # model can see it has.
    parts = [f'--- {skill_md.name} ---\n\n{skill_md.read_text()}']
    for page in sorted((root / 'references').glob('*.md')):
        parts.append(f'--- {page.relative_to(root)} ---\n\n{page.read_text()}')
    return '\n\n'.join(parts)


# --- The stores. Each runs one statement and says what happened, in words. ---
#
# Neither knows what it is running: the statement arrives as text from the
# model, which got it from the skill, which got it from the binding profile.
# That chain is the demo -- a table name in this file would break it.

# GoogleSQL type names, which Spanner and BigQuery spell the same way.
SQL_TYPES = {bool: 'BOOL', int: 'INT64', float: 'FLOAT64',
             decimal.Decimal: 'NUMERIC', str: 'STRING'}

# Leading comments and an opening parenthesis, which a model puts in front of
# a statement often enough to matter: Spanner rejects a SELECT sent down the
# DML path, so `-- read the total\nSELECT ...` misrouted is a failed read
# rather than a harmless one. Every branch consumes a character, so the loop
# below ends.
_PREAMBLE = re.compile(r'\s*(?:--[^\n]*\n|\#[^\n]*\n|/\*.*?\*/|\()', re.DOTALL)


def _is_read(sql):
    """Whether to send this as a query or as a write.

    Crude on purpose: a dispatch decision inside one client, not a security
    boundary. Nothing here is deciding whether a write is allowed.
    """
    while skipped := _PREAMBLE.match(sql):
        sql = sql[skipped.end():]
    return sql.lstrip().lower().startswith(('select', 'with'))


class SpannerStore:
    """Cloud Spanner, in the GoogleSQL dialect."""

    def __init__(self, project, instance, database):
        # Set before the client library is imported. Its built-in metrics
        # exporter writes to Cloud Monitoring on shutdown and, from a
        # workstation, usually fails -- printing a screenful of unrelated
        # error after the agent's answer. Nothing in the demo needs it.
        os.environ.setdefault('SPANNER_DISABLE_BUILTIN_METRICS', 'true')
        from google.cloud import spanner
        self.database = (spanner.Client(project=project)
                         .instance(instance).database(database))
        self.describe = f'Spanner {project}/{instance}/{database}'

    def run(self, sql, params):
        from google.cloud.spanner_v1 import param_types
        bind = {'params': params, 'param_types': {
            k: getattr(param_types, SQL_TYPES.get(type(v), 'STRING'))
            for k, v in params.items()}} if params else {}
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
    profile writes its statements under. Setting one here would make
    statements work in the agent that fail the pre-flight `kcmd push` runs.
    """

    def __init__(self, project, dataset):
        from google.cloud import bigquery
        self.bigquery = bigquery
        self.client = bigquery.Client(project=project)
        self.describe = f'BigQuery {project}.{dataset}'

    def run(self, sql, params):
        bq = self.bigquery
        job = self.client.query(sql, job_config=bq.QueryJobConfig(
            query_parameters=[
                bq.ScalarQueryParameter(k, SQL_TYPES.get(type(v), 'STRING'), v)
                for k, v in params.items()]))
        results = job.result()
        if job.num_dml_affected_rows is not None:
            return f'{job.num_dml_affected_rows} row(s) changed.'
        return _render_rows([f.name for f in results.schema],
                            [tuple(r.values()) for r in results])


MAX_ROWS = 50


def _render_rows(names, rows):
    """Rows as JSON the model can read, with the cap announced not silent.

    A model shown 50 of 900 line items and told nothing will answer about the
    order as though it had seen all of them. `default=str` catches the types
    JSON has no spelling for, which here means a NUMERIC: as a string it
    reaches the model with the digits the database holds rather than the
    nearest binary float to them.
    """
    if not rows:
        return '0 rows.'
    body = json.dumps([dict(zip(names, row)) for row in rows[:MAX_ROWS]],
                      indent=2, default=str)
    capped = (f', first {MAX_ROWS} shown -- narrow the query for the rest'
              if len(rows) > MAX_ROWS else '')
    return f'{len(rows)} row(s){capped}.\n{body}'


def sql_tool(store):
    """The one tool the agent gets, closed over the store it runs against.

    The SDK turns the inner function into the declaration the model sees, so
    its docstring is prompt text, not commentary.
    """

    def execute_sql(sql: str, params: str = '{}') -> str:
        """Run one SQL statement against the store and return the result.

        A SELECT returns its rows. An INSERT, UPDATE or DELETE returns the
        number of rows it changed -- read that number, because a statement
        that matched nothing changes zero rows and does not fail.

        Args:
          sql: One statement, in the dialect the skill names. No trailing
            semicolon. Refer to values as named parameters, @like_this.
          params: A JSON object giving a value for every named parameter in
            `sql`, e.g. {"order": 12345, "amount": 4.50}. Omit when there are
            none.
        """
        statement = sql.strip().rstrip(';')
        if not statement:
            return 'Error: no statement given.'
        try:
            # `parse_float=Decimal` is the whole of this harness's opinion
            # about money: a JSON `4.50` becomes Decimal('4.50') and reaches
            # the database as the NUMERIC it is, rather than as the nearest
            # double to it.
            bound = json.loads(params or '{}', parse_float=decimal.Decimal)
        except json.JSONDecodeError as err:
            return f'Error: `params` is not valid JSON: {err}'
        if not isinstance(bound, dict):
            return 'Error: `params` must be a JSON object of name to value.'
        try:
            return store.run(statement, bound)
        except Exception as err:  # noqa: BLE001 -- the model is the handler.
            # Returned as text rather than raised, because a rejected
            # statement is something the agent should read and act on -- the
            # codelab leans on this when a column name is wrong. Raising here
            # would end the run instead of giving it back to the model.
            return f'Error: {type(err).__name__}: {err}'

    return execute_sql


def print_transcript(history):
    """The run in order: what the agent said, what it sent, what came back.

    Echoed exactly as the model sent it, so a number sent as a string -- which
    is how an identifier comparison silently matches nothing -- is visible
    here and not only in the row count.
    """
    for content in history[1:]:  # [0] is the request, already printed.
        for part in content.parts or []:
            if part.text and part.text.strip():
                print(f'\n{part.text.strip()}')
            if part.function_call:
                args = part.function_call.args or {}
                print(f'\n  [sql] {args.get("sql", "")}')
                if args.get('params', '{}') != '{}':
                    print(f'  [params] {args["params"]}')
            if part.function_response:
                out = str((part.function_response.response or {}).get('result'))
                print('  [result] ' + (out if len(out) <= 400 else
                                       f'{out.splitlines()[0]} [...]'))


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

    # The SDK runs the tool loop: it sends the request, calls `execute_sql`
    # when the model asks for it, feeds the result back, and returns when the
    # model stops calling. That loop is the part of an agent that is the same
    # everywhere, which is why it is not written out here.
    chat = genai.Client(vertexai=True, project=args.project,
                        location=args.location).chats.create(
        model=args.model,
        config=types.GenerateContentConfig(
            system_instruction=HARNESS_PREAMBLE + '\n' + skill,
            tools=[sql_tool(store)],
            temperature=0,
        ))
    response = chat.send_message(args.request)
    print_transcript(chat.get_history(curated=False))
    if not response.candidates:
        # A prompt the safety filter blocks comes back with no candidate at
        # all, which is an answer from the service rather than a bug here.
        print('\nThe model returned nothing, and no candidate to say why. '
              f'Prompt feedback: {response.prompt_feedback}.')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
