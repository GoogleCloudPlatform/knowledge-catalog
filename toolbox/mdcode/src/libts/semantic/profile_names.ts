// The profile name rule, shared by the layout that reads and writes profile
// files and the serializer that names them, so the two cannot drift: a letter,
// then up to 499 letters, digits, underscores, or hyphens. A profile name never
// appears in SQL, so a hyphen is safe.
export const PROFILE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,499}$/;
