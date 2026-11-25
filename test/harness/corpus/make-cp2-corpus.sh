#!/usr/bin/env bash
# A small synthetic folder for checkpoint 2: receipts, an expenses CSV, a README,
# a tiny Python project, and one item the ring check should hide (a fake,
# Luhn-valid card number). All names, vendors and numbers are invented.
#   test/harness/corpus/make-cp2-corpus.sh <dest-dir>
set -euo pipefail
d="${1:?destination directory}"
rm -rf "$d"; mkdir -p "$d/receipts" "$d/finance" "$d/projects/unitconv/tests" "$d/notes"

cat > "$d/README.md" <<'EOF'
# Household folder (synthetic)

Receipts from the last month, a CSV of expenses, and a small Python project
for unit conversions. Everything here is made up for testing.
EOF

cat > "$d/receipts/receipt-oak-street-grocer.md" <<'EOF'
# Receipt
Vendor: Oak Street Grocer
Date: 2026-10-03
Items: apples, bread, oat milk
Total: 23.40 EUR
Paid by: debit card
EOF
cat > "$d/receipts/receipt-bluebird-hardware.md" <<'EOF'
# Receipt
Vendor: Bluebird Hardware
Date: 2026-10-11
Items: wood screws, sanding paper, wall plugs
Total: 41.95 EUR
EOF
cat > "$d/receipts/scan-0042.txt" <<'EOF'
RECEIPT
Riverside Pharmacy
2026-10-17 14:22
Plasters             4.20
Hand cream           6.80
TOTAL               11.00 EUR
EOF
cat > "$d/receipts/receipt-cafe-lumen.md" <<'EOF'
# Receipt
Vendor: Cafe Lumen
Date: 2026-10-24
Items: two flat whites, croissant
Total: 9.70 EUR
EOF

cat > "$d/finance/expenses-2026-10.csv" <<'EOF'
date,vendor,category,amount_eur
2026-10-01,Northside Rail,transport,48.00
2026-10-03,Oak Street Grocer,groceries,23.40
2026-10-05,Oak Street Grocer,groceries,31.15
2026-10-08,City Power Co,utilities,62.30
2026-10-11,Bluebird Hardware,household,41.95
2026-10-14,Northside Rail,transport,12.50
2026-10-17,Riverside Pharmacy,health,11.00
2026-10-20,Oak Street Grocer,groceries,27.85
2026-10-24,Cafe Lumen,eating out,9.70
2026-10-27,Lantern Books,leisure,18.90
2026-10-29,City Water,utilities,24.10
2026-10-30,Cafe Lumen,eating out,14.20
EOF

cat > "$d/projects/unitconv/README.md" <<'EOF'
# unitconv

Tiny unit conversions. Run the tests with `python -m pytest -q` from this folder.
EOF
cat > "$d/projects/unitconv/unitconv.py" <<'EOF'
"""Small unit conversion helpers."""


def km_to_miles(km: float) -> float:
    return km * 0.621371


def celsius_to_fahrenheit(c: float) -> float:
    return c * 9 / 5 + 32
EOF
cat > "$d/projects/unitconv/tests/test_unitconv.py" <<'EOF'
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from unitconv import celsius_to_fahrenheit, km_to_miles


def test_km_to_miles():
    assert round(km_to_miles(10), 3) == 6.214


def test_celsius_to_fahrenheit():
    assert celsius_to_fahrenheit(100) == 212
EOF

cat > "$d/notes/garden-plan.md" <<'EOF'
# Garden plan
- Plant tulip bulbs before mid-November.
- Ask the neighbour about sharing the compost bin.
EOF

# The item the ring check should hide: a fake card number that passes the Luhn check
# (4111 1111 1111 1111 is the standard test number, not a real card).
cat > "$d/notes/card-for-online-orders.txt" <<'EOF'
Card for online orders
Number: 4111 1111 1111 1111
Expiry: 09/29
Name on card: Test Person
EOF
find "$d" -type f | sort
