import * as kcmd from 'kcmd';

const context = kcmd.gcp.ApiContext.default();
const catalogSnapshot = await kcmd.CatalogSnapshot.fromPath('.', context);

const entry = await catalogSnapshot.lookupEntry('index');
if (!entry.aspects) {
  entry.aspects = {};
}
entry.aspects['dataplex-types.global.overview'] = {
  content: 'New updated content\n',
  contentType: 'MARKDOWN',
};
await catalogSnapshot.updateEntry(entry, ['dataplex-types.global.overview']);
