import { ART } from '../../lib/artConfig';

export function Background() {
  return (
    <div className="fixed inset-0 z-0">
      <img src={ART.forestScene.src} alt="" className="w-full h-full object-cover" style={{ opacity: 0.08 }} />
      <div className="absolute inset-0" style={{
        background: 'linear-gradient(160deg, rgba(6,12,26,0.97) 0%, rgba(8,18,32,0.98) 40%, rgba(5,10,20,0.99) 70%, rgba(6,12,26,0.97) 100%)',
      }} />
    </div>
  );
}
