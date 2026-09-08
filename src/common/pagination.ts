export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export function paginate<T extends { id: number }>(
  rows: T[],
  limit: number,
  cursor?: string,
): Page<T> {
  const afterId = cursor ? decodeCursor(cursor) : 0;
  const start = rows.findIndex((row) => row.id > afterId);
  const slice = start === -1 ? [] : rows.slice(start, start + limit);
  const hasMore = start !== -1 && start + limit < rows.length;
  return {
    items: slice,
    next_cursor: hasMore ? encodeCursor(slice[slice.length - 1].id) : null,
  };
}

function encodeCursor(id: number): string {
  return Buffer.from(String(id)).toString('base64url');
}

function decodeCursor(cursor: string): number {
  const id = Number(Buffer.from(cursor, 'base64url').toString());
  return Number.isInteger(id) && id > 0 ? id : 0;
}
