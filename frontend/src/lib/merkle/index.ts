export {
  hashLeaf,
  buildMerkleTree,
  merkleProof,
  verifyMerkleProof,
  type AirdropLeaf,
  type MerkleTree,
} from './core.js';
export {
  buildCampaign,
  findRow,
  verifyManifest,
  serializeManifest,
  parseManifest,
  type CampaignEntry,
  type CampaignManifest,
  type CampaignRow,
} from './campaign';
export { parseAllocationCsv, type CsvParseResult, type CsvRowError } from './csv';
export {
  fetchStoredProof,
  publishManifest,
  attachDistributor,
  AIRDROP_STORE_ENDPOINT,
  type ManifestStoreResult,
  type ManifestStoreStatus,
  type StoredManifestMeta,
  type PublishResult,
} from './manifestStore';
export {
  evaluateEligibility,
  type EligibilityInput,
  type EligibilityResult,
  type EligibilityStatus,
  type OnChainCampaign,
} from './eligibility';
