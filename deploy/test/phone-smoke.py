#!/usr/bin/env python3
"""Walks the app's first screens on the phone with uiautomator (phone-smoke.sh).

Welcome -> the new phrase (read off the screen, and the screen must refuse
screenshots) -> the 3-word check, each word picked from four (a wrong word
first, which shows the words again; then the right ones) -> the country
picker; then deep links to other screens must land back on the country
picker. Stops before "Continue": nothing reaches LNVPS.

The phrase screen shows its words in two columns. Needs one phone on adb with the
release app installed; first run on a Pixel 8 Pro.
"""
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

ADB = sys.argv[1]


def adb(*args: str) -> str:
    return subprocess.run([ADB, *args], check=True, capture_output=True, text=True).stdout


def nodes():
    xml = adb('exec-out', 'uiautomator', 'dump', '/dev/tty')
    xml = xml[: xml.rindex('>') + 1]
    return list(ET.fromstring(xml).iter('node'))


def find(pred, timeout=30.0):
    end = time.time() + timeout
    while time.time() < end:
        for n in nodes():
            if pred(n):
                return n
        time.sleep(1)
    raise SystemExit(f'not on screen after {timeout:.0f}s')


def text_is(t):
    return lambda n: n.get('text') == t


def tap(n):
    x1, y1, x2, y2 = map(int, re.findall(r'\d+', n.get('bounds')))
    adb('shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2))


def step(name):
    print(f'phone-smoke: {name}', flush=True)


step('welcome')
find(text_is('for Bolt Card'), 60)
tap(find(text_is('Set up a new server')))

step('phrase')
find(text_is('Your recovery phrase'))
words = {}
for n in nodes():
    # Each of the two columns is one group, described as "1, skin. 2, april. ..." (ui.tsx Words).
    for m in re.finditer(r'(\d+), ([a-z]+)', n.get('content-desc') or ''):
        words[int(m.group(1))] = m.group(2)
assert sorted(words) == list(range(1, 13)), f'expected 12 numbered words, saw {words}'
windows = adb('shell', 'dumpsys', 'window', 'windows')
app = [ln for ln in windows.splitlines() if 'fl=' in ln and 'SECURE' in ln]
assert app, 'the phrase screen allows screenshots (FLAG_SECURE missing)'
tap(find(text_is('I have written them down')))


def label(n):
    return n.get('text') or n.get('content-desc')


def question(after=None):
    """The check's question once it has changed from `after`: the word's place, and the four choices."""
    asked = lambda n: re.fullmatch(r'Which is word \d+ on your paper\?', n.get('text') or '') and n.get('text') != after
    q = find(asked).get('text')
    # The choices are the buttons that are one word; a tap on one is the answer.
    choices = [n for n in nodes() if n.get('class') == 'android.widget.Button' and re.fullmatch(r'[a-z]+', label(n) or '')]
    assert len(choices) == 4, f'expected 4 choices, saw {[label(n) for n in choices]}'
    assert not any(n.get('selected') == 'true' for n in choices), 'a choice is picked before any tap'
    return q, int(re.search(r'\d+', q).group()), choices


step('check, a wrong word first')
find(text_is('Check your words'))
q, pos, choices = question()
tap(next(n for n in choices if label(n) != words[pos]))
# A wrong word shows the words again, naming the one that missed.
find(lambda n: (n.get('text') or '').startswith(f'Word {pos} on your paper'))
find(text_is('Your recovery phrase'))
tap(find(text_is('I have written them down')))

step('check, the right words')
find(text_is('Check your words'))
q = None
for i in range(3):
    q, pos, choices = question(after=q)
    tap(next(n for n in choices if label(n) == words[pos]))

step('country')
find(text_is('Your country'), 60)
find(lambda n: (n.get('text') or '').startswith('Continue with') or n.get('text') == 'Choose a country')
# Each country's row ends with the VAT LNVPS is expected to charge: most of the first eight charge none.
find(text_is('no VAT'))

# Any app or web page can open cardapp:// links: none may reach a screen out of turn.
for link in ('cardapp://phrase', 'cardapp://welcome', 'cardapp://diagnostics', 'cardapp://home'):
    step(f'deep link {link}')
    adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', link, 'app.cardapp')
    time.sleep(3)
    find(text_is('Your country'))
    assert not any(n.get('text') in ('Your recovery phrase', 'Karto Wallet diagnostics', 'Your server') for n in nodes()), link
print('PASS')
