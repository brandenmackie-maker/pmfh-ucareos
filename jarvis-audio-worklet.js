/**
 * ============================================================================
 * jarvis-audio-worklet.js (pmfh-ucareos — 16 kHz PCM Capture + Pre-Roll Ring)
 * Runs on dedicated Web Audio rendering thread (zero main-thread UI jank).
 * Downsamples native hardware sampleRate (48k/44.1k/16k) -> 16,000 Hz Int16 LE.
 * Emits 40ms frames (640 samples = 1,280 bytes) + rolling pre-roll buffer.
 * ============================================================================
 */
class JarvisCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.frameSamples = 640; // 40ms @ 16kHz
    this.outBuffer = new Int16Array(this.frameSamples);
    this.outIndex = 0;

    // Fractional boxcar accumulator for clean anti-aliased downsampling
    this.resampleRatio = sampleRate / this.targetRate;
    this.srcPhase = 0;
    this.accumSum = 0;
    this.accumCount = 0;

    // Rolling 1.6s pre-roll buffer (40 frames x 40ms) during WebSocket handshake
    this.maxPreRollFrames = 40;
    this.preRollQueue = [];
    this.streaming = false;

    this.port.onmessage = (ev) => {
      const msg = ev.data || {};
      if (msg.cmd === 'START_STREAM') {
        this.streaming = true;
        if (msg.flushPreRoll && this.preRollQueue.length > 0) {
          for (let i = 0; i < this.preRollQueue.length; i++) {
            const item = this.preRollQueue[i];
            this.port.postMessage(
              { type: 'PCM_CHUNK', pcmBuffer: item.buffer, rms: item.rms, preRoll: true },
              [item.buffer]
            );
          }
        }
        this.preRollQueue = [];
      } else if (msg.cmd === 'STOP_STREAM') {
        this.streaming = false;
        this.preRollQueue = [];
      }
    };
  }

  emitFrame_(int16Chunk) {
    let sumSq = 0;
    for (let i = 0; i < int16Chunk.length; i++) {
      const norm = int16Chunk[i] / 32768.0;
      sumSq += norm * norm;
    }
    const rms = Math.sqrt(sumSq / int16Chunk.length);
    const copy = new Int16Array(int16Chunk);

    if (this.streaming) {
      this.port.postMessage(
        { type: 'PCM_CHUNK', pcmBuffer: copy.buffer, rms: rms, preRoll: false },
        [copy.buffer]
      );
    } else {
      this.preRollQueue.push({ buffer: copy.buffer, rms: rms });
      if (this.preRollQueue.length > this.maxPreRollFrames) {
        this.preRollQueue.shift();
      }
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;
    const ch0 = input[0];

    if (sampleRate === this.targetRate) {
      for (let i = 0; i < ch0.length; i++) {
        const s = Math.max(-1, Math.min(1, ch0[i]));
        this.outBuffer[this.outIndex++] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        if (this.outIndex >= this.frameSamples) {
          this.emitFrame_(this.outBuffer);
          this.outIndex = 0;
        }
      }
      return true;
    }

    for (let i = 0; i < ch0.length; i++) {
      this.accumSum += ch0[i];
      this.accumCount++;
      this.srcPhase += 1;

      if (this.srcPhase >= this.resampleRatio) {
        this.srcPhase -= this.resampleRatio;
        const avg = this.accumCount > 0 ? this.accumSum / this.accumCount : ch0[i];
        this.accumSum = 0;
        this.accumCount = 0;

        const clamped = Math.max(-1, Math.min(1, avg));
        this.outBuffer[this.outIndex++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;

        if (this.outIndex >= this.frameSamples) {
          this.emitFrame_(this.outBuffer);
          this.outIndex = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('jarvis-capture-processor', JarvisCaptureProcessor);