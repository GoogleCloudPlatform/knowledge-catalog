// OWL property chains -> derived relationships (K2, proposed; see
// ../../derived_relationships.ts for what `via` means and how it lowers).
//
//   ex:belongsTo owl:propertyChainAxiom
//       ( [ owl:inverseOf ex:memberOf ] ex:inClub ) .
//
// becomes `belongsTo` with `via: [^memberOf, inClub]` -- a named
// step follows the property, an `[ owl:inverseOf p ]` step walks p backwards
// (`^p`). A property may omit its rdfs:domain / rdfs:range: the chain's first
// and last entities stand in (see to_ir). Only the first chain of a property
// is imported (a relationship derives from one chain), and a chain that
// cannot be one fixed join -- a step naming the property itself (a recursive
// chain), a step OWL expresses with anything but owl:inverseOf, a single step
// -- is not imported, with a warning.

import {RelationshipStep} from '../../ir';

import {OwlObjectProperty} from './model';
import {localName} from './parse';

/**
 * The `via` steps a property's chain axioms give it, plus the warnings that
 * explain anything left out. `steps` is undefined when the property has no
 * usable chain.
 */
export function chainSteps(p: OwlObjectProperty):
    {steps?: RelationshipStep[]; warnings: string[]} {
  const warnings: string[] = [];
  const [chain, ...rest] = p.propertyChain;
  if (!chain) return {warnings};
  const ctx = `object property '${p.localName}'`;
  if (rest.length) {
    warnings.push(`${ctx} declares ${
        p.propertyChain.length} owl:propertyChainAxiom chains; a ` +
                  `relationship derives from one, so only the first is ` +
                  `imported as 'via'.`);
  }
  const unsupported = chain.find(s => s.unsupported !== undefined);
  if (unsupported) {
    warnings.push(`${ctx}: its owl:propertyChainAxiom has ${
        unsupported.unsupported}; not imported as 'via'.`);
    return {warnings};
  }
  if (chain.length < 2) {
    warnings.push(`${ctx}: its owl:propertyChainAxiom has a single step; not ` +
                  `imported as 'via' (a chain composes at least two).`);
    return {warnings};
  }
  const steps: RelationshipStep[] = chain.map(
      s => s.inverse ? {relationship: localName(s.property), inverse: true} :
                       {relationship: localName(s.property)});
  if (steps.some(s => s.relationship === p.localName)) {
    warnings.push(`${ctx}: its owl:propertyChainAxiom names the property ` +
                  `itself (a recursive chain), which no fixed join ` +
                  `materializes; not imported as 'via'.`);
    return {warnings};
  }
  return {steps, warnings};
}

/**
 * Rewrites steps that name a property folded into another relationship's
 * `inverse:` (see to_ir.planInverseFolds) as that relationship walked the
 * other way, so a chain never depends on the inverse name surviving.
 * `forwardOf` maps a folded property's name to its forward relationship.
 */
export function canonicalSteps(
    steps: readonly RelationshipStep[],
    forwardOf: ReadonlyMap<string, string>): RelationshipStep[] {
  return steps.map(s => {
    const forward = forwardOf.get(s.relationship);
    if (forward === undefined) return s;
    return s.inverse ? {relationship: forward} :
                       {relationship: forward, inverse: true};
  });
}
