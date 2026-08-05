# Security Policy

## Supported versions

Security fixes are provided for the latest version published to each registry. During a coordinated release, registry versions can briefly differ; consult the root README and capability manifest rather than assuming the source version is already published.

| Version | Support |
|---|---|
| 0.3.x | Supported until 0.4.0 is verified on all applicable registries |
| 0.2.x and earlier | Unsupported |
| Unreleased source | Best effort; not a published compatibility promise |

## Reporting a vulnerability

Do not report vulnerabilities in a public issue, discussion, pull request, or chat channel.

Use GitHub's **Report a vulnerability** form under the repository Security tab. Do not report vulnerabilities in public issues, discussions, pull requests, or chat channels.

Include the affected package/version/environment, the smallest safe reproduction, expected and observed behavior, security impact and trust boundary, and whether credentials, tenants, billing, signing, or production services are involved.

Do not include live secrets, customer data, private keys, or unnecessary production identifiers. Use synthetic values and privacy-conscious identifiers.

Maintainers will acknowledge a complete report within three business days, triage severity and affected versions, coordinate a fix and advisory privately, and publish remediation evidence when disclosure is safe.

## Security expectations

- Credentials are never committed or placed in examples.
- Authentication, tenant attribution, consent, billing, and redaction fail closed.
- Release artifacts are built once, tested in clean environments, digest-bound, and published through protected workflows.
- A green source test suite is not proof that a registry artifact or deployed service works; published-artifact and live-seam checks are separate gates.
- Secret-scan exceptions must match an exact synthetic fixture in `.gitleaks.toml`; path-wide or provider-prefix exceptions are not accepted.
