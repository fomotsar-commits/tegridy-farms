/** The sheet's zones, left to right. scripts/render-pools-frame.mjs draws the same eight in /pools' first frame. */
const ZONES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const;

/** The zone ruler along a sheet's top edge (dwg.css `.dwg-ruler`): letters from data-z, no words. From 48rem. */
export function SheetRuler() {
  return (
    <div className="dwg-ruler" aria-hidden="true">
      {ZONES.map((z) => (
        <i key={z} data-z={z} />
      ))}
    </div>
  );
}
