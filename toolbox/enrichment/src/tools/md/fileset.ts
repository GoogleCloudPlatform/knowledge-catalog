// Markdown fileset collection implementation
//

import * as fs from 'fs';
import * as path from 'path';

export interface SearchResult {
  file: string;
  line: number;
  content: string;
}

export class MarkdownFileset {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    if (!fs.existsSync(this.root) || !fs.statSync(this.root).isDirectory()) {
      throw new Error(`Root directory "${root}" does not exist or is not a directory.`);
    }
  }

  private safePath(relativePath: string): string {
    const fullPath = path.resolve(this.root, relativePath.replace(/^\/+/, ''));

    const isInside = fullPath === this.root || fullPath.startsWith(this.root + path.sep);
    if (!isInside) {
      throw new Error(`Access denied: Path "${relativePath}" is invalid.`);
    }
    return fullPath;
  }

  async listContents(relativePath: string = ''): Promise<string> {
    const targetDir = this.safePath(relativePath);
    if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
      return `Path not found or is not a directory: ${relativePath}`;
    }

    const items = await fs.promises.readdir(targetDir);
    const lines: string[] = [];
    for (const name of items) {
      const fullPath = path.join(targetDir, name);
      const stat = await fs.promises.stat(fullPath);
      const itemType = stat.isDirectory() ? 'directory' : 'file';
      const itemPath = path.relative(this.root, fullPath);
      lines.push(`${name} | ${itemPath} | ${itemType}`);
    }
    return lines.join('\n');
  }

  async readFile(relativePath: string): Promise<string> {
    const targetFile = this.safePath(relativePath);
    if (!fs.existsSync(targetFile) || !fs.statSync(targetFile).isFile()) {
      return `Path not found or is not a file: ${relativePath}`;
    }
    return await fs.promises.readFile(targetFile, 'utf-8');
  }

  private async getMarkdownFiles(dir: string): Promise<string[]> {
    const files: string[] = [];
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const subFiles = await this.getMarkdownFiles(fullPath);
        files.push(...subFiles);
      }
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(fullPath);
      }
    }
    return files;
  }

  async searchContents(query: string, relativePath: string = ''): Promise<SearchResult[] | string> {
    const targetPath = this.safePath(relativePath);
    if (!fs.existsSync(targetPath)) {
      return `Path not found: ${relativePath}`;
    }

    let regex: RegExp;
    try {
      regex = new RegExp(query, 'i');
    }
    catch (error: any) {
      return `Invalid query: ${error.message}`;
    }

    const filesToSearch: string[] = [];
    const stat = await fs.promises.stat(targetPath);
    if (stat.isFile()) {
      if (targetPath.endsWith('.md')) {
        filesToSearch.push(targetPath);
      }
    }
    else if (stat.isDirectory()) {
      const walkFiles = await this.getMarkdownFiles(targetPath);
      filesToSearch.push(...walkFiles);
    }

    const results: SearchResult[] = [];

    for (const file of filesToSearch) {
      try {
        const content = await fs.promises.readFile(file, 'utf-8');
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (regex.test(line)) {
            results.push({
              file: path.relative(this.root, file),
              line: i + 1,
              content: line.trim()
            });
          }
        }
      }
      catch {
        continue;
      }
    }

    return results;
  }
}
