import { describe, it, expect } from 'vitest';
import {
  parseCsv,
  buildTokenMetadata,
  buildContractMetadata,
  validateImages,
  matchCsvToFiles,
  sanitizeFilename,
} from './nftMetadata';

// Tiny helper: build a stub File with MIME + size without reading actual bytes.
function mockFile(name: string, type = 'image/png', size = 1024): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe('parseCsv', () => {
  it('parses a minimal valid CSV', () => {
    const csv = [
      'file_name,name,description',
      '1.png,Token 1,First one',
      '2.png,Token 2,Second one',
    ].join('\n');
    const { rows, warnings } = parseCsv(csv);
    expect(rows).toHaveLength(2);
    expect(warnings).toEqual([]);
    expect(rows[0]).toEqual({
      file_name: '1.png',
      name: 'Token 1',
      description: 'First one',
      attributes: [],
    });
  });

  it('extracts attribute_N_trait / attribute_N_value pairs', () => {
    const csv = [
      'file_name,name,attribute_0_trait,attribute_0_value,attribute_1_trait,attribute_1_value',
      '1.png,Token 1,Background,Kyle Green,Rarity,Common',
    ].join('\n');
    const { rows } = parseCsv(csv);
    expect(rows[0]!.attributes).toEqual([
      { trait_type: 'Background', value: 'Kyle Green' },
      { trait_type: 'Rarity', value: 'Common' },
    ]);
  });

  it('skips rows missing file_name with a warning, not error', () => {
    const csv = ['file_name,name', ',Orphan', '1.png,Valid'].join('\n');
    const { rows, warnings } = parseCsv(csv);
    expect(rows).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('missing file_name');
  });

  it('throws when file_name header is missing', () => {
    expect(() => parseCsv('name,description\nToken 1,x')).toThrow(/file_name/);
  });

  it('throws when name header is missing', () => {
    // Papaparse needs ≥ 2 columns to pick a delimiter, so give it a second header
    // that isn't `name`. Our own validator should still catch the missing `name`.
    expect(() => parseCsv('file_name,description\n1.png,x')).toThrow(/"name"/);
  });

  it('throws on empty CSV', () => {
    expect(() => parseCsv('file_name,name\n')).toThrow(/empty/i);
  });

  it('tolerates missing attribute values (skips those, keeps row)', () => {
    const csv = [
      'file_name,name,attribute_0_trait,attribute_0_value',
      '1.png,Token 1,Background,',
      '2.png,Token 2,Background,Blue',
    ].join('\n');
    const { rows } = parseCsv(csv);
    expect(rows[0]!.attributes).toEqual([]); // value was blank → no attribute
    expect(rows[1]!.attributes).toEqual([{ trait_type: 'Background', value: 'Blue' }]);
  });
});

describe('buildTokenMetadata', () => {
  it('produces OpenSea-shaped JSON', () => {
    const row = {
      file_name: '1.png',
      name: 'Token 1',
      description: 'Hello',
      attributes: [{ trait_type: 'Background', value: 'Blue' }],
    };
    const meta = buildTokenMetadata(row, 'ar://cid/1.png');
    expect(meta).toEqual({
      name: 'Token 1',
      description: 'Hello',
      image: 'ar://cid/1.png',
      attributes: [{ trait_type: 'Background', value: 'Blue' }],
    });
  });

  it('treats missing description as empty string (required by OpenSea)', () => {
    const row = {
      file_name: '1.png',
      name: 'Token 1',
      attributes: [],
    };
    const meta = buildTokenMetadata(row, 'ar://cid/1.png');
    expect(meta.description).toBe('');
  });
});

