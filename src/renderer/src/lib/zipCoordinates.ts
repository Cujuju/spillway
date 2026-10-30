export interface Coordinates { latitude: number; longitude: number }

/** The large Census table is fetched only when a ZIP is used or validated. */
export async function zipCoordinates(zip: string): Promise<Coordinates | null> {
  if (!/^\d{5}$/.test(zip)) return null;
  const { default: points } = await import('./zcta.json');
  const key = Number(zip);
  let low = 0;
  let high = points.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const point = points[mid]!;
    if (point[0]! < key) low = mid + 1;
    else if (point[0]! > key) high = mid - 1;
    else return { latitude: point[1]!, longitude: point[2]! };
  }
  return null;
}
