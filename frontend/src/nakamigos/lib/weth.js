import { WETH, CONDUIT_ADDRESS } from "../constants";
import { getProvider } from "../api";

const WETH_ABI = [
  "function deposit() payable",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

async function getEthers() {
  return import("ethers");
}

async function getSigner() {
  const { ethers } = await getEthers();
  const provider = getProvider();
  if (!provider) throw new Error("No wallet");
  const browserProvider = new ethers.BrowserProvider(provider);
  return browserProvider.getSigner();
}

export async function getWethBalance(address) {
  const { ethers } = await getEthers();
  const provider = getProvider();
  if (!provider) return 0n;
  const browserProvider = new ethers.BrowserProvider(provider);
  const weth = new ethers.Contract(WETH, WETH_ABI, browserProvider);
  return weth.balanceOf(address);
}

export async function getEthBalance(address) {
  const { ethers } = await getEthers();
  const provider = getProvider();
  if (!provider) return 0n;
  const browserProvider = new ethers.BrowserProvider(provider);
  return browserProvider.getBalance(address);
}

export async function getWethAllowance(address) {
  const { ethers } = await getEthers();
  const provider = getProvider();
  if (!provider) return 0n;
  const browserProvider = new ethers.BrowserProvider(provider);
  const weth = new ethers.Contract(WETH, WETH_ABI, browserProvider);
  return weth.allowance(address, CONDUIT_ADDRESS);
}

export async function wrapEth(amountWei) {
  const { ethers } = await getEthers();
  const signer = await getSigner();
  const weth = new ethers.Contract(WETH, WETH_ABI, signer);
  const tx = await weth.deposit({ value: amountWei });
  await tx.wait();
  return tx;
}

export async function approveWeth(amount) {
  const signer = await getSigner();
  const { ethers } = await getEthers();
  const weth = new ethers.Contract(WETH, WETH_ABI, signer);
  // Approve the conduit (not Seaport directly). When orders use a
  // non-zero conduitKey, Seaport pulls tokens through the conduit.
  const tx = await weth.approve(CONDUIT_ADDRESS, amount);
  await tx.wait();
  return tx;
}

export function formatEth(wei) {
  // Use BigInt division to 4 decimal places to avoid float precision loss
  const w = BigInt(wei);
  const whole = w / BigInt(1e18);
  const frac = (w % BigInt(1e18)) / BigInt(1e14);
  return `${whole}.${String(frac).padStart(4, "0")}`;
}
