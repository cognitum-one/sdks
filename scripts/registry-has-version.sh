#!/usr/bin/env bash
# Is <version> already published on <registry>?
#
#   exit 0  -> yes, it is published        (caller must PROVE it matches the bundle)
#   exit 10 -> no, authoritatively absent  (caller may publish)
#   exit 1  -> unknown; registry did not give a usable answer
#
# The three-way answer is the whole point. A probe that collapses "absent"
# and "could not tell" into one branch is dangerous here: on a transient 503
# the caller would conclude "not published", skip the identity proof, and --
# because the PyPI step passes `skip-existing: true` -- silently accept
# whatever bytes are already up there. That is precisely the split-release the
# prove-before-skip logic exists to prevent, so "I don't know" must stop the
# release rather than guess.

set -euo pipefail

registry="${1:?usage: registry-has-version.sh <npm|pypi|crates> <version>}"
version="${2:?usage: registry-has-version.sh <npm|pypi|crates> <version>}"

case "${registry}" in
  npm)    url="https://registry.npmjs.org/@cognitum-one%2Fsdk/${version}" ;;
  pypi)   url="https://pypi.org/pypi/cognitum-sdk/${version}/json" ;;
  crates) url="https://crates.io/api/v1/crates/cognitum-one/${version}" ;;
  *) echo "unknown registry: ${registry}" >&2; exit 1 ;;
esac

# Retry a few times so a single blip is not treated as an unusable answer.
for attempt in 1 2 3; do
  # `-w '%{http_code}'` always emits a code (000 when the request never
  # completed), so no `|| echo` fallback -- adding one concatenates onto
  # curl's own output and produces nonsense like "000000" in the error.
  status="$(curl -sS -o /dev/null -w '%{http_code}' \
              --max-time 30 \
              -H 'User-Agent: cognitum-sdks-release' \
              "${url}" 2>/dev/null)" || true
  case "${status}" in
    200) echo "${registry}: ${version} is already published"; exit 0 ;;
    404) echo "${registry}: ${version} is not published"; exit 10 ;;
    *)   echo "${registry}: attempt ${attempt}/3 gave HTTP ${status}" >&2; sleep 5 ;;
  esac
done

echo "${registry}: could not determine whether ${version} is published (last HTTP ${status})." >&2
echo "Refusing to guess -- publishing on a wrong guess is not reversible." >&2
exit 1
