#!/usr/bin/env python3
"""Walks Karto PoS's first screens on the phone with uiautomator (pos-smoke.sh).

A phone that isn't paired opens Pair. Then the links any app or web page can
send: a pairing link asks first, naming its server, and Not now pairs nothing;
a link whose parts are wrong is dropped; a link to a screen of a paired phone,
or to no screen at all, lands on Pair, and none closes the app (its process is the same after each). Nothing is paired: Pair is never
pressed, and the links name a server that can't exist (example.invalid).

Needs one phone on adb with Karto PoS's release app installed; first run on a Pixel 8 Pro.
"""
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

ADB = sys.argv[1]
PACKAGE = 'app.cardapp.pos'
CODE = 'a' * 32
HEADING = 'Pair this phone to take payments'


def adb(*args: str) -> str:
    return subprocess.run([ADB, *args], check=True, capture_output=True, text=True).stdout


def texts():
    xml = adb('exec-out', 'uiautomator', 'dump', '/dev/tty')
    # While the app is starting there may be no dump at all: nothing on screen yet.
    if '>' not in xml:
        return []
    xml = xml[: xml.rindex('>') + 1]
    return [(n.get('text') or n.get('content-desc') or '', n.get('bounds')) for n in ET.fromstring(xml).iter('node')]


def find(text, timeout=30.0):
    end = time.time() + timeout
    seen = []
    while time.time() < end:
        seen = texts()
        for t, bounds in seen:
            if t == text:
                return bounds
        time.sleep(1)
    raise SystemExit(f'"{text}" not on screen after {timeout:.0f}s; on screen: {[t for t, _ in seen if t]}')


def tap(bounds):
    x1, y1, x2, y2 = map(int, re.findall(r'\d+', bounds))
    adb('shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2))


def link(url):
    # To this package alone: the smoke is of Karto PoS, whatever else on the phone claims the scheme.
    adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url, PACKAGE)
    time.sleep(3)


def step(name):
    print(f'pos-smoke: {name}', flush=True)


def pid():
    return subprocess.run([ADB, 'shell', 'pidof', PACKAGE], capture_output=True, text=True).stdout.strip()


def alive(since, what):
    # Android starts a crashed app again, onto its first screen: the screen alone would hide a crash.
    now = pid()
    assert now and now == since, f'Karto PoS was closed or started again by {what} (process {since or "none"}, now {now or "none"})'


def never(*unwanted):
    on = [t for t, _ in texts()]
    assert not any(u in on for u in unwanted), f'{unwanted} on screen: {on}'


step('pair, on a phone that is not paired')
find(HEADING, 60)
STARTED = pid()
assert STARTED, 'Karto PoS is not running'
find('Scan the code')
find("Once paired, this phone can take payments and see the shop's sales. It can't move money, and it never sees the cards or the recovery phrase.")

step('a pairing link asks first, and Not now pairs nothing')
link(f"'kartopos://pair?host=example.invalid&code={CODE}'")
find('Pair this phone with example.invalid?')
find('Only if you opened this from Karto Wallet, or scanned its code, just now. This phone will take payments for that server.')
find('Pair')
never('Pairing…')
tap(find('Not now'))
find(HEADING)

for url in (
    f"'kartopos://pair?host=EXAMPLE.invalid&code={CODE}'",  # a host in capitals
    "'kartopos://pair?host=example.invalid&code=abc'",  # a code too short
    f"'kartopos://pair?host=example.invalid/x&code={CODE}'",  # a path in the host
    f"'kartopos://pair?host=example.invalid&host=other.invalid&code={CODE}'",  # two hosts
    "'kartopos://pair'",
):
    step(f'a wrong link is dropped: {url}')
    link(url)
    find(HEADING)
    never('Pair', 'Pairing…')
    alive(STARTED, url)

# Any app or web page can open kartopos:// links: none may reach a paired phone's screen, or anything else.
for url in ('kartopos://till', 'kartopos://sale', 'kartopos://sales', 'kartopos://this-pos', 'kartopos://nowhere', 'kartopos://_sitemap'):
    step(f'deep link {url}')
    link(url)
    find(HEADING)
    never('Charge', 'Sales', 'This PoS', 'Unpair this phone', 'Unmatched Route', 'Sitemap')
    alive(STARTED, url)
print('PASS')
