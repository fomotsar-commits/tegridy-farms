// A calendar file for a loan's due moment.
//
// The site cannot message anyone (no email, no push sender), and a missed deadline costs the
// borrower the NFT with no grace period. A calendar entry rings with the tab closed, so the
// borrower can carry the deadline out of the site. Built in the browser; nothing is sent.

/** Reminders before the due moment: a week, three days, a day, two hours. */
export const DUE_ALARMS_MINUTES = [7 * 24 * 60, 3 * 24 * 60, 24 * 60, 120] as const;

function icsStamp(seconds: number): string {
  // 2026-12-10T15:14:00.000Z -> 20261210T151400Z
  return new Date(seconds * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** RFC 5545 text: backslash, semicolon and comma are escaped, a line break becomes \n. */
function icsText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

export function loanDueIcs(input: { loanId: string; title: string; description: string; dueSeconds: number; nowSeconds: number }): string {
  // The entry ENDS at the deadline and starts 30 minutes before it: the last moment to act
  // is the end of the block, never its start.
  const start = input.dueSeconds - 30 * 60;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//NFT lending//loan due date//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:loan-${input.loanId}-${input.dueSeconds}@nft-lending`,
    `DTSTAMP:${icsStamp(input.nowSeconds)}`,
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(input.dueSeconds)}`,
    `SUMMARY:${icsText(input.title)}`,
    `DESCRIPTION:${icsText(input.description)}`,
    ...DUE_ALARMS_MINUTES.flatMap((minutes) => [
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${icsText(input.title)}`,
      // Relative to the END of the entry, which is the deadline itself.
      `TRIGGER;RELATED=END:-PT${minutes}M`,
      'END:VALARM',
    ]),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.join('\r\n')}\r\n`;
}

/** Hand the reader the file. Returns false where the browser cannot build a download. */
export function downloadIcs(filename: string, ics: string): boolean {
  try {
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  } catch {
    return false;
  }
}
