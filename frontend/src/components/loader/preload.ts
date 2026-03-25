export function preloadImages(srcs: string[]): Promise<(HTMLImageElement | null)[]> {
  return Promise.allSettled(
    srcs.map(
      (src) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = src;
        }),
    ),
  ).then((results) =>
    results.map((r) => (r.status === 'fulfilled' ? r.value : null)),
  );
}
