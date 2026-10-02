// SHACL import coverage (proposed): every shape and constraint component a
// `kcmd shacl import` read, classified as compiled, hinted or dropped (see
// ../coverage.ts for the outcomes).
//
// Built from the parsed shapes (what was there) and, per property shape and
// target class, the constraints derived and the warnings raised while
// deriving them (constraints.ts ShaclPropertyTrace). A component is
//   compiled -- when a derived constraint quotes it in its provenance terms,
//               or when nothing was derived and nothing was warned: the model
//               already guarantees it (a field holds one value, an edge ends
//               at its destination, sh:minCount 0, an agreeing sh:datatype);
//   dropped  -- when a warning names it, or its whole property shape was
//               skipped (unknown target, unresolvable path, deactivated).
// No SHACL construct is hinted today: a rule either becomes a constraint or
// is not carried.

import {CoverageEntry, CoverageRecorder} from '../coverage';
import {localName} from '../owl/parse';

import {ShaclPropertyTrace, shapeKey} from './constraints';
import {ShaclPropertyShape, ShaclShapes} from './parse';

interface Component {
  term: string;
  // True when a derived constraint's provenance terms state this component.
  stated: (terms: string) => boolean;
  // True when a warning is about this component.
  warned: (warning: string) => boolean;
  // A component the importer never maps: dropped even when no warning names
  // it (it cannot be "guaranteed by the model structure").
  unsupported?: boolean;
}

/** The coverage entries of one SHACL import, in report order. */
export function shaclCoverage(
    shapes: ShaclShapes, traces: readonly ShaclPropertyTrace[]): CoverageEntry[] {
  const rec = new CoverageRecorder();
  const byProperty =
      new Map<ShaclPropertyShape, Map<string, ShaclPropertyTrace>>();
  for (const t of traces) {
    const forShape = byProperty.get(t.property) ?? new Map();
    forShape.set(t.target, t);
    byProperty.set(t.property, forShape);
  }

  for (const ns of shapes.nodeShapes) {
    const shape = shapeKey(ns);
    // The property shapes of a node shape that applies to nothing, each
    // reported as dropped for `reason`.
    const droppedProperties = (reason: string) => {
      for (const ps of ns.properties) {
        const label = ps.name ?? (ps.path ? localName(ps.path) : '[anonymous]');
        rec.dropped('sh:PropertyShape', `${shape} / ${label}`, reason);
      }
    };
    if (ns.deactivated) {
      rec.dropped('sh:NodeShape', shape, 'sh:deactivated true');
      droppedProperties('its node shape is deactivated');
      continue;
    }
    const inner = new CoverageRecorder();
    for (const t of ns.otherTargets) {
      inner.dropped(
          `sh:${t}`, shape,
          'targets individual nodes, which the model does not hold; only ' +
              'sh:targetClass is supported');
    }
    for (const t of ns.unsupported) {
      inner.dropped(`sh:${t}`, `${shape} (node level)`, 'not supported');
    }
    let anyCompiled = false;
    for (const ps of ns.properties) {
      for (const target of ns.targetClasses) {
        anyCompiled =
            property(inner, shape, ps, localName(target)) || anyCompiled;
      }
    }
    if (!ns.targetClasses.length) {
      rec.dropped(
          'sh:NodeShape', shape,
          ns.properties.length ?
              'no sh:targetClass (and not itself a class): its rules apply ' +
                  'to nothing' :
              'no sh:targetClass and no property shapes');
    } else if (anyCompiled) {
      rec.compiled(
          'sh:NodeShape', shape,
          `target ${ns.targetClasses.map(localName).join(', ')}`);
    } else {
      rec.dropped(
          'sh:NodeShape', shape,
          ns.properties.length ? 'none of its property shapes was carried' :
                                 'no property shapes (node-level rules only)');
    }
    for (const e of inner.entries) rec.add(e);
    if (!ns.targetClasses.length) {
      droppedProperties('its node shape has no target class');
    }
  }

  for (const ps of shapes.standaloneProperties) {
    const shape = ps.name ?? '[anonymous property shape]';
    if (!ps.targetClasses.length) {
      rec.dropped(
          'sh:PropertyShape', shape,
          'no target class: its rules apply to nothing');
      continue;
    }
    for (const target of ps.targetClasses) {
      property(rec, shape, ps, localName(target));
    }
  }
  return rec.entries;

  // Records one property shape applied to target class C, then its
  // components; true when anything of it was carried.
  function property(
      out: CoverageRecorder, shape: string, ps: ShaclPropertyShape,
      C: string): boolean {
    const label = ps.name ?? (ps.path ? localName(ps.path) : '[anonymous]');
    const subject = `${shape} / ${label} on ${C}`;
    const trace = byProperty.get(ps)?.get(C);
    const warnings = trace?.warnings ?? [];
    const derived = trace?.constraints ?? [];
    const components = componentsOf(ps);

    const skip = ps.deactivated ? 'sh:deactivated true' :
                                  warnings.find(w => isWholeShapeSkip(w, C));
    if (skip) {
      out.dropped('sh:PropertyShape', subject, skip);
      for (const c of components) {
        out.dropped(c.term, subject, 'its property shape was not carried');
      }
      return false;
    }

    const parts = new CoverageRecorder();
    for (const c of components) {
      const by = derived.filter(d => c.stated(d.terms));
      if (by.length) {
        parts.compiled(
            c.term, subject,
            `constraint ${by.map(d => d.constraint.name).join(', ')}`);
        continue;
      }
      const w = warnings.find(x => c.warned(x));
      if (w) {
        parts.dropped(c.term, subject, w);
      } else if (c.unsupported) {
        parts.dropped(c.term, subject, 'not supported');
      } else {
        parts.compiled(
            c.term, subject, 'model structure',
            'already guaranteed by the model structure; no constraint needed');
      }
    }
    const names = derived.map(d => d.constraint.name).join(', ');
    const carried = (construct: string) => {
      if (derived.length) {
        parts.compiled(construct, subject, `constraint ${names}`);
      } else {
        parts.dropped(construct, subject,
                      'no constraint was derived to carry it');
      }
    };
    if (ps.message !== undefined) {
      carried('sh:message');
    } else if (ps.description !== undefined) {
      carried('sh:description');
    }
    if (ps.severity !== undefined) carried('sh:severity');
    if (ps.label !== undefined) {
      parts.dropped('sh:name', subject,
                    'a property shape display name has no slot in the model');
    }

    const dropped = parts.entries.filter(
        e => e.outcome === 'dropped' && components.some(c => c.term === e.construct));
    const anyCarried = derived.length > 0 || dropped.length < components.length;
    if (anyCarried) {
      out.compiled(
          'sh:PropertyShape', subject,
          derived.length ? `constraint ${names}` : 'model structure',
          dropped.length ?
              `${dropped.length} of ${components.length} terms dropped` :
              undefined);
    } else {
      out.dropped(
          'sh:PropertyShape', subject,
          components.length ? 'none of its terms was carried' :
                              'no constraint terms');
    }
    for (const e of parts.entries) out.add(e);
    return anyCarried;
  }
}

