# Security Policy

## Reporting a vulnerability

Report vulnerabilities privately through [Sevenflanks/kangentic](https://github.com/Sevenflanks/kangentic):

- Use GitHub's private vulnerability reporting when it is enabled for the repository.
- Otherwise, use the repository's **Security Advisories** / **Report a vulnerability** flow.

Do not open a public GitHub issue for a security problem. Include whatever you have:

- What the issue is and its potential impact
- Steps to reproduce or a proof of concept
- The source revision or local installer version and your OS
- Relevant logs, with file paths, project names, and other personal information stripped out

## Scope

This policy covers the code in the source-built fork and its locally built, unsigned Windows
installer, including the desktop app, Electron main/preload/renderer processes, local MCP server,
mobile bridge, and pairing flow.

Only the source-built fork and its local unsigned Windows installer are covered by this policy.
Upstream products and services outside this repository are outside this policy.

## Out of scope

- **Code execution through the product's own purpose.** Kangentic runs agent CLIs, shell commands,
  and column auto-commands on your machine by design. A configured command running is the product
  working, not a vulnerability.
- Findings in third-party agent CLIs such as Claude Code, Codex, Gemini, or OpenCode. Report those
  to their maintainers.
- Dependency advisories with no reachable path in Kangentic, and hardening suggestions with no
  demonstrated impact.

## Disclosure

Please allow a reasonable opportunity for private investigation and remediation before publishing
vulnerability details. Do not include secrets, credentials, private keys, or personal data in a
report.
