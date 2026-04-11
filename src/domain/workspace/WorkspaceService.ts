import path from 'path';
import { readdir, stat, readFile, rm } from 'fs/promises';
import { logger } from '../../logger.js';

export class WorkspaceService {
  constructor(private dataDir: string) {}

  async getFileTree(agentId: string, dirPath?: string): Promise<any[]> {
    const agentDir = path.join(this.dataDir, agentId);
    try {
      await stat(agentDir);
    } catch {
      return [];
    }
    let targetDir = agentDir;
    if (dirPath) {
      const resolved = path.resolve(agentDir, dirPath);
      if (!resolved.startsWith(agentDir + path.sep) && resolved !== agentDir) {
        return [];
      }
      targetDir = resolved;
    }
    return this.listDirectoryChildren(targetDir, agentDir);
  }

  async readFile(agentId: string, filePath: string): Promise<{ content: string | null; binary: boolean }> {
    const agentDir = path.join(this.dataDir, agentId);
    const resolved = path.resolve(agentDir, filePath);
    if (!resolved.startsWith(agentDir + path.sep) && resolved !== agentDir) {
      throw new Error('Access denied');
    }
    const info = await stat(resolved);
    if (info.isDirectory()) throw new Error('Cannot read a directory');

    const TEXT_EXTENSIONS = new Set([
      '.md', '.txt', '.json', '.js', '.ts', '.jsx', '.tsx',
      '.yaml', '.yml', '.toml', '.log', '.csv', '.xml',
      '.html', '.css', '.sh', '.py',
    ]);
    const ext = path.extname(resolved).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext) && ext !== '') {
      return { content: null, binary: true };
    }
    if (info.size > 1048576) throw new Error('File too large');
    const content = await readFile(resolved, 'utf-8');
    return { content, binary: false };
  }

  async scanAllWorkspaces(): Promise<Array<{ directoryName: string; totalSizeBytes: number; lastModified: string; fileCount: number }>> {
    const results: Array<{ directoryName: string; totalSizeBytes: number; lastModified: string; fileCount: number }> = [];
    let entries: import('fs').Dirent[];
    try {
      entries = await readdir(this.dataDir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(this.dataDir, entry.name);
      try {
        const dirContents = await readdir(dirPath, { withFileTypes: true });
        let totalSize = 0;
        let latestMtime = new Date(0);
        let fileCount = 0;
        for (const item of dirContents) {
          const itemPath = path.join(dirPath, item.name);
          try {
            const info = await stat(itemPath);
            if (item.isFile()) {
              totalSize += info.size;
              fileCount++;
            }
            if (info.mtime > latestMtime) {
              latestMtime = info.mtime;
            }
          } catch {
            continue;
          }
        }
        results.push({
          directoryName: entry.name,
          totalSizeBytes: totalSize,
          lastModified: latestMtime.toISOString(),
          fileCount,
        });
      } catch {
        continue;
      }
    }
    return results;
  }

  async deleteWorkspaceDirectory(directoryName: string): Promise<boolean> {
    if (directoryName.includes('/') || directoryName.includes('..') || directoryName.includes('\\')) {
      return false;
    }
    const targetDir = path.join(this.dataDir, directoryName);
    try {
      await rm(targetDir, { recursive: true, force: true });
      logger.info(`[Workspace] Deleted directory: ${targetDir}`);
      return true;
    } catch (err) {
      logger.error(`[Workspace] Failed to delete directory ${targetDir}`, err);
      return false;
    }
  }

  async listDirectoryChildren(dir: string, rootDir: string): Promise<any[]> {
    let entries: import('fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });
    const nodes: any[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(rootDir, fullPath);
      let info: import('fs').Stats;
      try {
        info = await stat(fullPath);
      } catch {
        continue;
      }
      if (entry.isDirectory()) {
        nodes.push({ name: entry.name, path: relativePath, isDirectory: true, size: 0, modifiedAt: info.mtime.toISOString() });
      } else {
        nodes.push({ name: entry.name, path: relativePath, isDirectory: false, size: info.size, modifiedAt: info.mtime.toISOString() });
      }
    }
    return nodes;
  }
}
