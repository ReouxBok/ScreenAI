(function initializeTrainingRecorder(global) {
  const MAX_DURATION_MS = 60 * 60 * 1000;
  const VIDEO_BITS_PER_SECOND = 1_000_000;
  const AUDIO_BITS_PER_SECOND = 128_000;
  const MULTIPART_TARGET_BYTES = 8 * 1024 * 1024;

  function recordingMimeType(MediaRecorderClass) {
    const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return candidates.find(type => MediaRecorderClass.isTypeSupported?.(type)) || '';
  }

  class TrainingScreenRecorder {
    constructor({ mediaDevices = navigator.mediaDevices, MediaRecorderClass = global.MediaRecorder, uploader = global.LimovaTrainingRecordingUpload, multipartFactory = global.LimovaTrainingMultipartUpload } = {}) {
      this.mediaDevices = mediaDevices;
      this.MediaRecorderClass = MediaRecorderClass;
      this.uploader = uploader;
      this.multipartFactory = multipartFactory;
      this.stream = null;
      this.microphoneStream = null;
      this.recorder = null;
      this.chunks = [];
      this.recordingBlob = null;
      this.startedAt = 0;
      this.durationMs = 0;
      this.interrupted = false;
      this.intentionalStop = false;
      this.limitTimer = null;
      this.stopPromise = null;
      this.multipart = null;
      this.multipartSession = null;
      this.partBuffer = [];
      this.partBufferBytes = 0;
      this.partNumber = 0;
      this.totalSize = 0;
      this.uploadQueue = Promise.resolve();
      this.failedParts = [];
      this.uploadPromise = null;
      this.uploadResult = null;
    }

    get active() {
      return this.recorder?.state === 'recording';
    }

    async start() {
      if (!this.mediaDevices?.getDisplayMedia || !this.MediaRecorderClass || (typeof this.uploader !== 'function' && typeof this.multipartFactory !== 'function')) {
        throw new Error('L’enregistrement complet de l’écran n’est pas disponible dans cette version de Chrome.');
      }
      const stream = await this.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: 'monitor',
          frameRate: { ideal: 12, max: 15 },
          width: { ideal: 1600 },
          height: { ideal: 900 }
        },
        audio: false,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'exclude',
        systemAudio: 'exclude',
        monitorTypeSurfaces: 'include'
      });
      const videoTrack = stream.getVideoTracks()[0];
      const displaySurface = videoTrack?.getSettings?.().displaySurface;
      if (!videoTrack || (displaySurface && displaySurface !== 'monitor')) {
        stream.getTracks().forEach(track => track.stop());
        const error = new Error('Sélectionne « Écran entier » dans Chrome, pas un onglet ni une fenêtre.');
        error.code = 'FULL_SCREEN_REQUIRED';
        throw error;
      }
      let microphoneStream;
      try {
        microphoneStream = await this.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          },
          video: false
        });
      } catch (cause) {
        stream.getTracks().forEach(track => track.stop());
        const error = new Error('Autorise le microphone pour enregistrer tes explications dans la vidéo.');
        error.code = 'TRAINING_MIC_REQUIRED';
        error.cause = cause;
        throw error;
      }
      const audioTracks = microphoneStream.getAudioTracks();
      if (!audioTracks.length) {
        stream.getTracks().forEach(track => track.stop());
        microphoneStream.getTracks().forEach(track => track.stop());
        const error = new Error('Aucun microphone actif n’a été détecté.');
        error.code = 'TRAINING_MIC_UNAVAILABLE';
        throw error;
      }
      audioTracks.forEach(track => stream.addTrack(track));
      this.stream = stream;
      this.microphoneStream = microphoneStream;
      this.chunks = [];
      this.recordingBlob = null;
      this.partBuffer = [];
      this.partBufferBytes = 0;
      this.partNumber = 0;
      this.totalSize = 0;
      this.uploadQueue = Promise.resolve();
      this.failedParts = [];
      this.uploadPromise = null;
      this.uploadResult = null;
      this.startedAt = Date.now();
      this.intentionalStop = false;
      this.interrupted = false;
      const mimeType = recordingMimeType(this.MediaRecorderClass);
      this.recorder = new this.MediaRecorderClass(stream, {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
        audioBitsPerSecond: AUDIO_BITS_PER_SECOND
      });
      this.recorder.addEventListener('dataavailable', event => {
        if (!event.data?.size) return;
        this.totalSize += event.data.size;
        if (!this.multipart) {
          this.chunks.push(event.data);
          return;
        }
        this.partBuffer.push(event.data);
        this.partBufferBytes += event.data.size;
        if (this.partBufferBytes >= MULTIPART_TARGET_BYTES) this.enqueueBufferedPart(false);
      });
      videoTrack.addEventListener('ended', () => {
        if (this.intentionalStop) return;
        this.interrupted = true;
        this.stopCaptureOnly().finally(() => {
          global.dispatchEvent(new CustomEvent('limova-training-screen-ended'));
        });
      }, { once: true });
      this.recorder.start(4_000);
      this.limitTimer = setTimeout(() => {
        this.interrupted = true;
        this.stopCaptureOnly().finally(() => {
          global.dispatchEvent(new CustomEvent('limova-training-recording-limit'));
        });
      }, MAX_DURATION_MS);
      return { displaySurface: displaySurface || 'monitor' };
    }

    async beginProgressiveUpload({ token, sessionId }) {
      if (this.multipart || typeof this.multipartFactory !== 'function') return;
      const contentType = String(this.recorder?.mimeType || 'video/webm').split(';')[0];
      this.multipart = await this.multipartFactory({ token, sessionId, contentType });
      this.multipartSession = { token, sessionId };
      if (this.chunks.length) {
        this.partBuffer.push(...this.chunks);
        this.partBufferBytes += this.chunks.reduce((sum, chunk) => sum + chunk.size, 0);
        this.chunks = [];
        if (this.partBufferBytes >= MULTIPART_TARGET_BYTES) this.enqueueBufferedPart(false);
      }
    }

    enqueueBufferedPart(finalPart) {
      if (!this.multipart || !this.partBufferBytes || (!finalPart && this.partBufferBytes < MULTIPART_TARGET_BYTES)) return;
      const blob = new Blob(this.partBuffer, { type: String(this.recorder?.mimeType || 'video/webm').split(';')[0] });
      this.partBuffer = [];
      this.partBufferBytes = 0;
      const partNumber = ++this.partNumber;
      this.uploadQueue = this.uploadQueue.then(async () => {
        try {
          await this.multipart.uploadPart(partNumber, blob);
        } catch (error) {
          this.failedParts.push({ partNumber, blob, error });
        }
      });
    }

    async stopCaptureOnly() {
      if (this.stopPromise) return this.stopPromise;
      this.intentionalStop = true;
      clearTimeout(this.limitTimer);
      this.durationMs = Math.max(1_000, Date.now() - this.startedAt);
      this.stopPromise = new Promise(resolve => {
        if (!this.recorder || this.recorder.state === 'inactive') return resolve();
        this.recorder.addEventListener('stop', () => resolve(), { once: true });
        this.recorder.stop();
      }).then(() => {
        this.stream?.getTracks().forEach(track => track.stop());
        this.microphoneStream?.getTracks().forEach(track => track.stop());
        const mimeType = String(this.recorder?.mimeType || 'video/webm').split(';')[0];
        if (!this.multipart && !this.recordingBlob) this.recordingBlob = new Blob(this.chunks, { type: mimeType });
        return this.recordingBlob;
      });
      return this.stopPromise;
    }

    async stopAndUpload({ token, sessionId, onProgress }) {
      if (this.uploadResult) return this.uploadResult;
      if (this.uploadPromise) return this.uploadPromise;
      this.uploadPromise = this.performStopAndUpload({ token, sessionId, onProgress });
      try {
        this.uploadResult = await this.uploadPromise;
        return this.uploadResult;
      } catch (error) {
        this.uploadPromise = null;
        throw error;
      }
    }

    async performStopAndUpload({ token, sessionId, onProgress }) {
      const blob = await this.stopCaptureOnly();
      if (this.multipart) {
        this.enqueueBufferedPart(true);
        await this.uploadQueue;
        const failed = this.failedParts.splice(0);
        for (const part of failed) {
          try { await this.multipart.uploadPart(part.partNumber, part.blob); }
          catch (error) { this.failedParts.push({ ...part, error }); }
        }
        if (this.failedParts.length) throw this.failedParts[0].error;
        if (!this.totalSize) throw new Error('La vidéo est vide. Recommence la démonstration.');
        onProgress?.({ percentage: 99 });
        await this.multipart.complete({ durationMs: this.durationMs });
        onProgress?.({ percentage: 100 });
        return { size: this.totalSize, durationMs: this.durationMs };
      }
      if (!blob?.size) throw new Error('La vidéo est vide. Recommence la démonstration.');
      await this.uploader({ blob, token, sessionId, durationMs: this.durationMs, onProgress });
      return { size: blob.size, durationMs: this.durationMs };
    }

    abort() {
      this.intentionalStop = true;
      clearTimeout(this.limitTimer);
      try { if (this.recorder?.state === 'recording') this.recorder.stop(); } catch (_) {}
      this.stream?.getTracks().forEach(track => track.stop());
      this.microphoneStream?.getTracks().forEach(track => track.stop());
      this.chunks = [];
      this.recordingBlob = null;
      this.partBuffer = [];
      this.partBufferBytes = 0;
      this.failedParts = [];
      this.uploadPromise = null;
      this.uploadResult = null;
    }
  }

  global.LimovaTrainingScreenRecorder = TrainingScreenRecorder;
})(globalThis);