describe('buildContractMetadata', () => {
  const base = {
    name: 'Towelies',
    description: 'A drop about towels.',
    royaltyBps: 500,
    feeRecipient: '0x1111111111111111111111111111111111111111',
  };

  it('builds with required fields', () => {
    const meta = buildContractMetadata(base);
    expect(meta).toMatchObject({
      name: 'Towelies',
      description: 'A drop about towels.',
      seller_fee_basis_points: 500,
      fee_recipient: '0x1111111111111111111111111111111111111111',
    });
  });

  it('omits optional fields when not provided', () => {
    const meta = buildContractMetadata(base);
    expect(meta.image).toBeUndefined();
    expect(meta.banner_image).toBeUndefined();
    expect(meta.external_link).toBeUndefined();
  });

  it('includes optional fields when provided', () => {
    const meta = buildContractMetadata({
      ...base,
      coverImageUri: 'ar://cover',
      bannerImageUri: 'ar://banner',
      externalLink: 'https://tegridyfarms.xyz',
    });
    expect(meta.image).toBe('ar://cover');
    expect(meta.banner_image).toBe('ar://banner');
    expect(meta.external_link).toBe('https://tegridyfarms.xyz');
  });

  it('throws on royaltyBps > 10000', () => {
    expect(() => buildContractMetadata({ ...base, royaltyBps: 10001 })).toThrow(/royaltyBps/);
  });

  it('throws on non-https external_link', () => {
    expect(() => buildContractMetadata({ ...base, externalLink: 'http://insecure' }))
      .toThrow(/https/);
  });

  it('throws on empty name', () => {
    expect(() => buildContractMetadata({ ...base, name: '   ' })).toThrow(/name/);
  });

  it('throws on over-long name', () => {
    expect(() => buildContractMetadata({ ...base, name: 'x'.repeat(65) })).toThrow(/64/);
  });
});

describe('validateImages', () => {
  it('returns error when zero files', () => {
    const { errors } = validateImages([]);
    expect(errors).toContain('No images selected');
  });

  it('rejects unsupported MIME types', () => {
    const { errors } = validateImages([mockFile('bad.svg', 'image/svg+xml')]);
    expect(errors[0]).toMatch(/unsupported type/);
  });

  it('rejects >100MB', () => {
    const huge = mockFile('huge.png', 'image/png', 101 * 1024 * 1024);
    const { errors } = validateImages([huge]);
    expect(errors[0]).toMatch(/exceeds 100 MB/);
  });

  it('warns on >20MB but <100MB', () => {
    const big = mockFile('big.png', 'image/png', 25 * 1024 * 1024);
    const { warnings, errors } = validateImages([big]);
    expect(errors).toEqual([]);
    expect(warnings[0]).toMatch(/large/);
  });

  it('warns when count > 10,000', () => {
    const many = Array.from({ length: 10_001 }, (_, i) => mockFile(`${i}.png`));
    const { warnings } = validateImages(many);
    expect(warnings[0]).toMatch(/10001/);
  });
});

describe('matchCsvToFiles', () => {
  it('matches and reports missing files + extras', () => {
    const rows = [
      { file_name: '1.png', name: 'A', attributes: [] },
      { file_name: '2.png', name: 'B', attributes: [] },
      { file_name: 'missing.png', name: 'C', attributes: [] },
    ];
    const files = [mockFile('1.png'), mockFile('2.png'), mockFile('orphan.png')];
    const { matched, missingFiles, extraFiles } = matchCsvToFiles(rows, files);
    expect(matched).toHaveLength(2);
    expect(missingFiles).toHaveLength(1);
    expect(missingFiles[0]!.file_name).toBe('missing.png');
    expect(extraFiles).toHaveLength(1);
    expect(extraFiles[0]!.name).toBe('orphan.png');
  });
});

describe('sanitizeFilename', () => {
  it('lowercases and replaces unsafe chars with underscore', () => {
    expect(sanitizeFilename('My Token #1!.PNG')).toBe('my_token_1_.png');
  });
  it('collapses runs of underscores', () => {
    expect(sanitizeFilename('a   b___c')).toBe('a_b_c');
  });
  it('strips leading/trailing underscores and dots', () => {
    expect(sanitizeFilename('..hidden..')).toBe('hidden');
    expect(sanitizeFilename('___a___')).toBe('a');
  });
});
