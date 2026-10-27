// One-by-one batch writes, for layouts that keep each entry in its own file.
//

import { CatalogLayout } from '../layout';
import * as md from '../metadata';


// Saves each entry with saveEntry, in order, and reports one result per entry.
// A failed entry is reported and the others are still saved.
export async function saveEachEntry(
    layout: CatalogLayout, entries: md.Entry[]): Promise<md.EntryResult[]> {
  const results: md.EntryResult[] = [];
  for (const entry of entries) {
    try {
      await layout.saveEntry(entry.name, entry);
      results.push({name: entry.name, ok: true});
    } catch (err: any) {
      results.push({name: entry.name, ok: false, error: messageOf(err)});
    }
  }
  return results;
}


// Deletes each named entry with deleteEntry, in order, and reports one result
// per name. A failed deletion is reported and the others still happen.
export async function deleteEachEntry(
    layout: CatalogLayout, names: string[]): Promise<md.EntryResult[]> {
  const results: md.EntryResult[] = [];
  for (const name of names) {
    try {
      await layout.deleteEntry(name);
      results.push({name, ok: true});
    } catch (err: any) {
      results.push({name, ok: false, error: messageOf(err)});
    }
  }
  return results;
}


export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
