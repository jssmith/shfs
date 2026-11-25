#!/usr/bin/env python3
"""Synthetic test corpus for the ring check.

Writes a corpus of fake personal files to a directory, plus manifest.json with
ground truth for every file (docs/contracts.md section 5). Everything is
invented: names, institutions, numbers. Card numbers pass Luhn and IBANs pass
mod-97 so the checksum rules are exercised, but they are random and belong to
no one.

Deterministic from --seed (same seed, same fonts installed -> same bytes).

    python3 -I test/fixtures/generate.py --out /tmp/a1-corpus --seed 1
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import random
import string
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

GENERATOR_VERSION = 1
HERE = os.path.dirname(os.path.abspath(__file__))
BIP39_PATH = os.path.join(HERE, '..', '..', 'server', 'src', 'reading', 'wordlists', 'bip39-english.txt')

FONT_CANDIDATES = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSerif.ttf',
    '/usr/share/fonts/truetype/crosextra/Carlito-Regular.ttf',
    '/usr/share/fonts/truetype/crosextra/Caladea-Regular.ttf',
]
MONO_CANDIDATES = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf',
    '/usr/share/fonts/truetype/freefont/FreeMono.ttf',
]
ITALIC_CANDIDATES = [
    '/usr/share/fonts/truetype/liberation/LiberationSerif-Italic.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSerifItalic.ttf',
    '/usr/share/fonts/truetype/crosextra/Caladea-Italic.ttf',
]


def existing(paths):
    out = [p for p in paths if os.path.exists(p)]
    if not out:
        sys.exit('no usable fonts found; install fonts-dejavu or fonts-liberation')
    return out


FONTS = existing(FONT_CANDIDATES)
MONO = existing(MONO_CANDIDATES)
ITALIC = [p for p in ITALIC_CANDIDATES if os.path.exists(p)] or FONTS

# ---------------------------------------------------------------- fake vocab
FIRST = ['Avery', 'Jordan', 'Mira', 'Tobias', 'Lena', 'Oskar', 'Priya', 'Mateo', 'Ines', 'Rafael',
         'Hana', 'Elliot', 'Sofia', 'Kai', 'Noor', 'Felix', 'Clara', 'Idris', 'Maren', 'Theo',
         'Yara', 'Bastian', 'Lucia', 'Ravi', 'Greta', 'Simon', 'Anouk', 'Darius', 'Freya', 'Milo']
LAST = ['Halloway', 'Brennick', 'Okafor', 'Lindqvist', 'Marchetti', 'Ashdown', 'Varga', 'Quillen',
        'Desrosiers', 'Thornbury', 'Achterberg', 'Kowalczyk', 'Ferreira', 'Nakamura', 'Ellery',
        'Petrakis', 'Vance', 'Holloran', 'Strand', 'Abernethy', 'Castellano', 'Wexford', 'Imrie']
STREETS = ['Larkspur Lane', 'Elm Street', 'Quarry Road', 'Willowbank Avenue', 'Harbour Row',
           'Juniper Court', 'Foundry Street', 'Mill Lane', 'Orchard Close', 'Beacon Hill Road']
TOWNS = ['Millbrook', 'Eastwick Falls', 'Port Aldridge', 'Greyhaven', 'Thornfield', 'Westmere',
         'Kestrel Bay', 'Hollow Creek', 'Ravensholm', 'Brightwater']
BANKS = ['Harbor Federal Bank', 'Northwind Savings', 'Kestrel Bank plc', 'Bank of Greyhaven',
         'Meridian Credit Union', 'Sparrow Direct Bank', 'Ostwald Volksbank', 'Banque Lumiere']
BROKERS = ['Summit Ridge Securities', 'Bluewater Brokerage', 'Cobalt Invest', 'Fernhill Capital Markets']
EMPLOYERS = ['Acme Robotics', 'Lantern Logistics', 'Pinecone Analytics', 'Harrow & Finch LLP',
             'Brightline Foods', 'Copperleaf Studios', 'Orbital Freight Co.']
CLINICS = ['Riverside Family Practice', 'St. Aldric Hospital', 'Millbrook Medical Centre',
           'Greyhaven Dermatology', 'Westmere Orthopaedic Clinic', 'Harbourview Cardiology']
SHOPS = ['GreenBasket Market', 'Corner Hardware', 'Blue Door Bakery', 'Northside Pharmacy',
         'Pixel Electronics', 'Fern & Feather Cafe', 'Millbrook Books', 'QuickFuel Station']
STATES = ['Westmere', 'New Ravens', 'Utopia', 'North Aldridge']
COUNTRIES = [('UTO', 'UTOPIA'), ('D', 'GERMANY'), ('GBR', 'UNITED KINGDOM'), ('USA', 'UNITED STATES'),
             ('FRA', 'FRANCE'), ('NLD', 'NETHERLANDS')]
CONDITIONS = ['type 2 diabetes', 'hypertension', 'asthma', 'iron-deficiency anaemia', 'migraine',
              'generalised anxiety disorder', 'hypothyroidism', 'lower back pain', 'eczema',
              'major depressive episode', 'atrial fibrillation', 'sleep apnoea']
MEDS = [('metformin', '500 mg twice daily'), ('lisinopril', '10 mg once daily'),
        ('salbutamol inhaler', '2 puffs as needed'), ('ferrous sulfate', '200 mg daily'),
        ('sumatriptan', '50 mg at onset'), ('sertraline', '50 mg once daily'),
        ('levothyroxine', '75 mcg each morning'), ('naproxen', '250 mg as needed'),
        ('apixaban', '5 mg twice daily'), ('hydrocortisone cream 1%', 'apply thinly twice daily')]
ICD = ['E11.9', 'I10', 'J45.909', 'D50.9', 'G43.909', 'F41.1', 'E03.9', 'M54.5', 'L30.9', 'F32.1', 'I48.91']
SERVICES = ['GitHub', 'Google', 'Dropbox', 'Proton Mail', 'Coinbase', 'Microsoft', 'Discord',
            'Slack', 'AWS', 'Twitter', 'Nextcloud', 'Bitwarden', 'Kraken', 'Fastmail']
SITES = ['mail.example.com', 'bank.example.org', 'shop.example.net', 'forum.example.com',
         'cloud.example.io', 'streaming.example.tv', 'news.example.com', 'travel.example.co',
         'gym.example.fit', 'school.example.edu', 'router.local', 'nas.local']


def person(r):
    return f'{r.choice(FIRST)} {r.choice(LAST)}'


def address(r):
    return [f'{r.randint(2, 240)} {r.choice(STREETS)}', f'{r.choice(TOWNS)} {r.randint(10000, 99999)}']


def date(r, y0=2019, y1=2026):
    return f'{r.randint(y0, y1)}-{r.randint(1, 12):02d}-{r.randint(1, 28):02d}'


def date_dmy(r, y0=1950, y1=2005):
    return f'{r.randint(1, 28):02d}/{r.randint(1, 12):02d}/{r.randint(y0, y1)}'


def money(r, lo=1, hi=5000):
    return f'{r.uniform(lo, hi):,.2f}'


def digits(r, n):
    return ''.join(r.choice(string.digits) for _ in range(n))


def luhn_check_digit(body: str) -> str:
    total = 0
    for i, ch in enumerate(reversed(body)):
        d = int(ch)
        if i % 2 == 0:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return str((10 - total % 10) % 10)


def luhn_ok(num: str) -> bool:
    return luhn_check_digit(num[:-1]) == num[-1]


def card_number(r):
    prefix, length = r.choice([('4', 16), ('51', 16), ('53', 16), ('55', 16), ('37', 15), ('6011', 16), ('4', 13)])
    body = prefix + digits(r, length - len(prefix) - 1)
    return body + luhn_check_digit(body)


def fmt_card(num, r):
    if len(num) == 15:
        return f'{num[:4]} {num[4:10]} {num[10:]}'
    sep = r.choice([' ', ' ', '-', ''])
    return sep.join(num[i:i + 4] for i in range(0, len(num), 4))


def iban(r):
    country, body = r.choice([
        ('DE', lambda: digits(r, 8) + digits(r, 10)),
        ('GB', lambda: ''.join(r.choice(string.ascii_uppercase) for _ in range(4)) + digits(r, 14)),
        ('FR', lambda: digits(r, 10) + ''.join(r.choice(string.ascii_uppercase + string.digits) for _ in range(11)) + digits(r, 2)),
        ('NL', lambda: ''.join(r.choice(string.ascii_uppercase) for _ in range(4)) + digits(r, 10)),
        ('ES', lambda: digits(r, 20)),
    ])
    bban = body()
    rearranged = bban + country + '00'
    num = int(''.join(str(int(c, 36)) for c in rearranged))
    check = 98 - num % 97
    raw = f'{country}{check:02d}{bban}'
    return ' '.join(raw[i:i + 4] for i in range(0, len(raw), 4))


def aba_routing(r):
    d = [int(x) for x in digits(r, 8)]
    d[0] = r.choice([0, 1, 2, 3])
    s = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5])
    d.append((10 - s % 10) % 10)
    return ''.join(map(str, d))


def ssn(r):
    while True:
        a = r.randint(1, 899)
        if a != 666:
            return f'{a:03d}-{r.randint(1, 99):02d}-{r.randint(1, 9999):04d}'


def nino(r):
    letters = 'ABCEGHJKLMNPRSTWXYZ'
    return f'{r.choice(letters)}{r.choice(letters)} {digits(r, 2)} {digits(r, 2)} {digits(r, 2)} {r.choice("ABCD")}'


def nhs_number(r):
    while True:
        d = [int(x) for x in digits(r, 9)]
        s = sum(v * (10 - i) for i, v in enumerate(d))
        c = 11 - s % 11
        if c == 11:
            c = 0
        if c != 10:
            n = ''.join(map(str, d)) + str(c)
            return f'{n[:3]} {n[3:6]} {n[6:]}'


def mrz_check(s: str) -> str:
    w = [7, 3, 1]
    total = 0
    for i, ch in enumerate(s):
        if ch.isdigit():
            v = int(ch)
        elif ch.isalpha():
            v = ord(ch) - 55
        else:
            v = 0
        total += v * w[i % 3]
    return str(total % 10)


def mrz_td3(r, surname, given, country):
    pno = ''.join(r.choice(string.ascii_uppercase + string.digits) for _ in range(9))
    dob = f'{r.randint(50, 99):02d}{r.randint(1, 12):02d}{r.randint(1, 28):02d}'
    exp = f'{r.randint(27, 35):02d}{r.randint(1, 12):02d}{r.randint(1, 28):02d}'
    sex = r.choice('MF')
    l1 = f'P<{country:<3}'.replace(' ', '<') + f'{surname.upper()}<<{given.upper()}'.replace(' ', '<')
    l1 = (l1 + '<' * 44)[:44]
    personal = '<' * 14
    l2 = (pno + mrz_check(pno) + f'{country:<3}'.replace(' ', '<') + dob + mrz_check(dob) + sex + exp
          + mrz_check(exp) + personal + mrz_check(personal))
    final = mrz_check(l2[0:10] + l2[13:20] + l2[21:43])
    return l1, l2 + final, pno, dob, exp, sex


def mrz_td1(r, surname, given, country):
    dno = ''.join(r.choice(string.ascii_uppercase + string.digits) for _ in range(9))
    dob = f'{r.randint(50, 99):02d}{r.randint(1, 12):02d}{r.randint(1, 28):02d}'
    exp = f'{r.randint(27, 35):02d}{r.randint(1, 12):02d}{r.randint(1, 28):02d}'
    c = f'{country:<3}'.replace(' ', '<')
    l1 = (f'I<{c}{dno}{mrz_check(dno)}' + '<' * 30)[:30]
    l2 = (dob + mrz_check(dob) + r.choice('MF') + exp + mrz_check(exp) + c + '<' * 11)[:29]
    l2 = l2 + mrz_check(l1[5:30] + l2[0:7] + l2[8:15] + l2[18:29])
    l3 = (f'{surname.upper()}<<{given.upper()}'.replace(' ', '<') + '<' * 30)[:30]
    return l1, l2, l3, dno


def b64(r, n):
    return ''.join(r.choice(string.ascii_letters + string.digits + '+/') for _ in range(n))


def alnum(r, n, alphabet=string.ascii_letters + string.digits):
    return ''.join(r.choice(alphabet) for _ in range(n))


def hexs(r, n):
    return ''.join(r.choice('0123456789abcdef') for _ in range(n))


def password(r):
    style = r.random()
    if style < 0.4:
        return alnum(r, r.randint(12, 24), string.ascii_letters + string.digits + '!@#$%^&*-_')
    if style < 0.7:
        return '-'.join(r.choice(WORDS) for _ in range(4))
    return r.choice(WORDS).capitalize() + str(r.randint(10, 9999)) + r.choice('!?#$')


WORDS = ['maple', 'river', 'copper', 'lantern', 'orbit', 'falcon', 'meadow', 'granite', 'velvet',
         'harbor', 'cinder', 'tundra', 'willow', 'pepper', 'quartz', 'saffron', 'thistle', 'ember']

# ---------------------------------------------------------------- rendering


def font(path, size):
    return ImageFont.truetype(path, size)


def render_page(r, lines, *, width=1240, height=None, mono=False, size=None, italic=False, margin=80,
                bg=255, fg=0, title_size=None):
    fpath = r.choice(MONO if mono else (ITALIC if italic else FONTS))
    size = size or r.randint(24, 32)
    f = font(fpath, size)
    longest = max((f.getlength(l) for l in lines), default=1)
    while longest > width - 2 * margin and size > 12:
        size -= 1
        f = font(fpath, size)
        longest = max(f.getlength(l) for l in lines)
    lh = int(size * 1.45)
    height = height or max(600, 2 * margin + lh * len(lines))
    img = Image.new('L', (width, height), bg)
    d = ImageDraw.Draw(img)
    y = margin
    for i, line in enumerate(lines):
        ff = f
        if i == 0 and title_size:
            ff = font(fpath, title_size)
        d.text((margin, y), line, font=ff, fill=fg)
        y += lh if ff is f else int(title_size * 1.4)
        if y > height - margin:
            break
    return img


def render_screenshot(r, title, lines, mono=False):
    w, h = r.choice([(1280, 800), (1440, 900), (1170, 1800), (1080, 1920)])
    img = Image.new('RGB', (w, h), (250, 250, 252) if r.random() < 0.7 else (32, 34, 40))
    dark = img.getpixel((0, 0))[0] < 100
    d = ImageDraw.Draw(img)
    bar = (60, 90, 160) if not dark else (20, 20, 24)
    d.rectangle([0, 0, w, 70], fill=bar)
    tf = font(FONTS[0], 30)
    d.text((24, 18), title, font=tf, fill=(255, 255, 255))
    fpath = r.choice(MONO if mono else FONTS)
    size = r.randint(22, 30) if w < 1300 else r.randint(26, 34)
    f = font(fpath, size)
    while max(f.getlength(l) for l in lines) > w - 80 and size > 12:
        size -= 1
        f = font(fpath, size)
    y = 100
    fg = (20, 20, 20) if not dark else (225, 225, 225)
    for i, line in enumerate(lines):
        if i % 2 == 1 and not dark:
            d.rectangle([20, y - 4, w - 20, y + int(size * 1.3)], fill=(238, 240, 245))
        d.text((40, y), line, font=f, fill=fg)
        y += int(size * 1.6)
        if y > h - 40:
            break
    return img


def degrade(r, img, level):
    """Make an image look scanned or photographed. Returns (image, params)."""
    p = {'level': level}
    img = img.convert('L') if img.mode != 'L' else img
    if level == 'clean':
        p['rotation'] = 0
        return img, p
    # contrast
    if level in ('scan', 'photo', 'hard'):
        lo = r.choice([0, 0, 30, 70, 110]) if level != 'hard' else r.choice([90, 120, 140])
        hi = r.choice([255, 240, 225]) if level != 'hard' else r.choice([215, 200, 190])
        p['contrast'] = [lo, hi]
        arr = np.asarray(img).astype(np.float32) / 255.0
        arr = lo + arr * (hi - lo)
        img = Image.fromarray(arr.clip(0, 255).astype(np.uint8))
    # rotation
    roll = r.random()
    if level == 'scan':
        ang = r.uniform(-3, 3)
    elif level == 'photo':
        ang = r.uniform(-8, 8)
    else:
        ang = r.uniform(-12, 12)
    if roll < 0.08 and level != 'scan':
        ang += r.choice([90, 180, 270])
    p['rotation'] = round(ang, 2)
    fill = int(np.asarray(img)[0:5, 0:5].mean())
    if level in ('photo', 'hard'):
        fill = r.randint(60, 140)
    img = img.rotate(ang, resample=Image.BICUBIC, expand=True, fillcolor=fill)
    # lighting gradient (photos)
    arr = np.asarray(img).astype(np.float32)
    nr = np.random.default_rng(r.getrandbits(32))
    if level in ('photo', 'hard'):
        hgt, wid = arr.shape
        gx = np.linspace(r.uniform(0.75, 1.0), r.uniform(0.75, 1.0), wid)[None, :]
        gy = np.linspace(r.uniform(0.8, 1.0), r.uniform(0.7, 1.0), hgt)[:, None]
        arr = arr * gx * gy
    sigma = {'scan': r.uniform(4, 12), 'photo': r.uniform(8, 20), 'hard': r.uniform(15, 30)}[level]
    p['noise'] = round(sigma, 1)
    arr = arr + nr.normal(0, sigma, arr.shape)
    # speckle
    if level != 'scan' or r.random() < 0.5:
        mask = nr.random(arr.shape) < 0.002
        arr[mask] = nr.choice([0, 255], size=mask.sum())
    img = Image.fromarray(arr.clip(0, 255).astype(np.uint8))
    blur = {'scan': r.uniform(0, 0.8), 'photo': r.uniform(0.4, 1.4), 'hard': r.uniform(1.0, 2.0)}[level]
    p['blur'] = round(blur, 2)
    if blur > 0.05:
        img = img.filter(ImageFilter.GaussianBlur(blur))
    if level in ('photo', 'hard'):
        scale = r.uniform(0.6, 0.9) if level == 'photo' else r.uniform(0.45, 0.7)
        p['scale'] = round(scale, 2)
        img = img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))), Image.BILINEAR)
    return img, p


def save_image(img, path, r, fmt):
    if fmt == 'jpg':
        q = r.randint(45, 88)
        img.convert('L' if img.mode == 'L' else 'RGB').save(path, 'JPEG', quality=q, optimize=False)
    else:
        img.save(path, 'PNG', optimize=False)


def save_pdf_scan(pages, path):
    pages = [p.convert('L') for p in pages]
    import time
    fixed = time.strptime('2026-01-01', '%Y-%m-%d')  # PIL stamps the current time otherwise
    pages[0].save(path, 'PDF', resolution=150.0, save_all=True, append_images=pages[1:], creationDate=fixed, modDate=fixed)


def save_pdf_text(lines, path, r, title=None):
    c = canvas.Canvas(path, pagesize=A4, invariant=1)
    face = r.choice(['Helvetica', 'Times-Roman', 'Courier'])
    size = 10 if face == 'Courier' else 11
    w, h = A4
    y = h - 60
    if title:
        c.setTitle(title)
    for i, line in enumerate(lines):
        if y < 60:
            c.showPage()
            y = h - 60
        c.setFont(face + ('' if i else ''), size if i else size + 3)
        c.drawString(50, y, line[:110])
        y -= size * 1.5
    c.save()


# ---------------------------------------------------------------- documents
# Each builder returns dict(lines=[...], kind=..., topics=[...], rings=[...],
# formats=[...preferred formats...], name_hint=str, extra={})


def doc(lines, kind, rings, topics=(), name=None, mono=False, hard_negative=False, ext='txt', title=None, **extra):
    return dict(lines=lines, kind=kind, rings=list(rings), topics=list(topics), name=name, mono=mono,
                hard_negative=hard_negative, ext=ext, title=title, extra=extra)


def slug(s):
    return ''.join(c if c.isalnum() else '-' for c in s.lower()).strip('-').replace('--', '-')


# ---- finance

def bank_statement(r):
    bank = r.choice(BANKS)
    who = person(r)
    us = r.random() < 0.4
    lines = [f'{bank}', 'Account Statement', '', who] + address(r) + ['']
    if us:
        lines += [f'Account number: {digits(r, r.randint(9, 12))}', f'Routing number: {aba_routing(r)}']
    else:
        lines += [f'IBAN: {iban(r)}', f'BIC: {alnum(r, 4, string.ascii_uppercase)}{r.choice(["DE", "GB", "FR", "NL"])}{alnum(r, 2, string.ascii_uppercase)}XXX']
    bal = r.uniform(200, 20000)
    lines += [f'Statement period: {date(r)} to {date(r)}', f'Opening balance: {bal:,.2f}', '',
              'Date        Description                         Amount']
    for _ in range(r.randint(5, 14)):
        amt = r.uniform(-900, 600)
        bal += amt
        desc = r.choice(['Card payment ' + r.choice(SHOPS), 'Direct debit ' + r.choice(['Energy Co', 'Phone Ltd', 'Gym']),
                         'Transfer from ' + person(r), 'Salary ' + r.choice(EMPLOYERS), 'ATM withdrawal', 'Standing order rent'])
        lines.append(f'{date(r)}  {desc[:34]:<34}  {amt:>10,.2f}')
    lines += ['', f'Closing balance: {bal:,.2f}']
    return doc(lines, 'bank-statement', ['ring:finance'], [f'topic:company:{slug(bank)}'], name='statement')


def card_statement(r):
    bank = r.choice(BANKS)
    num = card_number(r)
    masked = r.random() < 0.55
    shown = ('XXXX XXXX XXXX ' + num[-4:]) if masked else fmt_card(num, r)
    lines = [f'{bank} Credit Card', 'Monthly statement', person(r), f'Card number: {shown}',
             f'Credit limit: {money(r, 1000, 15000)}', f'Minimum payment due: {money(r, 25, 300)}',
             f'Payment due date: {date(r)}', '', 'Transactions']
    for _ in range(r.randint(4, 10)):
        lines.append(f'{date(r)}  {r.choice(SHOPS):<24} {money(r, 3, 400):>10}')
    lines += ['', f'New balance: {money(r, 100, 6000)}', 'Interest rate (APR): 23.9%']
    return doc(lines, 'card-statement', ['ring:finance'], [f'topic:company:{slug(bank)}'], name='card-statement', masked=masked)


def brokerage_statement(r):
    b = r.choice(BROKERS)
    lines = [b, 'Quarterly Portfolio Statement', person(r), f'Account No. {alnum(r, 2, string.ascii_uppercase)}-{digits(r, 8)}', '',
             'Holding                 Shares     Price      Market value']
    total = 0
    for t in r.sample(['VTX World Index Fund', 'Acme Robotics Inc', 'Greyhaven Utilities', 'Orbital Freight Co',
                       'Global Bond ETF', 'Pinecone Analytics', 'Copperleaf Studios', 'Emerging Mkts Fund'], r.randint(3, 7)):
        sh = r.randint(1, 400)
        pr = r.uniform(5, 400)
        total += sh * pr
        lines.append(f'{t:<24}{sh:>6}  {pr:>9.2f}  {sh * pr:>12,.2f}')
    lines += ['', f'Total portfolio value: {total:,.2f}', f'Dividends this quarter: {money(r, 5, 900)}',
              f'Realised gains (year to date): {money(r, 0, 4000)}']
    return doc(lines, 'brokerage-statement', ['ring:finance'], [f'topic:company:{slug(b)}'], name='portfolio')


def tax_form(r):
    full_ssn = r.random() < 0.5
    s = ssn(r)
    shown = s if full_ssn else 'XXX-XX-' + s[-4:]
    emp = r.choice(EMPLOYERS)
    kind = r.choice(['W-2 Wage and Tax Statement', 'Form 1099-DIV Dividends', 'Form 1040 summary'])
    lines = [kind, f'Tax year {r.randint(2020, 2025)}', f"Employee's social security number: {shown}",
             f'Employer identification number (EIN): {digits(r, 2)}-{digits(r, 7)}', f'Employer: {emp}', person(r)] + address(r) + [
        f'Wages, tips, other compensation: {money(r, 20000, 180000)}',
        f'Federal income tax withheld: {money(r, 2000, 40000)}', f'Social security wages: {money(r, 20000, 160000)}',
        f'Medicare tax withheld: {money(r, 300, 3000)}', f'State: {r.choice(STATES)}']
    rings = ['ring:finance'] + (['ring:identity'] if full_ssn else [])
    return doc(lines, 'tax-form', rings, ['topic:project:taxes'], name='tax')


def payslip(r):
    emp = r.choice(EMPLOYERS)
    uk = r.random() < 0.5
    gross = r.uniform(2000, 9000)
    lines = [emp, 'Payslip', f'Employee: {person(r)}', f'Pay date: {date(r)}']
    rings = ['ring:finance']
    if uk:
        if r.random() < 0.6:
            lines.append(f'NI number: {nino(r)}')
            rings.append('ring:identity')
        lines += [f'Tax code: {r.randint(1000, 1300)}L']
    lines += [f'Gross pay: {gross:,.2f}', f'Income tax: {gross * 0.2:,.2f}', f'National insurance: {gross * 0.08:,.2f}' if uk else f'FICA: {gross * 0.0765:,.2f}',
              f'Pension contribution: {gross * 0.05:,.2f}', f'Net pay: {gross * 0.67:,.2f}',
              f'Paid to account ending {digits(r, 4)}']
    return doc(lines, 'payslip', rings, [f'topic:company:{slug(emp)}'], name='payslip')


def wire_confirmation(r):
    lines = ['International transfer confirmation', f'Reference: TRX{digits(r, 10)}', f'From: {person(r)}',
             f'Debit account IBAN: {iban(r)}', f'Beneficiary: {person(r)}', f'Beneficiary IBAN: {iban(r)}',
             f'Amount: EUR {money(r, 100, 25000)}', f'Value date: {date(r)}', 'Charges: shared (SHA)',
             'Purpose: ' + r.choice(['Rent deposit', 'Family support', 'Invoice 2291', 'House purchase deposit'])]
    return doc(lines, 'transfer', ['ring:finance'], name='transfer')


def loan_letter(r):
    bank = r.choice(BANKS)
    lines = [bank, f'Dear {person(r)},', '', 'Re: Your mortgage account ' + digits(r, 10), '',
             f'Your outstanding balance is {money(r, 50000, 600000)}. From {date(r)} your monthly',
             f'repayment will change to {money(r, 600, 3500)} following the change in our standard',
             f'variable rate to {r.uniform(3, 7):.2f}%. Your remaining term is {r.randint(5, 30)} years.',
             '', 'If you are in arrears or expect difficulty paying, please call us.', '', 'Mortgage Servicing Team']
    return doc(lines, 'loan-letter', ['ring:finance'], [f'topic:company:{slug(bank)}'], name='mortgage-letter')


def card_photo(r):
    num = card_number(r)
    lines = [r.choice(BANKS).upper(), '', fmt_card(num, r).replace('-', ' '), '',
             f'VALID THRU {r.randint(1, 12):02d}/{r.randint(27, 31)}', person(r).upper()]
    return doc(lines, 'card-photo', ['ring:finance'], name='card', force='card')


def cheque(r):
    lines = [r.choice(BANKS), f'Pay {person(r)}', f'The sum of {r.choice(["two hundred", "one thousand", "eighty-five"])} dollars only',
             f'Date {date(r)}', 'Signature ____________',
             f'C{digits(r, 6)}C A{aba_routing(r)}A {digits(r, 10)}C']
    return doc(lines, 'cheque', ['ring:finance'], name='cheque')


FINANCE = [(bank_statement, 40), (card_statement, 25), (brokerage_statement, 20), (tax_form, 20), (payslip, 20),
           (wire_confirmation, 12), (loan_letter, 10), (card_photo, 15), (cheque, 8)]

# ---- identity


def passport(r):
    sur, giv = r.choice(LAST), r.choice(FIRST)
    code, cname = r.choice(COUNTRIES)
    l1, l2, pno, dob, exp, sex = mrz_td3(r, sur, giv, code)
    lines = [f'PASSPORT  {cname}', f'Type P   Code {code}   Passport No. {pno}', f'Surname: {sur.upper()}',
             f'Given names: {giv.upper()}', f'Nationality: {cname}', f'Date of birth: {dob[4:6]}.{dob[2:4]}.19{dob[0:2]}',
             f'Sex: {sex}   Place of birth: {r.choice(TOWNS).upper()}', f'Date of expiry: {exp[4:6]}.{exp[2:4]}.20{exp[0:2]}',
             '', l1, l2]
    return doc(lines, 'passport', ['ring:identity'], name='passport', force='id', mrz=True)


def id_card(r):
    sur, giv = r.choice(LAST), r.choice(FIRST)
    code, cname = r.choice(COUNTRIES)
    l1, l2, l3, dno = mrz_td1(r, sur, giv, code)
    lines = [f'{cname} NATIONAL IDENTITY CARD', f'Surname {sur.upper()}', f'Given names {giv.upper()}',
             f'Date of birth {date_dmy(r)}', f'Document no. {dno}', f'Expiry {date_dmy(r, 2027, 2035)}', '', l1, l2, l3]
    return doc(lines, 'id-card', ['ring:identity'], name='id', force='id', mrz=True)


def drivers_license(r):
    st = r.choice(STATES)
    lines = [f'{st.upper()} DRIVER LICENSE', f'DL {alnum(r, 1, string.ascii_uppercase)}{digits(r, 7)}', f'EXP {date_dmy(r, 2027, 2033)}',
             f'LN {r.choice(LAST).upper()}', f'FN {r.choice(FIRST).upper()}', f'DOB {date_dmy(r)}'] + [a.upper() for a in address(r)] + [
        f'CLASS {r.choice("CDM")}  SEX {r.choice("MF")}  HGT 5-{r.randint(1, 11):02d}  EYES {r.choice(["BRN", "BLU", "GRN"])}']
    return doc(lines, 'drivers-license', ['ring:identity'], name='license', force='id')


def ssn_card(r):
    lines = ['SOCIAL SECURITY', 'THIS NUMBER HAS BEEN ESTABLISHED FOR', person(r).upper(), '', ssn(r), '', 'SIGNATURE']
    return doc(lines, 'ssn-card', ['ring:identity'], name='ss-card', force='id')


def birth_certificate(r):
    lines = ['CERTIFIED COPY OF AN ENTRY OF BIRTH', f'Registration district: {r.choice(TOWNS)}',
             f'Date and place of birth: {date_dmy(r)}, {r.choice(CLINICS)}', f'Name and surname: {person(r)}',
             f'Sex: {r.choice(["Male", "Female"])}', f'Father: {person(r)}', f'Mother: {person(r)}, maiden surname {r.choice(LAST)}',
             f'Entry No. {digits(r, 3)}   Certificate No. {alnum(r, 3, string.ascii_uppercase)} {digits(r, 6)}']
    return doc(lines, 'birth-certificate', ['ring:identity'], name='birth-cert')


def residence_permit(r):
    lines = ['RESIDENCE PERMIT', f'Name: {person(r)}', f'Nationality: {r.choice(COUNTRIES)[1]}', f'Permit number: {alnum(r, 2, string.ascii_uppercase)}{digits(r, 7)}',
             f'Valid until: {date_dmy(r, 2026, 2031)}', 'Type of permit: Settled status', f'Date of birth: {date_dmy(r)}',
             'Remarks: Employment permitted']
    return doc(lines, 'residence-permit', ['ring:identity'], name='permit')


def kyc_form(r):
    lines = ['Customer identity verification', f'Full legal name: {person(r)}', f'Date of birth: {date_dmy(r)}',
             f'Social Security Number: {ssn(r)}' if r.random() < 0.5 else f'National Insurance number: {nino(r)}',
             f'Passport number: {alnum(r, 9, string.ascii_uppercase + string.digits)}', 'Address:'] + address(r) + [
        'Document checked: passport (original seen)', f'Checked by: {person(r)}  on {date(r)}']
    return doc(lines, 'kyc-form', ['ring:identity'], name='verification')


IDENTITY = [(passport, 25), (id_card, 18), (drivers_license, 18), (ssn_card, 10), (birth_certificate, 10),
            (residence_permit, 9), (kyc_form, 12)]

# ---- health


def referral_letter(r):
    c = r.choice(CLINICS)
    cond = r.choice(CONDITIONS)
    med, dose = r.choice(MEDS)
    uk = r.random() < 0.4
    lines = [c, f'Dear Dr {r.choice(LAST)},', '', f'Re: {person(r)}, DOB {date_dmy(r)}' + (f', NHS No. {nhs_number(r)}' if uk else f', MRN {digits(r, 8)}'),
             '', f'Thank you for seeing this patient, whom I am referring with {cond}.',
             f'Symptoms began about {r.randint(2, 30)} weeks ago. Examination today showed',
             f'blood pressure {r.randint(110, 170)}/{r.randint(70, 100)} and pulse {r.randint(55, 110)}.',
             f'Current medication: {med} {dose}.', 'I would be grateful for your assessment and advice on management.',
             '', 'Yours sincerely,', f'Dr {person(r)}']
    return doc(lines, 'medical-letter', ['ring:health'], ['topic:thing:health'], name='letter')


def lab_results(r):
    lines = ['LABORATORY REPORT', f'Patient: {person(r)}   DOB: {date_dmy(r)}   MRN: {digits(r, 8)}', f'Collected: {date(r)}',
             'Test                 Result    Units     Reference range']
    for t, u, lo, hi in r.sample([('Haemoglobin', 'g/dL', 12, 17), ('Ferritin', 'ng/mL', 15, 300), ('HbA1c', '%', 4, 6),
                                  ('TSH', 'mIU/L', 0.4, 4), ('Cholesterol', 'mmol/L', 3, 5), ('ALT', 'U/L', 7, 56),
                                  ('Creatinine', 'umol/L', 60, 110), ('CRP', 'mg/L', 0, 5)], r.randint(3, 7)):
        v = r.uniform(lo * 0.6, hi * 1.5)
        lines.append(f'{t:<20} {v:>7.1f}   {u:<8}  {lo}-{hi}' + ('  H' if v > hi else ('  L' if v < lo else '')))
    lines += ['', f'Comment: {r.choice(["Results discussed with patient.", "Repeat in 3 months.", "Refer to GP for review."])}']
    return doc(lines, 'lab-results', ['ring:health'], name='results')


def prescription(r):
    med, dose = r.choice(MEDS)
    lines = [r.choice(CLINICS), 'PRESCRIPTION', f'Patient: {person(r)}', f'Date of birth: {date_dmy(r)}', '',
             f'Rx: {med}', f'Sig: {dose}', f'Quantity: {r.choice([28, 30, 56, 90])}', f'Refills: {r.randint(0, 5)}', '',
             f'Prescriber: Dr {person(r)}', f'Diagnosis code: {r.choice(ICD)}']
    return doc(lines, 'prescription', ['ring:health'], name='rx')


def discharge_summary(r):
    cond = r.choice(CONDITIONS)
    lines = [r.choice(CLINICS), 'Discharge summary', f'Patient: {person(r)}', f'Admitted: {date(r)}   Discharged: {date(r)}',
             f'Primary diagnosis: {cond} ({r.choice(ICD)})', 'Procedures: ' + r.choice(['none', 'ECG, chest X-ray', 'MRI lumbar spine', 'endoscopy']),
             'Follow-up: outpatient clinic in 6 weeks', 'Medication on discharge:'] + [f'  {m} {d}' for m, d in r.sample(MEDS, 2)]
    return doc(lines, 'discharge-summary', ['ring:health'], name='discharge')


def therapy_notes(r):
    lines = [f'Session notes - {date(r)}', f'Client: {r.choice(FIRST)} {r.choice(LAST)[0]}.',
             'Presenting: low mood, poor sleep, worry about work.', f'PHQ-9 score: {r.randint(5, 22)}   GAD-7: {r.randint(4, 18)}',
             'Discussed: cognitive restructuring; sleep hygiene; behavioural activation plan.',
             'Risk: no current suicidal ideation reported.', 'Plan: continue weekly CBT sessions; review medication with GP.']
    return doc(lines, 'therapy-notes', ['ring:health'], name='session-notes')


def vaccination_record(r):
    lines = ['Immunisation record', f'Name: {person(r)}   DOB: {date_dmy(r)}']
    for v in r.sample(['MMR', 'Tetanus/diphtheria', 'Hepatitis B', 'Influenza', 'COVID-19', 'HPV', 'Yellow fever'], 4):
        lines.append(f'{v:<22} {date(r, 1995, 2025)}  batch {alnum(r, 6, string.ascii_uppercase + string.digits)}')
    lines.append('Administered at: ' + r.choice(CLINICS))
    return doc(lines, 'vaccination-record', ['ring:health'], name='vaccinations')


def insurance_eob(r):
    lines = ['Explanation of Benefits - THIS IS NOT A BILL', f'Member: {person(r)}', f'Member ID: {alnum(r, 3, string.ascii_uppercase)}{digits(r, 9)}',
             f'Provider: {r.choice(CLINICS)}', f'Service date: {date(r)}', f'Service: {r.choice(["Office visit", "MRI scan", "Physical therapy", "Blood panel"])}',
             f'Diagnosis: {r.choice(ICD)}', f'Billed: {money(r, 100, 3000)}  Plan paid: {money(r, 50, 2000)}  You owe: {money(r, 10, 500)}']
    return doc(lines, 'insurance-eob', ['ring:health'], name='eob')


def sick_note(r):
    lines = ['Statement of fitness for work', f'Patient: {person(r)}', f'I assessed your case on {date(r)} and, because of',
             f'{r.choice(CONDITIONS)}, I advise that you are not fit for work for {r.randint(1, 6)} weeks.', f'Doctor: Dr {person(r)}',
             r.choice(CLINICS)]
    return doc(lines, 'fit-note', ['ring:health'], name='fit-note')


HEALTH = [(referral_letter, 22), (lab_results, 18), (prescription, 15), (discharge_summary, 12), (therapy_notes, 12),
          (vaccination_record, 10), (insurance_eob, 12), (sick_note, 9)]

# ---- intimate (private personal writing; kept tasteful)


LOVE = ['I keep thinking about the evening by the harbour, when you laughed at my terrible map reading.',
        'Every time you are away the flat is too quiet and I find myself saving up things to tell you.',
        'I know we said we would take things slowly, but I think I am falling for you completely.',
        'Thank you for staying with me through the worst of this year. I could not have done it alone.',
        'I miss the weight of your hand in mine on the walk home.',
        'Please keep this just between us - nobody else knows how I feel yet.',
        'I have never written a letter like this before, so forgive me if it comes out clumsy.',
        'When you held me at the station I wanted the train to never arrive.']
DIARY = ['We argued again tonight about whether to try for a baby. I cried in the bathroom afterwards.',
         'I think I am still in love with M. even though it has been two years.',
         'Told my sister about the separation. She was kinder than I expected.',
         'Our counsellor asked us to write down what we need from each other. I did not know what to write.',
         'I finally said it out loud: I am gay. My hands were shaking.',
         'I feel guilty that I am relieved he moved out.',
         'Date with R. went well. Nervous about what it means. Not telling anyone yet.',
         'I keep rereading her old messages. I should delete them but I cannot.']


def love_letter(r):
    to, frm = r.choice(FIRST), r.choice(FIRST)
    lines = [r.choice(['My dearest', 'Dear', 'My love,', 'Darling']) + f' {to},', ''] + r.sample(LOVE, r.randint(3, 5)) + [
        '', r.choice(['All my love,', 'Yours, always,', 'Forever yours,', 'With love,']), frm]
    return doc(lines, 'private-letter', ['ring:intimate'], name='letter', italic=True)


def diary(r):
    lines = [f'{date(r)}', ''] + r.sample(DIARY, r.randint(2, 4)) + ['', r.choice(['Must remember to breathe.', 'Tomorrow is another day.', 'Private.'])]
    return doc(lines, 'diary', ['ring:intimate'], name='journal', italic=True)


def relationship_note(r):
    lines = [r.choice(['Things I want to say to you', 'Notes before our talk', 'For couples counselling']), ''] + [
        '- ' + s for s in r.sample(['I feel lonely even when we are together.', 'I want us to be honest about the affair.',
                                    'I still find you attractive and I miss being close.', 'I need you to stop checking my phone.',
                                    'I am scared that we want different things.', 'I forgive you, but I have not forgotten.',
                                    'I want to talk about our sex life without it turning into a fight.'], 4)]
    return doc(lines, 'private-note', ['ring:intimate'], name='notes')


INTIMATE = [(love_letter, 32), (diary, 30), (relationship_note, 18)]

# ---- credentials (the dedicated set)


def recovery_codes(r):
    svc = r.choice(SERVICES)
    style = r.random()
    codes = []
    for _ in range(r.choice([8, 10, 16])):
        if style < 0.4:
            codes.append(f'{alnum(r, 4, string.ascii_lowercase + string.digits)}-{alnum(r, 4, string.ascii_lowercase + string.digits)}')
        elif style < 0.7:
            codes.append(digits(r, 8))
        else:
            codes.append(f'{alnum(r, 5, string.ascii_uppercase + string.digits)}-{alnum(r, 5, string.ascii_uppercase + string.digits)}')
    header = r.choice([f'{svc} recovery codes', f'{svc} backup codes', f'Two-factor backup codes for {svc}',
                       f'{svc} - emergency codes', 'Save these codes'])
    lines = [header, f'Account: {r.choice(FIRST).lower()}{r.randint(1, 99)}@example.com', '',
             'Keep these somewhere safe. Each code can be used once.', ''] + (
        [f'{i + 1}. {c}' for i, c in enumerate(codes)] if r.random() < 0.5 else codes) + ['', f'Generated {date(r)}']
    if r.random() < 0.25:  # bare list with a cryptic header
        lines = [svc.lower()] + codes
    return doc(lines, 'recovery-codes', ['ring:credentials'], name=r.choice([f'{slug(svc)}-recovery-codes', 'codes', 'backup', f'{slug(svc)}']))


def pw_export(r):
    fmt = r.choice(['bitwarden', '1password', 'chrome', 'lastpass', 'keepass'])
    n = r.randint(5, 25)
    rows = [(r.choice(SITES), r.choice(FIRST).lower() + '@example.com', password(r)) for _ in range(n)]
    if fmt == 'bitwarden':
        lines = ['folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp'] + [
            f',,login,{s},,,0,https://{s},{u},{p},' for s, u, p in rows]
    elif fmt == '1password':
        lines = ['Title,Url,Username,Password,Notes,OTPAuth'] + [f'{s},https://{s}/login,{u},{p},,' for s, u, p in rows]
    elif fmt == 'chrome':
        lines = ['name,url,username,password,note'] + [f'{s},https://{s}/,{u},{p},' for s, u, p in rows]
    elif fmt == 'lastpass':
        lines = ['url,username,password,totp,extra,name,grouping,fav'] + [f'https://{s},{u},{p},,,{s},Personal,0' for s, u, p in rows]
    else:
        lines = ['"Group","Title","Username","Password","URL","Notes"'] + [f'"Root","{s}","{u}","{p}","https://{s}",""' for s, u, p in rows]
    return doc(lines, 'password-export', ['ring:credentials'], name=r.choice(['export', 'passwords', f'{fmt}_export', 'vault']), ext='csv', mono=True)


def pem_key(r):
    kind = r.choice(['RSA PRIVATE KEY', 'PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY', 'PGP PRIVATE KEY BLOCK'])
    body_lines = r.randint(6, 26)
    if kind == 'PGP PRIVATE KEY BLOCK':
        lines = ['-----BEGIN PGP PRIVATE KEY BLOCK-----', ''] + [b64(r, 64) for _ in range(body_lines)] + [f'={b64(r, 4)}', '-----END PGP PRIVATE KEY BLOCK-----']
    else:
        lines = [f'-----BEGIN {kind}-----'] + [b64(r, 64) for _ in range(body_lines)] + [b64(r, r.randint(8, 60)) + '=', f'-----END {kind}-----']
    name = r.choice(['id_rsa', 'id_ed25519', 'server.key', 'deploy-key', 'private', 'key', 'signing'])
    ext = r.choice(['', 'pem', 'key', 'txt'])
    return doc(lines, 'private-key', ['ring:credentials'], name=name, ext=ext, mono=True)


def api_key_text(r):
    k = r.choice(['aws', 'github', 'stripe', 'slack', 'openai', 'google', 'gitlab', 'twilio', 'sendgrid', 'generic', 'npm', 'jwt'])
    if k == 'aws':
        pairs = [('AWS_ACCESS_KEY_ID', 'AKIA' + alnum(r, 16, string.ascii_uppercase + string.digits)),
                 ('AWS_SECRET_ACCESS_KEY', alnum(r, 40, string.ascii_letters + string.digits + '/+'))]
    elif k == 'github':
        pairs = [('GITHUB_TOKEN', r.choice(['ghp_', 'gho_', 'ghs_']) + alnum(r, 36)) if r.random() < 0.7 else ('GH_PAT', 'github_pat_' + alnum(r, 22) + '_' + alnum(r, 59))]
    elif k == 'stripe':
        pairs = [('STRIPE_SECRET_KEY', r.choice(['sk_live_', 'rk_live_']) + alnum(r, 24))]
    elif k == 'slack':
        pairs = [('SLACK_BOT_TOKEN', f'xoxb-{digits(r, 11)}-{digits(r, 12)}-{alnum(r, 24)}')]
    elif k == 'openai':
        pairs = [('LLM_API_KEY', 'sk-proj-' + alnum(r, 48, string.ascii_letters + string.digits + '_-'))]
    elif k == 'google':
        pairs = [('MAPS_API_KEY', 'AIza' + alnum(r, 35, string.ascii_letters + string.digits + '_-'))]
    elif k == 'gitlab':
        pairs = [('GITLAB_TOKEN', 'glpat-' + alnum(r, 20, string.ascii_letters + string.digits + '_-'))]
    elif k == 'twilio':
        pairs = [('TWILIO_ACCOUNT_SID', 'AC' + hexs(r, 32)), ('TWILIO_AUTH_TOKEN', hexs(r, 32))]
    elif k == 'sendgrid':
        pairs = [('SENDGRID_API_KEY', 'SG.' + alnum(r, 22, string.ascii_letters + string.digits + '_-') + '.' + alnum(r, 43, string.ascii_letters + string.digits + '_-'))]
    elif k == 'npm':
        pairs = [('NPM_TOKEN', 'npm_' + alnum(r, 36))]
    elif k == 'jwt':
        hdr = base64.urlsafe_b64encode(b'{"alg":"HS256","typ":"JWT"}').decode().rstrip('=')
        pairs = [('SESSION_TOKEN', f'{hdr}.{alnum(r, 60, string.ascii_letters + string.digits + "_-")}.{alnum(r, 43, string.ascii_letters + string.digits + "_-")}')]
    else:
        pairs = [(r.choice(['DB_PASSWORD', 'API_SECRET', 'ADMIN_PASSWORD', 'SECRET_KEY']), password(r) if r.random() < 0.5 else alnum(r, 32))]
    style = r.choice(['env', 'env', 'yaml', 'json', 'note', 'shell'])
    if style == 'env':
        lines = ['# production settings'] + [f'{a}={b}' for a, b in pairs] + ['LOG_LEVEL=info', f'PORT={r.randint(3000, 9000)}']
        ext, name = '', '.env' if r.random() < 0.5 else 'prod.env'
    elif style == 'yaml':
        lines = ['service:', f'  name: {r.choice(WORDS)}-api', '  credentials:'] + [f'    {a.lower()}: "{b}"' for a, b in pairs]
        ext, name = 'yaml', 'config'
    elif style == 'json':
        lines = ['{'] + [f'  "{a.lower()}": "{b}",' for a, b in pairs] + ['  "region": "eu-west-1"', '}']
        ext, name = 'json', 'credentials'
    elif style == 'shell':
        lines = ['#!/bin/sh'] + [f'export {a}="{b}"' for a, b in pairs] + ['./deploy.sh --prod']
        ext, name = 'sh', 'deploy-env'
    else:
        lines = [r.choice(['keys for the new project', 'note to self', 'dont lose this', 'from the dashboard'])] + [f'{a.lower().replace("_", " ")}: {b}' for a, b in pairs]
        ext, name = 'txt', r.choice(['notes', 'keys', 'todo', 'misc'])
    return doc(lines, 'api-key', ['ring:credentials'], name=name, ext=ext, mono=True, key_type=k)


def seed_phrase(r, bip):
    n = r.choice([12, 12, 24, 18])
    words = [r.choice(bip) for _ in range(n)]
    style = r.random()
    if style < 0.35:
        lines = [r.choice(['Recovery phrase', 'Wallet seed - DO NOT SHARE', 'Secret Recovery Phrase', 'backup']), ''] + [f'{i + 1}. {w}' for i, w in enumerate(words)]
    elif style < 0.7:
        lines = [' '.join(words[i:i + 6]) for i in range(0, n, 6)]
    else:
        lines = [r.choice(['wallet', 'ledger backup', 'metamask', 'cold storage'])] + [' '.join(f'{i + j + 1:>2} {words[i + j]:<10}' for j in range(3)) for i in range(0, n, 3)]
    return doc(lines, 'seed-phrase', ['ring:credentials'], name=r.choice(['seed', 'wallet', 'backup-words', 'words', 'important']))


def totp_secret(r):
    secret = alnum(r, 32, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')
    svc = r.choice(SERVICES)
    lines = [f'{svc} 2FA setup', f'otpauth://totp/{svc}:{r.choice(FIRST).lower()}%40example.com?secret={secret}&issuer={svc}', '',
             f'Setup key: {" ".join(secret[i:i + 4] for i in range(0, 32, 4))}'] if r.random() < 0.6 else [
        f'{svc} authenticator key', f'{" ".join(secret[i:i + 4] for i in range(0, 32, 4))}']
    return doc(lines, 'totp-secret', ['ring:credentials'], name=r.choice(['2fa', 'authenticator', f'{slug(svc)}-totp']))


def password_note(r):
    lines = [r.choice(['Passwords', 'logins', 'Accounts', 'IMPORTANT - logins for mum'])] + [
        f'{r.choice(SITES)} - user: {r.choice(FIRST).lower()}{r.randint(1, 99)}  pw: {password(r)}' if r.random() < 0.5 else
        f'{r.choice(SERVICES)}: {password(r)}' for _ in range(r.randint(3, 10))]
    if r.random() < 0.3:
        lines += [f'wifi password: {password(r)}', f'phone PIN: {digits(r, 6)}']
    return doc(lines, 'password-list', ['ring:credentials'], name=r.choice(['logins', 'passwords', 'accounts', 'notes']))


def ssh_config_with_key(r):
    lines = ['# kubeconfig', 'apiVersion: v1', 'clusters:', '- cluster:', f'    certificate-authority-data: {b64(r, 80)}',
             f'    server: https://10.0.{r.randint(0, 9)}.{r.randint(1, 250)}:6443', 'users:', '- name: admin', '  user:',
             f'    client-key-data: {b64(r, 120)}', f'    token: {alnum(r, 40)}']
    return doc(lines, 'kubeconfig', ['ring:credentials'], name='kubeconfig', ext='yaml', mono=True)


# ---- ordinary, including hard negatives


def receipt(r):
    shop = r.choice(SHOPS)
    lines = [shop.upper(), r.choice(address(r)), f'{date(r)} {r.randint(7, 22):02d}:{r.randint(0, 59):02d}', '']
    total = 0
    for _ in range(r.randint(2, 9)):
        item = r.choice(['Milk 1L', 'Bread', 'Coffee beans', 'Batteries AA', 'Screws M4', 'Notebook', 'Apples 1kg', 'Fuel unleaded', 'Croissant', 'Paperback'])
        p = r.uniform(0.8, 40)
        total += p
        lines.append(f'{item:<20}{p:>8.2f}')
    lines += ['', f'TOTAL{total:>23.2f}', f'{r.choice(["VISA", "MASTERCARD", "DEBIT"])} ************{digits(r, 4)}',
              f'AUTH CODE {alnum(r, 6, string.ascii_uppercase + string.digits)}', 'THANK YOU FOR SHOPPING']
    return doc(lines, 'receipt', [], [f'topic:company:{slug(shop)}'], name='receipt')


def contract(r):
    a, b = r.choice(EMPLOYERS), r.choice(EMPLOYERS)
    lines = ['SERVICES AGREEMENT', f'This Agreement is made on {date(r)} between {a} ("Client") and {b} ("Supplier").',
             '1. Services. Supplier shall provide the services described in Schedule A.',
             f'2. Fees. Client shall pay the fees set out in Schedule B within {r.choice([14, 30, 45])} days of invoice.',
             '3. Confidentiality. Each party shall keep the other party\'s confidential information secret.',
             '4. Term. This Agreement continues for twelve months and renews unless terminated.',
             '5. Liability. Neither party is liable for indirect or consequential loss.',
             '6. Governing law. This Agreement is governed by the laws of the State of ' + r.choice(STATES) + '.',
             '', 'Signed for the Client ____________   Signed for the Supplier ____________']
    return doc(lines, 'contract', [], [f'topic:company:{slug(a)}'], name='agreement')


def note(r):
    lines = [r.choice(['Ideas', 'Weekend', 'Todo', 'Garden plans', 'Book list', 'Trip packing']), ''] + [
        '- ' + r.choice(['Repaint the fence', 'Call the plumber about the tap', 'Pick up dry cleaning', 'Plant tomatoes after the frost',
                         'Read "The Long Way Round"', 'Fix bike brakes', 'Order printer ink', 'Book table for Saturday',
                         'Sunscreen, adapters, charger', 'Ask Jordan about the climbing gym', 'Return library books'])
        for _ in range(r.randint(3, 8))]
    return doc(lines, 'note', [], name='note', ext=r.choice(['txt', 'md']))


def recipe(r, hard=False):
    dish = r.choice(['Lentil soup', 'Lemon drizzle cake', 'Shakshuka', 'Mushroom risotto', 'Banana bread', 'Chickpea curry'])
    lines = [dish, '', 'Ingredients:'] + [f'- {r.randint(1, 500)} g {i}' for i in r.sample(['flour', 'lentils', 'butter', 'sugar', 'rice', 'onion', 'tomatoes', 'chickpeas'], 4)] + [
        '', 'Method:', '1. Preheat the oven to 180C.', '2. Mix the dry ingredients, then fold in the wet.', '3. Cook for 25-35 minutes.']
    if hard:
        lines += ['', 'Notes: take into account that every oven differs - my account of the timing is approximate.',
                  'Balance the salt and acid at the end; the closing balance of flavours matters most.',
                  'This was my grandmother\'s statement dish. Serves 4, about 450 kcal and 12 mg sodium per 100 g.',
                  f'Recipe card no. {digits(r, 4)} {digits(r, 4)} {digits(r, 4)} {digits(r, 4)} from the 1987 club book.']
    return doc(lines, 'recipe', [], ['topic:thing:cooking'], name=slug(dish), hard_negative=hard, ext='md')


def code_file(r, hard=False):
    lang = r.choice(['py', 'ts', 'js', 'go'])
    lines = {
        'py': ['import hashlib', 'import uuid', '', 'def fingerprint(data: bytes) -> str:', '    return hashlib.sha256(data).hexdigest()', '',
               f'SAMPLE_ID = "{uuid4(r)}"', f'COMMIT = "{hexs(r, 40)}"', '', 'if __name__ == "__main__":', '    print(fingerprint(b"hello"))'],
        'ts': ['export interface User { id: string; name: string }', '', 'export function greet(u: User): string {', '  return `Hello, ${u.name}`;', '}',
               f'const FIXTURE_ID = "{uuid4(r)}";', f'// build {hexs(r, 12)}'],
        'js': ['const express = require("express");', 'const app = express();', 'app.get("/healthz", (req, res) => res.send("ok"));',
               f'app.listen(process.env.PORT || {r.randint(3000, 9000)});', f'// etag {hexs(r, 32)}'],
        'go': ['package main', '', 'import "fmt"', '', 'func main() {', '\tfmt.Println("hello")', '}', f'// checksum {hexs(r, 64)}'],
    }[lang]
    if hard:
        lines += r.choice([
            ['', '# Configure your key before running:', '# export API_KEY=your-api-key-here', 'API_KEY = os.environ.get("API_KEY", "<YOUR_API_KEY>")',
             'password = getpass.getpass("Password: ")  # never hard-code credentials'],
            ['', '// Stripe test card for local development (documented test number)', 'const TEST_CARD = "4242 4242 4242 4242";',
             'const TEST_EXP = "12/34"; // any future date', 'const aws = { accessKeyId: "AKIAIOSFODNN7EXAMPLE" } // AWS docs example'],
            ['', '-- schema', 'CREATE TABLE users (id uuid primary key, email text, password_hash text not null);',
             'CREATE TABLE accounts (account_number text, iban text, balance numeric);', '-- password_hash is argon2id; never store plaintext'],
            ['', '# test fixture: base64 of a PNG header, not a secret', f'PNG = "{base64.b64encode(bytes(range(48))).decode()}"',
             f'session_id = "{hexs(r, 32)}"  # random per test run'],
        ])
    return doc(lines, 'code', [], ['topic:project:side-project'], name=r.choice(['main', 'util', 'server', 'handler', 'fixtures']), ext=lang,
               mono=True, hard_negative=hard)


def uuid4(r):
    h = hexs(r, 32)
    return f'{h[:8]}-{h[8:12]}-4{h[13:16]}-{r.choice("89ab")}{h[17:20]}-{h[20:]}'


def meeting_notes(r, hard=False):
    lines = [f'Meeting notes {date(r)}', f'Attendees: {person(r)}, {person(r)}, {person(r)}', '',
             '- Q3 roadmap reviewed; shipping the export feature first', '- Hiring: two interviews next week',
             f'- Action: {r.choice(FIRST)} to draft the onboarding doc']
    if hard:
        lines += ['- Security: password reset flow needs rate limiting; rotate service credentials quarterly',
                  '- Discussed the account deletion process and how bank statements are imported in the finance app',
                  '- Recovery codes UX: show them once, ask the user to confirm they saved them',
                  '- Health check endpoint returns patient-friendly status page (for the clinic customer)']
    return doc(lines, 'meeting-notes', [], ['topic:project:work'], name='meeting', ext='md', hard_negative=hard)


def article(r):
    t = r.choice(['passport', 'seed', 'bank', 'health', 'love', 'id'])
    texts = {
        'passport': ['How to renew your passport', 'You will need your old passport, two photos and the form.',
                     'Photos must be 45 mm by 35 mm. Your date of birth and place of birth must match your birth certificate.',
                     'Processing takes about three weeks. The passport number changes on renewal.',
                     'Nationality questions are answered by the consulate.'],
        'seed': ['What is a seed phrase?', 'A wallet seed phrase is a list of 12 or 24 words that can restore a wallet.',
                 'Never type your recovery phrase into a website. Write it on paper and store it safely.',
                 'Anyone with the words can take your funds. Hardware wallets show the words once during setup.'],
        'bank': ['Five ways to cut bank fees', 'Check your statement every month for charges you did not expect.',
                 'Ask your bank about a fee-free current account. Keep a small balance as a buffer.',
                 'Card payments abroad often carry a 3% fee; an IBAN transfer may be cheaper.'],
        'health': ['Staying well this winter', 'Most colds clear up in a week. Drink fluids and rest.',
                   'Adults can take paracetamol 500 mg up to four times a day. See a doctor if symptoms last.',
                   'Flu vaccine clinics run every Saturday at the community centre.'],
        'love': ['Chapter 3', 'The ship came in at dawn and Elena waited on the pier with a letter she would never send.',
                 '"I love you," the captain said, though the wind took the words. She pretended not to hear.',
                 'In the hospital that winter, the doctor read to them both from the old diary.'],
        'id': ['New ID card rules from next year', 'Residents will be able to apply for the national identity card online.',
               'You will need proof of address and a recent photo. The card shows your name and date of birth.',
               'Driver licence holders can use their licence instead for most purposes.'],
    }[t]
    return doc(texts, 'article', [], name=slug(texts[0])[:40], ext=r.choice(['txt', 'md', 'html']), hard_negative=True, about=t)


def invoice(r):
    a = r.choice(EMPLOYERS)
    inv = digits(r, 16)
    lines = [a, 'INVOICE', f'Invoice number: {" ".join(inv[i:i + 4] for i in range(0, 16, 4))}', f'Order reference: {digits(r, 12)}',
             f'Date: {date(r)}', f'Bill to: {r.choice(EMPLOYERS)}', '', 'Description                Qty   Amount']
    for _ in range(r.randint(1, 5)):
        lines.append(f'{r.choice(["Consulting hours", "Licence renewal", "Freight handling", "Design work"]):<26}{r.randint(1, 40):>4}  {money(r, 50, 4000):>10}')
    lines += ['', f'Total due: {money(r, 200, 20000)}', f'Payment terms: {r.choice([14, 30])} days', f'VAT reg no. GB{digits(r, 9)}']
    return doc(lines, 'invoice', [], [f'topic:company:{slug(a)}'], name='invoice', hard_negative=True, luhn_valid_number=luhn_ok(inv))


def shipping_label(r):
    lines = ['PRIORITY PARCEL', f'TRACKING # 1Z{alnum(r, 6, string.ascii_uppercase + string.digits)}{digits(r, 10)}', f'SHIP TO: {person(r)}'] + address(r) + [
        f'WEIGHT {r.uniform(0.2, 12):.1f} KG', f'{digits(r, 4)} {digits(r, 4)} {digits(r, 4)} {digits(r, 4)} {digits(r, 4)} {digits(r, 2)}']
    return doc(lines, 'shipping-label', [], name='label', hard_negative=True)


def inventory_csv(r):
    lines = ['sku,name,qty,price'] + [f'{digits(r, r.choice([12, 13, 16]))},{r.choice(["Widget", "Gasket", "Bracket", "Hinge", "Cable"])} {r.randint(1, 99)},{r.randint(0, 500)},{money(r, 1, 90)}'
                                      for _ in range(r.randint(8, 25))]
    return doc(lines, 'spreadsheet', [], name='inventory', ext='csv', mono=True, hard_negative=True)


def ticket(r):
    lines = ['E-TICKET', f'Event: {r.choice(["Harbour Jazz Night", "City FC v Rovers", "Spring Science Fair"])}', f'Date: {date(r)}',
             f'Booking reference: {alnum(r, 6, string.ascii_uppercase + string.digits)}', f'Seat: Row {r.choice("ABCDEFGH")} Seat {r.randint(1, 30)}',
             f'Barcode: {digits(r, 13)}', 'Please present this ticket at the entrance.']
    return doc(lines, 'ticket', [], name='ticket', hard_negative=True)


def itinerary(r):
    lines = ['Travel itinerary', f'Traveller: {person(r)}', f'Flight {alnum(r, 2, string.ascii_uppercase)}{r.randint(100, 9999)}  {date(r)}  Depart 07:40',
             f'Hotel: {r.choice(TOWNS)} Grand, 3 nights, confirmation {digits(r, 9)}', 'Remember: passport, chargers, umbrella.']
    return doc(lines, 'itinerary', [], name='trip', hard_negative=True)


def bank_marketing(r):
    bank = r.choice(BANKS)
    lines = [bank, 'Open a savings account today!', 'Earn 4.1% AER on balances up to 10,000.',
             'Already a customer? Log in to online banking and move money in seconds.',
             'No account number needed to apply - just your name, address and email.', 'Terms apply. Representative example: APR 0%.']
    return doc(lines, 'advert', [], [f'topic:company:{slug(bank)}'], name='offer', hard_negative=True)


def gym_plan(r):
    lines = ['12-week training plan', 'Week 1-4: 3 x 5 squats, deadlifts, bench', 'Protein: 1.6 g per kg body weight',
             'Creatine 5 mg... no, 5 g daily', 'Resting heart rate this morning: 58', 'Sleep 8 hours; check with a doctor before starting if unsure.']
    return doc(lines, 'note', [], name='training', hard_negative=True)


def photo_object(r):
    return doc([], 'photo', [], name=f'IMG_{r.randint(1000, 9999)}', force='object')


def whiteboard(r):
    lines = r.sample(['Sprint goals', 'fix login bug', 'ship exports', 'customer call fri', 'retro: what went well', 'deploy freeze 12/20',
                      'Q: who owns billing?', 'onboarding v2', 'perf budget 200ms'], 5)
    return doc(lines, 'whiteboard', [], name=f'IMG_{r.randint(1000, 9999)}')


def school_letter(r):
    lines = [f'{r.choice(TOWNS)} Primary School', 'Dear Parents and Carers,', 'The autumn fair is on Saturday from 10am.',
             'Please send in cakes and tombola prizes by Friday.', 'Year 3 swimming starts after half term; kits needed.', 'Thank you, The Office']
    return doc(lines, 'letter', [], name='newsletter')


def manual(r):
    lines = [f'{r.choice(["Kettle", "Router", "Dishwasher", "Drill"])} - quick start', '1. Unpack and check all parts are present.',
             '2. Connect to power. The light flashes green.', '3. Default admin password is printed on the label under the device.',
             '4. For support visit the website and enter your serial number.', f'Model {alnum(r, 4, string.ascii_uppercase)}-{r.randint(100, 999)}']
    return doc(lines, 'manual', [], name='manual', hard_negative=True)


# ---------------------------------------------------------------- planning

FORMAT_MIME = {'txt': 'text/plain', 'md': 'text/markdown', 'csv': 'text/csv', 'json': 'application/json', 'yaml': 'application/yaml',
               'html': 'text/html', 'py': 'text/x-python', 'ts': 'text/x-typescript', 'js': 'text/javascript', 'go': 'text/x-go',
               'sh': 'application/x-sh', 'pem': 'application/x-pem-file', 'key': 'application/octet-stream', '': 'application/octet-stream',
               'pdf': 'application/pdf', 'png': 'image/png', 'jpg': 'image/jpeg'}


def plan(seed):
    """List of (builder, rendering) in a fixed order. rendering is one of
    native, pdf-text, pdf-scan, image-scan, image-photo, image-hard, screenshot."""
    r = random.Random(f'plan:{seed}')
    items = []

    def add(builder, n, renders):
        for _ in range(n):
            items.append((builder, r.choices([x for x, _ in renders], weights=[w for _, w in renders])[0]))

    sens_mix = [('native', 3), ('pdf-text', 3), ('pdf-scan', 2), ('image-scan', 1.5), ('image-photo', 1.5), ('image-hard', 0.5)]
    for b, n in FINANCE:
        add(b, n, [('image-photo', 3), ('image-hard', 1)] if b in (card_photo, cheque) else sens_mix)
    for b, n in IDENTITY:
        add(b, n, [('image-photo', 4), ('image-scan', 3), ('image-hard', 1), ('pdf-scan', 2)] if b in (passport, id_card, drivers_license, ssn_card)
            else sens_mix)
    for b, n in HEALTH:
        add(b, n, sens_mix)
    for b, n in INTIMATE:
        add(b, n, [('native', 4), ('pdf-text', 1), ('image-scan', 2), ('image-photo', 2), ('pdf-scan', 1)])
    cred_mix = [('native', 6), ('screenshot', 2), ('image-photo', 1.2), ('image-scan', 0.6), ('pdf-scan', 0.3), ('image-hard', 0.3)]
    for b, n in [(recovery_codes, 45), (pw_export, 30), (pem_key, 30), (api_key_text, 55), ('seed', 35), (totp_secret, 15),
                 (password_note, 25), (ssh_config_with_key, 5)]:
        add(b, n, cred_mix)
    ordinary = [
        (receipt, 90, [('image-photo', 4), ('image-scan', 1), ('image-hard', 1), ('pdf-text', 1), ('native', 1)]),
        (contract, 40, [('pdf-text', 3), ('pdf-scan', 2), ('native', 1)]),
        (note, 60, [('native', 5), ('image-photo', 1)]),
        (recipe, 30, [('native', 3), ('image-photo', 1)]),
        ('recipe-hard', 20, [('native', 3), ('image-photo', 1)]),
        (code_file, 40, [('native', 5), ('screenshot', 1)]),
        ('code-hard', 30, [('native', 5), ('screenshot', 1)]),
        (meeting_notes, 20, [('native', 1)]),
        ('meeting-hard', 15, [('native', 2), ('image-photo', 1)]),
        (article, 50, [('native', 3), ('pdf-text', 1), ('screenshot', 1)]),
        (invoice, 35, [('pdf-text', 2), ('pdf-scan', 1), ('image-photo', 1)]),
        (shipping_label, 15, [('image-photo', 1)]),
        (inventory_csv, 12, [('native', 1)]),
        (ticket, 12, [('pdf-text', 1), ('screenshot', 1)]),
        (itinerary, 12, [('native', 1), ('pdf-text', 1)]),
        (bank_marketing, 12, [('pdf-text', 1), ('image-scan', 1)]),
        (gym_plan, 8, [('native', 1)]),
        (photo_object, 40, [('object', 1)]),
        (whiteboard, 15, [('image-photo', 1)]),
        (school_letter, 12, [('pdf-text', 1), ('image-scan', 1)]),
        (manual, 12, [('pdf-text', 1), ('image-scan', 1)]),
    ]
    for b, n, renders in ordinary:
        add(b, n, renders)
    return items


def build(builder, r, bip):
    if builder == 'seed':
        return seed_phrase(r, bip)
    if builder == 'recipe-hard':
        return recipe(r, hard=True)
    if builder == 'code-hard':
        return code_file(r, hard=True)
    if builder == 'meeting-hard':
        return meeting_notes(r, hard=True)
    return builder(r)


def draw_object(r):
    w, h = r.choice([(1200, 900), (900, 1200), (1024, 768)])
    img = Image.new('RGB', (w, h), tuple(r.randint(60, 200) for _ in range(3)))
    d = ImageDraw.Draw(img)
    for _ in range(r.randint(2, 7)):
        x0, y0 = r.randint(0, w - 100), r.randint(0, h - 100)
        x1, y1 = x0 + r.randint(80, w // 2), y0 + r.randint(80, h // 2)
        col = tuple(r.randint(0, 255) for _ in range(3))
        r.choice([d.ellipse, d.rectangle])([x0, y0, x1, y1], fill=col)
    arr = np.asarray(img).astype(np.float32)
    arr += np.random.default_rng(r.getrandbits(32)).normal(0, 12, arr.shape)
    return Image.fromarray(arr.clip(0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(r.uniform(0.5, 2.5)))


GENERIC_NAMES = ['scan', 'Scan', 'document', 'IMG', 'Screenshot', 'file', 'Untitled', 'doc']


def file_stem(d, r, idx, image):
    """Mix descriptive and generic names, as in real folders."""
    if d['name'] and r.random() < 0.55:
        stem = d['name']
    else:
        g = r.choice(GENERIC_NAMES if image else ['document', 'file', 'Untitled', 'doc', 'notes', 'New'])
        stem = f'{g}_{r.randint(1, 9999):04d}' if g != 'Screenshot' else f'Screenshot {date(r)} at {r.randint(10, 23)}.{r.randint(10, 59)}.{r.randint(10, 59)}'
    return f'{idx:04d}-{stem}'


def materialize(d, rendering, r, out, idx, folder):
    extra = {}
    stem = file_stem(d, r, idx, rendering not in ('native', 'pdf-text'))
    os.makedirs(os.path.join(out, folder), exist_ok=True)
    lines = d['lines']
    force = d['extra'].get('force')
    if rendering == 'native':
        ext = d['ext']
        if d.get('ext') == 'html':
            body = '<!doctype html><html><head><title>' + lines[0] + '</title></head><body>' + ''.join(f'<p>{l}</p>' for l in lines) + '</body></html>'
        else:
            body = '\n'.join(lines) + '\n'
        name = stem if d['name'] in ('.env',) and stem.endswith('.env') else (f'{stem}.{ext}' if ext else stem)
        path = os.path.join(folder, name)
        with open(os.path.join(out, path), 'w', encoding='utf-8') as f:
            f.write(body)
        return path, FORMAT_MIME.get(ext, 'text/plain'), {'level': 'native'}
    if rendering == 'pdf-text':
        path = os.path.join(folder, f'{stem}.pdf')
        save_pdf_text(lines, os.path.join(out, path), r, title=d['title'])
        return path, 'application/pdf', {'level': 'text-layer'}
    if rendering == 'object':
        img = draw_object(r)
        path = os.path.join(folder, f'{stem}.jpg')
        save_image(img, os.path.join(out, path), r, 'jpg')
        return path, 'image/jpeg', {'level': 'photo-no-text'}
    if rendering == 'screenshot':
        img = render_screenshot(r, r.choice(['Notes', 'Terminal', 'Passwords', 'Settings', 'Messages', 'Editor']), lines, mono=d['mono'])
        level = 'screenshot'
        p = {'level': level}
        if r.random() < 0.3:  # photo of a screen
            img, p = degrade(r, img, 'photo')
            p['level'] = 'screen-photo'
        path = os.path.join(folder, f'{stem}.png' if p['level'] == 'screenshot' else f'{stem}.jpg')
        save_image(img, os.path.join(out, path), r, 'png' if p['level'] == 'screenshot' else 'jpg')
        return path, 'image/png' if path.endswith('.png') else 'image/jpeg', p
    # page images
    if force == 'card':
        img = render_page(r, lines, width=1012, height=638, size=44, margin=60, bg=r.randint(150, 240), fg=r.randint(0, 60))
    elif force == 'id':
        img = render_page(r, lines, width=1400, height=max(880, 120 + 52 * len(lines)), size=34, margin=60, bg=r.randint(200, 245),
                          mono=d['extra'].get('mrz', False) and r.random() < 0.5)
    elif d['kind'] == 'receipt':
        img = render_page(r, lines, width=640, size=26, margin=40, mono=r.random() < 0.6)
    else:
        img = render_page(r, lines, mono=d['mono'], italic=d['extra'].get('italic', False) or d['kind'] in ('private-letter', 'diary'))
    level = {'pdf-scan': 'scan', 'image-scan': 'scan', 'image-photo': 'photo', 'image-hard': 'hard'}[rendering]
    img, p = degrade(r, img, level)
    if rendering == 'pdf-scan':
        path = os.path.join(folder, f'{stem}.pdf')
        save_pdf_scan([img], os.path.join(out, path))
        return path, 'application/pdf', p
    fmt = 'png' if (level == 'scan' and r.random() < 0.5) else 'jpg'
    path = os.path.join(folder, f'{stem}.{fmt}')
    save_image(img, os.path.join(out, path), r, fmt)
    return path, 'image/png' if fmt == 'png' else 'image/jpeg', p


FOLDERS = {'ring:finance': 'finance', 'ring:identity': 'identity', 'ring:health': 'health', 'ring:intimate': 'personal',
           'ring:credentials': 'misc'}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', required=True, help='output directory (outside the repository)')
    ap.add_argument('--seed', default='1')
    ap.add_argument('--limit', type=int, default=0, help='only the first N planned items (for quick tests)')
    args = ap.parse_args()
    out = os.path.abspath(args.out)
    repo = os.path.abspath(os.path.join(HERE, '..', '..'))
    if out == repo or out.startswith(repo + os.sep):
        sys.exit('refusing to write a corpus inside the repository')
    os.makedirs(out, exist_ok=True)
    with open(BIP39_PATH, encoding='utf-8') as f:
        bip = [w.strip() for w in f if w.strip()]
    items = plan(args.seed)
    order = random.Random(f'order:{args.seed}')
    idxs = list(range(len(items)))
    order.shuffle(idxs)  # interleave kinds; file numbering reveals nothing
    if args.limit:
        idxs = idxs[:args.limit]
    manifest = []
    for n, i in enumerate(idxs):
        builder, rendering = items[i]
        r = random.Random(f'item:{args.seed}:{i}')
        d = build(builder, r, bip)
        # folder: mostly an "inbox", sometimes a meaningful folder (as people file things)
        folder = 'inbox'
        if d['rings'] and r.random() < 0.3:
            folder = FOLDERS[d['rings'][0]]
        elif not d['rings'] and r.random() < 0.3:
            folder = r.choice(['documents', 'projects', 'home'])
        path, mime, deg = materialize(d, rendering, r, out, n, folder)
        extra = {k: v for k, v in d['extra'].items() if k not in ('force', 'italic')}
        manifest.append({
            'path': path, 'mime': mime, 'rings': d['rings'], 'kind': d['kind'], 'topics': d['topics'],
            'rendering': rendering, 'degradation': deg, 'hard_negative': d['hard_negative'],
            'set': 'credentials-dedicated' if 'ring:credentials' in d['rings'] else 'main', **({'extra': extra} if extra else {}),
        })
    with open(os.path.join(out, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump({'generator': 'agent-drive test/fixtures/generate.py', 'version': GENERATOR_VERSION, 'seed': args.seed,
                   'synthetic': True, 'count': len(manifest), 'items': manifest}, f, indent=1)
    by_ring = {}
    images = 0
    for m in manifest:
        for ring in m['rings'] or ['none']:
            by_ring[ring] = by_ring.get(ring, 0) + 1
        if m['rendering'] not in ('native', 'pdf-text'):
            images += 1
    print(json.dumps({'out': out, 'count': len(manifest), 'images_or_scans': images, 'by_ring': by_ring}))


if __name__ == '__main__':
    main()
