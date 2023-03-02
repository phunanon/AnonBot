const cache: { [key: string]: number } = {};

export const cacheAdd = (key: string, ttlMs: number) =>
  (cache[key] = Date.now() + ttlMs);

export const cacheHas = (key: string) => {
  for (const x in cache) if (cache[x]! < Date.now()) delete cache[x];
  return cache[key] !== undefined;
};

export async function resilience<T>(f: () => Promise<T>) {
  for (let i = 0; i < 5; i++) {
    try {
      return await f();
    } catch (e) {
      console.log(i, 'resilience', e);
    }
    //Back-off
    await new Promise(resolve => setTimeout(resolve, i * 100));
  }
  //TODO: throw and inform user
}

export function failable<P extends any[], U>(f: (...args: P) => Promise<U>) {
  return <F>(onFail?: () => Promise<F>) =>
    async (...params: P): Promise<U | Awaited<F> | undefined> => {
      try {
        return await f(...params);
      } catch (e: any) {
        console.log('failable', 'rawError' in e ? e.rawError : e);
        const x = await onFail?.();
        return x;
      }
    };
}
