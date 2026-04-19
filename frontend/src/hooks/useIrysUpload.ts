import { useCallback, useRef, useState } from 'react';
import { buildIrysUploader, type IrysUploader } from '../lib/irysClient';

export interface UploadProgress {
  uploaded: number;
  total: number;
  currentFile?: string;
}

export type UploadStatus =
  | 'idle'
  | 'initializing'
  | 'quoting'
  | 'funding'
  | 'uploading'
  | 'ready'
  | 'error';

export interface UseIrysUploadApi {
  status: UploadStatus;
  error: Error | null;
  progress: UploadProgress;

  /// Estimate funding needed for N bytes. Returns wei as bigint.
  quote: (totalBytes: number) => Promise<bigint>;

  /// Current Irys balance for this wallet, in wei.
  balance: () => Promise<bigint>;

  /// Top up the Irys node with `amountWei` funded from the connected wallet.
  /// Returns the ETH transaction hash. Safe to call with extra headroom — dust
  /// leftover can be withdrawn via `withdrawBalance()` later.
  fund: (amountWei: bigint) => Promise<string>;

  /// Upload an array of files as a folder manifest. Returns the manifest
  /// transaction ID which resolves at `ar://<id>/<filename>`.
  uploadFolder: (files: File[]) => Promise<string>;

  /// Upload a JSON object as a single transaction. Returns the tx ID.
  uploadJson: (data: object, filename?: string) => Promise<string>;

  /// Upload an array of { filename, json } items as a folder manifest.
  uploadJsonFolder: (items: Array<{ filename: string; json: object }>) => Promise<string>;

  /// Drop the cached uploader — call on wallet / chain change.
  reset: () => void;
}

export function useIrysUpload(): UseIrysUploadApi {
  const [status, setStatus] = useState<UploadStatus>('idle');
  const [error, setError] = useState<Error | null>(null);
  const [progress, setProgress] = useState<UploadProgress>({ uploaded: 0, total: 0 });

  const uploaderRef = useRef<IrysUploader | null>(null);

  const getUploader = useCallback(async (): Promise<IrysUploader> => {
    if (uploaderRef.current) return uploaderRef.current;
    setStatus('initializing');
    try {
      const u = await buildIrysUploader();
      uploaderRef.current = u;
      setStatus('ready');
      return u;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err);
      setStatus('error');
      throw err;
    }
  }, []);

  const quote = useCallback(async (totalBytes: number) => {
    setStatus('quoting');
    const u = await getUploader();
    // Irys returns a BigNumber-like — coerce via string to keep bigint semantics.
    const price = await u.getPrice(totalBytes);
    setStatus('ready');
    return BigInt(price.toString());
  }, [getUploader]);

  const balance = useCallback(async () => {
    const u = await getUploader();
    const bal = await u.getLoadedBalance();
    return BigInt(bal.toString());
  }, [getUploader]);

  const fund = useCallback(async (amountWei: bigint) => {
    setStatus('funding');
    setError(null);
    try {
      const u = await getUploader();
      // Irys accepts string | BigNumber for the fund amount. Pass as string
      // to avoid BigNumber version mismatches between ethers v5 / v6.
      const receipt = await u.fund(amountWei.toString());
      setStatus('ready');
      // Irys fund receipts include a `txId` — the on-chain ETH tx hash.
      return (receipt as { txId?: string; id?: string }).txId ?? (receipt as { id?: string }).id ?? '';
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err);
      setStatus('error');
      throw err;
    }
  }, [getUploader]);

  const uploadFolder = useCallback(async (files: File[]) => {
    setStatus('uploading');
    setError(null);
    setProgress({ uploaded: 0, total: files.length });
    try {
      const u = await getUploader();
      // uploadFolder takes a File[] in the browser; each file becomes a
      // manifest entry keyed by its name. Returns a transaction object with
      // `id` — the manifest tx ID that resolves at ar://<id>/<filename>.
      //
      // We fake progress by wrapping each upload individually when the SDK
      // doesn't expose a progress callback. Irys's upload events vary across
      // SDK versions — uploading file-by-file gives us reliable progress + retry.
      const fileIds: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i]!;
        setProgress({ uploaded: i, total: files.length, currentFile: f.name });
        const buf = new Uint8Array(await f.arrayBuffer());
        const receipt = await u.upload(buf, {
          tags: [
            { name: 'Content-Type', value: f.type },
            { name: 'File-Name', value: f.name },
          ],
        });
        fileIds.push(receipt.id);
      }
      // Build manifest: { manifest: "arweave/paths", version: "0.1.0", paths: { "file.png": { id } } }
      const manifest = {
        manifest: 'arweave/paths',
        version: '0.1.0',
        paths: Object.fromEntries(
          files.map((f, i) => [f.name, { id: fileIds[i] }])
        ),
      };
      const manifestReceipt = await u.upload(
        new TextEncoder().encode(JSON.stringify(manifest)),
        { tags: [{ name: 'Content-Type', value: 'application/x.arweave-manifest+json' }] }
      );
      setProgress({ uploaded: files.length, total: files.length });
      setStatus('ready');
      return manifestReceipt.id;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err);
      setStatus('error');
      throw err;
    }
  }, [getUploader]);

  const uploadJson = useCallback(async (data: object, filename = 'data.json') => {
    const u = await getUploader();
    const body = new TextEncoder().encode(JSON.stringify(data));
    const receipt = await u.upload(body, {
      tags: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'File-Name', value: filename },
      ],
    });
    return receipt.id;
  }, [getUploader]);

  const uploadJsonFolder = useCallback(async (items: Array<{ filename: string; json: object }>) => {
    setStatus('uploading');
    setError(null);
    setProgress({ uploaded: 0, total: items.length });
    try {
      const u = await getUploader();
      const ids: string[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        setProgress({ uploaded: i, total: items.length, currentFile: item.filename });
        const body = new TextEncoder().encode(JSON.stringify(item.json));
        const receipt = await u.upload(body, {
          tags: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'File-Name', value: item.filename },
          ],
        });
        ids.push(receipt.id);
      }
      const manifest = {
        manifest: 'arweave/paths',
        version: '0.1.0',
        paths: Object.fromEntries(
          items.map((item, i) => [item.filename, { id: ids[i] }])
        ),
      };
      const manifestReceipt = await u.upload(
        new TextEncoder().encode(JSON.stringify(manifest)),
        { tags: [{ name: 'Content-Type', value: 'application/x.arweave-manifest+json' }] }
      );
      setProgress({ uploaded: items.length, total: items.length });
      setStatus('ready');
      return manifestReceipt.id;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err);
      setStatus('error');
      throw err;
    }
  }, [getUploader]);

  const reset = useCallback(() => {
    uploaderRef.current = null;
    setStatus('idle');
    setError(null);
    setProgress({ uploaded: 0, total: 0 });
  }, []);

  return {
    status,
    error,
    progress,
    quote,
    balance,
    fund,
    uploadFolder,
    uploadJson,
    uploadJsonFolder,
    reset,
  };
}
