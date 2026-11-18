let pending: Promise<void> | null = null;

/** The Cubism SDK must exist before importing pixi-live2d-display. */
export function ensureCubismCore(): Promise<void> {
  if ((window as any).Live2DCubismCore) return Promise.resolve();
  if (pending) return pending;
  pending = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/live2dcubismcore.min.js";
    script.onload = () => (window as any).Live2DCubismCore ? resolve() : reject(new Error("Cubism Core tidak tersedia"));
    script.onerror = () => reject(new Error("Gagal memuat Cubism Core. Tekan Muat ulang avatar."));
    document.head.appendChild(script);
  }).catch((error) => { pending = null; throw error; });
  return pending;
}
