# ADR 0018: SD-Card Flashing Tool for Cognitum Seed Images

- **Status:** Accepted
- **Date:** 2026-04-23
- **Deciders:** SDK WG + fleet / seed-appliance team
- **Scope:** cross-cutting — new tool; thin SDK helpers; no changes to
  core SDK HTTP surface

## Context

The seed-image release workflow (documented in the project `CLAUDE.md`
under **Cognitum Seed Release Build Process**) requires an operator to
flash a `.img.gz` to a 16 GB micro-SD card before every seed commission
or re-image. Today this is done manually with `dd` + `gunzip`, or with a
third-party tool like Raspberry Pi Imager. Both paths carry known foot-
guns the project has already hit (see the long list of "DO NOT" notes in
`CLAUDE.md:"Build SD Card Image — CORRECT APPROACH"`):

- Docker image patching corrupts networking.
- `debugfs` writes produce corrupt inodes on macOS.
- `create-release-image.sh` sanitisation breaks the seed.
- 64 GB cards fail capture; 16 GB is the proven target.
- Writing the wrong `/dev/disk*` node silently wipes the host filesystem.
- The SHA256 step is optional in manual flows and frequently skipped.

A named tool that codifies the proven workflow — picks the right image,
verifies the SHA256, refuses to target a non-removable disk, and reports
bytes written vs expected — would remove every one of these foot-guns
from the operator path and make a fresh commission a one-command
operation.

