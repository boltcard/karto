#!/usr/bin/python3
"""The signing key's password in the desktop's login keyring (the Secret Service, through python3-secretstorage:
`sudo apt install python3-secretstorage`; it is run by the system's Python, /usr/bin/python3, whatever the PATH).

  keyring.py get    prints the password; exit 1 when there is none or the keyring is locked
  keyring.py has    exit 0 when there is one
  keyring.py set    stores the password: asked for at a prompt, unseen, in a terminal (restoring the key from a
                    backup), else one line of standard input (make-key.sh); refuses to replace one
  keyring.py del    removes it (make-key.sh, when it could not finish)

deploy/signing/make-key.sh stores it once; deploy/signing/sign-apk.sh reads it for every build that goes to a phone.
"""
import getpass
import sys

import secretstorage

ATTRIBUTES = {'service': 'karto-android-signing', 'account': 'karto'}
LABEL = 'Karto Android signing key'


def items():
    bus = secretstorage.dbus_init()
    collection = secretstorage.get_default_collection(bus)
    if collection.is_locked():
        raise SystemExit('the login keyring is locked')
    return collection, list(collection.search_items(ATTRIBUTES))


def main(what: str) -> int:
    collection, found = items()
    if what == 'has':
        return 0 if found else 1
    if what == 'get':
        if not found:
            return 1
        sys.stdout.write(found[0].get_secret().decode() + '\n')
        return 0
    if what == 'set':
        if found:
            raise SystemExit('the keyring already holds a signing password: it is not replaced')
        # Typed at a prompt, unseen, when a person runs it (restoring from a backup); one line of standard input otherwise.
        password = getpass.getpass('The signing key\'s password: ') if sys.stdin.isatty() else sys.stdin.readline().rstrip('\n')
        if not password:
            raise SystemExit('no password given')
        collection.create_item(LABEL, ATTRIBUTES, password.encode(), replace=False)
        return 0
    if what == 'del':
        for item in found:
            item.delete()
        return 0
    raise SystemExit(__doc__)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) == 2 else ''))
