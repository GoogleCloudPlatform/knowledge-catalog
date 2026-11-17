// Tests for changing the text of a YAML document (yaml_update.ts).

import {expect, test} from 'bun:test';
import * as yaml from 'yaml';

import {plainCopy} from '../../../src/libts/semantic/resolve_profiles';
import {linkNodes, parseForUpdate, updateText} from '../../../src/libts/semantic/yaml_update';

// Each row changes a plain copy of `input`. The nodes kept from the input keep
// their quoting and flow style, and the text must still read back as the new
// value, under YAML 1.1 as well. A row with a fourth column must give that
// text.
test.each<[string, string, (value: any) => void, string?]>([
  [
    'a mapping added to a list whose items start on the line after their dash',
    'a:\n  -\n   k: 1\n', v => v.a.push({k: 2}), 'a:\n  -\n   k: 1\n  -\n   k: 2\n'
  ],
  [
    'a mapping added to a list whose items start on the line after their dash, two columns in',
    'a:\n  -\n    k: 1\n', v => v.a.push({k: 2}), 'a:\n  -\n    k: 1\n  -\n    k: 2\n'
  ],
  [
    'empty flow collections with a space or a comment inside, beside a changed key',
    'a: [ ]\nb: {\n  # c\n}\nd: 1\n', v => v.d = 2, 'a: [ ]\nb: {\n  # c\n}\nd: 2\n'
  ],
  ['a flow mapping key with no value, beside a changed key', 'm: {a: 1, b}\nc: 1\n', v => v.c = 2, 'm: {a: 1, b}\nc: 2\n'],
  [
    'keys with no value set to values, in a flow and a block mapping',
    'm: {a: 1, b}\np:\n  a: 1\n  ? b  # c\n', v => (v.m.b = 2, v.p.b = [1]),
    'm: {a: 1, b: 2}\np:\n  a: 1\n  ? b  # c\n  :\n    - 1\n'
  ],
  [
    'keys after `?`, an anchor or a tag, beside a new key, list and flow mapping, and a moved block scalar',
    'm:\n  ? a\n  : 1\n? s\n:\n- x\nf: { &k c: 1 }\nc:\n  custom:\n    !!str t: |  # h\n      x\n',
    v => (v.m.b = 2, v.z = [1], v.f.d = {e: 1}, v.c = {...v.c.custom}),
    'm:\n  ? a\n  : 1\n  b: 2\n? s\n:\n- x\nf: { &k c: 1, d: { e: 1 } }\nc:\n  t: |  # h\n    x\nz:\n- 1\n'
  ],
  [
    'a new flow list beside one whose first item has an anchor',
    'a: [  &k x ]\nm: {b: 1}\n', v => v.m.c = [1], 'a: [  &k x ]\nm: {b: 1, c: [  1  ]}\n'
  ],
  [
    'flow list items beside an anchor or a tag: one removed, one added before it and one after',
    'f: [&a p, &b q]\ng: *b\nk: [&c r]\nl: *c\nh: [0, !!str 1]\n',
    v => (v.f.shift(), v.k.unshift('w'), v.h.push(2)),
    'f: [&b q]\ng: *b\nk: [w, &c r]\nl: *c\nh: [0, !!str 1, 2]\n'
  ],
  [
    'a new flow mapping beside a pair written as a flow list item after an anchor',
    'l: [ &k a: 1 ]\nm: { b: 1 }\n', v => v.m.c = {d: [1]},
    'l: [ &k a: 1 ]\nm: { b: 1, c: { d: [ 1 ] } }\n'
  ],
  [
    'block lists after an anchor or a tag on their key line, set to a scalar and a block scalar',
    'a: &x  # c\n  - 1\nb: *x\nd: !!seq\n  - 2\n', v => (v.a = 'v', v.d = 'p\nq\n'),
    'a: v  # c\nb:\n  - 1\nd: |\n  p\n  q\n'
  ],
  [
    'values under their key after an anchor or a tag, set to values of another kind',
    'a:\n  &x [1,\n  2]\nb: *x\nd: !!str  # c\n  x\ne:\n  !!seq [1,\n  2]\n',
    v => (v.a = [1, 3], v.d = ['w'], v.e = 'x'),
    'a:\n  - 1\n  - 3\nb:\n  - 1\n  - 2\nd:  # c\n  - w\ne:\n  x\n'
  ],
  [
    'values under an anchor or a tag on a line of its own, set to lists, two before a comment',
    'a:\n  &x  # c\n  {k: 1}\nb:\n  !!str  # d\n  x\ne:\n  &z !!map\n  {k: 1}\n',
    v => (v.a = [1], v.b = [1], v.e = [1]), 'a:\n  # c\n  [1]\nb:\n  # d\n  - 1\ne:\n  [1]\n'
  ],
  [
    'anchored empty values removed from the end of a flow list and a flow mapping',
    'f: [a, &b]\ng: *b\nm: {a: 1, b: &y}\nh: *y\n', v => (v.f.pop(), delete v.m.b),
    'f: [a]\ng: null\nm: {a: 1}\nh: null\n'
  ],
  [
    'scalars after a tag set to values of the same and of another type',
    'a: !!str x\nb: &k !!str y\nc: !!int 5\nd: !!str\n  z\ne: !!str\n',
    v => (v.a = 5, v.b = 6, v.c = 6, v.d = 7, v.e = 8), 'a: 5\nb: &k 6\nc: !!int 6\nd:\n  7\ne: 8\n'
  ],
  [
    'numbers after a tag set to numbers it reads as other values, and to one it reads alike',
    'a: !!float 1.0\nb: !!int 1\nc: !!float 1.5\n', v => (v.a = 2, v.b = 2.5, v.c = 2.5),
    'a: 2\nb: 2.5\nc: !!float 2.5\n'
  ],
  [
    'scalars after an anchor and a tag in either order set to a number',
    'a: !!str &k x\ne: &j !!str\n  w\nk:\n  !!str\n', v => (v.a = 5, v.e = 8, v.k = 9),
    'a: &k 5\ne: &j\n  8\nk:\n  9\n'
  ],
  [
    'empty values after an anchor or a tag alone on their line, before a comment or a space',
    'a:\n  &x  # c\nb: *x\nc:\n  &y \nd:\n  !!str  # e\nz: 1\n', v => (v.a = [1, 3], v.c = {k: 1}, v.d = 5),
    'a:\n  - 1  # c\n  - 3\nb: null\nc:\n  k: 1\nd:\n  5  # e\nz: 1\n'
  ],
  [
    'scalars after a core tag set to text the tag cannot read',
    'a: !!int 1\nb: !!null ~\n', v => (v.a = 'hello', v.b = 'x'), 'a: hello\nb: x\n'
  ],
  [
    'scalars after a custom tag set to a string and to a number it reads as a string',
    'a: !foo x\nb: !foo x\n', v => (v.a = 'y', v.b = 5), 'a: !foo "y"\nb: 5\n'
  ],
  [
    'flow values after an anchor or a tag, set to values of another kind',
    'g: !!map {a: 1}\nm: {a: !!str x, b: &y }\n', v => (v.g = [1], v.m.a = [1], v.m.b = [2]),
    'g: [1]\nm: {a: [1], b: [2]}\n'
  ],
  [
    'the last key of a mapping removed through the final newline, beside a key added after the mapping',
    'a:\n  k: 1\n  e:\n', v => (delete v.a.e, v.z = 1), 'a:\n  k: 1\nz: 1\n'
  ],
  ['a plain scalar set to "true"', 'a: x  # c\n', v => v.a = 'true'],
  ['a plain scalar set to "a: b #c"', 'a: x  # c\n', v => v.a = 'a: b #c'],
  [
    'a plain scalar set to two lines, the first ending in a space', 'a: x  # c\n',
    v => v.a = 'x \ny'
  ],
  ['a quoted string set to a number', 'a: "x"  # c\n', v => v.a = 5],
  [
    'a single-quoted string set to two lines', "a: 'x\n\n  y'  # c\n", v => v.a = 'p\nq',
    "a: 'p\n\n  q'  # c\n"
  ],
  [
    'double-quoted strings set to other lines, one that writes its line breaks as escapes on one line',
    'a: "x\\ny"  # c\nb: "x\\ny\n\n  z"\nd: "x"\n', v => (v.a = v.b = v.d = 'p\nq'),
    'a: "p\\nq"  # c\nb: "p\n\n  q"\nd: "p\n\n  q"\n'
  ],
  [
    'strings on one line that gain DEL, a line separator, a paragraph separator and C1 controls',
    'a: "Sales by region"\nb: \'Sales by region\'\nc: Sales by region\nd: "Sales by region"\n',
    v => (v.a = 'Sales by\x7f region', v.b = 'Sales by\u2028 region',
          v.c = 'Sales by\u2029 region', v.d = 'Sales\x85 by\x9b region'),
    'a: "Sales by\\x7f region"\nb: "Sales by\\L region"\nc: "Sales by\\P region"\nd: "Sales\\N by\\x9b region"\n'
  ],
  [
    'block scalars set to a number and a mapping', 'a: |-  # c\n  x\nb: |-  # d\n  y\n',
    v => (v.a = 5, v.b = {k: 1}), 'a: 5  # c\nb:  # d\n  k: 1\n'
  ],
  [
    'block scalars above blank lines set to text that ends in more or fewer line breaks',
    'a: |-\n  x\n\nb: |\n  y\n\n\nc: |+\n  v\n\nd: 1\n',
    v => (v.a = ' z\n\n', v.b = 'w\n\n', v.c = 'u\n'),
    'a: " z\n\n  \\n"\n\nb: "w\n\n  \\n"\n\n\nc: |\n  u\nd: 1\n'
  ],
  [
    'a block scalar whose first line of text starts with a tab',
    'a: |\n    \tx\n    y\n', v => (v.a = '\tx\nz\n'), 'a: |\n    \tx\n    z\n'
  ],
  [
    'block scalars in a file indented by ten that come to start with a blank, one more than 9 columns deeper than its key',
    'a:\n          k: |-\n                    x\nb:\n          k: |8\n                   x\n',
    v => (v.a.k = '  y\nz', v.b.k = ' y\n'),
    'a:\n          k: "  y\n\n                    z"\nb:\n          k: |8\n                   y\n'
  ],
  [
    'block scalars that come to start with an empty line',
    'a: |\n  x\nm:\n  k: |-\n      x\n', v => (v.a = '\nx\n', v.m.k = '\nx'),
    'a: |\n\n  x\nm:\n  k: |-\n\n      x\n'
  ],
  [
    'a block scalar whose first line of text holds only a tab',
    'a: |\n    \t\n      y\n', v => (v.a = '\t\n  z\n'), 'a: |\n    \t\n      z\n'
  ],
  [
    'block scalars 9 and more than 9 columns deeper than their key, two that come to start with a blank',
    'a:\n  k: |\n              x\n              y\n  q: 1\nb:\n  k: |-\n            x\nc:\n  k: |-\n           x\n',
    v => (v.a.k = 'x\nz\n', v.b.k = v.c.k = '  y\nz'),
    'a:\n  k: |\n              x\n              z\n  q: 1\nb:\n  k: "  y\n\n            z"\nc:\n  k: |9-\n             y\n           z\n'
  ],
  [
    'block scalars whose header sets their indentation, before or after the chomping indicator, one that comes to keep its last line break',
    'k:\n  data: |-4\n        x\n      y\nm:\n  data: |-4\n      x\n      y\np: |4-\n      x\n    y\n',
    v => (v.k.data = '  x\nz', v.m.data = 'x\nz\n', v.p = '  x\nz'),
    'k:\n  data: |-4\n        x\n      z\nm:\n  data: |4\n      x\n      z\np: |4-\n      x\n    z\n'
  ],
  [
    'a quoted string set to text whose lines yaml would write so that a line of one space reads back as a backslash',
    'a: "x"\n', v => (v.a = 'first line of forty characters or more!!\n \nlast'),
    'a: "first line of forty characters or more!!\\n\\ \\nlast"\n'
  ],
  [
    '`|+` block scalars moved, and text that ends in two line breaks added',
    'a:\n  m: |+  # h\n    x\n\n  w:\n    v: |+\n      y\n  k: 1\n\nc:\n  - 1\n',
    v => (v.a = {k: 1, c: {m: v.a.m, w: v.a.w}}, v.c.push('y\n\n'), v.d = 'x\n\n'),
    'a:\n  k: 1\n  c:\n    m: "x\n\n      \\n"\n    w:\n      v: |\n        y\n\nc:\n  - 1\n  - "y\n\n    \\n"\n' +
        'd: "x\n\n  \\n"\n'
  ],
  [
    'items that end in an empty value with a comment or in a deeper comment, removed or moved',
    'l:\n  - k: 1\n\n  - k: 2\n    e:  # c\n\n  - k: 3\n\n  - k: 4\n    # deep\n\n  - k: 5\n' +
        'a:\n  team:\n    notes:  # n\n\n  s: 1\nb: 1\nm:\n  - d: |\n      x\n        \n  - k: 2\n  - k: 3\n',
    v => (v.l.splice(3, 1), v.l.splice(1, 1), v.a = {s: 1, custom: {team: v.a.team}}, v.m.splice(1, 1)),
    'l:\n  - k: 1\n\n  - k: 3\n\n  - k: 5\na:\n  s: 1\n  custom:\n    team:\n      notes:  # n\nb: 1\nm:\n  - d: |\n      x\n        \n  - k: 3\n'
  ],
  [
    'an item added after an item that ends in an empty value with no comment, and such an item removed',
    'l:\n  - a: 1\n    d:\nm:\n  - e: 1\n    d:\n  - k: 1\n', v => (v.l.push({b: 2}), v.m.shift()),
    'l:\n  - a: 1\n    d:\n  - b: 2\nm:\n  - k: 1\n'
  ],
  [
    'items that end in a deeper comment above a comment and a line of spaces, removed or moved',
    'l:\n  - k: 1\n    # deep\n  # c\n  \n  - k: 2\na:\n  t:\n    l: 1\n    # deep\n  # d\n  \n  i: 1\n',
    v => (v.l.shift(), v.a = {i: 1, custom: {t: v.a.t}}),
    'l:\n  # c\n  \n  - k: 2\na:\n  # d\n  \n  i: 1\n  custom:\n    t:\n      l: 1\n'
  ],
  [
    'items removed and replaced after `|+` block scalars that stay',
    'l:\n  - e: |+\n      x\n\n  - k: 2\n\n  - k: 3\nr:\n  - e: |+\n      x\n\n  - k: 2\n\n  - k: 3\n' +
        'a:\n  m:\n    - e: |+\n        x\n\n    - k: 2\n\n  n: 1\n\n  o: 2\nb:\n  - >2+\n    x\n\nc: 1\nd: 1\ne:\n  - >2+\n    y\n\nf: 1\n\ng: 1\n',
    v => (v.l.splice(1, 1), v.r.splice(1, 1, {k: 9}), v.a.m.splice(1, 1), delete v.a.n, delete v.c, delete v.f),
    'l:\n  - e: |+\n      x\n\n  - k: 3\nr:\n  - e: |+\n      x\n\n  - k: 9\n\n  - k: 3\n' +
        'a:\n  m:\n    - e: |+\n        x\n\n  o: 2\nb:\n  - >2+\n    x\n\nd: 1\ne:\n  - >2+\n    y\n\ng: 1\n'
  ],
  [
    'items removed after a `|+` block scalar that changes and one in a value that changes',
    'l:\n  - d: |+\n      x\n\n  - k: 2\n\n  - k: 3\nm:\n  - e:\n      d: |+\n        x\n\n  - k: 2\n\n  - k: 3\n',
    v => (v.l[0].d = 'y', v.l.splice(1, 1), v.m[0].e = 5, v.m.splice(1, 1)),
    'l:\n  - d: |-\n      y\n\n  - k: 3\nm:\n  - e: 5\n\n  - k: 3\n'
  ],
  [
    'text that starts with a space, written as block scalars in a file indented by four',
    'a:\n    k: |-  # c\n        x\n    l:\n        - x\n', v => (v.a.k = '  y\nz', v.a.l.push('  p\nq')),
    'a:\n    k: |4-  # c\n          y\n        z\n    l:\n        - x\n        - |4-\n              p\n            q\n'
  ],
  [
    'a JSON file', '{"a": "x", "b": [1, 2], "c": ["yes", "on", "2001-12-14"]}',
    v => (v.a = 'true', v.b[1] = 3)
  ],
  ['an anchor and its alias', 'a: &x {k: 1}  # c\nb: *x\n', v => v.a.k = 2],
  [
    'values of several lines written before a comment that stays',
    'a: &d |-\n  x\n  y\nb: *d  # c\nc:\n  "p\\nq"  # e\nd: {k: 1}  # f\n',
    v => (v.a = 'x\nz', v.c = {k: 'p\nq'}, v.d = '\u0007\nr'),
    'a: &d |-\n  x\n  z\nb: |-  # c\n  x\n  y\nc:\n  k: |-  # e\n    p\n    q\nd: "\\a\n\n  r"  # f\n'
  ],
  [
    'empty values set to lists and a scalar, and a key added after one',
    'a:  # c\nb:  # d\nc:\ne: 1\nf: {g: , h: 1}\n', v => {
      Object.assign(v, {a: [{k: 1}], b: 'x'});
      v.f.g = [1];
      const {e, f} = v;
      delete v.e;
      delete v.f;
      Object.assign(v, {d: 2, e, f});
    },
    'a:  # c\n  - k: 1\nb: x  # d\nc:\nd: 2\ne: 1\nf: {g: [1], h: 1}\n'
  ],
  [
    'a mapping whose keys all change, ending in a comment',
    'm:\n  a:\n    b:\n      - x\n      # c\n  d: 1\n', v => v.m.a = {e: v.m.a.b}
  ],
  [
    'a mapping ending in a list and a comment replaced, above a commented key',
    'a:\n  k:\n    - x\n    # deep\n# c\nb: 1\n', v => v.a = {c: v.a.k},
    'a:\n  c:\n    - x\n# c\nb: 1\n'
  ],
  [
    'aliases and flow collections over several lines on the line under their key, written again',
    'a: &e\n  k: 1\nb:\n  # b1\n  *e  # b2\nh: &s |-\n  p\n  q\ni:\n  # i1\n  *s  # i2\n' +
        'f:\n  # f1\n  {i: x,\n    o: y}  # f2\ng:\n  # g1\n  [1,\n    2]  # g2\n',
    v => (v.a.k = 2, v.h = 'r', delete v.f.o, v.f.c = 'z', v.g = 'z'),
    'a: &e\n  k: 2\nb:\n  # b1\n  k: 1  # b2\nh: &s |-\n  r\ni:\n  # i1\n  "p\n\n  q"  # i2\n' +
        'f:\n  # f1\n  i: x  # f2\n  c: z\ng:\n  # g1\n  z  # g2\n'
  ],
  [
    'a block scalar in a CRLF text set to a mapping', 'a: |\r\n  x\r\nb: 1\r\n',
    v => v.a = {c: 1}, 'a:\r\n  c: 1\r\nb: 1\r\n'
  ],
  [
    'moved values keep their text',
    'a:\n  custom:\n    t: [x, z]  # c\n    u: \'z\'\n    "k: 1": \'x\'\n    w:\n      - p  # q\n\n      - r\nc: \'p\'\n',
    v => (v.a = {...v.a.custom}, v.d = {c: 'p'}),
    'a:\n  t: [x, z]\n  u: \'z\'\n  "k: 1": \'x\'\n  w:\n    - p  # q\n\n    - r\nc: \'p\'\nd:\n  c: p\n'
  ],
  [
    'moved values with a comment above their first key or item',
    'a:\n  custom:\n    m:\n      # c\n      k: 1\n    l:\n      # d\n      - x\n',
    v => v.a = {...v.a.custom}, 'a:\n  m:\n    # c\n    k: 1\n  l:\n    # d\n    - x\n'
  ],
  [
    'moved values in flow mappings, one that a flow mapping would read differently',
    'a:\n  custom: {t: 1}\n  m: a, b\n  o: \'x\'\nb: {i: 1, o: \'z\'}\n',
    v => (v.a.custom.m = v.a.m, v.a.custom.o = v.a.o, delete v.a.m, delete v.a.o,
          v.b = {i: 1, custom: {o: v.b.o}}),
    'a:\n  custom: {t: 1, m: "a, b", o: \'x\'}\nb: {i: 1, custom: {o: \'z\'}}\n'
  ],
  [
    'moved values with a line of spaces in a block scalar, or a comment at their key\'s column after them',
    'a:\n  note: |  # h\n    x\n      \n    y\n  extra:\n    - k: 1\n      # deep\n  # above s\n  s: 1\n' +
        'd:\n  custom:\n    w: |  # g\n      x\n        \n      y\n',
    v => {
      const {note, extra, s} = v.a;
      v.a = {s, custom: {note, extra}};
      v.d = {...v.d.custom};
    },
    'a:\n  # above s\n  s: 1\n  custom:\n    note: |  # h\n      x\n        \n      y\n    extra:\n      - k: 1\n        # deep\n' +
        'd:\n  w: |  # g\n    x\n      \n    y\n'
  ],
  [
    'moved values written fresh: text over several lines in a flow mapping, and an alias',
    'b:\n  custom: {p: "a long text", m: "first\n    second", o: {\n      t: 1\n    }}\n' +
        'c:\n  team:\n    lead: &l ann  # c\n  other:\n    owner: *l\n',
    v => (v.b = {...v.b.custom}, v.c = {custom: {...v.c}}),
    'b:\n  p: "a long text"\n  m: first second\n  o:\n    t: 1\n' +
        'c:\n  custom:\n    team:\n      lead: &l ann  # c\n    other:\n      owner: ann\n'
  ],
  [
    'moved mappings written entry by entry, one holding an alias of an anchor outside it',
    "x: &a 1\nm:\n  k: 1\n  w:\n    r: *a\n    h: |-  # c\n      p\n    t: 'd'\nf: {k: 1}\ng:\n  t: 'e'\n" +
        'a:\n  k: 1\n  h: |-  # c\n    p\n',
    v => {
      v.m = {k: 1, c: {w: v.m.w}};
      v.f.g = v.g;
      delete v.g;
      // A new mapping takes the place of `a`, which moves with a new key.
      const a = Object.assign(v.a, {z: 1});
      v.a = {k: 1, h: 'p'};
      v.b = a;
    },
    "x: &a 1\nm:\n  k: 1\n  c:\n    w:\n      r: 1\n      h: |-  # c\n        p\n      t: 'd'\n" +
        "f: {k: 1, g: {t: 'e'}}\na:\n  k: 1\n  h: |-  # c\n    p\nb:\n  k: 1\n  h: p\n  z: 1\n"
  ],
  [
    'a mapping moved under a new mapping that keeps its place',
    "ai:\n  custom:  # outer\n    # above inner\n    custom: 'x'  # inner\n    note: |-  # note\n      hello\n",
    v => v.ai = {custom: {custom: v.ai.custom}},
    "ai:\n  custom:  # outer\n    # above inner\n    custom:  # inner\n      custom: 'x'\n      note: |-  # note\n" +
        '        hello\n'
  ],
  [
    'an empty value moved to a new key', 'a:\n  k: 1\n  e:  # c\n',
    v => (delete v.a.e, v.b = {e: null}), 'a:\n  k: 1\nb:\n  e:\n'
  ],
  [
    'a new list item beside an equal item that stays',
    'l:\n  - d: S\n    e: |-  # h\n      x\n', v => v.l = [{d: 'S', e: 'x'}, {d: 'B', e: 'x'}],
    'l:\n  - d: S\n    e: |-  # h\n      x\n  - d: B\n    e: x\n'
  ],
  ['an alias of an anchor in a removed item', 'l:\n  - &x a\n  - b\nk: *x\n', v => v.l.shift()],
  [
    'an alias reached before its anchor gains an item', 'a: &s\n  - 1\nb: *s\n',
    v => {
      const a = [...v.a, 2];
      delete v.a;
      v.a = a;
    }
  ],
  ['the last item removed from a flow list', 'f: [a, b]  # c\n', v => v.f.pop(), 'f: [a]  # c\n'],
  [
    'flow collections over several lines that change, written in block style',
    'a: {  # c\n  i: x,\n  o: y\n}  # d\nl: [p,  # e\n  q]\nk: [\n  p]\n',
    v => (delete v.a.o, v.a.c = 'z', v.l.push('r')),
    'a:  # d\n  i: x\n  c: z\nl:\n  - p\n  - q\n  - r\nk: [\n  p]\n'
  ],
  [
    'a flow mapping given text of several lines, in a scalar and a new mapping',
    'f: [{name: a, d: x}]\n', v => {
      const text = 'Owned by the analytics team in the main office.\n\nAsk first.';
      v.f[0].d = text;
      v.f[0].e = {k: text};
    }
  ],
  [
    'a flow list item renamed to "b, c"', 'f: [{name: a}, {name: b}]  # c\n',
    v => v.f[1].name = 'b, c'
  ],
  [
    'the last item removed from a CRLF text with no final newline',
    'a:\r\n  - x\r\n  - y', v => v.a.pop(), 'a:\r\n  - x'
  ],
  [
    'the last key of a text with no final newline moved under a new key',
    'a:\n  k: 1\n  t: 2', v => (delete v.a.t, v.a.c = {t: 2}), 'a:\n  k: 1\n  c:\n    t: 2'
  ],
  [
    'a scalar in a padded flow mapping set to a mapping',
    'g: {\n  k: 1}\nf: [{ name: a, e: x }]\n', v => v.f[0].e = {d: [{k: 'x'}]},
    'g: {\n  k: 1}\nf: [{ name: a, e: { d: [{ k: x }] } }]\n'
  ],
  [
    'a first key removed above a comment at column 0',
    'l:\n  - a: 1\n# c\n    b: 2\n', v => delete v.l[0].a, 'l:\n# c\n  - b: 2\n'
  ],
  [
    'the last item removed after a `|+` block scalar in a text with no final newline',
    'l:\n  - e: |+\n      x\n\n  - k: 2', v => v.l.pop(), 'l:\n  - e: |+\n      x\n\n'
  ],
  [
    'a new first key and a new last item in a text with no final newline',
    'l:\n  - b: 1', v => {
      const {b} = v.l[0];
      delete v.l[0].b;
      Object.assign(v.l[0], {a: 0, b});
      v.l.push('y');
    }
  ],
  [
    'a list item removed between comments at its key column',
    'a:\n  - k: 1\n    # c1\n  - k: 2\n    # c2\n  - k: 3\n', v => v.a.splice(1, 1)
  ],
  [
    'a value beside keys whose text is not their value',
    '~: a\n1.0: b\n0x10: c\n02: d\nx: e\n', v => v.x = 'f',
    '~: a\n1.0: b\n0x10: c\n02: d\nx: f\n'
  ],
  [
    'values of two lines and flow collections replaced by other kinds',
    'a: x\n  y  # c\nb: [1,\n  2]  # d\nm: {b: 1}  # e\nl: [1, 2]\np: |+\n  x\n\nq: 1\n',
    v => (v.a = {k: 1}, v.b = 'z', v.m = {c: 1}, v.l = {a: 1}, v.p = {k: 1}),
    'a:  # c\n  k: 1\nb: z  # d\nm: {c: 1}  # e\nl: {a: 1}\np:\n  k: 1\nq: 1\n'
  ],
])('%s reads back as the new value', (_, input, change, ...[expected]) => {
  const {document, text} = parseForUpdate(input);
  const value = plainCopy(document.toJS());
  const links = linkNodes(value, document.contents);
  change(value);

  const output = updateText(text, document, value, links);

  expect(yaml.parse(output)).toEqual(value);
  expect(yaml.parse(output, {version: '1.1'})).toEqual(value);
  // A text with no final newline keeps none, unless a block scalar that keeps
  // its final line breaks ends it.
  expect(output.endsWith('\n'))
      .toBe(text.endsWith('\n') || endsInKeptBlock(output));
  if (expected) expect(output).toBe(expected);
});

