// A workspace that holds a semantic model in OSI+G under `catalog/` and the
// rest of a context set as an OKF bundle under `bundle/`.
//
// The semantic model half is read and written as whole `<model>.yaml` documents
// through `this.semantic` by the semantic pull/push legs. The per-entry
// `CatalogLayout` methods forward to `this.okf` so `CatalogSnapshot` and
// `CatalogSync` operate on the OKF bundle half.

import {CatalogLayout} from '../layout';
import * as md from '../metadata';
import {OkfLayout} from './okf';
import {SemanticModelLayout} from './semantic-model';

export class SplitLayout implements CatalogLayout {
  readonly semantic: SemanticModelLayout;
  readonly okf: OkfLayout;

  constructor(semantic: SemanticModelLayout, okf: OkfLayout) {
    this.semantic = semantic;
    this.okf = okf;
  }

  // Initializes both halves without parsing the model YAML (SemanticModelLayout
  // only globs for `<model>.yaml` paths during init(), so the SQL parser does
  // not need to be loaded when opening a split workspace).
  async init(): Promise<void> {
    await this.semantic.init();
    await this.okf.init();
  }

  entryExists(name: string): boolean {
    return this.okf.entryExists(name);
  }

  listEntries(): string[] {
    return this.okf.listEntries();
  }

  async loadEntry(name: string): Promise<md.Entry> {
    return await this.okf.loadEntry(name);
  }

  async saveEntry(name: string, entry: md.Entry): Promise<void> {
    await this.okf.saveEntry(name, entry);
  }

  async deleteEntry(name: string): Promise<void> {
    await this.okf.deleteEntry(name);
  }
}
