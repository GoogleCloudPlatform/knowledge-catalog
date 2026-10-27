// Defines metadata objects provided by the catalog snapshot
//

import * as z from 'zod';

// The aspect that holds an entry's overview text, which the documents layout
// writes as a document's body.
export const OVERVIEW_ASPECT = 'dataplex-types.global.overview';

export interface Aspect {
  [key: string]: any;
}

export interface Entry {
  name: string;
  type: string;
  resource: {
    name?: string;
    displayName?: string;
    description?: string;
    labels?: Record<string, string>;
    location?: string;
    parent?: string;
    ancestors?: {
      name: string;
      type: string;
    }[];
    createTime?: string;
    updateTime?: string;
  };
  aspects?: Record<string, Aspect>;
}

// The outcome of one item of a call that saves or deletes several entries.
// Results come in the order of the items. `name` is the name the item used,
// or, for an entry the call created, the name the layout gave it; `error`
// says why an item failed and is absent when it succeeded.
export interface EntryResult {
  name: string;
  ok: boolean;
  error?: string;
}

// The shape of an entry that comes from outside kcmd, such as an item of a
// `kcmd entry save` file: exactly the keys kcmd's own entries have, so that a
// misspelled key fails instead of being dropped.
const resourceSchema = z.object({
  name: z.string().optional(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  location: z.string().optional(),
  parent: z.string().optional(),
  ancestors: z.array(z.object({name: z.string(), type: z.string()}).strict())
                 .optional(),
  createTime: z.string().optional(),
  updateTime: z.string().optional(),
}).strict();

export const entrySchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  resource: resourceSchema.optional(),
  aspects: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
}).strict();

// One line naming every problem entrySchema found, each at its key.
export function entrySchemaProblems(error: z.ZodError): string {
  return error.issues
      .map(i => `${i.path.length ? i.path.join('.') : 'the entry'}: ${i.message}`)
      .join('; ');
}
