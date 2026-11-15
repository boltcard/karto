#!/usr/bin/env python3
"""Seals a signed iPhone app for the workflow's artifacts, and opens it again on the computer that installs it.

A signed .ipa holds its development profile, which names the team and the one iPhone it is made for. The
workflow's artifacts can be downloaded by anyone who can read the repository (anyone at all, once it is public),
so .github/workflows/ios.yml uploads only sealed apps: AES-256-GCM under a key made by scrypt from the passphrase
in the secret IPA_PASSPHRASE. The file is "KARTO-SEAL1", a 16-byte salt, a 12-byte nonce, then the sealed bytes.

    ios-seal.py seal IN OUT   (the passphrase from IPA_PASSPHRASE)
    ios-seal.py open IN OUT   (from IPA_PASSPHRASE if it is set, else asked for)

Needs the cryptography package: on the runner from deploy/test/ios-provision-requirements.txt, and on a computer
with pip install cryptography (or python3-cryptography from the system's packages).
"""
import getpass
import os
import sys

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

MAGIC = b"KARTO-SEAL1"


def key(passphrase, salt):
    return Scrypt(salt=salt, length=32, n=2**15, r=8, p=1).derive(passphrase.encode())


def passphrase(asking):
    value = os.environ.get("IPA_PASSPHRASE", "")
    if not value and asking:
        value = getpass.getpass("The passphrase (the secret IPA_PASSPHRASE): ")
    if not value:
        sys.exit("IPA_PASSPHRASE is not set")
    return value


def seal(src, dst):
    with open(src, "rb") as f:
        data = f.read()
    salt, nonce = os.urandom(16), os.urandom(12)
    sealed = AESGCM(key(passphrase(False), salt)).encrypt(nonce, data, MAGIC)
    with open(dst, "wb") as f:
        f.write(MAGIC + salt + nonce + sealed)


def open_sealed(src, dst):
    with open(src, "rb") as f:
        data = f.read()
    if not data.startswith(MAGIC):
        sys.exit(f"{src} is not a sealed app")
    rest = data[len(MAGIC):]
    salt, nonce, sealed = rest[:16], rest[16:28], rest[28:]
    try:
        plain = AESGCM(key(passphrase(True), salt)).decrypt(nonce, sealed, MAGIC)
    except InvalidTag:
        sys.exit(f"{src} does not open with this passphrase (or it was changed after sealing)")
    with open(dst, "wb") as f:
        f.write(plain)


def main():
    if len(sys.argv) != 4 or sys.argv[1] not in ("seal", "open"):
        sys.exit(__doc__)
    (seal if sys.argv[1] == "seal" else open_sealed)(sys.argv[2], sys.argv[3])


if __name__ == "__main__":
    main()
