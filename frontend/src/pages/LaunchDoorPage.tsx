import { lazy, useEffect } from 'react';
import { Countdown } from '../components/heat/Countdown';
import { usePageTitle } from '../hooks/usePageTitle';
import { trackPageView } from '../lib/analytics';
import { useLastReading } from '../lib/heat/heatStore';
import { isLaunchDoorOpen } from '../lib/launcher/door';

// The launch hub, with its tabs and rails, for the day the island opens the door.
const LaunchHubPage = lazy(() => import('./LaunchHubPage'));

/**
 * /launch, the launch door (island answer twenty-six): the countdown, for every wallet, warm ones
 * too, and for a visitor with nothing read, from a standing start. No tab strip, no chain menu, no
 * form: the door is not open yet, and that state is the page. The rails keep their own addresses
 * (/curve-launch, /eth-curve, /launch-simulator) for whoever has them, and a launched token keeps
 * its page (/launch/:token).
 */
export default function LaunchDoorPage() {
  usePageTitle('Launch', "The launch door opens on the island's word.");
  useEffect(() => {
    trackPageView('/launch');
  }, []);
  const reading = useLastReading();
  if (isLaunchDoorOpen()) return <LaunchHubPage />;
  return <Countdown reading={reading} look="screen" />;
}
