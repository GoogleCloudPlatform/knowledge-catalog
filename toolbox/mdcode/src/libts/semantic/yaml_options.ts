// How kcmd parses a model or profile document. `resolveKnownTags: false` keeps
// YAML-only tags (`!!timestamp`, `!!binary`) as the text written instead of
// turning them into Date or Uint8Array, and reads `!!set` as a mapping with
// null values, so custom `ai_context` members with no JSON counterpart stay
// text. `logLevel: 'error'` keeps unresolved-tag warnings off stderr. The
// loader, the profile reader and the layout all parse with these, so a value
// means the same thing to each.
export const YAML_OPTIONS = {resolveKnownTags: false, logLevel: 'error'} as const;
