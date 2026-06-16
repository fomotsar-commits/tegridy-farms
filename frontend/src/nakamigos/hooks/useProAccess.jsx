import { useState, useEffect, useRef } from "react";
import { fetchWalletNfts } from "../api";
import { TEGRIDY_PRO_PASS_ADDRESS, isDeployed } from "../../lib/constants";

// Pro is live only once the operator deploys the Pro Pass collection and wires
// its address. Until then every Pro perk + the mint funnel stay in their
// pre-launch state and this hook returns isPro:false — so the whole feature
// auto-activates the moment TEGRIDY_PRO_PASS_ADDRESS is set, no code change.
export const PRO_PASS_LIVE = isDeployed(TEGRIDY_PRO_PASS_ADDRESS);

/**
 * Tegridy Pro access gate. Pro = the connected wallet owns >= 1 Tegridy Pro Pass
 * NFT. Mirrors useHolderStatus's balanceOf-via-fetchWalletNfts read (cached
 * upstream, generation-guarded here so a wallet switch mid-fetch can't apply a
 * stale result). Returns { isPro, loading, live }.
 */
export default function useProAccess(wallet) {
  const [isPro, setIsPro] = useState(false);
  const [loading, setLoading] = useState(false);
  const genRef = useRef(0);

  useEffect(() => {
    if (!PRO_PASS_LIVE || !wallet) {
      setIsPro(false);
      return;
    }
    const gen = ++genRef.current;
    setLoading(true);
    fetchWalletNfts(wallet, TEGRIDY_PRO_PASS_ADDRESS)
      .then((data) => {
        if (gen !== genRef.current) return;
        setIsPro((data?.totalCount || 0) > 0);
      })
      .catch(() => {
        if (gen === genRef.current) setIsPro(false);
      })
      .finally(() => {
        if (gen === genRef.current) setLoading(false);
      });
  }, [wallet]);

  return { isPro, loading, live: PRO_PASS_LIVE };
}
