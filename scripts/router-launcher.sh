#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  printf '%s\n' 'Usage: router-launcher.sh /absolute/workbench-state/router' >&2
  exit 64
fi

router_data=$(realpath -e -- "$1")
router_assets=$(dirname "$(realpath -e -- "$0")")
router_binary="$router_assets/codex-router"
router_network="$router_assets/model.netns"
router_home="$router_data/home"
router_workspace="$router_data/workspace"
router_codex="$router_data/codex-home"

cd "$router_assets"
sha256sum --check --status codex-router.sha256
test -d "$router_workspace"
test -d "$router_home"
test -d "$router_codex"
test -f "$router_codex/config.toml"
test "$(stat -Lc '%i' "$router_network")" != "$(stat -Lc '%i' /proc/self/ns/net)"
test "$(realpath -e -- "$router_workspace")" = "$router_workspace"
test "$(realpath -e -- "$router_home")" = "$router_home"
test "$(realpath -e -- "$router_codex")" = "$router_codex"
test "$(realpath -e -- "$router_codex/config.toml")" = "$router_codex/config.toml"

# The deployment provisions model.netns with DNS and provider-only egress.
# Storage mounts expose Router state and independent credentials only.
exec /usr/bin/nsenter "--net=$router_network" /usr/bin/bwrap \
  --unshare-user --unshare-pid --unshare-ipc --unshare-uts \
  --cap-drop ALL --die-with-parent --new-session \
  --proc /proc --dev /dev --tmpfs /tmp \
  --ro-bind /usr/lib /usr/lib \
  --ro-bind-try /usr/lib64 /usr/lib64 \
  --ro-bind-try /lib /lib \
  --ro-bind-try /lib64 /lib64 \
  --ro-bind-try /etc/ssl/certs /etc/ssl/certs \
  --ro-bind-try /etc/pki/tls/certs /etc/pki/tls/certs \
  --ro-bind-try /etc/pki/ca-trust/extracted /etc/pki/ca-trust/extracted \
  --ro-bind /etc/resolv.conf /etc/resolv.conf \
  --ro-bind "$router_binary" /codex-router \
  --ro-bind "$router_home" "$router_home" \
  --ro-bind "$router_workspace" "$router_workspace" \
  --bind "$router_codex" "$router_codex" \
  --ro-bind "$router_codex/config.toml" "$router_codex/config.toml" \
  --setenv HOME "$router_home" --setenv CODEX_HOME "$router_codex" \
  --setenv PATH /nonexistent --setenv TMPDIR /tmp \
  --chdir "$router_workspace" \
  -- /codex-router app-server --stdio --strict-config
