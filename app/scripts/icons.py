"""Karto Wallet's and Karto PoS's icon and splash images, from their SVG sources in app/assets/icon/.

Run by `make app-icons`, which gives it cairosvg 2.9.0 in a venv of its own. Writes 1024x1024 PNGs into
app/assets/, where app.json names them: the whole icon, the adaptive icon's foreground and monochrome layers,
and the splash image.
"""
import pathlib

import cairosvg

if cairosvg.__version__ != '2.9.0':
    raise SystemExit(f'cairosvg 2.9.0 is pinned, this is {cairosvg.__version__}: run make app-icons')

ASSETS = pathlib.Path(__file__).resolve().parent.parent / 'assets'
PNGS = {
    'icon.png': 'icon.svg',
    'android-icon-foreground.png': 'card.svg',
    'android-icon-monochrome.png': 'monochrome.svg',
    'splash-icon.png': 'card.svg',
    # Karto PoS's (app/variant.js names them): the card held to a till, the person's pick of four.
    'pos/icon.png': 'pos-icon.svg',
    'pos/android-icon-foreground.png': 'pos-card.svg',
    'pos/android-icon-monochrome.png': 'pos-monochrome.svg',
    'pos/splash-icon.png': 'pos-card.svg',
}

for png, svg in PNGS.items():
    (ASSETS / png).parent.mkdir(exist_ok=True)
    cairosvg.svg2png(url=str(ASSETS / 'icon' / svg), write_to=str(ASSETS / png), output_width=1024, output_height=1024)
    print(f'{png} from icon/{svg}')
