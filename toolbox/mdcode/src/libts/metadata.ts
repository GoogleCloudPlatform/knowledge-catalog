// Defines metadata objects provided by the catalog snapshot
//

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
  links?: Record<string, EntryLink[]>;
}

export interface EntryLink {
  target: string;
  id?: string;
  aspects?: Record<string, Aspect>;
}
