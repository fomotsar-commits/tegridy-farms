import Papa from 'papaparse';

// ─── OpenSea-standard metadata shapes ─────────────────────────────

export interface TokenAttribute {
  trait_type: string;
  value: string | number;
}

/// Per-token JSON (what OpenSea fetches at `baseURI + tokenId`)
export interface TokenMetadata {
  name: string;
  description: string;
  image: string;
  attributes: TokenAttribute[];
}

/// Collection-level JSON (what `contractURI()` resolves to). OpenSea reads this
/// for banner / description / royalty fallback. Follows the 2024 OpenSea schema.
export interface ContractMetadata {
  name: string;
  description: string;
  image?: string;
  banner_image?: string;
  external_link?: string;
  seller_fee_basis_points?: number;
  fee_recipient?: string;
}

// ─── CSV parsing ─────────────────────────────────────────────────

export interface CsvRow {
  file_name: string;
  name: string;
  description?: string;
  attributes: TokenAttribute[];
}

export interface ParseResult {
  rows: CsvRow[];
  warnings: string[];
}

/// Parses a Thirdweb-style NFT drop CSV into normalized rows. Header format:
///   `file_name,name,description,attribute_0_trait,attribute_0_value,attribute_1_trait,...`
/// - `file_name` (required) matches an uploaded image (e.g. `1.png`)
/// - `name` (required) is the per-token display name
/// - `description` (optional) per-token
/// - `attribute_N_trait` / `attribute_N_value` pairs, up to 16 pairs
///
/// Warnings are returned for non-fatal issues so the UI can surface them without
/// blocking. Fatal issues throw — the wizard should catch and show an error.
export function parseCsv(csvText: string): ParseResult {
  const warnings: string[] = [];
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  if (parsed.errors.length > 0) {
    throw new Error(`CSV parse failed: ${parsed.errors[0]?.message}`);
  }
  if (parsed.data.length === 0) {
    throw new Error('CSV is empty');
  }

  const headers = parsed.meta.fields ?? [];
  if (!headers.includes('file_name')) {
    throw new Error('CSV must include a "file_name" column');
  }
  if (!headers.includes('name')) {
    throw new Error('CSV must include a "name" column');
  }

  const attrPairs: Array<{ traitKey: string; valueKey: string }> = [];
  for (let i = 0; i < 16; i++) {
    const traitKey = `attribute_${i}_trait`;
    const valueKey = `attribute_${i}_value`;
    if (headers.includes(traitKey) && headers.includes(valueKey)) {
      attrPairs.push({ traitKey, valueKey });
    }
  }

  const rows: CsvRow[] = [];
  parsed.data.forEach((raw, idx) => {
    const fileName = (raw.file_name ?? '').trim();
    const name = (raw.name ?? '').trim();
    if (!fileName) {
      warnings.push(`Row ${idx + 2}: missing file_name — skipped`);
      return;
    }
    if (!name) {
      warnings.push(`Row ${idx + 2}: missing name — skipped`);
      return;
    }

    const attributes: TokenAttribute[] = [];
    for (const { traitKey, valueKey } of attrPairs) {
      const trait = (raw[traitKey] ?? '').trim();
      const value = (raw[valueKey] ?? '').trim();
      if (trait && value) {
        attributes.push({ trait_type: trait, value });
      }
    }

    rows.push({
      file_name: fileName,
      name,
      description: (raw.description ?? '').trim() || undefined,
      attributes,
    });
  });

  return { rows, warnings };
}

// ─── Metadata builders ───────────────────────────────────────────

/// Build per-token metadata JSON given a CSV row and the gateway-resolved image URI.
export function buildTokenMetadata(row: CsvRow, imageUri: string): TokenMetadata {
  return {
    name: row.name,
    description: row.description ?? '',
    image: imageUri,
    attributes: row.attributes,
  };
}

export interface ContractMetadataInput {
  name: string;
  description: string;
  coverImageUri?: string;
  bannerImageUri?: string;
  externalLink?: string;
  royaltyBps: number;
  feeRecipient: string;
}

