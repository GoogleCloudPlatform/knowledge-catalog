// The constraint expression grammar.
//
// A scanner over the small boolean language a guard is written in, producing
// the comparisons and the operators between them. It resolves no names, reads
// no binding and emits no SQL: what comes out says what the author wrote, and
// every later stage works from that rather than from the text.
//
// The grammar:
//
//   expression := comparison (('AND' | 'OR') comparison)*
//   comparison := operand <op> operand
//   operand    := <Entity>.<field> | <parameter> | literal
//   op         := >= | <= | != | <> | = | > | <
//   literal    := a number, a single-quoted string, TRUE, FALSE or NULL
//
// `= NULL` and `!= NULL` read as null tests and lower to IS NULL / IS NOT
// NULL. Parentheses, function calls, aggregates, IN, BETWEEN, LIKE and metric
// references are all outside the grammar, on purpose. Each is a real thing a
// constraint might want and each needs a decision this scanner does not make
// -- how an aggregate is evaluated inside a row-level probe, for one -- so
// each is refused with a reason rather than half-handled.
//
// Every scan here reads the text with its single-quoted spans masked. A
// literal that happens to spell `AND`, `==`, a bracket or an operator says
// nothing about the grammar, and refusing it would leave a reject-class guard
// permanently unrunnable.

import {blankStringLiterals, STRING_LITERAL} from '../../sql_expr_utils';


// The comparison operators the grammar accepts, longest first so `>=` is
// matched before `>`.
export const OPERATORS = ['>=', '<=', '!=', '<>', '=', '>', '<'] as const;


// An operand of a comparison: a field of an entity, an action parameter, or a
// literal already in SQL form.
export type Operand = {
  kind: 'field'; entity: string; field: string;
}|{
  kind: 'parameter'; name: string;
}|{
  kind: 'literal'; text: string;
};


export interface Comparison {
  left: Operand;
  right: Operand;
  operator: string;
}


// Comparisons and the logical operators between them: `joiners[i]` sits
// between `comparisons[i]` and `comparisons[i + 1]`.
export interface ParsedExpression {
  comparisons: Comparison[];
  joiners: string[];
}


/** Parses a constraint expression, or says why it is outside the grammar. */
export function parseExpression(
    expression: string,
    parameters: Map<string, {name: string}>): ParsedExpression|{error: string} {
  const text = expression.trim();
  if (!text) return {error: 'it declares no expression'};
  const bare = blankStringLiterals(text);
  if (bare.includes('==')) {
    return {
      error: `it writes '==' (${text}); equality in the expression language ` +
          `is a single '='`,
    };
  }
  if (/[()]/.test(bare)) {
    return {
      error: `it uses parentheses or a function call (${
          text}), which the grammar does not parse`,
    };
  }

  const split = splitOnLogicalOperators(text);
  const comparisons: Comparison[] = [];
  for (const segment of split.parts) {
    const comparison = parseComparison(segment, parameters);
    if ('error' in comparison) return comparison;
    comparisons.push(comparison);
  }
  return {comparisons, joiners: split.joiners};
}


// Splits on top-level AND/OR, matched as whole words so a field named `brand`
// survives. There are no parentheses to nest -- parseExpression refuses them
// -- so every operator found is top level.
function splitOnLogicalOperators(expression: string):
    {parts: string[]; joiners: string[]} {
  const parts: string[] = [];
  const joiners: string[] = [];
  // Scan a copy with the literals masked, so `Account.status = 'ON HOLD OR
  // CLOSED'` does not come apart inside the quotes. The mask is the same length
  // as what it replaces, so every index still points into the original.
  //
  // `blankStringLiterals` fills with spaces, which is wrong here: a blanked
  // literal would join the whitespace on either side of it, and `\s+AND\s+`
  // would then match across the space the literal used to occupy. The filler
  // has to be something `\s` does not match.
  const masked = expression.replace(STRING_LITERAL, m => '.'.repeat(m.length));
  const pattern = /\s+(AND|OR)\s+/gi;
  let last = 0;
  let match: RegExpExecArray|null;
  while ((match = pattern.exec(masked)) !== null) {
    parts.push(expression.slice(last, match.index));
    joiners.push(match[1].toUpperCase());
    last = match.index + match[0].length;
  }
  parts.push(expression.slice(last));
  return {parts, joiners};
}


