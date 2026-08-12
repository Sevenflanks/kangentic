import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildMeasurementEnv } from '../../scripts/lib/measure-injection-flush-env.mjs';

describe('measure-injection-flush offline mode', () => {
  it('removes inherited provider, cloud, and proxy credentials while preserving process essentials', () => {
    const parentEnv = {
      PATH: '/toolchain',
      HOME: '/home/tester',
      USERPROFILE: 'C:\\Users\\tester',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      LANG: 'en_US.UTF-8',
      NON_SECRET_MARKER: 'preserved',
      CLAUDECODE: 'parent-session',
      CLAUDE_CODE_SESSION_ID: 'parent-session',
      ANTHROPIC_API_KEY: 'anthropic-credential',
      OPENAI_API_KEY: 'openai-credential',
      FACTORY_API_KEY: 'factory-credential',
      GITHUB_TOKEN: 'github-credential',
      AWS_ACCESS_KEY_ID: 'aws-access-key',
      AWS_SECRET_ACCESS_KEY: 'aws-secret-key',
      AWS_SESSION_TOKEN: 'aws-session-token',
      AZURE_CLIENT_SECRET: 'azure-client-secret',
      GOOGLE_APPLICATION_CREDENTIALS: 'C:\\credentials.json',
      HTTP_PROXY: 'http://network.example.test:8080',
      http_proxy: 'http://network.example.test:8081',
      HtTp_PrOxY: 'http://network.example.test:8082',
      HTTPS_PROXY: 'http://network.example.test:8443',
      https_proxy: 'http://network.example.test:8444',
      ALL_PROXY: 'socks5://network.example.test:1080',
      all_proxy: 'socks5://network.example.test:1081',
      NO_PROXY: 'localhost,127.0.0.1',
      no_proxy: 'localhost',
    };

    const environment = buildMeasurementEnv(parentEnv, { offline: true });

    expect(environment).toMatchObject({
      PATH: '/toolchain',
      HOME: '/home/tester',
      USERPROFILE: 'C:\\Users\\tester',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      LANG: 'en_US.UTF-8',
      NON_SECRET_MARKER: 'preserved',
      HTTP_PROXY: 'http://127.0.0.1:9',
      http_proxy: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      https_proxy: 'http://127.0.0.1:9',
      ALL_PROXY: '',
      all_proxy: '',
      NO_PROXY: '',
      no_proxy: '',
    });

    expect(Object.keys(environment)).not.toEqual(expect.arrayContaining([
      'CLAUDECODE',
      'CLAUDE_CODE_SESSION_ID',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'FACTORY_API_KEY',
      'GITHUB_TOKEN',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AZURE_CLIENT_SECRET',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'HtTp_PrOxY',
    ]));
  });

  it('marks offline reports as best-effort and ineligible for a live PASS', () => {
    const outputDirectory = mkdtempSync(path.join(tmpdir(), 'kng-flush-offline-test-'));
    const reportPath = path.join(outputDirectory, 'report.json');

    try {
      const result = spawnSync(
        process.execPath,
        [
          'scripts/measure-injection-flush.mjs',
          '--agent',
          'not-a-real-agent',
          '--offline',
          '--out',
          reportPath,
        ],
        { cwd: process.cwd(), encoding: 'utf8' },
      );

      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toMatchObject({
        offline: true,
        networkIsolation: 'best-effort-env',
        livePassEligible: false,
        agents: [{
          agent: 'not-a-real-agent',
          networkIsolation: 'best-effort-env',
          livePassEligible: false,
        }],
      });
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });
});
