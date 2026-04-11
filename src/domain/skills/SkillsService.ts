import path from 'path';
import os from 'os';
import { readdir, readFile } from 'fs/promises';

export class SkillsService {
  static SKILL_PATHS: Record<string, { global: string[]; workspace: string[] }> = {
    claude: {
      global: ['.claude/skills', '.claude/commands'],
      workspace: ['.claude/skills', '.claude/commands'],
    },
    codex: {
      global: ['.codex/skills', '.codex/skills/.system', '.agents/skills'],
      workspace: ['.codex/skills', '.agents/skills'],
    },
  };

  constructor(private dataDir: string) {}

  async listSkills(agentId: string, runtimeHint?: string, agentRuntime?: string): Promise<{ global: any[]; workspace: any[] }> {
    const runtime = runtimeHint || agentRuntime || 'claude';
    const home = os.homedir();
    const workspaceDir = path.join(this.dataDir, agentId);
    const paths = SkillsService.SKILL_PATHS[runtime] || SkillsService.SKILL_PATHS.claude;

    const globalResults = await Promise.all(
      paths.global.map((p) => this.scanSkillsDir(path.join(home, p))),
    );
    const workspaceResults = await Promise.all(
      paths.workspace.map((p) => this.scanSkillsDir(path.join(workspaceDir, p))),
    );

    const dedup = (skills: any[]) => {
      const seen = new Set<string>();
      return skills.filter((s) => {
        if (seen.has(s.name)) return false;
        seen.add(s.name);
        return true;
      });
    };
    const shorten = (skills: any[]) =>
      skills.map((s) => ({
        ...s,
        sourcePath: s.sourcePath?.startsWith(home) ? '~' + s.sourcePath.slice(home.length) : s.sourcePath,
      }));

    return {
      global: shorten(dedup(globalResults.flat())),
      workspace: shorten(dedup(workspaceResults.flat())),
    };
  }

  async scanSkillsDir(dir: string): Promise<any[]> {
    let entries: import('fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const skills: any[] = [];
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        const skillMd = path.join(dir, entry.name, 'SKILL.md');
        try {
          const content = await readFile(skillMd, 'utf-8');
          const skill = this.parseSkillMd(entry.name, content);
          skill.sourcePath = dir;
          skills.push(skill);
        } catch {
          // ignore
        }
      } else if (entry.name.endsWith('.md')) {
        const cmdName = entry.name.replace(/\.md$/, '');
        try {
          const content = await readFile(path.join(dir, entry.name), 'utf-8');
          const skill = this.parseSkillMd(cmdName, content);
          skill.sourcePath = dir;
          skills.push(skill);
        } catch {
          // ignore
        }
      }
    }
    return skills;
  }

  parseSkillMd(dirName: string, content: string): any {
    const info: any = {
      name: dirName,
      displayName: dirName,
      description: '',
      userInvocable: false,
    };
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return info;
    const frontmatter = match[1];
    for (const line of frontmatter.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      if (key === 'name') info.displayName = value;
      if (key === 'description') info.description = value;
      if (key === 'user-invocable') info.userInvocable = value === 'true';
    }
    return info;
  }
}
