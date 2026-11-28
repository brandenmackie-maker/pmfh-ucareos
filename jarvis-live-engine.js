/**
 * ============================================================================
 * jarvis-live-engine.js (pmfh-ucareos — 3-Gear Dual-Layer Voice Engine)
 *
 * GEAR 0: OFF               — All microphone & WebSocket hardware released.
 * GEAR 1: AMBIENT_SENTRY    — Zero-cloud-cost local wake sentry ("Hey Jarvis").
 * GEAR 2: LIVE_CONVERSATION — Full-duplex Gemini 3.8 Live WebSocket (16kHz in,
 *                             24kHz Kore out, <10ms barge-in, 25s auto-sleep).
 * GEAR 3: ASYNC_ACTION_HANDS— Non-blocking postMessage tool bridge to uCareOS.
 * ============================================================================
 */
(function (global) {
  'use strict';

  const SR = global.SpeechRecognition || global.webkitSpeechRecognition || null;
  const WAKE_REGEX = /\b(?:hey\s+jarvis|hi\s+jarvis|yo\s+jarvis|okay\s+jarvis|ok\s+jarvis|jarvis)\b/i;

  class JarvisLiveEngine {
    constructor(options) {
      const opts = options || {};
      this.sendToCockpit = typeof opts.sendToCockpit === 'function' ? opts.sendToCockpit : function () {};
      this.idleTimeoutMs = opts.idleTimeoutMs || 25000;

      this.gear = 'OFF';               // 'OFF' | 'AMBIENT_SENTRY' | 'LIVE_CONVERSATION'
      this.returnToAmbient = false;    // Whether Gear 2 drops back to Gear 1 or OFF
      this.escalating = false;

      // Standby Ephemeral Token Vault
      this.standbyToken = null;
      this.pendingTokenWaiters = [];

      // Gear 1 Local Wake Sentry (Web Speech API)
      this.sentryRec = null;
      this.sentryRestartTimer = null;
      this.pendingWakePrompt = '';

      // Gear 2 Web Audio + WebSocket State
      this.audioCtx = null;
      this.workletLoaded = false;
      this.mediaStream = null;
      this.sourceNode = null;
      this.workletNode = null;
      this.ws = null;
      this.wsSetupComplete = false;
      this.rxChain = Promise.resolve();

      // Playback & Barge-In State
      this.activeSources = new Set();
      this.nextPlayTime = 0;
      this.pendingGracefulSleep = false;
      this.idleTimer = null;

      // Gear 3 Tool Call Registry
      this.pendingTools = new Map();

      this.bindGestureAudioUnlock_();
    }

    /**
     * Unlocks Web Audio context on first user tap/keypress so future hands-free
     * hallway "Hey Jarvis" wakes can speak back immediately without autoplay blocks.
     */
    bindGestureAudioUnlock_() {
      const unlock = () => {
        try {
          if (!this.audioCtx) {
            const Ctx = global.AudioContext || global.webkitAudioContext;
            if (Ctx) this.audioCtx = new Ctx();
          }
          if (this.audioCtx && this.audioCtx.state === 'suspended') {
            this.audioCtx.resume();
          }
        } catch (e) {}
      };
      global.addEventListener('pointerdown', unlock, { passive: true });
      global.addEventListener('keydown', unlock, { passive: true });
    }

    /**
     * Stores a fresh ephemeral session envelope minted by Jarvis_Live_Session_V4.gs
     */
    ingestStandbyToken(envelope) {
      if (!envelope || !envelope.ok || !envelope.wsUrl) return;
      envelope._used = false;
      this.standbyToken = envelope;

      while (this.pendingTokenWaiters.length > 0) {
        const waiter = this.pendingTokenWaiters.shift();
        waiter.resolve(envelope);
      }
    }

    hasValidStandbyToken_() {
      if (!this.standbyToken || this.standbyToken._used) return false;
      const expMs = Date.parse(this.standbyToken.newSessionExpireTime || '');
      if (isNaN(expMs)) return true;
      return Date.now() < (expMs - 30000); // 30s safety margin
    }

    requestTokenPreWarm_() {
      this.sendToCockpit({ type: 'JARVIS_MINT_LIVE_TOKEN' });
    }

    obtainSessionToken_(timeoutMs) {
      if (this.hasValidStandbyToken_()) {
        const tok = this.standbyToken;
        tok._used = true;
        // Immediately pre-warm next token in background for future turns
        setTimeout(() => this.requestTokenPreWarm_(), 1500);
        return Promise.resolve(tok);
      }

      this.requestTokenPreWarm_();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = this.pendingTokenWaiters.findIndex((w) => w.resolve === wrappedResolve);
          if (idx !== -1) this.pendingTokenWaiters.splice(idx, 1);
          reject(new Error('Timed out waiting for ephemeral Live token from cockpit.'));
        }, timeoutMs || 8000);

        const wrappedResolve = (tok) => {
          clearTimeout(timer);
          tok._used = true;
          setTimeout(() => this.requestTokenPreWarm_(), 1500);
          resolve(tok);
        };
        this.pendingTokenWaiters.push({ resolve: wrappedResolve, reject: reject });
      });
    }

    /**
     * Public Mode Switcher called by outer PWA / Cockpit postMessage
     * @param {'OFF'|'AMBIENT'|'SINGLE'|'LIVE'} targetMode
     */
    setMode(targetMode) {
      const mode = String(targetMode || 'OFF').toUpperCase();
      if (mode === 'OFF') {
        this.returnToAmbient = false;
        this.teardownLiveSession_('manual_off');
        this.stopSentry_();
        this.setGear_('OFF');
        return;
      }

      if (mode === 'AMBIENT') {
        this.returnToAmbient = true;
        if (!this.hasValidStandbyToken_()) this.requestTokenPreWarm_();
        if (this.gear !== 'LIVE_CONVERSATION') {
          this.startSentry_();
        }
        return;
      }

      if (mode === 'SINGLE' || mode === 'LIVE') {
        // Direct orb tap -> jump straight into Gear 2 Live Conversation!
        this.escalateToLive('');
      }
    }

    setGear_(nextGear, detail) {
      this.gear = nextGear;
      const legacyMode = nextGear === 'OFF' ? 'OFF' : (nextGear === 'AMBIENT_SENTRY' ? 'AMBIENT' : 'LIVE');
      this.sendToCockpit({
        type: 'JARVIS_GEAR_STATE',
        gear: nextGear,
        mode: legacyMode,
        listening: nextGear !== 'OFF',
        liveActive: nextGear === 'LIVE_CONVERSATION',
        detail: detail || ''
      });
    }

    /* ========================================================================
     * GEAR 1: LOCAL ZERO-COST AMBIENT SENTRY ("Hey Jarvis")
     * ======================================================================== */
    startSentry_() {
      if (!SR) {
        this.sendToCockpit({ type: 'JARVIS_LIVE_ERROR', message: 'SpeechRecognition unavailable for Ambient Sentry.' });
        return;
      }
      this.stopSentry_();
      this.setGear_('AMBIENT_SENTRY', 'Listening locally for Hey Jarvis');

      const launch = () => {
        if (this.gear !== 'AMBIENT_SENTRY' || this.escalating) return;
        clearTimeout(this.sentryRestartTimer);

        try {
          const rec = new SR();
          this.sentryRec = rec;
          rec.continuous = true;
          rec.interimResults = true;
          rec.lang = 'en-US';

          rec.onresult = (ev) => {
            if (this.gear !== 'AMBIENT_SENTRY' || this.escalating) return;
            let combined = '';
            let finalTail = '';

            for (let i = ev.resultIndex; i < ev.results.length; i++) {
              const txt = ev.results[i][0].transcript || '';
              combined += txt + ' ';
              if (ev.results[i].isFinal) finalTail += txt + ' ';
            }

            const match = WAKE_REGEX.exec(combined);
            if (match) {
              const afterWake = combined.slice(match.index + match[0].length).trim();
              this.sendToCockpit({
                type: 'MIC_INTERIM',
                transcript: combined.trim(),
                mode: 'AMBIENT'
              });
              // Escalate immediately; pass any words spoken right after "Hey Jarvis"
              this.escalateToLive(finalTail ? afterWake : afterWake);
            }
          };

          rec.onerror = (ev) => {
            if (ev && (ev.error === 'not-allowed' || ev.error === 'service-not-allowed')) {
              this.returnToAmbient = false;
              this.setGear_('OFF', 'Microphone permission denied');
            }
          };

          rec.onend = () => {
            if (this.gear === 'AMBIENT_SENTRY' && !this.escalating) {
              this.sentryRestartTimer = setTimeout(launch, 280);
            }
          };

          rec.start();
        } catch (e) {
          this.sentryRestartTimer = setTimeout(launch, 800);
        }
      };

      launch();
    }

    stopSentry_() {
      clearTimeout(this.sentryRestartTimer);
      if (this.sentryRec) {
        try {
          this.sentryRec.onresult = null;
          this.sentryRec.onend = null;
          this.sentryRec.onerror = null;
          this.sentryRec.stop();
        } catch (e) {}
        this.sentryRec = null;
      }
    }

    /* ========================================================================
     * GEAR 2: FULL-DUPLEX GEMINI 3.8 LIVE WEBSOCKET + AUDIOWORKLET
     * ======================================================================== */
    async escalateToLive(initialTrailingText) {
      if (this.escalating || this.gear === 'LIVE_CONVERSATION') return;
      this.escalating = true;
      this.pendingGracefulSleep = false;
      this.pendingWakePrompt = String(initialTrailingText || '').trim();

      // Release Gear 1 SR immediately so mic hardware is clean on Windows & iPadOS
      this.stopSentry_();
      this.setGear_('LIVE_CONVERSATION', 'Connecting Gemini 3.8 Live...');

      try {
        // Run mic hardware start + ephemeral token grab in parallel for minimum latency
        const [, tokenEnv] = await Promise.all([
          this.startMicWorklet_(),
          this.obtainSessionToken_(9000)
        ]);

        await this.openLiveWebSocket_(tokenEnv);
        this.escalating = false;
      } catch (err) {
        this.escalating = false;
        this.sendToCockpit({
          type: 'JARVIS_LIVE_ERROR',
          message: String(err && err.message ? err.message : err)
        });
        this.coolDownAfterSession_('escalation_error');
      }
    }

    async startMicWorklet_() {
      const Ctx = global.AudioContext || global.webkitAudioContext;
      if (!this.audioCtx) {
        this.audioCtx = new Ctx();
      }
      if (this.audioCtx.state === 'suspended') {
        await this.audioCtx.resume();
      }

      if (!this.workletLoaded) {
        await this.audioCtx.audioWorklet.addModule('./jarvis-audio-worklet.js');
        this.workletLoaded = true;
      }

      if (!this.mediaStream) {
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1
          }
        });
      }

      this.sourceNode = this.audioCtx.createMediaStreamSource(this.mediaStream);
      this.workletNode = new AudioWorkletNode(this.audioCtx, 'jarvis-capture-processor');

      this.workletNode.port.onmessage = (ev) => {
        const data = ev.data;
        if (!data || data.type !== 'PCM_CHUNK') return;

        // Reset idle timer when audible human speech energy is present
        if (data.rms > 0.025) {
          this.resetIdleTimer_();
        }

        if (this.ws && this.ws.readyState === WebSocket.OPEN && this.wsSetupComplete) {
          const b64 = this.arrayBufferToBase64_(data.pcmBuffer);
          this.ws.send(JSON.stringify({
            realtimeInput: {
              audio: {
                mimeType: 'audio/pcm;rate=16000',
                data: b64
              }
            }
          }));
        }
      };

      // Note: Do NOT connect workletNode to audioCtx.destination (avoids mic sidetone feedback)
      this.sourceNode.connect(this.workletNode);
    }

    openLiveWebSocket_(tokenEnv) {
      return new Promise((resolve, reject) => {
        let settled = false;
        this.wsSetupComplete = false;
        this.rxChain = Promise.resolve();

        const ws = new WebSocket(tokenEnv.wsUrl);
        this.ws = ws;

        ws.onopen = () => {
          // Send constrained-matching BidiGenerateContentSetup as frame #1
          ws.send(JSON.stringify({ setup: tokenEnv.setup }));
        };

        ws.onmessage = (event) => {
          // Serialize async Blob reads in strict FIFO order so 24kHz audio never scrambles
          this.rxChain = this.rxChain.then(async () => {
            let rawText = '';
            if (typeof event.data === 'string') {
              rawText = event.data;
            } else if (event.data instanceof Blob) {
              rawText = await event.data.text();
            } else if (event.data instanceof ArrayBuffer) {
              rawText = new TextDecoder('utf-8').decode(event.data);
            }
            if (!rawText) return;

            const msg = JSON.parse(rawText);
            await this.handleServerMessage_(msg, () => {
              if (!settled) {
                settled = true;
                resolve();
              }
            });
          }).catch((err) => {
            console.error('[JarvisLive] Frame error:', err);
          });
        };

        ws.onerror = () => {
          if (!settled) {
            settled = true;
            reject(new Error('Gemini Live WebSocket connection failed.'));
          }
        };

        ws.onclose = () => {
          if (this.ws === ws) {
            this.ws = null;
            this.wsSetupComplete = false;
            if (this.gear === 'LIVE_CONVERSATION') {
              this.coolDownAfterSession_('ws_closed');
            }
          }
        };
      });
    }

    async handleServerMessage_(msg, onReadyCallback) {
      // 1. Handshake Complete -> Flush Pre-Roll Audio + Any Wake Trailing Text!
      if (msg.setupComplete !== undefined) {
        this.wsSetupComplete = true;
        this.resetIdleTimer_();
        this.setGear_('LIVE_CONVERSATION', 'Live Full-Duplex Active');

        if (this.workletNode) {
          this.workletNode.port.postMessage({ cmd: 'START_STREAM', flushPreRoll: true });
        }

        if (this.pendingWakePrompt && this.ws && this.ws.readyState === WebSocket.OPEN) {
          const promptText = this.pendingWakePrompt;
          this.pendingWakePrompt = '';
          this.ws.send(JSON.stringify({
            realtimeInput: { text: promptText }
          }));
        }

        if (onReadyCallback) onReadyCallback();
        return;
      }

      // 2. Server Audio, Barge-In Interruption & Live Transcriptions
      if (msg.serverContent) {
        const sc = msg.serverContent;

        // Instant <10ms Barge-In Queue Flush!
        if (sc.interrupted) {
          this.flushPlaybackQueue_();
          this.sendToCockpit({ type: 'JARVIS_LIVE_INTERRUPTED' });
        }

        if (sc.inputTranscription && sc.inputTranscription.text) {
          this.resetIdleTimer_();
          this.sendToCockpit({
            type: 'JARVIS_LIVE_TRANSCRIPT',
            role: 'user',
            text: sc.inputTranscription.text
          });
        }

        if (sc.outputTranscription && sc.outputTranscription.text) {
          this.resetIdleTimer_();
          this.sendToCockpit({
            type: 'JARVIS_LIVE_TRANSCRIPT',
            role: 'model',
            text: sc.outputTranscription.text
          });
        }

        if (sc.modelTurn && Array.isArray(sc.modelTurn.parts)) {
          for (let i = 0; i < sc.modelTurn.parts.length; i++) {
            const part = sc.modelTurn.parts[i];
            if (part.inlineData && part.inlineData.data) {
              this.schedulePcm24kPlayback_(part.inlineData.data);
            }
          }
        }

        if (sc.turnComplete) {
          this.resetIdleTimer_();
          if (this.pendingGracefulSleep) {
            const remainingMs = this.audioCtx
              ? Math.max(250, (this.nextPlayTime - this.audioCtx.currentTime) * 1000 + 250)
              : 400;
            setTimeout(() => this.coolDownAfterSession_('user_signoff'), remainingMs);
          }
        }
      }

      // 3. Gear 3 Non-Blocking Tool Calls
      if (msg.toolCall && Array.isArray(msg.toolCall.functionCalls)) {
        this.dispatchToolCalls_(msg.toolCall.functionCalls);
      }

      // 4. Cancelled Tool Calls (when user barges in mid-action)
      if (msg.toolCallCancellation && Array.isArray(msg.toolCallCancellation.ids)) {
        msg.toolCallCancellation.ids.forEach((id) => {
          const pending = this.pendingTools.get(id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingTools.delete(id);
          }
        });
      }
    }

    /* ========================================================================
     * 24 kHz GAPLESS PLAYBACK + <10ms BARGE-IN FLUSH
     * ======================================================================== */
    schedulePcm24kPlayback_(base64Pcm) {
      if (!this.audioCtx) return;
      const bytes = this.base64ToUint8Array_(base64Pcm);
      const sampleCount = Math.floor(bytes.byteLength / 2);
      if (sampleCount === 0) return;

      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const float32 = new Float32Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        float32[i] = view.getInt16(i * 2, true) / 32768.0;
      }

      const audioBuffer = this.audioCtx.createBuffer(1, sampleCount, 24000);
      audioBuffer.getChannelData(0).set(float32);

      const src = this.audioCtx.createBufferSource();
      src.buffer = audioBuffer;
      src.connect(this.audioCtx.destination);

      const now = this.audioCtx.currentTime;
      const startAt = Math.max(now + 0.015, this.nextPlayTime);
      src.start(startAt);
      this.nextPlayTime = startAt + audioBuffer.duration;

      this.activeSources.add(src);
      src.onended = () => {
        this.activeSources.delete(src);
      };

      this.resetIdleTimer_();
    }

    flushPlaybackQueue_() {
      this.activeSources.forEach((src) => {
        try {
          src.onended = null;
          src.stop(0);
          src.disconnect();
        } catch (e) {}
      });
      this.activeSources.clear();
      this.nextPlayTime = this.audioCtx ? this.audioCtx.currentTime : 0;
    }

    /* ========================================================================
     * GEAR 3: NON-BLOCKING TOOL BRIDGE (PWA <-> Mod_1_GlobalShell <-> SSOT)
     * ======================================================================== */
    async dispatchToolCalls_(functionCalls) {
      const responses = await Promise.all(functionCalls.map(async (fc) => {
        if (fc.name === 'end_live_conversation') {
          this.pendingGracefulSleep = true;
          return {
            id: fc.id,
            name: fc.name,
            response: { result: { ok: true, status: 'standby_armed' } }
          };
        }

        const result = await this.invokeCockpitTool_(fc.id, fc.name, fc.args || {});
        return {
          id: fc.id,
          name: fc.name,
          response: { result: result }
        };
      }));

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          toolResponse: {
            functionResponses: responses
          }
        }));
      }
    }

    invokeCockpitTool_(callId, name, args) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.pendingTools.delete(callId);
          resolve({ ok: false, error: 'Cockpit tool timeout after 12s', tool: name });
        }, 12000);

        this.pendingTools.set(callId, { resolve: resolve, timer: timer });
        this.sendToCockpit({
          type: 'JARVIS_LIVE_TOOL_CALL',
          callId: callId,
          name: name,
          args: args
        });
      });
    }

    resolveCockpitToolResult(payload) {
      if (!payload || !payload.callId) return;
      const pending = this.pendingTools.get(payload.callId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingTools.delete(payload.callId);
      pending.resolve(payload.result || { ok: true });
    }

    /* ========================================================================
     * IDLE AUTO-COOL-DOWN & HARDWARE CLEANUP
     * ======================================================================== */
    resetIdleTimer_() {
      clearTimeout(this.idleTimer);
      if (this.gear !== 'LIVE_CONVERSATION') return;

      let playbackPadMs = 0;
      if (this.audioCtx && this.nextPlayTime > this.audioCtx.currentTime) {
        playbackPadMs = (this.nextPlayTime - this.audioCtx.currentTime) * 1000;
      }

      this.idleTimer = setTimeout(() => {
        if (this.gear === 'LIVE_CONVERSATION') {
          this.coolDownAfterSession_('idle_timeout');
        }
      }, Math.round(playbackPadMs + this.idleTimeoutMs));
    }

    coolDownAfterSession_(reason) {
      this.teardownLiveSession_(reason);
      if (this.returnToAmbient) {
        this.startSentry_();
      } else {
        this.setGear_('OFF', reason);
      }
    }

    teardownLiveSession_() {
      clearTimeout(this.idleTimer);
      this.flushPlaybackQueue_();

      if (this.workletNode) {
        try {
          this.workletNode.port.postMessage({ cmd: 'STOP_STREAM' });
          this.workletNode.disconnect();
        } catch (e) {}
        this.workletNode = null;
      }

      if (this.sourceNode) {
        try { this.sourceNode.disconnect(); } catch (e) {}
        this.sourceNode = null;
      }

      if (this.mediaStream) {
        try {
          this.mediaStream.getTracks().forEach((t) => t.stop());
        } catch (e) {}
        this.mediaStream = null;
      }

      if (this.ws) {
        const closingWs = this.ws;
        this.ws = null;
        this.wsSetupComplete = false;
        try {
          if (closingWs.readyState === WebSocket.OPEN) {
            closingWs.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
          }
          closingWs.close();
        } catch (e) {}
      }
    }

    /* ========================================================================
     * FAST BINARY <-> BASE64 HELPERS
     * ======================================================================== */
    arrayBufferToBase64_(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const step = 0x8000;
      for (let i = 0; i < bytes.length; i += step) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
      }
      return btoa(binary);
    }

    base64ToUint8Array_(b64) {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) {
        out[i] = bin.charCodeAt(i);
      }
      return out;
    }
  }

  global.JarvisLiveEngine = JarvisLiveEngine;
})(window);