function parseComparison(
    segment: string,
    parameters: Map<string, {name: string}>): Comparison|{error: string} {
  const text = segment.trim();
  const found = findOperator(text);
  if (!found) {
    return {
      error: `'${text}' is not a comparison (expected one of ${
          OPERATORS.join(', ')})`,
    };
  }
  const leftText = text.slice(0, found.index).trim();
  const rightText = text.slice(found.index + found.operator.length).trim();
  if (!leftText) return {error: `'${text}' has nothing left of the operator`};
  if (!rightText) return {error: `'${text}' has nothing right of the operator`};

  const left = parseOperand(leftText, parameters);
  if ('error' in left) return {error: `in '${text}', ${left.error}`};
  const right = parseOperand(rightText, parameters);
  if ('error' in right) return {error: `in '${text}', ${right.error}`};

  const operator = found.operator === '<>' ? '!=' : found.operator;

  // GoogleSQL refuses `col = NULL` outright rather than evaluating it to
  // unknown, so lowering it verbatim would emit a probe that cannot run. An
  // author writing `Order.closedOn != NULL` means the column must be
  // populated, which SQL spells IS NOT NULL -- so the two operators with a
  // null-test reading are translated and the four without one are refused, an
  // ordering comparison against NULL having no meaning to preserve.
  const isNull = (operand: Operand) =>
      operand.kind === 'literal' && /^NULL$/i.test(operand.text);
  if (isNull(left) || isNull(right)) {
    if (operator !== '=' && operator !== '!=') {
      return {
        error: `'${text}' compares with NULL using '${operator}', which has ` +
            `no meaning; write '= NULL' or '!= NULL' to ask whether the ` +
            `field is set`,
      };
    }
    return {
      left: isNull(left) ? right : left,
      right: {kind: 'literal', text: 'NULL'},
      operator: operator === '=' ? 'IS' : 'IS NOT',
    };
  }

  return {left, right, operator};
}


function parseOperand(
    text: string,
    parameters: Map<string, {name: string}>): Operand|{error: string} {
  const field = text.match(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/);
  if (field) return {kind: 'field', entity: field[1], field: field[2]};
  if (isLiteral(text)) return {kind: 'literal', text};
  if (/^[A-Za-z_]\w*$/.test(text)) {
    if (parameters.has(text)) return {kind: 'parameter', name: text};
    return {
      error: `'${text}' is not a parameter of this action; a field is ` +
          `written <Entity>.<field>`,
    };
  }
  return {error: `'${text}' is not a field, a parameter or a literal`};
}


// The first comparison operator in `text`, longest match first so `>=` is not
// read as `>` with a stray `=` after it. Read with the literals blanked, so an
// operator character inside a string -- `'a>b' = Order.tag` -- is not mistaken
// for the comparison.
function findOperator(text: string): {operator: string; index: number}|null {
  let best: {operator: string; index: number}|null = null;
  const masked = blankStringLiterals(text);
  for (const operator of OPERATORS) {
    const index = masked.indexOf(operator);
    if (index < 0) continue;
    if (!best || index < best.index ||
        (index === best.index && operator.length > best.operator.length)) {
      best = {operator, index};
    }
  }
  return best;
}


// A literal the probe embeds verbatim, restricted to shapes with no quoting
// hazard: a number, a single-quoted string with no embedded quote or
// backslash, or one of the three keywords. Anything else is refused rather
// than escaped, because a constraint expression is model text and a surprising
// escape is harder to notice than a refusal.
function isLiteral(text: string): boolean {
  if (/^[-+]?\d+(\.\d+)?$/.test(text)) return true;
  if (/^'[^'\\]*'$/.test(text)) return true;
  return /^(TRUE|FALSE|NULL)$/i.test(text);
}
