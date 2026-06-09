import { hash } from 'ohash';
import { Entry } from './metadata';

function stripUndefined(obj: any): any {
  if (obj === undefined) return undefined;
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Calculates the checksum of an individual aspect using ohash for stable serialization.
 */
export function calculateAspectChecksum(aspectData: any): string {
  return hash(stripUndefined(aspectData));
}

/**
 * Calculates the unified entry-level checksum of an Entry by combining the hashes
 * of its core fields and individual aspect checksums.
 */
export function calculateEntryChecksum(entry: Entry): string {
  const coreData: Record<string, any> = {
    name: entry.name,
    type: entry.type,
  };
  if (entry.resource !== undefined) {
    coreData.resource = entry.resource;
  }

  const aspectChecksums: Record<string, string> = {};
  if (entry.aspects) {
    for (const [key, value] of Object.entries(entry.aspects)) {
      aspectChecksums[key] = calculateAspectChecksum(value);
    }
  }

  const unifiedData = {
    core: hash(stripUndefined(coreData)),
    aspects: aspectChecksums,
  };

  return hash(unifiedData);
}
