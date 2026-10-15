/** A chain time as format.ts `minuteText` and poolHealth.ts `formatWhen` print it. */
const CHAIN_TIME = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})? UTC)/;

/**
 * A sentence with every chain time in it kept on one line. A browser may break a line
 * after a hyphen, so on a phone "2026-10-03 19:18 UTC" was split as "2026-" and the rest.
 */
export function WholeDates({ text }: { text: string }) {
  return (
    <>
      {text.split(CHAIN_TIME).map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="whitespace-nowrap">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}
