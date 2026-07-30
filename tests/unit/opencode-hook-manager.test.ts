import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { buildHooks, removeHooks } from '../../src/main/agent/adapters/opencode';

let projectDir: string;

function pluginPath(directory = projectDir): string {
  return path.join(directory, '.opencode', 'plugins', 'kangentic-activity.js');
}

function sourcePluginPath(): string {
  return path.join(
    process.cwd(),
    'src',
    'main',
    'agent',
    'adapters',
    'opencode',
    'plugin',
    'kangentic-activity.mjs',
  );
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-hookman-'));
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe('opencode-hook-manager', () => {
  describe('buildHooks', () => {
    it('installs only the discoverable .js entry into .opencode/plugins/', () => {
      buildHooks(projectDir);

      expect(fs.existsSync(pluginPath())).toBe(true);
      expect(fs.existsSync(path.join(projectDir, '.opencode', 'plugins', 'kangentic-activity.mjs'))).toBe(false);
    });

    it('plugin file starts with the kangentic-activity sentinel', () => {
      buildHooks(projectDir);

      const contents = fs.readFileSync(pluginPath(), 'utf-8');
      const firstLine = contents.split('\n', 1)[0];
      expect(firstLine).toContain('kangentic-activity');
    });

    it('plugin source matches the resolved source file byte-for-byte', () => {
      buildHooks(projectDir);

      const sourceBytes = fs.readFileSync(sourcePluginPath());
      const installedBytes = fs.readFileSync(pluginPath());
      expect(installedBytes.equals(sourceBytes)).toBe(true);
    });

    it('is idempotent on repeated calls', () => {
      const copyFileSpy = vi.spyOn(fs, 'copyFileSync');
      try {
        buildHooks(projectDir);
        const firstMtime = fs.statSync(pluginPath()).mtimeMs;
        const firstContents = fs.readFileSync(pluginPath());
        expect(copyFileSpy).toHaveBeenCalledOnce();
        copyFileSpy.mockClear();

        buildHooks(projectDir);
        const secondMtime = fs.statSync(pluginPath()).mtimeMs;
        const secondContents = fs.readFileSync(pluginPath());

        expect(copyFileSpy).not.toHaveBeenCalled();
        expect(secondContents.equals(firstContents)).toBe(true);
        expect(secondMtime).toBe(firstMtime);
      } finally {
        copyFileSpy.mockRestore();
      }
    });

    it('overwrites a stale plugin file with different contents', () => {
      const targetDir = path.dirname(pluginPath());
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(pluginPath(), '// kangentic-activity\n// outdated stub\n');

      buildHooks(projectDir);

      const contents = fs.readFileSync(pluginPath(), 'utf-8');
      expect(contents).not.toContain('outdated stub');
      expect(contents).toContain('export const KangenticActivity');
      expect(fs.readFileSync(pluginPath()).equals(fs.readFileSync(sourcePluginPath()))).toBe(true);
    });

    it('fails without recreating a missing cwd', () => {
      const missingCwd = path.join(projectDir, 'missing-cwd');

      expect(() => buildHooks(missingCwd)).toThrow();
      expect(fs.existsSync(missingCwd)).toBe(false);
    });

    it('fails without changing a file-valued cwd', () => {
      const fileCwd = path.join(projectDir, 'cwd-file');
      const originalBytes = Buffer.from('foreign cwd bytes');
      fs.writeFileSync(fileCwd, originalBytes);

      expect(() => buildHooks(fileCwd)).toThrow();
      expect(fs.statSync(fileCwd).isFile()).toBe(true);
      expect(fs.readFileSync(fileCwd).equals(originalBytes)).toBe(true);
    });

    it('creates only the .opencode and plugins children non-recursively', () => {
      const mkdirSpy = vi.spyOn(fs, 'mkdirSync');

      try {
        buildHooks(projectDir);
        expect(mkdirSpy.mock.calls).toEqual([
          [path.join(projectDir, '.opencode')],
          [path.join(projectDir, '.opencode', 'plugins')],
        ]);
      } finally {
        mkdirSpy.mockRestore();
      }
    });

    it.each([
      ['.opencode', path.join('.opencode')],
      ['plugins', path.join('.opencode', 'plugins')],
    ])('accepts EEXIST only when the %s child is a directory', (_caseName, childPath) => {
      const conflictPath = path.join(projectDir, childPath);
      const parent = path.dirname(conflictPath);
      if (parent !== projectDir) fs.mkdirSync(parent);
      const originalBytes = Buffer.from('foreign child bytes');
      fs.writeFileSync(conflictPath, originalBytes);

      expect(() => buildHooks(projectDir)).toThrow();
      expect(fs.statSync(conflictPath).isFile()).toBe(true);
      expect(fs.readFileSync(conflictPath).equals(originalBytes)).toBe(true);
    });

    it('fails without recreating cwd when it disappears before child creation', () => {
      const cwd = path.join(projectDir, 'vanishing-cwd');
      fs.mkdirSync(cwd);
      const mkdirSync = fs.mkdirSync.bind(fs);
      let removed = false;
      const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation((target, options) => {
        if (!removed) {
          removed = true;
          fs.rmSync(cwd, { recursive: true, force: true });
        }
        return mkdirSync(target, options);
      });

      try {
        expect(() => buildHooks(cwd)).toThrow();
        expect(fs.existsSync(cwd)).toBe(false);
      } finally {
        mkdirSpy.mockRestore();
      }
    });

    it('fails without changing a foreign destination file', () => {
      const targetDir = path.dirname(pluginPath());
      const foreignBytes = Buffer.from('// foreign plugin\nexport default {};\n');
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(pluginPath(), foreignBytes);

      expect(() => buildHooks(projectDir)).toThrow();
      expect(fs.readFileSync(pluginPath()).equals(foreignBytes)).toBe(true);
    });

    it('propagates an unreadable destination without changing its bytes', () => {
      const targetDir = path.dirname(pluginPath());
      const foreignBytes = Buffer.from('// foreign unreadable plugin\n');
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(pluginPath(), foreignBytes);
      const readError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      const sourceBytes = fs.readFileSync(sourcePluginPath());
      const readSpy = vi.spyOn(fs, 'readFileSync')
        .mockReturnValueOnce(sourceBytes)
        .mockImplementationOnce(() => {
          throw readError;
        });

      try {
        expect(() => buildHooks(projectDir)).toThrow(readError);
      } finally {
        readSpy.mockRestore();
      }
      expect(fs.readFileSync(pluginPath()).equals(foreignBytes)).toBe(true);
    });

    it('throws when the packaged plugin source is missing', () => {
      const existsSync = fs.existsSync.bind(fs);
      const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((file) => (
        String(file).endsWith('kangentic-activity.mjs') ? false : existsSync(file)
      ));

      try {
        expect(() => buildHooks(projectDir)).toThrow('Required OpenCode plugin source not found');
      } finally {
        existsSpy.mockRestore();
      }
    });

    it('propagates plugin directory creation failures', () => {
      const mkdirError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementationOnce(() => {
        throw mkdirError;
      });

      try {
        expect(() => buildHooks(projectDir)).toThrow(mkdirError);
      } finally {
        mkdirSpy.mockRestore();
      }
    });
  });

  describe('removeHooks', () => {
    it('removes the kangentic plugin file', () => {
      buildHooks(projectDir);
      expect(fs.existsSync(pluginPath())).toBe(true);

      removeHooks(projectDir);

      expect(fs.existsSync(pluginPath())).toBe(false);
    });

    it('cleans up empty .opencode/plugins/ and .opencode/ directories', () => {
      buildHooks(projectDir);

      removeHooks(projectDir);

      expect(fs.existsSync(path.join(projectDir, '.opencode', 'plugins'))).toBe(false);
      expect(fs.existsSync(path.join(projectDir, '.opencode'))).toBe(false);
    });

    it('preserves user-authored plugins in the same directory', () => {
      buildHooks(projectDir);
      const userPluginPath = path.join(
        projectDir,
        '.opencode',
        'plugins',
        'user-plugin.mjs',
      );
      fs.writeFileSync(userPluginPath, '// user plugin\nexport default {};\n');

      removeHooks(projectDir);

      expect(fs.existsSync(pluginPath())).toBe(false);
      expect(fs.existsSync(userPluginPath)).toBe(true);
      // Directory must remain because it still contains the user plugin.
      expect(fs.existsSync(path.join(projectDir, '.opencode', 'plugins'))).toBe(true);
    });

    it('does not touch a file at our path that lacks the sentinel', () => {
      const targetDir = path.dirname(pluginPath());
      fs.mkdirSync(targetDir, { recursive: true });
      const foreignContents = '// not ours\nexport default {};\n';
      fs.writeFileSync(pluginPath(), foreignContents);

      removeHooks(projectDir);

      expect(fs.existsSync(pluginPath())).toBe(true);
      expect(fs.readFileSync(pluginPath(), 'utf-8')).toBe(foreignContents);
    });

    it('handles missing project gracefully', () => {
      expect(() => removeHooks(projectDir)).not.toThrow();
    });
  });

  describe('buildHooks gitignore behavior', () => {
    const PLUGIN_GITIGNORE_ENTRY = '.opencode/plugins/kangentic-activity.js';

    function gitignorePath(): string {
      return path.join(projectDir, '.gitignore');
    }

    function readGitignore(): string {
      return fs.readFileSync(gitignorePath(), 'utf-8');
    }

    function initGitRepo(): void {
      execSync(`git -C "${projectDir}" init -b main`, {
        stdio: 'ignore',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        },
      });
    }

    it('adds the plugin entry to .gitignore after a successful install', () => {
      initGitRepo();
      buildHooks(projectDir);

      expect(fs.existsSync(gitignorePath())).toBe(true);
      expect(readGitignore()).toContain(PLUGIN_GITIGNORE_ENTRY);
    });

    it('is idempotent on repeated calls (no duplicate entry)', () => {
      initGitRepo();
      buildHooks(projectDir);
      buildHooks(projectDir);
      buildHooks(projectDir);

      const occurrences = readGitignore()
        .split('\n')
        .filter((line) => line.trim() === PLUGIN_GITIGNORE_ENTRY);
      expect(occurrences).toHaveLength(1);
    });

    it('does not touch .gitignore when the directory is not a git repo', () => {
      // projectDir has no .git directory.
      buildHooks(projectDir);

      // The plugin must still install...
      expect(fs.existsSync(path.join(projectDir, '.opencode', 'plugins', 'kangentic-activity.js'))).toBe(true);
      // ...but no .gitignore must be created.
      expect(fs.existsSync(gitignorePath())).toBe(false);
    });

    it('preserves pre-existing user content in .gitignore', () => {
      initGitRepo();
      const userContent = 'node_modules/\ndist/\n*.log\n';
      fs.writeFileSync(gitignorePath(), userContent);

      buildHooks(projectDir);

      const content = readGitignore();
      expect(content).toContain('node_modules/');
      expect(content).toContain('dist/');
      expect(content).toContain('*.log');
      expect(content).toContain(PLUGIN_GITIGNORE_ENTRY);
    });

    it('does not duplicate the entry if it is already present without a trailing newline', () => {
      initGitRepo();
      // No trailing newline - the helper must still detect the existing line.
      fs.writeFileSync(gitignorePath(), `node_modules/\n${PLUGIN_GITIGNORE_ENTRY}`);

      buildHooks(projectDir);

      const occurrences = readGitignore()
        .split('\n')
        .filter((line) => line.trim() === PLUGIN_GITIGNORE_ENTRY);
      expect(occurrences).toHaveLength(1);
    });

    it.each(['readFileSync', 'writeFileSync'] as const)(
      'keeps successful plugin installation when .gitignore %s fails',
      (operation) => {
        initGitRepo();
        const gitignoreError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const fsSpy = operation === 'readFileSync'
          ? vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
              throw gitignoreError;
            })
          : vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
              throw gitignoreError;
            });

        try {
          expect(() => buildHooks(projectDir)).not.toThrow();
          expect(fs.existsSync(pluginPath())).toBe(true);
        } finally {
          fsSpy.mockRestore();
          warnSpy.mockRestore();
        }
      },
    );

    it('propagates copyFileSync failure without writing a .gitignore entry', () => {
      // This test protects the ordering invariant that is the heart of the
      // "stop appending opencode" fix: ensurePluginGitignored is only called
      // when fs.existsSync(destinationFile) is true AFTER the copy attempt.
      // If the copy fails the file does not exist, existsSync returns false,
      // and the gitignore entry must never be written - otherwise we would
      // add an entry pointing to a non-existent file.
      initGitRepo();

      const copyError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      const copyFileSpy = vi.spyOn(fs, 'copyFileSync').mockImplementationOnce(() => {
        throw copyError;
      });

      try {
        expect(() => buildHooks(projectDir)).toThrow(copyError);
      } finally {
        copyFileSpy.mockRestore();
      }

      // The plugin file must not exist because the copy threw.
      expect(fs.existsSync(pluginPath())).toBe(false);
      // The gitignore entry must not have been written.
      expect(fs.existsSync(gitignorePath())).toBe(false);
    });
  });
});
