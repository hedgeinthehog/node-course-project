export async function getOrder(baseUrl, id) {
  const res = await fetch(`${baseUrl}/orders/${id}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`GET /orders/${id} failed with ${res.status}`);
  }
  return res.json();
}
