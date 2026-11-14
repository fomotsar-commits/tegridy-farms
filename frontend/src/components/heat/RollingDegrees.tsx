import { useEffect, useState, type CSSProperties } from 'react';
import { deltaLine, readSeen, useRollUp, writeSeen } from '../../lib/heat/ticks';

/** The degrees, rolling up from 0 over 600 ms once a session (island answer twenty-four, §2b; lib/heat/ticks.ts). */
export function RollingDegrees({ degrees, address, className, style }: { degrees: number; address: string; className?: string; style?: CSSProperties }) {
  const shown = useRollUp(degrees, address);
  return (
    <span className={className} style={style} data-testid="heat-degrees">
      {shown.toFixed(2)}
    </span>
  );
}

/** The change since the last visit, from this browser's own memory of the last reading of this wallet; nothing stored anywhere else. */
export function HeatSince({ degrees, address, className }: { degrees: number; address: string; className?: string }) {
  // Read once per reading, before this reading replaces it.
  const [line] = useState(() => deltaLine(readSeen(address), degrees, Date.now()));
  useEffect(() => {
    const previous = readSeen(address);
    // A visit under an hour ago keeps the older mark, so "since yesterday" stays yesterday across a reload.
    if (previous && Date.now() - previous.at < 3600_000 && previous.degrees === degrees) return;
    writeSeen(address, { degrees, at: Date.now() });
  }, [degrees, address]);
  if (!line) return null;
  return (
    <span className={className} data-testid="heat-since">
      {line}
    </span>
  );
}
