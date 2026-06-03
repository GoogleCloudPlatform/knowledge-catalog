import * as crypto from 'node:crypto';
import { Entry } from './metadata';

/**
 * Normalizes aspect data recursively by sorting object keys alphabetically.
 * Preserves the order of array elements, but normalizes objects within arrays.
 */
export function normalizeAspectData(data: any): any {
  if (data === null || typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(item => normalizeAspectData(item));
  }

  const sortedKeys = Object.keys(data).sort();
  const normalizedObj: Record<string, any> = {};
  for (const key of sortedKeys) {
    normalizedObj[key] = normalizeAspectData(data[key]);
  }
  return normalizedObj;
}

/**
 * Computes a SHA-256 hash of a string.
 */
export function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Calculates the checksum of an individual aspect by serializing its normalized form.
 */
export function calculateAspectChecksum(aspectData: any): string {
  const normalized = normalizeAspectData(aspectData);
  return sha256(JSON.stringify(normalized));
}

/**
 * Calculates the unified entry-level checksum of an Entry by combining the hashes
 * of its normalized core fields and individual aspect checksums.
 */
export function calculateEntryChecksum(entry: Entry): string {
  const coreData = {
    name: entry.name,
    type: entry.type,
    resource: entry.resource ? normalizeAspectData(entry.resource) : undefined,
  };
  const coreJson = JSON.stringify(coreData);

  const aspectChecksums: Record<string, string> = {};
  if (entry.aspects) {
    const sortedAspectKeys = Object.keys(entry.aspects).sort();
    for (const key of sortedAspectKeys) {
      aspectChecksums[key] = calculateAspectChecksum(entry.aspects[key]);
    }
  }

  const unifiedData = {
    core: coreJson,
    aspects: aspectChecksums,
  };

  return sha256(JSON.stringify(unifiedData));
}
