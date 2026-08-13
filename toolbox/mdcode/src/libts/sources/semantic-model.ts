// A locally-authored Semantic Model as a Metadata Source
//
// The model is authored on the local filesystem as a single Apache Ossie
// document per model (the SemanticModel layout); it is not ingested from a
// remote service. `push` deploys the model's BigQuery Graph.
//
// Knowledge Catalog resource emit (entries + entryLinks) for the semantic model
// is a follow-on; the sync-oriented members below are therefore not yet wired.
//

import * as gcp from '../gcp';
import {Layouts} from '../layout';
import {CatalogSource} from '../source';


export class SemanticModelSource implements CatalogSource {
  readonly type: string;
  readonly name: string;
  readonly ingestedEntries = false;
  readonly layout = Layouts.SEMANTIC_MODEL;

  readonly project: string;
  readonly location: string;
  readonly entryGroup: string;

  constructor(type: string, name: string) {
    const [project, location, entryGroup] = name.split('.');
    if (!project || !location || !entryGroup) {
      throw new Error(
          'Semantic model scope must be in format <projectId>.<locationId>.<entryGroupId>');
    }

    this.type = type;
    this.name = name;
    this.project = project;
    this.location = location;
    this.entryGroup = entryGroup;
  }

  // The model is authored locally; there is nothing to enumerate from a
  // service.
  async *
      entries(_ctx: gcp.ApiContext): AsyncGenerator<gcp.Entry, void, unknown> {
    return;
  }

  localName(_entry: gcp.Entry): string {
    throw new Error(
        'Knowledge Catalog resource sync is not supported for the semantic-model scope yet.');
  }

  serviceName(_localName: string): string {
    throw new Error(
        'Knowledge Catalog resource sync is not supported for the semantic-model scope yet.');
  }
}
