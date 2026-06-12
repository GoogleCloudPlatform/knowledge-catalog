// Dataplex Business Glossary as Metadata Source
//

import * as gcp from '../gcp';
import * as dataplex from '../gcp/dataplex';
import {Layouts} from '../layout';
import {CatalogSource} from '../source';

export class GlossarySource implements CatalogSource {
  readonly type: string;
  readonly name: string;
  readonly namespace: string;
  readonly ingestedEntries = false;
  readonly layout = Layouts.STANDARD;

  private readonly _parts: string[];
  private readonly _glossaries: dataplex.Glossary[];
  private readonly _displayNames = new Map<string, string>();

  constructor(
    type: string,
    name: string,
    glossaries: dataplex.Glossary[] = [],
  ) {
    this.type = type;
    this.name = name;

    this._parts = name.split('.');
    this._glossaries = glossaries;
    for (const g of glossaries) {
      this._displayNames.set(g.name, g.displayName || '');
    }

    this.namespace = 'glossaries';
  }

  async *entries(ctx: gcp.ApiContext): AsyncGenerator<any, void, unknown> {
    const catalog = new gcp.CatalogClient(ctx);
    const [project, location] = this._parts;

    if (this._glossaries.length > 0) {
      // Specific Glossaries mode
      for (const glossary of this._glossaries) {
        this._displayNames.set(glossary.name, glossary.displayName || '');
        yield glossary;

        const glossaryId = glossary.name.split('/').pop()!;

        for await (const category of catalog.listGlossaryCategories(
          project,
          location,
          glossaryId,
        )) {
          this._displayNames.set(category.name, category.displayName || '');
          yield category;
        }
        for await (const term of catalog.listGlossaryTerms(
          project,
          location,
          glossaryId,
        )) {
          yield term;
        }
      }
    } else {
      // Location mode: list all glossaries, their categories and terms
      for await (const glossary of catalog.listGlossaries(project, location)) {
        this._displayNames.set(glossary.name, glossary.displayName || '');
        yield glossary;
        const gId = glossary.name.split('/').pop()!;
        for await (const category of catalog.listGlossaryCategories(
          project,
          location,
          gId,
        )) {
          this._displayNames.set(category.name, category.displayName || '');
          yield category;
        }
        for await (const term of catalog.listGlossaryTerms(
          project,
          location,
          gId,
        )) {
          yield term;
        }
      }
    }
  }

  localName(resource: any, isReference?: boolean): string {
    const name = resource.name as string;
    const displayName = resource.displayName as string;

    let localPath = '';
    if (name.includes('/terms/')) {
      const match = name.match(/glossaries\/([^/]+)\/terms\/(.+)$/);
      if (!match) {
        throw new Error(`Invalid glossary term name for resource: ${name}`);
      }
      const glossaryId = match[1];
      const termId = match[2];

      const glossaryName = name.split('/terms/')[0];
      const gDisplayName = this._displayNames.get(glossaryName);
      const gFolderName = gDisplayName
        ? `${gDisplayName} (${glossaryId})`
        : glossaryId;

      // Check if term belongs to a category
      const categoryName = (resource as dataplex.GlossaryTerm).parent;
      if (categoryName && categoryName.includes('/categories/')) {
        const cMatch = categoryName.match(/\/categories\/(.+)$/);
        const categoryId = cMatch ? cMatch[1] : categoryName;
        const cDisplayName = this._displayNames.get(categoryName);
        const cFolderName = cDisplayName
          ? `${cDisplayName} (${categoryId})`
          : categoryId;

        localPath = `${this.namespace}/${gFolderName}/${cFolderName}/terms/${displayName || termId}`;
      } else {
        localPath = `${this.namespace}/${gFolderName}/terms/${displayName || termId}`;
      }
    } else if (name.includes('/categories/')) {
      const match = name.match(/glossaries\/([^/]+)\/categories\/(.+)$/);
      if (!match) {
        throw new Error(`Invalid glossary category name for resource: ${name}`);
      }
      const glossaryId = match[1];
      const categoryId = match[2];

      const glossaryName = name.split('/categories/')[0];
      const gDisplayName = this._displayNames.get(glossaryName);
      const gFolderName = gDisplayName
        ? `${gDisplayName} (${glossaryId})`
        : glossaryId;

      const cFolderName = displayName
        ? `${displayName} (${categoryId})`
        : categoryId;
      const cFileName = displayName || categoryId;

      localPath = `${this.namespace}/${gFolderName}/${cFolderName}/${cFileName}`;
    } else {
      const match = name.match(/glossaries\/([^/]+)$/);
      if (!match) {
        throw new Error(`Invalid glossary name for resource: ${name}`);
      }
      const glossaryId = match[1];
      const gFolderName = displayName
        ? `${displayName} (${glossaryId})`
        : glossaryId;
      const gFileName = displayName || glossaryId;
      localPath = `${this.namespace}/${gFolderName}/${gFileName}`;
    }

    return isReference ? `${localPath}.ref` : localPath;
  }

