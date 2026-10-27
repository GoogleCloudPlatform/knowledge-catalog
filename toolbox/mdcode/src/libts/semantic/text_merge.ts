// A line-based three-way merge, which keeps the formatting of a hand-written
// model file through an edit. The YAML library re-renders a whole document
// when it saves one, and its rendering can differ from the file's: padding
// inside flow collections, the space before a comment, long lines it folds.
// mergeFormatting takes the lines the edit changed from the re-rendered text
// and every other line from the file as written.

// The lines of `base` from `start` up to `end` (exclusive) are replaced by
// `lines`.
interface Hunk {
  start: number;
  end: number;
  lines: string[];
}


// The text `edited` with the formatting of `original`: `rendered` is
// `original` as the YAML library re-renders it, unedited, and `edited` is the
// same re-rendering after the edit. Each run of lines the edit changed comes
// from `edited`; every other line comes from `original`. Where the edit
// changed a line that the re-rendering also changed, or one next to it, that
// run comes from `edited`.
export function mergeFormatting(
    original: string, rendered: string, edited: string): string {
  if (original === rendered || rendered === edited) {
    return rendered === edited ? original : edited;
  }
  const crlf = original.includes('\r\n');
  const ours = splitLines(crlf ? original.replace(/\r\n/g, '\n') : original);
  const base = splitLines(rendered);
  const theirs = splitLines(edited);
  const merged = merge(base, diffLines(base, ours), diffLines(base, theirs));
  const text = merged.join('\n');
  return crlf ? text.replace(/\n/g, '\r\n') : text;
}


// The hunks that turn `a` into `b`, in order, from a shortest edit script.
export function diffLines(a: string[], b: string[]): Hunk[] {
  // Edits are local, so the common head and tail are left out of the search.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head &&
         a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail++;
  }
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let open: Hunk|undefined;
  for (const op of editScript(midA, midB)) {
    if (op === '=') {
      if (open) hunks.push(open);
      open = undefined;
      i++;
      j++;
      continue;
    }
    open ??= {start: head + i, end: head + i, lines: []};
    if (op === '-') {
      i++;
      open.end = head + i;
    } else {
      open.lines.push(midB[j]);
      j++;
    }
  }
  if (open) hunks.push(open);
  return hunks;
}


// Myers' shortest edit script from `a` to `b`: '=' keeps a line, '-' drops a
// line of `a`, '+' adds a line of `b`.
function editScript(a: string[], b: string[]): Array<'='|'-'|'+'> {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) ?
          v[offset + k + 1] :
          v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }

  const ops: Array<'='|'-'|'+'> = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1])) ?
        k + 1 :
        k - 1;
    const prevX = vd[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push('=');
      x--;
      y--;
    }
    if (d > 0) ops.push(x === prevX ? '+' : '-');
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}


// Applies `ours` and `theirs`, each a list of hunks against `base`. Hunks that
// overlap or touch form one region; a region with hunks from both sides takes
// only `theirs`.
function merge(base: string[], ours: Hunk[], theirs: Hunk[]): string[] {
  const tagged = [
    ...ours.map(h => ({h, theirs: false})),
    ...theirs.map(h => ({h, theirs: true})),
  ].sort((p, q) => p.h.start - q.h.start || p.h.end - q.h.end);

  const out: string[] = [];
  let pos = 0;
  let k = 0;
  while (k < tagged.length) {
    const region = [tagged[k]];
    let end = tagged[k].h.end;
    k++;
    while (k < tagged.length && tagged[k].h.start <= end) {
      end = Math.max(end, tagged[k].h.end);
      region.push(tagged[k]);
      k++;
    }
    const start = region[0].h.start;
    const both = region.some(r => r.theirs) && region.some(r => !r.theirs);
    const applied = region.filter(r => r.theirs || !both).map(r => r.h);
    out.push(...base.slice(pos, start));
    let at = start;
    for (const h of applied) {
      out.push(...base.slice(at, h.start), ...h.lines);
      at = h.end;
    }
    out.push(...base.slice(at, end));
    pos = end;
  }
  out.push(...base.slice(pos));
  return out;
}


function splitLines(text: string): string[] {
  return text.split('\n');
}
