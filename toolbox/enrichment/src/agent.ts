// Agent implementation
//

import * as adk from '@google/adk';
import * as kcmd from 'kcmd';

const gcpContext = kcmd.gcp.ApiContext.default();

export const rootAgent = new adk.Agent({
  name: 'kcenrich',
  description: 'Enriches the metadata in the knowledge catalog.',
  instruction: 'Build documentation for the referenced asset.',
  model: new adk.Gemini({
    model: 'gemini-2.5-flash',
    vertexai: true,
    project: gcpContext.project,
    location: gcpContext.location,
  }),
});