// The warnings shaclConstraints raises when it skips a property shape as a
// whole for target C (see constraints.ts applyTo).
function isWholeShapeSkip(w: string, C: string): boolean {
  return w.includes(`: '${C}' is not an entity in the model; skipped.`) ||
      w.includes('which does not name one relationship or field; skipped.') ||
      w.includes('is neither a relationship nor a field of') ||
      w.includes(`, not at '${C}' or one of its supertypes; skipped.`);
}

// The constraint components a property shape states, in a fixed order.
function componentsOf(ps: ShaclPropertyShape): Component[] {
  const out: Component[] = [];
  const plain = (term: string) =>
      out.push({term, stated: hasTerm(term), warned: hasTerm(term)});
  if (ps.minCount !== undefined) plain('sh:minCount');
  if (ps.maxCount !== undefined) plain('sh:maxCount');
  if (ps.datatype !== undefined) plain('sh:datatype');
  for (const cls of ps.classes) {
    const X = localName(cls);
    out.push({
      term: 'sh:class',
      stated: terms => terms.includes(`sh:class ${X}`),
      warned: w => w.includes(`sh:class '${X}'`),
    });
  }
  if (ps.qualified) {
    out.push({
      term: 'sh:qualifiedValueShape',
      stated: terms => hasTerm('sh:qualifiedMinCount')(terms) ||
          hasTerm('sh:qualifiedMaxCount')(terms),
      warned: w => /qualified/i.test(w),
    });
  }
  if (ps.pattern !== undefined) plain('sh:pattern');
  if (ps.in !== undefined) plain('sh:in');
  for (const facet of ['minInclusive', 'maxInclusive', 'minExclusive',
                       'maxExclusive', 'minLength', 'maxLength'] as const) {
    if (ps[facet] !== undefined) plain(`sh:${facet}`);
  }
  for (const pair of ps.pairs) {
    const term = `sh:${pair.term}`;
    const other = pair.other ? localName(pair.other) : undefined;
    out.push({
      term,
      stated: terms => other !== undefined && terms.includes(`${term} ${other}`),
      warned: hasTerm(term),
    });
  }
  if (ps.node !== undefined) {
    out.push({
      term: 'sh:node',
      stated: () => false,
      warned: hasTerm('sh:node'),
      unsupported: true,
    });
  }
  for (const t of ps.unsupported) {
    out.push({
      term: `sh:${t}`,
      stated: () => false,
      warned: hasTerm(`sh:${t}`),
      unsupported: true,
    });
  }
  return out;
}

// A test for `term` as a whole token (so `sh:in` does not match
// `sh:minInclusive`, nor `sh:minCount` match `sh:qualifiedMinCount`).
function hasTerm(term: string): (text: string) => boolean {
  const re = new RegExp(
      `(^|[^A-Za-z0-9_:])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` +
      `(?![A-Za-z0-9_])`);
  return text => re.test(text);
}
