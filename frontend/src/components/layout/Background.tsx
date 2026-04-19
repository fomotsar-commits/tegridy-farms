import { pageArt } from '../../lib/artConfig';

export function Background() {
  return (
    <div className="fixed inset-0 z-0 bg-[#060c1a]">
      <img src={pageArt('app-bg', 0).src} alt="" className="w-full h-full object-cover" />
    </div>
  );
}
