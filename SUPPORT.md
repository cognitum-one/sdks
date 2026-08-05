# Support

## Where to ask

- Installation, API behavior, compatibility, and defects: [GitHub issues](https://github.com/cognitum-one/sdks/issues)
- Security vulnerabilities: follow [SECURITY.md](SECURITY.md), never a public issue.
- Cognitum platform and product information: [cognitum.one](https://cognitum.one)

This repository tracks SDK source and package behavior. Service availability, accounts, billing, and deployed API incidents may belong to another Cognitum service repository; maintainers will route a well-formed issue when necessary.

## Include in a support request

- SDK language, package name, exact version, and install source;
- runtime, operating system, architecture, and module system or Rust features;
- affected Cognitum product and endpoint;
- minimal synthetic reproduction;
- expected and observed result, including sanitized error metadata;
- whether the problem reproduces against source, a packed candidate, a public registry artifact, staging, or production.

Remove secrets, authorization headers, customer content, tenant identifiers, signed URLs, and private device details.

## Compatibility and release state

The source version can be ahead of public registries. The root README names both states, and `capabilities/sdk-release.v1.json` is authoritative for operation maturity. A package version does not promote preview or blocked operations.

The latest published release receives fixes. Pre-1.0 releases follow Semantic Versioning, but a minor version may contain documented public API changes.