test('a key renamed in the document keeps its tag and its value\'s', () => {
  const {document, text} = parseForUpdate('!!str datasets: !!seq\n  - a\n');
  ((document.contents as yaml.YAMLMap).items[0].key as yaml.Scalar).value = 'entities';
  const value = {entities: ['a']};

  expect(updateText(text, document, value, linkNodes(value, document.contents)))
      .toBe('!!str entities: !!seq\n  - a\n');
});

// A root set to a value of another kind loses its tag. The `---` before it
// stays.
test.each([
  ['!!seq [1]\n', '{a: 1}\n'],
  ['!!str\n', '{a: 1}\n'],
  ['--- !!seq\n[1]\n', '---\n{a: 1}\n'],
])('the root of %j set to a mapping', (input, expected) => {
  const {document, text} = parseForUpdate(input);

  const output = updateText(text, document, {a: 1}, new Map());

  expect(yaml.parse(output)).toEqual({a: 1});
  expect(output).toBe(expected);
});

// Whether a block scalar that keeps its final line breaks, as `|+` does, ends
// `text`.
function endsInKeptBlock(text: string): boolean {
  let found = false;
  yaml.visit(yaml.parseDocument(text), {
    Scalar: (_, n) => void (found ||= n.range![1] === text.length &&
        /^[|>][0-9]*\+/.test(text.slice(n.range![0]))),
  });
  return found;
}
