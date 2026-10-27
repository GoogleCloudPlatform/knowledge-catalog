// The `kcmd entry` command: lists, reads, saves and deletes the workspace's
// catalog entries as JSON, through the catalog snapshot, so the CLI applies
// the same rules as the library and the MCP server.
//
// stdout carries exactly one JSON value. A command that fails as a whole
// prints its error on stderr, prints nothing on stdout and exits 1. `save` and
// `delete` print one result per item and exit 1 when any item failed.

import * as fs from 'node:fs';

import * as kcmd from '../libts';
import * as context from '../libts/gcp/context';
import * as md from '../libts/metadata';


export interface EntryOptions {
  // entry list: only the entries of this type, as a full type reference
  // (dataplex-types.global.semantic-entity) or its last part (semantic-entity).
  type?: string;
  // entry list: print the full entries instead of their names and types.
  content?: boolean;
}

const ACTIONS = ['list', 'get', 'save', 'delete'];


// Runs `kcmd entry <action> [args...]` and returns the process exit code.
// `args` are entry names, or for `save` the one file to read (`-` for stdin).
export async function entry(
    action: string, args: string[] = [],
    options: EntryOptions = {}): Promise<number> {
  const usage = usageError(action, args, options);
  if (usage) {
    console.error(`Error: ${usage}`);
    return 1;
  }

  // Read and parse a save file before opening the workspace, so input that
  // does not parse fails without touching it.
  let items: unknown[] = [];
  if (action === 'save') {
    const parsed = parseSaveInput(args[0]);
    if (typeof parsed === 'string') {
      console.error(`Error: ${parsed}`);
      return 1;
    }
    items = parsed;
  }

  // A deferred context: opening a workspace whose scope needs no request, such
  // as a semantic-model scope, then runs no gcloud command.
  const snapshot =
      await kcmd.CatalogSnapshot.fromPath('.', context.ApiContext.deferred());

  switch (action) {
    case 'list':
      return await list(snapshot, options);
    case 'get':
      return await get(snapshot, args);
    case 'save':
      return printResults(await save(snapshot, items));
    default:
      return printResults(await snapshot.deleteEntries(args));
  }
}


function usageError(
    action: string, args: string[], options: EntryOptions): string|undefined {
  if (!ACTIONS.includes(action)) {
    return `unknown entry action '${action}'; use ${
        ACTIONS.slice(0, -1).join(', ')} or ${ACTIONS[ACTIONS.length - 1]}`;
  }
  if (action !== 'list' && (options.type !== undefined || options.content)) {
    return '--type and --content apply only to entry list';
  }
  if (action === 'list' && args.length) {
    return 'entry list takes no entry names';
  }
  if ((action === 'get' || action === 'delete') && !args.length) {
    return `entry ${action} needs at least one entry name`;
  }
  if (action === 'save' && args.length !== 1) {
    return 'entry save takes one file, or - to read standard input';
  }
  return undefined;
}


// Prints every entry, sorted by name: `{name, type}` for each, or the full
// entries with --content.
async function list(
    snapshot: kcmd.CatalogSnapshot, options: EntryOptions): Promise<number> {
  const names = [...await snapshot.listEntries()].sort();
  const entries: md.Entry[] = [];
  for (const name of names) {
    const entry = await snapshot.lookupEntry(name);
    if (options.type === undefined || matchesType(entry.type, options.type)) {
      entries.push(entry);
    }
  }
  printJson(
      options.content ? entries :
                        entries.map(e => ({name: e.name, type: e.type})));
  return 0;
}


// Prints the named entries, in the order given. One that cannot be read fails
// the command; the error names every such entry.
async function get(
    snapshot: kcmd.CatalogSnapshot, names: string[]): Promise<number> {
  const entries: md.Entry[] = [];
  const failures: string[] = [];
  for (const name of names) {
    try {
      entries.push(await snapshot.lookupEntry(name));
    } catch (err: any) {
      failures.push(`${name}: ${err?.message ?? err}`);
    }
  }
  if (failures.length) {
    console.error(
        `Error: cannot read ${failures.length} of the entries:\n  ` +
        failures.join('\n  '));
    return 1;
  }
  printJson(entries);
  return 0;
}


// Reads a save file: one entry, or an array of entries, as `entry get` prints
// them. Returns the items, or the error that fails the whole call.
function parseSaveInput(file: string): unknown[]|string {
  let text: string;
  try {
    text = fs.readFileSync(file === '-' ? 0 : file, 'utf8');
  } catch (err: any) {
    return `cannot read ${file === '-' ? 'standard input' : `'${file}'`}: ${
        err?.message ?? err}`;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err: any) {
    return `${file === '-' ? 'standard input' : `'${file}'`} is not valid ` +
        `JSON: ${err?.message ?? err}`;
  }
  return Array.isArray(value) ? value : [value];
}


// Checks each item's shape, saves the valid ones through the snapshot, and
// returns one result per item, in input order. An invalid item fails on its
// own and is never written.
async function save(snapshot: kcmd.CatalogSnapshot, items: unknown[]):
    Promise<md.EntryResult[]> {
  const results: Array<md.EntryResult|undefined> =
      new Array(items.length).fill(undefined);
  const valid: md.Entry[] = [];
  const validAt: number[] = [];
  items.forEach((item, i) => {
    const parsed = md.entrySchema.safeParse(item);
    if (parsed.success) {
      valid.push(parsed.data as md.Entry);
      validAt.push(i);
    } else {
      results[i] = {
        name: itemName(item, i),
        ok: false,
        error: `not an entry as entry get prints it: ${
            md.entrySchemaProblems(parsed.error)}`,
      };
    }
  });
  const saved = valid.length ? await snapshot.saveEntries(valid) : [];
  validAt.forEach((itemIndex, k) => {
    results[itemIndex] = saved[k];
  });
  return results as md.EntryResult[];
}


// The name to report for an invalid item: its own, or its position.
function itemName(item: unknown, index: number): string {
  const name = (item as any)?.name;
  return typeof name === 'string' && name !== '' ? name : `(item ${index + 1})`;
}


// Prints the results of a save or delete and returns the exit code: 0 when
// every item succeeded, 1 otherwise.
function printResults(results: md.EntryResult[]): number {
  printJson(results);
  return results.every(r => r.ok) ? 0 : 1;
}


// Whether an entry type reference matches a --type filter: the same
// reference, or a filter that is its last dot-separated parts.
export function matchesType(type: string|undefined, filter: string): boolean {
  if (!type) return false;
  return type === filter || type.endsWith(`.${filter}`);
}


export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
