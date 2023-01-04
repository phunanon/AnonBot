const cache: { [key: string]: number } = {};

export const cacheAdd = (key: string, ttlMs: number) =>
  (cache[key] = Date.now() + ttlMs);

export const cacheHas = (key: string) => {
  for (const x in cache) if (cache[x]! < Date.now()) delete cache[x];
  return cache[key] !== undefined;
};
