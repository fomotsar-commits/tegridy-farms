// GET /api/outside-prices: every listed pool's outside price, read once for everyone and
// kept at the edge (island answer twenty-four, build 1b). Its own function for its paced
// Jupiter loop (vercel.json maxDuration 60); see _lib/outside-prices.js.
import { handleOutsidePrices } from "./_lib/outside-prices.js";

export default async function handler(req, res, deps) {
  return handleOutsidePrices(req, res, deps);
}
