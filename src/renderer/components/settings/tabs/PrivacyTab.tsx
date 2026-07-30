import { ShieldAlert } from 'lucide-react';
import { Pill } from '../../Pill';
import { SectionHeader } from '../shared';

const FORK_DISCUSSIONS_URL = 'https://github.com/Sevenflanks/kangentic/discussions';
const FORK_ISSUES_URL = 'https://github.com/Sevenflanks/kangentic/issues';

export function PrivacyTab() {
  return (
    <div className="space-y-4">
      <Pill as="div" size="lg" className="bg-surface-hover">
        <ShieldAlert className="size-5 text-fg-muted shrink-0" />
        <span className="text-[1em] text-fg-secondary">Anonymous analytics only. No personal data collected.</span>
      </Pill>

      <SectionHeader label="What We Collect" />
      <ul className="list-disc list-inside text-sm text-fg-muted space-y-1 ml-1">
        <li>App launches, platform, and architecture</li>
        <li>App crashes and errors (sanitized, no file paths)</li>
        <li>Task and project creation counts</li>
        <li>Agent session starts, exit codes, and duration</li>
      </ul>

      <SectionHeader label="What We Don't Collect" />
      <ul className="list-disc list-inside text-sm text-fg-muted space-y-1 ml-1">
        <li>Task titles, descriptions, or any user-generated content</li>
        <li>File paths, project names, or code</li>
        <li>Usernames, emails, or any personally identifiable information</li>
      </ul>

      <SectionHeader label="How It Works" />
      <p className="text-sm text-fg-muted leading-relaxed">
        Analytics are powered by Aptabase, a privacy-first platform.
        No cookies or persistent identifiers. IP addresses are used
        for geographic lookup only, then discarded. GDPR-compliant by design.
      </p>

      <SectionHeader label="Conversation Search" />
      <p className="text-sm text-fg-muted leading-relaxed">
        Local conversation indexing and semantic search settings live in the{' '}
        <span className="text-fg-secondary">Memory</span> tab. All of it runs on your device with no
        API key; nothing leaves your machine.
      </p>

      <SectionHeader label="How to Opt Out" />
      <p className="text-sm text-fg-muted leading-relaxed">
        Set <code className="font-mono">KANGENTIC_TELEMETRY=0</code> as an environment variable to disable analytics.
      </p>

      <SectionHeader label="Questions" />
      <p className="text-sm text-fg-muted leading-relaxed">
        Ask questions in{' '}
        <button
          type="button"
          data-testid="privacy-contact-discussions"
          onClick={() => void window.electronAPI.shell.openExternal(FORK_DISCUSSIONS_URL)}
          className="text-fg-secondary underline underline-offset-2 hover:text-fg transition-colors cursor-pointer"
        >
          GitHub Discussions
        </button>
        {' '}or report a bug in{' '}
        <button
          type="button"
          data-testid="privacy-contact-issues"
          onClick={() => void window.electronAPI.shell.openExternal(FORK_ISSUES_URL)}
          className="text-fg-secondary underline underline-offset-2 hover:text-fg transition-colors cursor-pointer"
        >
          GitHub Issues
        </button>
        .
      </p>
    </div>
  );
}
