# Security policy

## Supported versions

Only the latest minor release gets security fixes.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

## Report a vulnerability

Please do not report a security problem in a public issue, pull request or discussion.

Report it privately, in one of two ways:

- **GitHub private vulnerability reporting** (preferred):
  [open a draft advisory](https://github.com/reuvenaor/agent-sdk-watchdog/security/advisories/new).
- **Email** info@reuvenaor.com, with `agent-sdk-watchdog security` in the subject.

Please include:

- the package version, and your Node and SDK versions;
- what the problem is and what an attacker can do with it;
- the steps to reproduce it, or a proof of concept.

## What happens next

1. You get a first answer within 7 days.
2. We confirm the problem and agree with you on a fix and a disclosure date.
3. We release the fix and publish a GitHub Security Advisory at the same time, with a CVE when
   the problem needs one. We credit you in the advisory, unless you ask us not to.

This is coordinated disclosure: please keep the details private until the advisory is out, or
for 90 days after your report, whichever comes first.

## Scope

In scope: the code in this repository and the package published to npm as `agent-sdk-watchdog`.

Out of scope: problems in the Claude Agent SDK, the Claude Code CLI or the Anthropic API.
Report those to Anthropic, as the security policies of their repositories describe.
