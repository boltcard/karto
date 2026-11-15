#!/bin/sh
# Makes the one key the iPhone's test server lets in (deploy/test/iphone-diag.sh), for one build of the
# diagnostics app: prints the key's seed, 64 hex digits, which the build puts into the app and nowhere else, and
# leaves the public half as DIR/diag-login.pub for the server to be given. The private key file is removed: the
# app derives the key from the seed, as it does from a recovery phrase's. Run by the workflow's device job
# (.github/workflows/ios.yml), so the seed is in no commit, no log and no file but the app itself.
#   seed=$(sh deploy/test/diag-login-key.sh DIR)
set -eu
dir=${1:?usage: diag-login-key.sh DIR}
mkdir -p "$dir"
work=$(mktemp -d)
(umask 077 && ssh-keygen -q -t ed25519 -N '' -C karto-diagnostics-login -f "$work/key")
# The seed stands in the key file just before the public key's second copy.
python3 - "$work/key" <<'PY'
import base64, sys
path = sys.argv[1]
body = base64.b64decode(''.join(l for l in open(path).read().splitlines() if not l.startswith('-----')))
public = base64.b64decode(open(path + '.pub').read().split()[1])[-32:]
at = body.rfind(public)
seed = body[at - 32:at]
assert at > 32 and len(seed) == 32
print(seed.hex())
PY
cut -d' ' -f1,2 "$work/key.pub" >"$dir/diag-login.pub"
rm -rf "${work:?}"
