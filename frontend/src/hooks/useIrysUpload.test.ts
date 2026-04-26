import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock the Irys client so we never hit the real SDK.
const uploadMock = vi.fn();
const fundMock = vi.fn();
const getPriceMock = vi.fn();
const getLoadedBalanceMock = vi.fn();

vi.mock('../lib/irysClient', () => ({
  buildIrysUploader: vi.fn(async () => ({
    upload: uploadMock,
    fund: fundMock,
    getPrice: getPriceMock,
    getLoadedBalance: getLoadedBalanceMock,
  })),
}));

import {
  useIrysUpload,
  PayloadTooLargeError,
  MAX_UPLOAD_BYTES_PER_FILE,
  MAX_UPLOAD_BYTES_TOTAL,
} from './useIrysUpload';

function makeFile(name: string, bytes: number): File {
  // Create a file of approximate size — Vitest uses node's File polyfill which
  // accepts any BlobPart, so we just pass a Uint8Array.
  return new File([new Uint8Array(bytes)], name, { type: 'application/octet-stream' });
}

describe('useIrysUpload — R044 H2 size cap', () => {
  beforeEach(() => {
    uploadMock.mockReset();
    fundMock.mockReset();
    getPriceMock.mockReset();
    getLoadedBalanceMock.mockReset();
    getPriceMock.mockResolvedValue({ toString: () => '12345' });
    uploadMock.mockResolvedValue({ id: 'tx_id_abc' });
    fundMock.mockResolvedValue({ txId: '0xfundtx' });
  });

  it('exposes the 100 MB and 500 MB caps', () => {
    expect(MAX_UPLOAD_BYTES_PER_FILE).toBe(100 * 1024 * 1024);
    expect(MAX_UPLOAD_BYTES_TOTAL).toBe(500 * 1024 * 1024);
  });

  it('quote() throws PayloadTooLargeError when bytes exceed total cap', async () => {
    const { result } = renderHook(() => useIrysUpload());
    await expect(
      act(async () => {
        await result.current.quote(MAX_UPLOAD_BYTES_TOTAL + 1);
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
    // Critical: quote must NOT call into the SDK if size guard tripped — that
    // is the wallet-drain defense.
    expect(getPriceMock).not.toHaveBeenCalled();
  });

  it('quote() allows payloads at the exact total cap', async () => {
    const { result } = renderHook(() => useIrysUpload());
    let price: bigint = 0n;
    await act(async () => {
      price = await result.current.quote(MAX_UPLOAD_BYTES_TOTAL);
    });
    expect(price).toBe(12345n);
    expect(getPriceMock).toHaveBeenCalledWith(MAX_UPLOAD_BYTES_TOTAL);
  });

  it('quote() rejects negative or NaN totals before SDK call', async () => {
    const { result } = renderHook(() => useIrysUpload());
    await expect(
      act(async () => {
        await result.current.quote(-1);
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
    await expect(
      act(async () => {
        await result.current.quote(NaN);
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect(getPriceMock).not.toHaveBeenCalled();
  });

  it('uploadFolder() rejects when ANY single file exceeds per-file cap', async () => {
    const { result } = renderHook(() => useIrysUpload());
    const tinyFile = makeFile('ok.bin', 100);
    const oversize = makeFile('huge.bin', MAX_UPLOAD_BYTES_PER_FILE + 1);
    await expect(
      act(async () => {
        await result.current.uploadFolder([tinyFile, oversize]);
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
    // No SDK call — guard fires before initialization
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('uploadFolder() rejects when cumulative total exceeds batch cap', async () => {
    // 6 files of 90 MB each = 540 MB total (each is under per-file cap, but
    // sum exceeds the 500 MB total).
    const ninetyMB = 90 * 1024 * 1024;
    const files = Array.from({ length: 6 }, (_, i) => makeFile(`f${i}.bin`, ninetyMB));
    const { result } = renderHook(() => useIrysUpload());
    await expect(
      act(async () => {
        await result.current.uploadFolder(files);
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('uploadJson() rejects oversize JSON before upload', async () => {
    // Build a large object whose JSON serialization exceeds the per-file cap
    // by stuffing a string value.
    const big = 'x'.repeat(MAX_UPLOAD_BYTES_PER_FILE + 16);
    const { result } = renderHook(() => useIrysUpload());
    await expect(
      act(async () => {
        await result.current.uploadJson({ blob: big });
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('uploadJsonFolder() validates per-item AND total before any upload', async () => {
    const big = { blob: 'x'.repeat(MAX_UPLOAD_BYTES_PER_FILE + 16) };
    const items = [
      { filename: '1.json', json: { ok: true } },
      { filename: '2.json', json: big },
    ];
    const { result } = renderHook(() => useIrysUpload());
    await expect(
      act(async () => {
        await result.current.uploadJsonFolder(items);
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('PayloadTooLargeError carries the offending size + limit for UI display', async () => {
    const { result } = renderHook(() => useIrysUpload());
    let caught: PayloadTooLargeError | null = null;
    await act(async () => {
      try {
        await result.current.quote(MAX_UPLOAD_BYTES_TOTAL + 100);
      } catch (e) {
        caught = e as PayloadTooLargeError;
      }
    });
    expect(caught).not.toBeNull();
    expect(caught!.bytes).toBe(MAX_UPLOAD_BYTES_TOTAL + 100);
    expect(caught!.limit).toBe(MAX_UPLOAD_BYTES_TOTAL);
    expect(caught!.name).toBe('PayloadTooLargeError');
  });

  it('happy path: small uploadFolder still flows through to SDK', async () => {
    const small = [makeFile('a.png', 1024), makeFile('b.png', 2048)];
    const { result } = renderHook(() => useIrysUpload());
    let manifestId: string = '';
    await act(async () => {
      manifestId = await result.current.uploadFolder(small);
    });
    expect(manifestId).toBe('tx_id_abc');
    // 2 file uploads + 1 manifest upload = 3 total
    expect(uploadMock).toHaveBeenCalledTimes(3);
  });
});
