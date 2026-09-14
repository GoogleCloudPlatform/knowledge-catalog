// A judge backed by Gemini on Vertex AI.
//
// The runtime defines what a judge is (semantic/runtime/judge.ts)
// and this supplies one, the same way spanner.ts supplies a store. It is one
// `generateContent` call over the REST surface every other client here uses,
// so it needs no SDK on the dependency list and authenticates the way the rest
// of the tool does.
//
// What it will not do is reason about the model. A judge is handed one rule
// and one attempted call and answers about that pair only, because a rule the
// catalog governs has to mean the same thing for every caller and a prompt
// that invited the model to consider anything else would stop being auditable.

import {Judge, JudgeRequest, JudgeVerdict} from '../semantic/runtime/judge';

import {ApiClient} from './api';
import * as context from './context';


// Flash rather than Pro: a guard sits in front of a write that a caller is
// waiting on, and the task is reading one short rule against one small object.
export const DEFAULT_JUDGE_MODEL = 'gemini-2.5-flash';


// Vertex serves models from a region, and not every region serves every model.
// `gcloud config get-value compute/region` is whatever the user set for
// Compute Engine and is routinely somewhere Vertex is not, so the judge falls
// back to a region that serves Gemini rather than failing on an unrelated
// setting.
export const DEFAULT_JUDGE_LOCATION = 'us-central1';


// The shape the model must answer in, declared to the API rather than asked
// for in the prompt so that a malformed answer is the service's error and not
// something to parse around.
const VERDICT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    holds: {type: 'BOOLEAN'},
    reason: {type: 'STRING'},
  },
  required: ['holds', 'reason'],
};


const SYSTEM_INSTRUCTION = [
  'You decide whether one stated rule holds for one attempted action.',
  '',
  'Answer only about the rule you are given. Do not consider other rules, ' +
      'other policies, or whether the action is wise.',
  'Judge only what the arguments actually say. Do not assume facts that are ' +
      'not there, and do not give the caller the benefit of the doubt.',
  'If the arguments do not contain enough to tell, the rule does not hold, ' +
      'and the reason says what is missing.',
  'The reason is read by whoever attempted the action. Address them, be ' +
      'specific about this call, and keep it to one or two sentences.',
].join('\n');


/** How the Gemini judge is pointed at a project, a region and a model. */
export interface GeminiJudgeOptions {
  project?: string;
  location?: string;
  model?: string;
}


/** A judge that asks Gemini on Vertex AI. */
export class GeminiJudge extends ApiClient implements Judge {
  readonly name: string;
  private readonly _project: string;
  private readonly _location: string;
  private readonly _model: string;

  constructor(ctx: context.ApiContext, options: GeminiJudgeOptions = {}) {
    const location =
        options.location ?? ctx.location ?? DEFAULT_JUDGE_LOCATION;
    super(`https://${location}-aiplatform.googleapis.com`, 'v1', ctx);
    this._location = location;
    this._project = options.project ?? ctx.project;
    this._model = options.model ?? DEFAULT_JUDGE_MODEL;
    this.name = `${this._model} (${this._location})`;
  }

  async decide(request: JudgeRequest): Promise<JudgeVerdict> {
    const resource = `projects/${this._project}/locations/${
        this._location}/publishers/google/models/${
        this._model}:generateContent`;
    const res = await this._post<GenerateContentResponse>(resource, {
      systemInstruction: {parts: [{text: SYSTEM_INSTRUCTION}]},
      contents: [{role: 'user', parts: [{text: promptFor(request)}]}],
      generationConfig: {
        // A guard that answered differently for identical calls would be a
        // guard nobody could rely on. Nothing makes a model deterministic, and
        // ir.ts says so where `onViolation` is required on a judgment, but
        // there is no reason to add sampling on top of it.
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: VERDICT_SCHEMA,
      },
    });
    if (res.status < 200 || res.status >= 300) {
      // Thrown, not returned as a refusal. The runtime distinguishes a judge
      // that answered "no" from a judge that could not be reached, and only
      // the first is the caller's problem.
      throw new Error(
          `judge ${this.name} could not be reached: ${
              res.message ?? res.status}`);
    }
    return verdictFrom(res.result, this.name);
  }
}


/** Builds a judge from the ambient gcloud configuration. */
export function geminiJudge(options: GeminiJudgeOptions = {}): GeminiJudge {
  return new GeminiJudge(context.ApiContext.default(), options);
}


// What the model is shown. The rule leads, because it is the thing being
// applied; the call follows as the thing it is applied to.
function promptFor(request: JudgeRequest): string {
  const lines = [
    `Rule (named '${request.constraint}'):`,
    request.rule,
    '',
    `Attempted action: ${request.action}`,
  ];
  if (request.actionDescription?.trim()) {
    lines.push(`What it does: ${request.actionDescription.trim()}`);
  }
  lines.push('', 'Arguments:', JSON.stringify(request.arguments, null, 2));
  lines.push('', 'Does the rule hold for this call?');
  return lines.join('\n');
}


interface GenerateContentResponse {
  candidates?: Array<{content?: {parts?: Array<{text?: string}>}}>;
}


// Reads the verdict out of the response. Everything that can go wrong here is
// the judge failing to answer rather than the rule failing to hold, so all of
// it throws.
function verdictFrom(
    response: GenerateContentResponse|undefined, name: string): JudgeVerdict {
  const text = response?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error(`judge ${name} returned no answer`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`judge ${name} returned an answer that is not JSON`);
  }
  const verdict = parsed as Partial<JudgeVerdict>;
  if (typeof verdict?.holds !== 'boolean') {
    throw new Error(`judge ${name} did not say whether the rule holds`);
  }
  return {
    holds: verdict.holds,
    reason: typeof verdict.reason === 'string' ? verdict.reason : '',
  };
}
