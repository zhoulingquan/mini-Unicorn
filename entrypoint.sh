#!/bin/sh
dir="$HOME/.miniUnicorn"
if [ -d "$dir" ] && [ ! -w "$dir" ]; then
    owner_uid=$(stat -c %u "$dir" 2>/dev/null || stat -f %u "$dir" 2>/dev/null)
    LOCAL_UID=$(id -u)
    LOCAL_GID=$(id -g)
    cat >&2 <<EOF
Error: $dir is not writable (owned by UID $owner_uid, running as UID $LOCAL_UID).

Fix (pick one):
  Host:   sudo chown -R $LOCAL_UID:$LOCAL_GID ~/.miniUnicorn
  Docker: docker run --user \$(id -u):\$(id -g) ...
  Podman: podman run --userns=keep-id ...
EOF
    exit 1
fi
exec miniUnicorn "$@"
