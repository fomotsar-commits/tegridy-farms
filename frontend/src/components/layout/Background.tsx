export function Background() {
  // Solid base only — every page renders its own fullscreen art bg via
  // pageArt(...) on top of this. Adding an art image here would inevitably
  // collide with whichever page's idx-0 piece happens to share its hash.
  return <div className="fixed inset-0 z-0 bg-[#060c1a]" />;
}