  serviceName(localName: string): string {
    const cleanName = localName.endsWith('.ref')
      ? localName.slice(0, -4)
      : localName;

    const project = this._parts[0];
    const location = this._parts[1];

    if (cleanName.startsWith(`${this.namespace}/`)) {
      const relativePath = cleanName.substring(this.namespace.length + 1);
      const parts = relativePath.split('/');

      // parts[0] is always "GlossaryName (ID)"
      const gPathPart = parts[0];
      const gMatch = gPathPart.match(/\(([^)]+)\)$/);
      const glossaryId = gMatch ? gMatch[1] : gPathPart;

      const termIndex = relativePath.indexOf('/terms/');
      if (termIndex !== -1) {
        // It's a glossary term.
        const termId = relativePath.substring(termIndex + 7);
        // Does it have a category folder? e.g. "G (id)/C (id)/terms/T" vs "G (id)/terms/T"
        if (parts.length >= 4 && parts[parts.length - 2] === 'terms') {
          const cPathPart = parts[1];
          const cMatch = cPathPart.match(/\(([^)]+)\)$/);
          const categoryId = cMatch ? cMatch[1] : cPathPart;
          return `projects/${project}/locations/${location}/glossaries/${glossaryId}/terms/${termId}`;
          // Note: In Dataplex, terms are addressed directly under glossary,
          // but they reference their parent category in the resource.
          // However, serviceName's job is to return the REST resource name.
          // For terms, that is always glossaries/{gid}/terms/{tid}.
        }
        return `projects/${project}/locations/${location}/glossaries/${glossaryId}/terms/${termId}`;
      } else {
        // It's a glossary or a category
        if (parts.length >= 3) {
          // It's a category: G (id)/C (id)/C
          const cPathPart = parts[1];
          const cMatch = cPathPart.match(/\(([^)]+)\)$/);
          const categoryId = cMatch ? cMatch[1] : cPathPart;
          return `projects/${project}/locations/${location}/glossaries/${glossaryId}/categories/${categoryId}`;
        }
        // It's the glossary itself
        return `projects/${project}/locations/${location}/glossaries/${glossaryId}`;
      }
    }

    throw new Error(`Invalid local name for glossary source: ${localName}`);
  }

  tryGetLocalName(serviceName: string): string | undefined {
    // This is a complex mapping due to display names.
    // We try to match by the resource ID parts.
    const project = this._parts[0];
    const location = this._parts[1];

    const termMatch = serviceName.match(
      /\/glossaries\/([^/]+)\/terms\/([^/]+)$/,
    );
    if (termMatch) {
      const glossaryId = termMatch[1];
      const termId = termMatch[2];
      const prefix = `projects/${project}/locations/${location}`;
      if (!serviceName.startsWith(prefix)) {
        return undefined;
      }

      const glossaryName = serviceName.split('/terms/')[0];
      const gDisplayName = this._displayNames.get(glossaryName);
      const gFolderName = gDisplayName
        ? `${gDisplayName} (${glossaryId})`
        : glossaryId;

      // Note: We might not have the category info here without more context.
      // For now, return a path without category or with raw ID.
      return `${this.namespace}/${gFolderName}/terms/${termId}`;
    }

    const catMatch = serviceName.match(
      /\/glossaries\/([^/]+)\/categories\/([^/]+)$/,
    );
    if (catMatch) {
      const glossaryId = catMatch[1];
      const categoryId = catMatch[2];
      const glossaryName = serviceName.split('/categories/')[0];
      const gDisplayName = this._displayNames.get(glossaryName);
      const gFolderName = gDisplayName
        ? `${gDisplayName} (${glossaryId})`
        : glossaryId;

      return `${this.namespace}/${gFolderName}/${categoryId}/${categoryId}`;
    }

    const glossaryMatch = serviceName.match(/\/glossaries\/([^/]+)$/);
    if (glossaryMatch) {
      const glossaryId = glossaryMatch[1];
      const gDisplayName = this._displayNames.get(serviceName);
      const gFolderName = gDisplayName
        ? `${gDisplayName} (${glossaryId})`
        : glossaryId;

      return `${this.namespace}/${gFolderName}/${glossaryId}`;
    }

    return undefined;
  }
}
