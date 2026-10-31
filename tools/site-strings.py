#!/usr/bin/env python3
"""The site in another language is the English page with its words swapped, nothing else (docs/index.html → docs/<lang>.html).
  tools/site-strings.py extract              every phrase of docs/index.html, as a JSON list (to stdout)
  tools/site-strings.py apply <lang> <json>  docs/<lang>.html from a JSON object {English phrase: translation}
                                             (each language's object is kept in tools/site-strings/<lang>.json)
A phrase is the inside of a heading, paragraph, list item, question, label, tab or button line (it may hold <b>, <a>, <code>,
<br>: keep them, translate the words around them) or an alt / aria-label / meta description. Apply also sets <html lang>,
the language menu's current entry and its code, and refuses a phrase left out."""
import json, re, sys
from pathlib import Path

DOCS = Path(__file__).resolve().parent.parent / 'docs'
INNER = [rf'<{t}\b[^>]*>(.*?)</{t}>' for t in ('p', 'h1', 'h2', 'h3', 'li', 'summary', 'button')] + [
         r'<span class="(?:label[^"]*|pill)"[^>]*>(.*?)</span>',
         r'<div><b>([^<]*)</b><span>([^<]*)</span>',  # a download button's two lines
         r'<b>([^<]*)</b><div class="bar"',
         r'\n\s*<a href="https://github.com/kalotrapezis/[^"#]*">([^<]*)</a>',
         r'<footer>\s*<div class="wrap">(.*?)</div>']
ATTRS = r'\b(alt|aria-label|content)="([^"]+)"'
KEEP = {'Tetra', 'Android', 'Linux', 'EN', 'Office'}  # names, the same in every language

def phrases(src):
    body = src.split('<body>')[1].split('<script>')[0]
    body = re.sub(r'<details class="lang">.*?</details>', '', body, flags=re.S)  # the menu's names are each language's own
    head = src.split('<style>')[0]
    out = []
    for pat in INNER:
        for m in re.finditer(pat, body, flags=re.S):
            for t in m.groups():
                t = t.strip()
                if t and not re.search(r'<(p|h3|li|div)\b', t) and not re.fullmatch(r'<img[^>]*>\w+', t): out.append(t)
    for m in re.finditer(ATTRS, head + body):
        if m.group(1) != 'content' or 'name="description"' in m.string[max(0, m.start() - 60):m.start()] or 'og:description' in m.string[max(0, m.start() - 60):m.start()]:
            out.append(m.group(2))
    seen = []
    for t in out:
        if t not in seen and t not in KEEP and not re.fullmatch(r'[\d.,\s→msGB·+%]*', t): seen.append(t)
    return seen

def apply(lang, tr):
    src = (DOCS / 'index.html').read_text()
    missing = [p for p in phrases(src) if p not in tr]
    if missing: sys.exit(f'{len(missing)} phrases not translated, e.g. {missing[0][:80]!r}')
    s = src
    # longest first, so a phrase inside a longer one is not swapped before it
    for en in sorted(tr, key=len, reverse=True):
        to = tr[en].strip()
        s = s.replace('>' + en + '</', '>' + to + '</')
        for a in ('alt', 'aria-label', 'content'):
            s = s.replace(f'{a}="{en}"', f'{a}="{to.replace(chr(34), "&quot;")}"')
        s = s.replace(f'<div class="wrap">{en}</div>', f'<div class="wrap">{to}</div>')
    s = s.replace('<html lang="en">', f'<html lang="{lang}">', 1)
    s = s.replace(' aria-current="page">English<', '>English<')
    s = re.sub(rf'(href="{lang}.html" hreflang="{lang}" lang="{lang}")>', r'\1 aria-current="page">', s, count=1)
    s = s.replace('>EN</summary>', f'>{lang.upper()}</summary>', 1)
    (DOCS / f'{lang}.html').write_text(s)
    print(f'docs/{lang}.html written')

if __name__ == '__main__':
    if sys.argv[1] == 'extract': print(json.dumps(phrases((DOCS / 'index.html').read_text()), ensure_ascii=False, indent=1))
    else: apply(sys.argv[2], json.loads(Path(sys.argv[3]).read_text()))
