import { useEffect, useId, type ReactNode, type RefObject } from 'react';
import { SHADOW } from '../curve/uiFormat';
import { useInDoor } from './lpDoor';

/**
 * The panel's frame: a section named by its heading, which takes focus when the panel opens.
 * In the LP door it is already at the top of the page, inside the door's card: no scroll, no box.
 */
export function PanelFrame({
  testId,
  title,
  headingRef,
  aside,
  children,
}: {
  testId: string;
  title: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  /** On the heading's line, at its end: the Add panel's coin name. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  const inDoor = useInDoor();
  useEffect(() => {
    const h = headingRef.current;
    if (!h) return;
    h.focus({ preventScroll: true });
    // The top of the panel goes to the top of the screen. The page's scroll-padding
    // (index.css) keeps it clear of the fixed bar and the tab strip. On a phone 'nearest'
    // left the heading at the bottom edge and the form itself below the screen.
    if (!inDoor) h.scrollIntoView?.({ block: 'start' });
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const heading = (
    <h4 id={id} ref={headingRef} tabIndex={-1} className="text-white font-semibold text-[13px] outline-none" style={SHADOW}>
      {title}
    </h4>
  );
  return (
    <section
      data-testid={testId}
      aria-labelledby={id}
      className={`relative space-y-3 text-white/75 text-[11px] leading-relaxed min-w-0 ${inDoor ? '' : 'rounded-lg p-3 mt-2'}`}
      style={inDoor ? undefined : { background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.12)' }}
    >
      {aside ? (
        <div className="flex flex-wrap items-center justify-between gap-x-3">
          {heading}
          {aside}
        </div>
      ) : (
        heading
      )}
      {children}
    </section>
  );
}
