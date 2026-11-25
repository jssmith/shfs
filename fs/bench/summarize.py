#!/usr/bin/env python3
"""Prints a Markdown table of median times (ms) and ratios from gvisor-bench.sh results.

usage: summarize.py <results dir>
"""
import json
import sys

d = sys.argv[1]
shared = json.load(open(f"{d}/gvisor-shared.json"))
excl = json.load(open(f"{d}/gvisor-excl.json"))
host = json.load(open(f"{d}/host.json"))


def ms(x):
    return f"{x['median'] * 1000:.0f}"


print("| Benchmark | gVisor: daemon | gVisor: daemon, zero timeouts | gVisor: plain (shared) "
      "| ratio | ratio, zero timeouts | gVisor: plain (default access) | host: daemon | host: plain | host ratio |")
print("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
for b in shared:
    s, e, h = shared[b], excl[b], host[b]
    r = s["drive"]["median"] / s["plain"]["median"]
    rz = s["drive_zero"]["median"] / s["plain"]["median"]
    rh = h["drive"]["median"] / h["plain"]["median"]
    print(f"| {b} | {ms(s['drive'])} | {ms(s['drive_zero'])} | {ms(s['plain'])} | {r:.1f}x | {rz:.1f}x "
          f"| {ms(e['plain_exclusive'])} | {ms(h['drive'])} | {ms(h['plain'])} | {rh:.1f}x |")
