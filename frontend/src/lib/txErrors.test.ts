import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UserRejectedRequestError } from 'viem';
import { isUserRejection, extractErrorMessage, surfaceTxError } from './txErrors';

describe('isUserRejection', () => {
  it('detects viem UserRejectedRequestError instances', () => {
    const err = new UserRejectedRequestError(new Error('rejected'));
    expect(isUserRejection(err)).toBe(true);
  });

  it('detects EIP-1193 code 4001 from older wallet providers', () => {
    expect(isUserRejection({ code: 4001 })).toBe(true);
  });

  it('detects error name "UserRejectedRequestError" on plain objects', () => {
    expect(isUserRejection({ name: 'UserRejectedRequestError' })).toBe(true);
  });

  it('detects "user rejected" in message text (case-insensitive)', () => {
    expect(isUserRejection({ message: 'User rejected the request' })).toBe(true);
    expect(isUserRejection({ message: 'USER REJECTED' })).toBe(true);
  });

  it('detects "user denied" in message text', () => {
    expect(isUserRejection({ message: 'User denied transaction signature' })).toBe(true);
  });

  it('returns false for null / undefined', () => {
    expect(isUserRejection(null)).toBe(false);
    expect(isUserRejection(undefined)).toBe(false);
  });

  it('returns false for non-object inputs', () => {
    expect(isUserRejection('some string')).toBe(false);
    expect(isUserRejection(42)).toBe(false);
    expect(isUserRejection(true)).toBe(false);
  });

  it('returns false for unrelated errors', () => {
    expect(isUserRejection(new Error('insufficient funds'))).toBe(false);
    expect(isUserRejection({ code: 500, message: 'server error' })).toBe(false);
  });
});

describe('extractErrorMessage', () => {
  it('prefers shortMessage over message', () => {
    expect(extractErrorMessage({ shortMessage: 'short', message: 'long' })).toBe('short');
  });

  it('falls back to message when shortMessage is absent', () => {
    expect(extractErrorMessage({ message: 'just message' })).toBe('just message');
  });

  it('falls back to default when neither field is present', () => {
    expect(extractErrorMessage({})).toBe('Transaction failed');
    expect(extractErrorMessage({ code: 500 })).toBe('Transaction failed');
  });

  it('accepts a custom fallback string', () => {
    expect(extractErrorMessage({}, 'Nope')).toBe('Nope');
  });

  it('returns string inputs directly', () => {
    expect(extractErrorMessage('direct string')).toBe('direct string');
  });

  it('returns the fallback for null / undefined', () => {
    expect(extractErrorMessage(null)).toBe('Transaction failed');
    expect(extractErrorMessage(undefined)).toBe('Transaction failed');
  });

  it('trims whitespace from shortMessage and message', () => {
    expect(extractErrorMessage({ shortMessage: '   trimmed   ' })).toBe('trimmed');
    expect(extractErrorMessage({ message: '   msg   ' })).toBe('msg');
  });

  it('skips blank shortMessage and falls through to message', () => {
    expect(extractErrorMessage({ shortMessage: '   ', message: 'real' })).toBe('real');
  });
});

describe('surfaceTxError', () => {
  let toast: { error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; message: ReturnType<typeof vi.fn> };
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    toast = { error: vi.fn(), info: vi.fn(), message: vi.fn() };
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('always logs to console.error with [tx] prefix by default', () => {
    surfaceTxError(new Error('boom'), toast);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy.mock.calls[0][0]).toBe('[tx]');
  });

  it('uses the component name as console prefix when provided', () => {
    surfaceTxError(new Error('boom'), toast, { component: 'StakingCard' });
    expect(consoleErrorSpy.mock.calls[0][0]).toBe('[StakingCard]');
  });

  it('surfaces user rejections as an info toast by default', () => {
    surfaceTxError({ code: 4001 }, toast);
    expect(toast.info).toHaveBeenCalledWith('Cancelled');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('uses custom cancelledMessage when provided', () => {
    surfaceTxError({ code: 4001 }, toast, { cancelledMessage: 'Nevermind' });
    expect(toast.info).toHaveBeenCalledWith('Nevermind');
  });

  it('falls back to toast.message if toast.info is unavailable', () => {
    const toastNoInfo = { error: vi.fn(), message: vi.fn() };
    surfaceTxError({ code: 4001 }, toastNoInfo);
    expect(toastNoInfo.message).toHaveBeenCalledWith('Cancelled');
    expect(toastNoInfo.error).not.toHaveBeenCalled();
  });

  it('falls back to toast.error if neither info nor message is available', () => {
    const toastBasic = { error: vi.fn() };
    surfaceTxError({ code: 4001 }, toastBasic);
    expect(toastBasic.error).toHaveBeenCalledWith('Cancelled');
  });

  it('surfaces real failures via toast.error with the extracted message', () => {
    surfaceTxError({ shortMessage: 'insufficient funds' }, toast);
    expect(toast.error).toHaveBeenCalledWith('insufficient funds');
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('suppresses the toast when silent: true but still logs', () => {
    surfaceTxError(new Error('boom'), toast, { silent: true });
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });
});
