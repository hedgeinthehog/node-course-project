export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  const id = Number(Buffer.from(cursor, 'base64url').toString());
  return Number.isInteger(id) && id > 0 ? id : 0;
}

export function buildPage<T extends { id: number }>(
  rows: T[],
  limit: number,
): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return {
    items,
    next_cursor: hasMore ? encodeCursor(items[items.length - 1].id) : null,
  };
}

function encodeCursor(id: number): string {
  return Buffer.from(String(id)).toString('base64url');
}
