#!/usr/bin/env python3
"""What Apple must hold before the app can be signed for the one test iPhone (a development build).

Through the App Store Connect API, with a team key, it makes sure of four things and makes none
of them twice: a development certificate for our own signing key, the iPhone registered as a
device, the app's identifier with NFC Tag Reading switched on, and a development profile that
names all three. It writes the certificate (cert.der) and the profile (profile.mobileprovision)
to the folder given; neither is a secret. Run by .github/workflows/ios.yml, on Linux.

    ios-provision.py OUT_DIR

From the environment: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8 (the .p8 file's text),
IOS_SIGNING_KEY (an RSA private key, PEM), IPHONE_UDID and BUNDLE_ID.
Needs: pip install --require-hashes -r deploy/test/ios-provision-requirements.txt
"""
import base64
import os
import sys
import time

import jwt
import requests
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.x509.oid import NameOID

API = "https://api.appstoreconnect.apple.com/v1"
# Names as Apple's pages show them. The certificate and the phone are found by what they are (our key, the
# phone's own ID), never by name, so ones registered earlier under other names are used as they are.
# Each app has its own profile and identifier names (Karto PoS's: "Karto PoS development", set by the workflow):
# a profile is made afresh by deleting those of its name, so two apps must never share one.
PROFILE_NAME = os.environ.get("PROFILE_NAME", "").strip() or "Karto development"
DEVICE_NAME = "Karto iPhone 12"
IDENTIFIER_NAME = os.environ.get("IDENTIFIER_NAME", "").strip() or "Karto development"


def env(name):
    value = os.environ.get(name, "").strip()
    if not value:
        sys.exit(f"{name} is not set")
    return value


def token():
    now = int(time.time())
    return jwt.encode(
        {"iss": env("ASC_ISSUER_ID"), "iat": now, "exp": now + 600, "aud": "appstoreconnect-v1"},
        env("ASC_KEY_P8"),
        algorithm="ES256",
        headers={"kid": env("ASC_KEY_ID")},
    )


def call(method, path, body=None, params=None):
    response = requests.request(
        method, API + path, json=body, params=params, headers={"Authorization": f"Bearer {token()}"}, timeout=60
    )
    if response.status_code >= 400:
        # Apple's errors say which rule was broken (an agreement not accepted, a role too low).
        sys.exit(f"{method} {path}: {response.status_code}\n{response.text[:2000]}")
    return response.json() if response.content else None


def public_bytes(key):
    return key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)


def certificate(key):
    """The development certificate issued for our key: found if Apple has one that is still good, else asked for."""
    ours = public_bytes(key.public_key())
    found = call("GET", "/certificates", params={"filter[certificateType]": "DEVELOPMENT", "limit": 200})
    for item in found["data"]:
        der = base64.b64decode(item["attributes"]["certificateContent"])
        if public_bytes(x509.load_der_x509_certificate(der).public_key()) == ours:
            print(f"certificate: found {item['attributes']['serialNumber']}, good until {item['attributes']['expirationDate']}")
            return item["id"], der
    csr = (
        x509.CertificateSigningRequestBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Karto development")]))
        .sign(key, hashes.SHA256())
    )
    made = call(
        "POST",
        "/certificates",
        {
            "data": {
                "type": "certificates",
                "attributes": {
                    "certificateType": "DEVELOPMENT",
                    "csrContent": csr.public_bytes(serialization.Encoding.PEM).decode(),
                },
            }
        },
    )["data"]
    print(f"certificate: made {made['attributes']['serialNumber']}, good until {made['attributes']['expirationDate']}")
    return made["id"], base64.b64decode(made["attributes"]["certificateContent"])


def device(udid):
    found = call("GET", "/devices", params={"filter[udid]": udid})["data"]
    if found:
        item = found[0]
        if item["attributes"]["status"] != "ENABLED":
            sys.exit(f"device: {udid} is registered but {item['attributes']['status']}")
        print(f"device: found {item['attributes']['name']} ({item['attributes'].get('model')})")
        return item["id"]
    made = call(
        "POST", "/devices", {"data": {"type": "devices", "attributes": {"name": DEVICE_NAME, "udid": udid, "platform": "IOS"}}}
    )["data"]
    print(f"device: registered as {DEVICE_NAME}")
    return made["id"]


def bundle_id(identifier, name=IDENTIFIER_NAME):
    """The app's identifier, with NFC Tag Reading on. Registering one is permanent: Apple never frees the name."""
    found = call("GET", "/bundleIds", params={"filter[identifier]": identifier, "limit": 200})["data"]
    # The filter matches identifiers that merely start the same.
    found = [item for item in found if item["attributes"]["identifier"] == identifier]
    if found:
        item_id = found[0]["id"]
        print(f"identifier: found {identifier}")
    else:
        item_id = call(
            "POST",
            "/bundleIds",
            {"data": {"type": "bundleIds", "attributes": {"identifier": identifier, "name": name, "platform": "IOS"}}},
        )["data"]["id"]
        print(f"identifier: registered {identifier}")
    capabilities = [
        item["attributes"]["capabilityType"] for item in call("GET", f"/bundleIds/{item_id}/bundleIdCapabilities")["data"]
    ]
    if "NFC_TAG_READING" not in capabilities:
        call(
            "POST",
            "/bundleIdCapabilities",
            {
                "data": {
                    "type": "bundleIdCapabilities",
                    "attributes": {"capabilityType": "NFC_TAG_READING"},
                    "relationships": {"bundleId": {"data": {"type": "bundleIds", "id": item_id}}},
                }
            },
        )
        capabilities.append("NFC_TAG_READING")
        print("identifier: NFC Tag Reading switched on")
    print(f"identifier: capabilities {sorted(capabilities)}")
    return item_id


def profile(bundle, cert, phone, name=PROFILE_NAME):
    """A fresh profile each time: one made before the NFC capability or for another certificate would be stale."""
    for item in call("GET", "/profiles", params={"filter[name]": name})["data"]:
        if item["attributes"]["name"] == name:
            call("DELETE", f"/profiles/{item['id']}")
    made = call(
        "POST",
        "/profiles",
        {
            "data": {
                "type": "profiles",
                "attributes": {"name": name, "profileType": "IOS_APP_DEVELOPMENT"},
                "relationships": {
                    "bundleId": {"data": {"type": "bundleIds", "id": bundle}},
                    "certificates": {"data": [{"type": "certificates", "id": cert}]},
                    "devices": {"data": [{"type": "devices", "id": phone}]},
                },
            }
        },
    )["data"]
    print(f"profile: made {made['attributes']['uuid']}, good until {made['attributes']['expirationDate']}")
    return base64.b64decode(made["attributes"]["profileContent"])


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    key = serialization.load_pem_private_key(env("IOS_SIGNING_KEY").encode(), password=None)
    cert_id, cert_der = certificate(key)
    phone_id = device(env("IPHONE_UDID"))
    with open(os.path.join(out, "cert.der"), "wb") as f:
        f.write(cert_der)
    bundle = bundle_id(env("BUNDLE_ID"))
    with open(os.path.join(out, "profile.mobileprovision"), "wb") as f:
        f.write(profile(bundle, cert_id, phone_id))


if __name__ == "__main__":
    main()
