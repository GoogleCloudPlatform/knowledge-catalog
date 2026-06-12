export enum ResourceType {
  ASPECT = 'aspect',
  GLOSSARY = 'glossary',
  ENTRYLINK = 'entryLink',
}

// Provides 1:1 mapping between alias and resource.
export class ResourceAlias {
  readonly _defaultAlias: ReadonlyMap<string, string> = new Map([
    ['bigquery-dataset', 'aspect: dataplex-types.global.bigquery-dataset'],
    ['bigquery-table', 'aspect: dataplex-types.global.bigquery-table'],
    ['schema', 'aspect: dataplex-types.global.schema'],
    ['storage', 'aspect: dataplex-types.global.storage'],
    ['overview', 'aspect: dataplex-types.global.overview'],
    ['definition', 'entryLink: dataplex-types.global.definition'],
    ['synonym', 'entryLink: dataplex-types.global.synonym'],
    ['related', 'entryLink: dataplex-types.global.related'],
    ['schema-join', 'entryLink: dataplex-types.global.schema-join'],
  ]);
  readonly _defaultResource: ReadonlyMap<string, string> = new Map([
    ['aspect: dataplex-types.global.bigquery-dataset', 'bigquery-dataset'],
    ['aspect: dataplex-types.global.bigquery-table', 'bigquery-table'],
    ['aspect: dataplex-types.global.schema', 'schema'],
    ['aspect: dataplex-types.global.storage', 'storage'],
    ['aspect: dataplex-types.global.overview', 'overview'],
    ['entryLink: dataplex-types.global.definition', 'definition'],
    ['entryLink: dataplex-types.global.synonym', 'synonym'],
    ['entryLink: dataplex-types.global.related', 'related'],
    ['entryLink: dataplex-types.global.schema-join', 'schema-join'],
  ]);

  private customAlias: Map<string, string>;
  private customResource: Map<string, string>;

  constructor() {
    this.customAlias = new Map();
    this.customResource = new Map();
  }

  add(alias: string, resourceType: string, resource: string) {
    if (this._defaultAlias.has(alias)) {
      throw new Error(
        `Cannot define predefined alias ${alias}, which is predefined for ${this._defaultAlias.get(alias)!}`,
      );
    }

    if (this.customAlias.has(alias)) {
      throw new Error(
        `Duplicate alias defined: ${alias}, which has a definition for ${this.customAlias.get(alias)!}`,
      );
    }

    if (!Object.values(ResourceType).includes(resourceType as ResourceType)) {
      throw new Error(
        `Unrecognized resource type ${resourceType}, supported types are [ ${Object.values(ResourceType).join(', ')} ]`,
      );
    }

    const resourceTypeName = `${resourceType}: ${resource}`;

    if (
      this._defaultResource.has(resourceTypeName) ||
      this.customResource.has(resourceTypeName)
    ) {
      const duplicate = this._defaultResource.has(resourceTypeName)
        ? this._defaultResource.get(resourceTypeName)!
        : this.customResource.get(resourceTypeName)!;
      throw new Error(
        `Cannot re-define resource ${resource}, which has an alias as ${duplicate}`,
      );
    }

    this.customAlias.set(alias, resourceTypeName);
    this.customResource.set(resourceTypeName, alias);
  }

  // Return the resource name, only when resourceType matches alias config.
  lookupAlias(alias: string, resourceType: ResourceType): string {
    if (
      this._defaultAlias.has(alias) &&
      this._defaultAlias.get(alias)!.startsWith(resourceType)
    ) {
      const resourceTypeName = this._defaultAlias.get(alias)!;
      const [_, name] = resourceTypeName.split(':').map((part) => part.trim());
      return name;
    }
    if (this.customAlias.has(alias)) {
      const resourceTypeName = this.customAlias.get(alias)!;
      const [_, name] = resourceTypeName.split(':').map((part) => part.trim());
      return name;
    }
    // Couldn't find, return the original.
    return alias;
  }

  // Return the alias.
  lookupResource(resource: string, resourceType: ResourceType): string {
    const resourceTypeName = `${resourceType}: ${resource}`;
    if (this._defaultResource.has(resourceTypeName)) {
      return this._defaultResource.get(resourceTypeName)!;
    }

    if (this.customResource.has(resourceTypeName)) {
      return this.customResource.get(resourceTypeName)!;
    }

    // Couldn't find, return the original.
    return resource;
  }
}
