// Defines metadata objects provided by the catalog snapshot
//

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
