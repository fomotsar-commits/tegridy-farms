import { ART } from '../../lib/artConfig';

export function Background() {
  return (
    <div className="fixed inset-0 z-0 bg-[#060c1a]">
      <img src={ART.forestScene.src} alt="" className="w-full h-full object-cover" />
    </div>
  );
}
