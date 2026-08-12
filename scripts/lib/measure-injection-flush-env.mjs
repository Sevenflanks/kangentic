const CHILD_IDENTITY_PATTERN = /^(CLAUDECODE|CLAUDE_CODE_)/i;
const CREDENTIAL_PATTERN = /(API_KEY|API_TOKEN|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|_TOKEN$|_SECRET$|_CREDENTIALS$|^(OPENAI|ANTHROPIC|GEMINI|GOOGLE|GCP|CLOUDSDK|MOONSHOT|DASHSCOPE|AWS|AZURE|GITHUB|FACTORY|CURSOR|COPILOT|QWEN|KIMI|DROID|OLLAMA)_)/i;
const PROXY_PATTERN = /^(HTTP|HTTPS|ALL|NO)_PROXY$/i;

const OFFLINE_PROXY_ENV = {
  HTTP_PROXY: 'http://127.0.0.1:9',
  http_proxy: 'http://127.0.0.1:9',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  https_proxy: 'http://127.0.0.1:9',
  ALL_PROXY: '',
  all_proxy: '',
  NO_PROXY: '',
  no_proxy: '',
};

/**
 * Builds the manual injection-flush harness child environment. Offline mode
 * hardens inherited environment only, not OS networking or CLI config files.
 */
export function buildMeasurementEnv(parentEnv, { offline }) {
  const environment = {};

  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined || CHILD_IDENTITY_PATTERN.test(key)) continue;
    if (offline && (CREDENTIAL_PATTERN.test(key) || PROXY_PATTERN.test(key))) continue;
    environment[key] = value;
  }

  return offline ? { ...environment, ...OFFLINE_PROXY_ENV } : environment;
}
