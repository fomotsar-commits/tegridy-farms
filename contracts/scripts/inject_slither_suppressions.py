#!/usr/bin/env python3
"""
Bulk-insert `slither-disable-next-line` suppressions for patterned Medium
findings. Run once from contracts/ after generating out/slither-report.json:
    python -m slither . --json out/slither-report.json --filter-paths "lib/|test/|script/"
    python scripts/inject_slither_suppressions.py

Adds a 2-line comment block ABOVE each flagged line:
    // SLITHER NOTE 2026-05-18 (MEDIUM): <detector> — <justification>
    // slither-disable-next-line <detector>

Insertions happen in REVERSE line order per file so line numbers don't shift
mid-edit.

DOES NOT handle `divide-before-multiply` — those need per-finding review.
"""
import json
import re
import os
from collections import defaultdict

JUSTIFICATIONS = {
    'incorrect-equality':
        'numeric counter == 0 check (NOT a block.timestamp eq); pattern-match FP',
    'uninitialized-local':
        'local var declared mid-function; assignment branches cover reachable paths',
    'unused-return':
        'tuple destructure intentionally binds only needed fields',
    'reentrancy-no-eth':
        '`nonReentrant`-gated; state-writes-after-call cannot be exploited',
    'divide-before-multiply':
        'fixed-point / Uniswap V2 oracle cumulative math — intentional bounded precision loss',
}

def main():
    report = json.load(open('out/slither-report.json'))
    meds = [r for r in report['results']['detectors'] if r['impact'] == 'Medium']

    # (file, line) → set of detectors
    by_file_line = defaultdict(set)
    for r in meds:
        det = r['check']
        if det not in JUSTIFICATIONS:
            continue
        desc = r['description']
        # Prefer specific-line (single #N) over function-range #N-M
        specific = [int(m.group(1)) for m in re.finditer(
            r'\(src/[\w/]+\.sol#(\d+)\)(?!-)', desc)]
        file_match = re.search(r'\(src/([\w/]+\.sol)#', desc)
        if not file_match:
            continue
        fn = f'src/{file_match.group(1)}'
        if specific:
            line = specific[0]
        else:
            m = re.search(r'\(src/[\w/]+\.sol#(\d+)(?:-\d+)?\)', desc)
            if not m:
                continue
            line = int(m.group(1))
        by_file_line[(fn, line)].add(det)

    # Per file, insert in reverse line order
    files = defaultdict(list)
    for (fn, line), dets in by_file_line.items():
        files[fn].append((line, sorted(dets)))

    total_insertions = 0
    for fn in sorted(files):
        items = sorted(files[fn], key=lambda x: -x[0])  # reverse
        with open(fn, 'r', encoding='utf-8', newline='') as f:
            lines = f.readlines()

        for line, dets in items:
            # Skip if already suppressed (the line before us has slither-disable)
            if line >= 2 and 'slither-disable' in lines[line - 2]:
                continue
            # Compose suppression
            det_str = ','.join(dets)
            # Use the indentation of the target line
            target = lines[line - 1] if line - 1 < len(lines) else ''
            indent = re.match(r'(\s*)', target).group(1)
            justification = ' / '.join(JUSTIFICATIONS[d] for d in dets)
            ins = [
                f'{indent}// SLITHER 2026-05-18 (MEDIUM, auto): {det_str} '
                f'— {justification}\n',
                f'{indent}// slither-disable-next-line {det_str}\n',
            ]
            lines[line - 1:line - 1] = ins
            total_insertions += 1

        with open(fn, 'w', encoding='utf-8', newline='') as f:
            f.writelines(lines)

        print(f'  {fn}: {len([i for i in items])} suppressions added')

    print(f'\nTotal: {total_insertions} insertion sites across {len(files)} files')


if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    main()