Repo context: the seed images live as release assets at
[`cognitum-one/seed`](https://github.com/cognitum-one/seed/releases)
(tag-per-image, with `.img.gz` + `.sha256` side-cars). The SDKs live
here. There is no existing first-party flashing tool.

## Decision

Ship a new first-party tool — **`cognitum-seed-flash`** — as a Rust
binary crate in this monorepo at `tools/seed-flash/`.

### Delivery shape

```
tools/
└── seed-flash/
    ├── Cargo.toml             # name = "cognitum-seed-flash", bin target
    ├── README.md              # operator-facing quick-start
    └── src/
        ├── main.rs            # clap CLI entry
        ├── discover.rs        # gh release asset enumeration
        ├── download.rs        # resume-capable downloader
        ├── verify.rs          # SHA256 check against .sha256 sidecar
        ├── devices.rs         # platform-specific block-device enum
        ├── write.rs           # dd-style write w/ verification
        └── guard.rs           # "is this a removable disk?" checks
```

Separate crate, not part of the `cognitum-rs` SDK — flashing involves
raw block-device I/O and is a layering violation inside an HTTP client.
`cargo install cognitum-seed-flash` gives a single self-contained
binary users can run on Linux / macOS / Windows.

### SDK helpers — thin, read-only

Each of the existing three SDKs (`@cognitum/sdk`, `cognitum`,
`cognitum-rs`) gets a new `seed.images.*` read-only resource that lets
the SDK user query "what seed images are available" without driving
a flash themselves:

```ts
// Node
const images = await client.seed.images.list();
// -> [{ tag: "v0.20.0", img_gz_url, sha256, size_bytes }, ...]
const latest = await client.seed.images.latest();
```

```python
# Python
images = client.seed.images.list()
latest = client.seed.images.latest()
```

```rust
// Rust
let images = client.seed().images().list().await?;
let latest = client.seed().images().latest().await?;
```

These helpers call the GitHub Releases API (`GET /repos/cognitum-one/
seed/releases`) and return typed metadata. **They do not write to
disk.** Writing is exclusively the dedicated CLI's job.

Rationale for the split: a typical consumer of the SDK is a dev-ops
script on a hub or an operator running automation. They need to
discover images via the same SDK they already use. They do not need the
SDK itself to escalate into raw-disk access — keeping that privilege
concentrated in one small, audited binary is safer.

### CLI surface (v0.1.0)

```
cognitum-seed-flash --help
cognitum-seed-flash list                        # enumerate releases
cognitum-seed-flash describe v0.20.0            # show size/sha256/url
cognitum-seed-flash download v0.20.0 [--to DIR] # just fetch + verify
cognitum-seed-flash devices                     # list candidate disks
cognitum-seed-flash write v0.20.0 /dev/diskN    # the primary verb
      [--yes]                                   # skip interactive confirm
      [--verify]                                # default on — read-back
      [--no-unmount]                            # skip pre-unmount
      [--allow-non-removable]                   # safety override
cognitum-seed-flash doctor                      # platform preflight
```

### Invariants the tool MUST enforce

1. **SHA256 verified before writing.** Abort if the sidecar is missing
   or the hash doesn't match. The sidecar path is the release asset
   named `<tag>.img.gz.sha256`.
2. **Target must be a removable disk by default.** Use platform APIs
   (`lsblk --json` on Linux, `diskutil info -plist` on macOS,
   `Get-Disk` on Windows). Require `--allow-non-removable` to override,
   and print the selected disk's vendor/model/size one more time with
   a 10-second countdown + typed confirmation before writing.
3. **Post-write read-back verification by default.** Re-read the first
   N MB (configurable) and compare to the source. `--verify=none` to
   skip for speed.
4. **Gzip-stream directly to block device.** Never stage an
   intermediate uncompressed image — the `.img.gz` decompresses on
   the fly, so 16 GB cards don't need 14 GB of free disk beforehand.
5. **Bytes-written progress, not "% complete".** Round-tripped through
   an atomic `fsync`; anything that can't fsync counts as write failed.

### Release + versioning

- Initial version: `0.1.0`. Follows ADR-0006 §"pre-1.0 breaking changes
  allowed".
- Lives in the same monorepo as the SDKs but tagged independently
  (`cognitum-seed-flash-v0.1.0`, parallel to the `@cognitum/sdk-v0.2.0`
  / `cognitum-py-v0.2.0` / `cognitum-rs-v0.2.0` tag pattern).
- Publish to crates.io so `cargo install cognitum-seed-flash` Just
  Works. Keep pre-built binaries as GitHub release assets for
  Linux x86_64/aarch64, macOS arm64, and Windows x86_64.

### Platform matrix

| Platform | Device enum | Write path | Unmount | CI |
|----------|-------------|-----------|---------|------|
| Linux | `lsblk --json` | raw `/dev/sdX` or `/dev/mmcblkN`, needs root or `cap_dac_override` | `umount` | ubuntu-latest |
| macOS | `diskutil info -plist` | raw `/dev/rdiskN`, needs `sudo` | `diskutil unmountDisk` | macos-latest |
| Windows | `Get-Disk` via PS | `\\.\PhysicalDriveN`, needs admin | `Dismount-Volume` | windows-latest |

The tool detects missing privilege and prints the exact elevation
command (e.g. `sudo cognitum-seed-flash write ...`) rather than
silently failing.

## Consequences

### Positive

- One command replaces the ~20-line manual dd / sha / diskutil dance
  documented in `CLAUDE.md`.
- Every named "DO NOT" from `CLAUDE.md` is moved from operator memory
  into enforced code paths.
- Fresh operators get a working seed on their first try.
- The tool becomes the canonical reference flow; if the flash recipe
  needs to change (e.g. image format moves from `.img.gz` → `.zip`),
  one codebase updates, not dozens of docs.
- SDK users who want to list available images don't need to reach for
  the GitHub API themselves.

### Negative

- New maintenance surface: a Rust binary with platform-specific
  branches and privilege elevation logic. Requires CI that actually
  exercises the write path against a loopback device or virtual disk.
- Users on very old distros may hit rustup / `sudo` / selinux corner
  cases the tool can't fully abstract away.
- Duplicates some logic available in Raspberry Pi Imager. The value is
  that it's opinionated for seed images specifically — not a general
  imaging tool.

### Risks

- **Destroying the wrong disk.** Guarded by the removable-only default
  + typed confirmation + 10-second countdown + vendor/model echo. This
  is the primary risk class; designed around from day one.
- **Write-verify false negatives on cheap SD cards.** Some flash media
  drop writes then return stale reads. The verify pass catches exactly
  this. Low-quality cards fail the commissioning step; that's the
  intended behaviour.
- **CI coverage.** Can't cut an actual SD card in CI. Mitigation:
  loopback-mounted sparse files + a flag `--target-is-file` that skips
  the removable-disk guard for tests only.

## Alternatives considered

| Option | Why rejected |
|--------|--------------|
| Add `client.seed.flash(...)` to each SDK | Layering violation — HTTP client libraries should not perform raw block-device writes. SDKs don't ship `sudo` escalation either. |
| Use Raspberry Pi Imager's "custom image" URL feature | Works but leaves every "DO NOT" in the operator's lap. No SHA256 enforcement. No cognitum-aware disk guard. |
| Publish a shell script in the `seed` repo | Bash + `dd` + `diskutil` works on macOS / Linux but breaks on Windows. Hard to add SHA256 verification rigorously in bash without adding dependencies. |
| Embed the logic in a web-install flow (browser + WebUSB) | Would be the nicest UX but WebUSB block-device write is non-trivial and doesn't work on mobile Safari. Future work. |
| Put the tool inside `sdks/rust/` as a binary target | Conflates the library crate's versioning with the tool's. A separate `tools/seed-flash/` crate is cleaner and doesn't leak `sudo`-capable code into the SDK dependency tree. |

## Compliance

- **CLAUDE.md §"Build SD Card Image — CORRECT APPROACH"** — every
  numbered step from §1 "Flash v0.8.1 base image on 16GB SD card"
  through §8 "Flash to a DIFFERENT card and boot-test before
  publishing" maps to a CLI flag or subcommand.
- **ADR-0011** — the tool is a peer of the SDKs, not part of them, so
  the `cognitum-one/sdks` / `cognitum-one/seed` split doesn't need
  to change.
- **ADR-0007** — the SDK-level `client.seed.images.*` helpers are
  read-only and do not escalate privilege.
- **ADR-0006** — separate SemVer lane starting at `0.1.0`.

## References

- Project `CLAUDE.md` §"🏗️ Cognitum Seed Release Build Process" —
  the manual workflow this tool encodes.
- Seed images — [`cognitum-one/seed/releases`](https://github.com/cognitum-one/seed/releases)
- Related ADRs: 0006 (versioning), 0007 (security), 0011 (scope).
- Tracking issue: `cognitum-one/sdks` (to be filed alongside this ADR).

## Rollout plan

1. **ADR (this file)** — Proposed. Review + Accept.
2. **Issue** filed at `cognitum-one/sdks` covering the CLI spec +
   platform matrix + SDK helper shape.
3. **Phase 1 — CLI** (~2 weeks):
   - `tools/seed-flash/` scaffolded with `list` / `describe` /
     `download` / `devices` / `doctor` subcommands working (no write
     verb yet).
   - CI matrix: ubuntu / macos / windows running the non-privileged
     subcommands.
   - Release tag `cognitum-seed-flash-v0.1.0-alpha.1`.
4. **Phase 2 — Write verb** (~2 weeks):
   - `write` subcommand behind `--experimental` flag.
   - Loopback-disk CI test on Linux.
   - Manual testing on real SD cards against the live seed-fleet.
   - Alpha → Beta → 0.1.0 once Linux + macOS are solid.
5. **Phase 3 — SDK helpers** (~1 week):
   - `seed.images.list()` / `seed.images.latest()` added to all three
     SDKs. No new crate / npm / PyPI release gate — these wrap the
     GitHub API and land in the next SDK minor (`v0.3.0`).
6. **Phase 4 — Windows + install docs** (~1 week):
   - Windows Admin + `Dismount-Volume` path stabilised.
   - `cognitum.one/docs/flashing` operator doc.
