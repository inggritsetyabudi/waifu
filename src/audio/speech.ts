import { invoke } from "@tauri-apps/api/core";

/** Playback samples, analysis and mouth motion all use the actual audio clock. */
export class AvatarSpeech {
  private context: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private frame = 0;
  private generation = 0;
  constructor(private mouth: (level: number) => void, private playback: (active: boolean) => void = () => {}) {}

  /** Call directly from a button click to unlock playback in WebKit. */
  async unlock() {
    const context = this.context ??= new AudioContext();
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        context.resume(),
        new Promise<never>((_, reject) => {
          resumeTimer = setTimeout(() => reject(new Error(
            "Audio belum aktif. Klik kanan avatar, lalu pilih Tes suara."
          )), 2000);
        }),
      ]);
    } finally {
      clearTimeout(resumeTimer);
    }
    return context;
  }

  async speak(text: string) {
    this.stop();
    const generation = this.generation;
    const context = await this.unlock();
    if (generation !== this.generation) return;
    const samples = await invoke<number[]>("cmd_synthesize_speech", { text });
    if (generation !== this.generation) return;
    const buffer = await context.decodeAudioData(new Uint8Array(samples).buffer);
    if (generation !== this.generation) return;
    if (context.state !== "running") {
      throw new Error("Audio belum aktif. Klik kanan avatar, lalu pilih Tes suara.");
    }
    const source = context.createBufferSource();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.buffer = buffer;
    source.connect(analyser);
    analyser.connect(context.destination);
    const waveform = new Uint8Array(analyser.fftSize);
    let smooth = 0;
    const update = () => {
      analyser.getByteTimeDomainData(waveform);
      let energy = 0;
      for (const value of waveform) energy += ((value - 128) / 128) ** 2;
      const target = Math.min(1, Math.max(0, Math.sqrt(energy / waveform.length) - 0.015) * 7);
      smooth += (target - smooth) * 0.45;
      this.mouth(smooth);
      this.frame = requestAnimationFrame(update);
    };
    this.source = source;
    source.onended = () => {
      source.disconnect();
      analyser.disconnect();
      if (this.source === source) {
        this.source = null;
        cancelAnimationFrame(this.frame);
        this.mouth(0);
        this.playback(false);
      }
    };
    source.start();
    this.playback(true);
    update();
  }

  stop() {
    ++this.generation;
    cancelAnimationFrame(this.frame);
    this.source?.stop();
    this.source = null;
    this.mouth(0);
    this.playback(false);
  }

  destroy() {
    this.stop();
    void this.context?.close();
    this.context = null;
  }
}
