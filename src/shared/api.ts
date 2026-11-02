import type { Account } from './settings';

/** The tapeshelf API as the extension calls it: its token, no cookies. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ExtensionContext {
  user: Account['user'];
  /** No daily limit through the extension (Pro, or none set on a self-hosted server). */
  unlimited: boolean;
  emailVerified: boolean;
  limits: {
    /** 0: no limit. */
    maxFileBytes: number;
    /** -1: no limit. */
    freeBytes: number;
    /** Videos a day through the extension; 0: no limit. */
    perDay: number;
    usedToday: number;
    resetsAt: string;
  };
  categories: { id: string; name: string }[];
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface UploadSession {
  id: string;
  /** Declared bytes: exact, or the most for a stream (`sizeIsMax`). */
  size: number;
  partSize: number;
  status: 'ACTIVE' | 'COMPLETED' | 'ABORTED' | 'EXPIRED';
  videoId: string | null;
  uploadedParts: UploadedPart[];
  audio?: { size: number; uploadedParts: UploadedPart[] };
}

export interface SavedVideo {
  id: string;
  code: string;
  title: string;
}

export async function api<T>(
  account: Pick<Account, 'server' | 'token'>,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  lang?: string,
  signal?: AbortSignal,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${account.server}/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${account.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(lang ? { 'Accept-Language': lang } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: 'omit',
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ApiError(0, 'network', String(err));
  }
  const data = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
  if (!res.ok)
    throw new ApiError(res.status, data?.code ?? 'http', data?.message ?? `HTTP ${res.status}`);
  return data as T;
}
