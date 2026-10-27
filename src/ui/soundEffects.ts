let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return null;
  if (!audioCtx) {
    audioCtx = new AudioCtx();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

/**
 * Synthesizes a pleasant ascending chime (C5 -> E5 -> G5 -> C6) on batch completion.
 */
export function playCompletionChime(): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6
    const startTime = ctx.currentTime;

    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, startTime + idx * 0.09);

      gain.gain.setValueAtTime(0, startTime + idx * 0.09);
      gain.gain.linearRampToValueAtTime(0.18, startTime + idx * 0.09 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + idx * 0.09 + 0.4);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(startTime + idx * 0.09);
      osc.stop(startTime + idx * 0.09 + 0.42);
    });
  } catch {
    // Non-fatal if browser blocks audio autoplay
  }
}

/**
 * Synthesizes a gentle 2-tone alert chime (A4 -> F#4) when attention or pause occurs.
 */
export function playAttentionChime(): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const notes = [440.0, 369.99]; // A4, F#4
    const startTime = ctx.currentTime;

    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, startTime + idx * 0.16);

      gain.gain.setValueAtTime(0, startTime + idx * 0.16);
      gain.gain.linearRampToValueAtTime(0.2, startTime + idx * 0.16 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + idx * 0.16 + 0.35);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(startTime + idx * 0.16);
      osc.stop(startTime + idx * 0.16 + 0.38);
    });
  } catch {
    // Non-fatal if browser blocks audio autoplay
  }
}