/// Build the OpenSea `contractURI()` JSON. Fields map 1:1 to the 2024 spec.
/// Throws on invalid royalty (>10000) or malformed external_link.
export function buildContractMetadata(input: ContractMetadataInput): ContractMetadata {
  if (!input.name.trim()) throw new Error('Contract name is required');
  if (input.name.length > 64) throw new Error('Contract name must be ≤ 64 characters');
  if (input.description.length > 1000) throw new Error('Description must be ≤ 1000 characters');
  if (input.royaltyBps < 0 || input.royaltyBps > 10000) {
    throw new Error('royaltyBps must be 0–10000');
  }
  if (input.externalLink && !/^https:\/\//i.test(input.externalLink)) {
    throw new Error('external_link must start with https://');
  }

  const meta: ContractMetadata = {
    name: input.name.trim(),
    description: input.description.trim(),
    seller_fee_basis_points: input.royaltyBps,
    fee_recipient: input.feeRecipient,
  };
  if (input.coverImageUri) meta.image = input.coverImageUri;
  if (input.bannerImageUri) meta.banner_image = input.bannerImageUri;
  if (input.externalLink) meta.external_link = input.externalLink;

  return meta;
}

// ─── Validation helpers ──────────────────────────────────────────

const IMAGE_MIME_WHITELIST = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

const MAX_IMAGE_BYTES_WARN = 20 * 1024 * 1024; // 20 MB soft warning
const MAX_IMAGE_BYTES_BLOCK = 100 * 1024 * 1024; // 100 MB hard block
const MAX_IMAGES_WARN = 10_000;

export interface ImageValidationResult {
  warnings: string[];
  errors: string[];
}

/// Sanity-check the uploaded images against MIME, size, and count limits.
/// Pushes to errors for fatal issues, warnings for soft issues.
export function validateImages(files: File[]): ImageValidationResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (files.length === 0) {
    errors.push('No images selected');
    return { warnings, errors };
  }

  if (files.length > MAX_IMAGES_WARN) {
    warnings.push(
      `Uploading ${files.length} files — expect longer wait times and higher Arweave cost`
    );
  }

  for (const f of files) {
    if (!IMAGE_MIME_WHITELIST.has(f.type)) {
      errors.push(`${f.name}: unsupported type ${f.type || '(unknown)'}`);
      continue;
    }
    if (f.size > MAX_IMAGE_BYTES_BLOCK) {
      errors.push(`${f.name}: ${(f.size / 1024 / 1024).toFixed(1)} MB exceeds 100 MB limit`);
    } else if (f.size > MAX_IMAGE_BYTES_WARN) {
      warnings.push(`${f.name}: ${(f.size / 1024 / 1024).toFixed(1)} MB is large — consider compressing`);
    }
  }

  return { warnings, errors };
}

/// Cross-check image files vs CSV rows. Returns diff info for the UI to show.
export interface MatchResult {
  matched: Array<{ row: CsvRow; file: File }>;
  missingFiles: CsvRow[];    // CSV row references a file not uploaded
  extraFiles: File[];        // uploaded file not referenced by any row
}

export function matchCsvToFiles(rows: CsvRow[], files: File[]): MatchResult {
  const byName = new Map(files.map((f) => [f.name, f]));
  const usedNames = new Set<string>();

  const matched: MatchResult['matched'] = [];
  const missingFiles: CsvRow[] = [];
  for (const row of rows) {
    const f = byName.get(row.file_name);
    if (f) {
      matched.push({ row, file: f });
      usedNames.add(row.file_name);
    } else {
      missingFiles.push(row);
    }
  }
  const extraFiles = files.filter((f) => !usedNames.has(f.name));
  return { matched, missingFiles, extraFiles };
}

/// Strip unsafe characters from a filename. Lowercase, replace anything not
/// `[a-z0-9._-]` with `_`, collapse runs of underscores. Does not dedupe — the
/// caller is responsible for collision handling.
export function sanitizeFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '');
}
