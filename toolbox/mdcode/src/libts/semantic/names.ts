// The names a semantic model may give its parts. A name does not stay in the
// model file: it is joined into a Knowledge Catalog entry id, written into
// SQL and graph queries, used as a profile's filename and passed on a
// comma-separated flag. One pattern per kind keeps a name safe in all of them,
// so there is no list of forbidden characters to keep up to date.
//
// - A model, profile or deployment name may contain a hyphen, as in
//   `sales-analytics`: none of them appears in SQL or a graph query.
// - An entity, metric or relationship name appears in expressions, the graph
//   DDL and graph queries, so it may not.
// - A field name is a BigQuery column name, so it may begin with an underscore
//   and is capped shorter.
// The 500-character cap is a Knowledge Catalog limit.

export type NameKind =
    'model'|'profile'|'deployment'|'entity'|'metric'|'relationship'|'field';

interface NameRule {
  pattern: RegExp;
  // The pattern as the message shows it.
  shown: string;
  // What the pattern allows, in words.
  says: string;
  max: number;
}

const WITH_HYPHEN: NameRule = {
  pattern: /^[A-Za-z][A-Za-z0-9_-]*$/,
  shown: '^[A-Za-z][A-Za-z0-9_-]*$',
  says: 'a letter, then letters, digits, underscores or hyphens',
  max: 500,
};
const IN_SQL: NameRule = {
  pattern: /^[A-Za-z][A-Za-z0-9_]*$/,
  shown: '^[A-Za-z][A-Za-z0-9_]*$',
  says: 'a letter, then letters, digits or underscores',
  max: 500,
};
const FIELD: NameRule = {
  pattern: /^[A-Za-z_][A-Za-z0-9_]*$/,
  shown: '^[A-Za-z_][A-Za-z0-9_]{0,299}$',
  says: 'a letter or underscore, then letters, digits or underscores',
  max: 300,
};

const RULES: Record<NameKind, NameRule> = {
  model: WITH_HYPHEN,
  profile: WITH_HYPHEN,
  deployment: WITH_HYPHEN,
  entity: IN_SQL,
  metric: IN_SQL,
  relationship: IN_SQL,
  field: FIELD,
};

const LABEL: Record<NameKind, string> = {
  model: 'Model',
  profile: 'Profile',
  deployment: 'Deployment',
  entity: 'Entity',
  metric: 'Metric',
  relationship: 'Relationship',
  field: 'Field',
};

// Why `name` is not a valid name for a `kind`, or undefined when it is. A name
// over the length limit is shown cut short, so the message stays readable.
export function nameProblem(kind: NameKind, name: string): string|undefined {
  const rule = RULES[kind];
  if (name.length > rule.max) {
    return `${LABEL[kind]} name '${
        Array.from(name).slice(0, 40).join('')}...' is ${
        name.length} characters long; names may be at most ${
        rule.max} characters.`;
  }
  if (!rule.pattern.test(name)) {
    return `${LABEL[kind]} name '${name}' is not valid; names must match ${
        rule.shown}: ${rule.says}.`;
  }
  return undefined;
}

// The most characters a description stored as a Knowledge Catalog entry's
// description may have: the model's, an entity's, a metric's and a
// relationship's.
export const MAX_ENTRY_DESCRIPTION = 2000;
