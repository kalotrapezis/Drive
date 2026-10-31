#!/usr/bin/env python3
"""The site's card pictures without words (docs/img/art/*.jpg): the words are HTML laid over them in docs/*.html, so a
translation changes text, not pictures. Old cards (docs/img/card-*.jpg, text drawn in) have their text area painted over
with the background; new ones are screenshots put into device frames on the same dark background.
Usage: tools/site-cards.py <screenshots dir>   (from the repository; the screenshots' names are in NEW below)"""
import sys, numpy as np
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

IMG = Path(__file__).resolve().parent.parent / 'docs' / 'img'
OUT = IMG / 'art'
W, H = 1600, 900

def smooth_column(a, x0, x1):
    """Per row, the background colour of columns x0..x1: the darker pixels' median (text and pills are brighter),
    blurred down the rows so one row's leftover text pixel cannot show."""
    block = a[:, x0:x1].astype(float)
    lum = block.mean(axis=2)
    out = np.empty((a.shape[0], 3))
    for y in range(a.shape[0]):
        keep = lum[y] <= np.percentile(lum[y], 40) + 6
        out[y] = np.median(block[y][keep], axis=0)
    k = np.exp(-np.arange(-60, 61) ** 2 / (2 * 22 ** 2)); k /= k.sum()
    pad = np.pad(out, ((60, 60), (0, 0)), mode='edge')
    return np.stack([np.convolve(pad[:, c], k, mode='valid') for c in range(3)], axis=1)

def erase_left(a, x):
    """Paints columns 0..x with the background, row by row from the left edge's colour to the colour just before x."""
    left, right = smooth_column(a, 0, 24), smooth_column(a, x - 44, x - 4)
    t = np.linspace(0, 1, x)[None, :, None]
    a[:, :x] = (left[:, None] * (1 - t) + right[:, None] * t).round().clip(0, 255)

def erase_box(a, x0, y0, x1, y1):
    """Paints a box with the background from the columns just outside it, row by row."""
    left, right = smooth_column(a, x0 - 24, x0 - 2)[y0:y1], smooth_column(a, x1 + 2, x1 + 24)[y0:y1]
    t = np.linspace(0, 1, x1 - x0)[None, :, None]
    a[y0:y1, x0:x1] = (left[:, None] * (1 - t) + right[:, None] * t).round().clip(0, 255)

def erase_rows(a, y0, y1, x0=0, x1=W):
    """Paints rows y0..y1 (of columns x0..x1) with the background, column by column from the row above to the row below."""
    top, bottom = a[max(y0 - 4, 0):y0 + 1, x0:x1].mean(axis=0), a[y1:y1 + 4, x0:x1].mean(axis=0)
    k = np.exp(-np.arange(-150, 151) ** 2 / (2 * 70 ** 2)); k /= k.sum()  # a device's halo below must not stripe the fill
    blur = lambda r: np.stack([np.convolve(np.pad(r[:, c], 150, mode='edge'), k, mode='valid') for c in range(3)], axis=1)
    top, bottom = blur(top), blur(bottom)
    t = np.linspace(0, 1, y1 - y0)[:, None, None]
    a[y0:y1, x0:x1] = (top[None] * (1 - t) + bottom[None] * t).round().clip(0, 255)

# old cards: where the devices start (the text is left of it), and any caption boxes inside the picture
OLD = {'photos': 645, 'office': 630, 'notes': 660, 'calendar': 597, 'people': 630, 'files': 650, 'data': 655,
       'safety': 545, 'maps': 636, 'bubble': 620}
BOXES = {'bubble': [(1180, 758, 1480, 795)],
         'send': [(413, 682, 735, 718), (24, 784, 312, 822), (885, 682, 1176, 718), (1306, 784, 1562, 822)]}
ROWS = {'home': [(0, 156), (818, 884)], 'send': [(0, 250)], 'bubble': [(612, 646, 788, 1012)]}  # title rows and captions under the phones, all the card wide

def clean_old():
    for name in OLD.keys() | ROWS.keys():
        a = np.array(Image.open(IMG / f'card-{name}.jpg').convert('RGB'))
        if name in OLD: erase_left(a, OLD[name])
        for rows in ROWS.get(name, []): erase_rows(a, *rows)
        for box in BOXES.get(name, []): erase_box(a, *box)
        Image.fromarray(a).save(OUT / f'{name}.jpg', quality=86)

def background(c):
    """The cards' dark background with the applet's colour glowing from the right."""
    yy, xx = np.mgrid[0:H, 0:W]
    base = np.array([15, 17, 19], float)
    glow = np.exp(-(((xx - W * 1.05) / (W * .55)) ** 2 + ((yy - H * .3) / (H * .9)) ** 2))[..., None]
    col = np.array([int(c[i:i + 2], 16) for i in (1, 3, 5)], float)
    return Image.fromarray((base * (1 - glow * .55) + col * glow * .30).clip(0, 255).astype('uint8'))

def framed(shot, w, kind):
    """A screenshot w pixels wide in a device: 'pc' a window, 'tablet' and 'phone' a black bezel."""
    im = Image.open(shot).convert('RGB')
    im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
    bez, rad = {'pc': (0, 18), 'tablet': (14, 36), 'phone': (10, 40)}[kind]
    out = Image.new('RGBA', (im.width + 2 * bez, im.height + 2 * bez), (0, 0, 0, 0))
    ImageDraw.Draw(out).rounded_rectangle((0, 0, out.width - 1, out.height - 1), rad, fill=(8, 9, 10, 255), outline=(52, 57, 64, 255), width=2)
    mask = Image.new('L', im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, im.width - 1, im.height - 1), max(rad - bez, 8), fill=255)
    out.paste(im, (bez, bez), mask)
    return out

def put(card, dev, x, y):
    shadow = Image.new('RGBA', card.size, (0, 0, 0, 0))
    shadow.paste((0, 0, 0, 150), (x + 6, y + 14, x + dev.width + 6, y + dev.height + 14), dev.split()[3])
    card.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(18)))
    card.alpha_composite(dev, (x, y))

# new cards: colour, then (screenshot, width, kind, x, y) back to front
NEW = {
    'builder': ('#25C4FE', [('d-wizard3.png', 820, 'pc', 640, 120), ('e-settings-maps2.png', 270, 'phone', 1300, 190)]),
    'borders': ('#25C4FE', [('d-route2.png', 900, 'pc', 660, 160)]),
    'guide': ('#8E99A6', [('d-guide-f3.png', 800, 'pc', 660, 80), ('t-guide-files.png', 520, 'tablet', 1010, 500)]),
    'languages': ('#8E99A6', [('t-language.png', 760, 'tablet', 810, 150), ('p-home-de.png', 250, 'phone', 680, 300)]),
    'phone-tablet': ('#1A9AA8', [('t-phone.png', 880, 'tablet', 680, 170)]),
}

def make_new(shots):
    for name, (c, devs) in NEW.items():
        card = background(c).convert('RGBA')
        for f, w, kind, x, y in devs:
            put(card, framed(shots / f, w, kind), x, y)
        card.convert('RGB').save(OUT / f'{name}.jpg', quality=86)

if __name__ == '__main__':
    OUT.mkdir(exist_ok=True)
    clean_old()
    make_new(Path(sys.argv[1]))
