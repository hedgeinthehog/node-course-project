export const MiB = 1024 * 1024;
export const MIN_PART_SIZE = 5 * MiB;
export const MAX_PARTS = 10_000;
export const MULTIPART_THRESHOLD = 2 * MIN_PART_SIZE;
export const MAX_FILE_SIZE = 5 * 1024 * 1024 * MiB;
export const PUT_URL_TTL_S = 300;
export const GET_URL_TTL_S = 60;

export const CONTENT_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'application/octet-stream': 'bin',
};

export const extensionFor = (contentType: string): string | undefined =>
  CONTENT_TYPES[contentType];

export const isMultipart = (size: number) => size > MULTIPART_THRESHOLD;

export function partSizeFor(size: number): number {
  const smallest = Math.ceil(size / MAX_PARTS);
  return Math.max(MIN_PART_SIZE, Math.ceil(smallest / MiB) * MiB);
}

export const partCountFor = (size: number, partSize: number) =>
  Math.ceil(size / partSize);
