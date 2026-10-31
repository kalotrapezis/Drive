#!/usr/bin/env python3
"""tools/site-check.py docs/xx.html: the page must be docs/index.html with only its words changed (text, alt, aria-label, meta content),
<html lang> and the current language's aria-current. Prints OK or the first differences."""
import sys, re
from html.parser import HTMLParser
from pathlib import Path
WORDS = {'alt', 'aria-label', 'content', 'aria-current'}
class P(HTMLParser):
    def __init__(s): super().__init__(convert_charrefs=True); s.out = []; s.text = 0
    def handle_starttag(s, t, a):
        a = [(k, v) for k, v in a if k not in WORDS and not (t == 'html' and k == 'lang')]
        s.out.append(('<', t, tuple(a)))
    def handle_endtag(s, t): s.out.append(('>', t))
    def handle_data(s, d):
        if d.strip(): s.text += 1
def parse(f):
    p = P(); src = Path(f).read_text(); p.feed(src); return p, src
f = sys.argv[1]
docs = Path(f).resolve().parent
(en, esrc), (tr, tsrc) = parse(docs / 'index.html'), parse(f)
lang = Path(f).stem
bad = []
if en.out != tr.out:
    for i, (a, b) in enumerate(zip(en.out, tr.out)):
        if a != b: bad.append(f'tag {i}: expected {a} got {b}'); break
    if len(en.out) != len(tr.out): bad.append(f'{len(tr.out)} tags, expected {len(en.out)}')
if f'<html lang="{lang}">' not in tsrc: bad.append(f'<html lang="{lang}"> missing')
if f'href="{lang}.html" hreflang="{lang}" lang="{lang}" aria-current="page"' not in tsrc: bad.append('aria-current="page" not on its own language in the menu')
if tsrc.split('<body>')[1].count('aria-current') != 1: bad.append('aria-current must appear once')
if f'<summary aria-label' not in tsrc or f'>{lang.upper()}</summary>' not in tsrc: bad.append(f'the menu summary must show {lang.upper()}')
same = [t for t in re.findall(r'<(?:h3|p)[^>]*>([^<]{25,})', esrc) if t in tsrc]
if len(same) > 2: bad.append(f'{len(same)} English sentences left, e.g. {same[0][:60]!r}')
print('OK' if not bad else '\n'.join(bad))
