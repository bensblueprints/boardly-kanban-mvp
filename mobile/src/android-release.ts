export type AndroidRelease = {
  version: string; version_code: number; size: number; sha256: string; download_url: string;
};

export function validateAndroidRelease(value: unknown): AndroidRelease {
  if (!value || typeof value !== 'object') throw new Error('Invalid Android release metadata.');
  const r = value as Record<string, unknown>;
  if (typeof r.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(r.version) ||
      typeof r.version_code !== 'number' || !Number.isSafeInteger(r.version_code) || r.version_code < 1 ||
      typeof r.size !== 'number' || !Number.isSafeInteger(r.size) || r.size < 1 || r.size > 300000000 ||
      typeof r.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(r.sha256) ||
      r.download_url !== '/api/mobile/android/apk') {
    throw new Error('Invalid Android release metadata. Please try again later.');
  }
  return { version: r.version, version_code: r.version_code, size: r.size, sha256: r.sha256, download_url: r.download_url };
}
