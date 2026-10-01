// audio.js - Procedural eerie alien music and sound effects
export class AudioManager {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.musicGain = null;
    this.sfxGain = null;
    this.musicPlaying = false;
    this.musicNodes = [];
    this.bgMusic = null;
    this.bgMusicSource = null;
    this.menuMusic = null;
    this.menuMusicSource = null;
    this.menuMusicPlaying = false;
  }

  init() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.7;
    this.masterGain.connect(this.ctx.destination);

    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0.25;
    this.musicGain.connect(this.masterGain);

    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = 0.5;
    this.sfxGain.connect(this.masterGain);
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  // === BACKGROUND MUSIC (MP3) ===
  startMusic() {
    if (this.musicPlaying) return;
    this.stopMenuMusic();
    this.musicPlaying = true;

    // If we already have the decoded buffer, just play it
    if (this.bgMusic) {
      this._playBgMusic();
      return;
    }

    // Fetch and decode the MP3 file
    fetch('assets/Before_the_Steel_Breaks.mp3')
      .then(response => response.arrayBuffer())
      .then(data => this.ctx.decodeAudioData(data))
      .then(buffer => {
        this.bgMusic = buffer;
        if (this.musicPlaying) this._playBgMusic();
      })
      .catch(err => console.warn('Failed to load background music:', err));
  }

  _playBgMusic() {
    if (this.bgMusicSource) {
      try { this.bgMusicSource.stop(); } catch(e) {}
    }
    const source = this.ctx.createBufferSource();
    source.buffer = this.bgMusic;
    source.loop = true;
    source.connect(this.musicGain);
    source.start(0);
    this.bgMusicSource = source;
  }

  stopMusic() {
    this.musicPlaying = false;
    if (this.bgMusicSource) {
      try { this.bgMusicSource.stop(); } catch(e) {}
      this.bgMusicSource = null;
    }
    this.musicNodes.forEach(n => { try { n.stop(); } catch(e) {} });
    this.musicNodes = [];
  }

  // === MENU / TITLE SCREEN MUSIC ===
  startMenuMusic() {
    if (this.menuMusicPlaying) return;
    if (this.musicPlaying) return;
    if (!this.ctx) this.init();
    this.resume();
    this.menuMusicPlaying = true;

    if (this.menuMusic) {
      this._playMenuMusic();
      return;
    }

    fetch('assets/Storm_at_the_Gate.mp3')
      .then(response => response.arrayBuffer())
      .then(data => this.ctx.decodeAudioData(data))
      .then(buffer => {
        this.menuMusic = buffer;
        if (this.menuMusicPlaying) this._playMenuMusic();
      })
      .catch(err => console.warn('Failed to load menu music:', err));
  }

  _playMenuMusic() {
    if (this.menuMusicSource) {
      try { this.menuMusicSource.stop(); } catch(e) {}
    }
    const source = this.ctx.createBufferSource();
    source.buffer = this.menuMusic;
    source.loop = true;
    source.connect(this.musicGain);
    source.start(0);
    this.menuMusicSource = source;
  }

  stopMenuMusic() {
    this.menuMusicPlaying = false;
    if (this.menuMusicSource) {
      try { this.menuMusicSource.stop(); } catch(e) {}
      this.menuMusicSource = null;
    }
  }

  // === SOUND EFFECTS ===

  playLaserRifle() {
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1200, t);
    osc.frequency.exponentialRampToValueAtTime(300, t + 0.1);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + 0.15);
  }

  playLaserSword() {
    const t = this.ctx.currentTime;
    // Whoosh sweep
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(200, t);
    osc.frequency.exponentialRampToValueAtTime(800, t + 0.15);
    osc.frequency.exponentialRampToValueAtTime(100, t + 0.4);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.2, t);
    g.gain.linearRampToValueAtTime(0.3, t + 0.1);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 500;
    filter.Q.value = 2;
    osc.connect(filter);
    filter.connect(g);
    g.connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + 0.4);
  }

  playSniperShot() {
    const t = this.ctx.currentTime;
    // Sharp crack
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(2000, t);
    osc.frequency.exponentialRampToValueAtTime(100, t + 0.3);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.4, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + 0.4);

    // Echo
    const delay = this.ctx.createDelay(1);
    delay.delayTime.value = 0.2;
    const fb = this.ctx.createGain();
    fb.gain.value = 0.3;
    g.connect(delay);
    delay.connect(fb);
    fb.connect(delay);
    fb.connect(this.sfxGain);
  }

  playAlienHit() {
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(300, t);
    osc.frequency.exponentialRampToValueAtTime(100, t + 0.1);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.2, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + 0.15);
  }

  playAlienDeath() {
    const t = this.ctx.currentTime;
    // Descending pitch
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(600, t);
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.6);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + 0.6);

    // Noise burst
    this._noiseBurst(0.15, 0.3);
  }

  playRocketLaunch() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    // Deep whoosh: low saw ramping down with noise
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.35);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.35, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + 0.4);
    // High hiss layer
    const osc2 = this.ctx.createOscillator();
    osc2.type = 'square';
    osc2.frequency.setValueAtTime(1600, t);
    osc2.frequency.exponentialRampToValueAtTime(300, t + 0.3);
    const g2 = this.ctx.createGain();
    g2.gain.setValueAtTime(0.1, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    osc2.connect(g2);
    g2.connect(this.sfxGain);
    osc2.start(t);
    osc2.stop(t + 0.3);
    // Noise whoosh
    this._noiseBurst(0.25, 0.35);
  }

  playExplosion() {
    const t = this.ctx.currentTime;
    // Low boom
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(80, t);
    osc.frequency.exponentialRampToValueAtTime(20, t + 0.8);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + 0.8);

    // Noise
    this._noiseBurst(0.4, 0.5);
  }

  playPlayerHit() {
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.2);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + 0.25);
  }

  playWaveComplete() {
    const t = this.ctx.currentTime;
    [523, 659, 784, 1047].forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t + i * 0.15);
      g.gain.linearRampToValueAtTime(0.2, t + i * 0.15 + 0.05);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.15 + 0.4);
      osc.connect(g);
      g.connect(this.sfxGain);
      osc.start(t + i * 0.15);
      osc.stop(t + i * 0.15 + 0.4);
    });
  }

  playAlienShoot() {
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(400, t);
    osc.frequency.exponentialRampToValueAtTime(200, t + 0.15);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.15, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  playAlienGrowl() {
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(80, t);
    osc.frequency.linearRampToValueAtTime(60, t + 0.3);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 300;
    osc.connect(filter);
    filter.connect(g);
    g.connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + 0.3);
  }

  playPickup() {
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, t);
    osc.frequency.exponentialRampToValueAtTime(1200, t + 0.08);
    osc.frequency.exponentialRampToValueAtTime(1600, t + 0.15);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.15, t);
    g.gain.linearRampToValueAtTime(0, t + 0.2);
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  playFootstep(sprint = false) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const bufSize = Math.floor(this.ctx.sampleRate * 0.06);
    const buf = this.ctx.createBuffer(1, bufSize, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufSize);
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = sprint ? 600 : 400;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(sprint ? 0.07 : 0.04, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    src.connect(filter);
    filter.connect(g);
    g.connect(this.sfxGain);
    src.start(t);
  }

  playDash() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(300, t);
    osc.frequency.exponentialRampToValueAtTime(80, t + 0.15);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.15, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 200;
    filter.Q.value = 1.5;
    osc.connect(filter);
    filter.connect(g);
    g.connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + 0.2);
    this._noiseBurst(0.08, 0.12);
  }

  playWeaponSwitch() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1000, t);
    osc.frequency.exponentialRampToValueAtTime(600, t + 0.06);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + 0.08);
    const osc2 = this.ctx.createOscillator();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(2200, t + 0.03);
    osc2.frequency.exponentialRampToValueAtTime(1600, t + 0.08);
    const g2 = this.ctx.createGain();
    g2.gain.setValueAtTime(0, t);
    g2.gain.linearRampToValueAtTime(0.06, t + 0.04);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    osc2.connect(g2);
    g2.connect(this.sfxGain);
    osc2.start(t);
    osc2.stop(t + 0.1);
  }

  playMultiKill() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [880, 1100, 1320].forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t + i * 0.06);
      g.gain.linearRampToValueAtTime(0.15, t + i * 0.06 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.06 + 0.25);
      osc.connect(g);
      g.connect(this.sfxGain);
      osc.start(t + i * 0.06);
      osc.stop(t + i * 0.06 + 0.25);
    });
  }

  startHeartbeat() {
    if (this._heartbeatActive) return;
    this._heartbeatActive = true;
  }

  stopHeartbeat() {
    this._heartbeatActive = false;
  }

  _pulseHeartbeat() {
    if (!this._heartbeatActive || !this.ctx) return;
    const t = this.ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 40;
      const g = this.ctx.createGain();
      const offset = i * 0.15;
      g.gain.setValueAtTime(0, t + offset);
      g.gain.linearRampToValueAtTime(i === 0 ? 0.2 : 0.12, t + offset + 0.04);
      g.gain.exponentialRampToValueAtTime(0.001, t + offset + 0.15);
      osc.connect(g);
      g.connect(this.sfxGain);
      osc.start(t + offset);
      osc.stop(t + offset + 0.15);
    }
  }

  startAmbient() {
    this.stopAmbient();
    if (!this.ctx) return;
    const t = this.ctx.currentTime;

    // City wind — filtered noise
    const bufSize = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, bufSize, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
    const windSrc = this.ctx.createBufferSource();
    windSrc.buffer = buf;
    windSrc.loop = true;
    const windFilter = this.ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 180;
    const windLfo = this.ctx.createOscillator();
    windLfo.type = 'sine';
    windLfo.frequency.value = 0.15;
    const windLfoGain = this.ctx.createGain();
    windLfoGain.gain.value = 60;
    windLfo.connect(windLfoGain);
    windLfoGain.connect(windFilter.frequency);
    windLfo.start(t);
    const windGain = this.ctx.createGain();
    windGain.gain.value = 0.025;
    windSrc.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(this.musicGain);
    windSrc.start(t);

    // Electrical hum (60 Hz mains)
    const hum = this.ctx.createOscillator();
    hum.type = 'sine';
    hum.frequency.value = 60;
    const humGain = this.ctx.createGain();
    humGain.gain.value = 0.012;
    hum.connect(humGain);
    humGain.connect(this.musicGain);
    hum.start(t);

    // Distant rumble — very low filtered noise
    const rumbleSrc = this.ctx.createBufferSource();
    rumbleSrc.buffer = buf;
    rumbleSrc.loop = true;
    const rumbleFilter = this.ctx.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.value = 50;
    const rumbleGain = this.ctx.createGain();
    rumbleGain.gain.value = 0.03;
    rumbleSrc.connect(rumbleFilter);
    rumbleFilter.connect(rumbleGain);
    rumbleGain.connect(this.musicGain);
    rumbleSrc.start(t);

    this._ambientNodes = [windSrc, windLfo, hum, rumbleSrc];
  }

  stopAmbient() {
    if (this._ambientNodes) {
      this._ambientNodes.forEach(n => { try { n.stop(); } catch(e) {} });
      this._ambientNodes = null;
    }
  }

  playGrenadeThrow() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(300, t);
    osc.frequency.exponentialRampToValueAtTime(150, t + 0.15);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.2, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + 0.2);
    this._noiseBurst(0.08, 0.1);
  }

  playGrenadeExplode() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(80, t);
    osc.frequency.exponentialRampToValueAtTime(30, t + 0.4);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.35, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + 0.5);
    this._noiseBurst(0.3, 0.35);
  }

  playReload() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const osc1 = this.ctx.createOscillator();
    osc1.type = 'triangle';
    osc1.frequency.setValueAtTime(600, t);
    osc1.frequency.exponentialRampToValueAtTime(900, t + 0.08);
    const g1 = this.ctx.createGain();
    g1.gain.setValueAtTime(0.12, t);
    g1.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    osc1.connect(g1);
    g1.connect(this.sfxGain);
    osc1.start(t);
    osc1.stop(t + 0.12);
    const osc2 = this.ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(1200, t + 0.1);
    osc2.frequency.exponentialRampToValueAtTime(800, t + 0.2);
    const g2 = this.ctx.createGain();
    g2.gain.setValueAtTime(0.08, t + 0.1);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    osc2.connect(g2);
    g2.connect(this.sfxGain);
    osc2.start(t + 0.1);
    osc2.stop(t + 0.22);
  }

  playCritHit() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1400, t);
    osc.frequency.exponentialRampToValueAtTime(2200, t + 0.06);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.15, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + 0.1);
    const osc2 = this.ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(2600, t + 0.03);
    const g2 = this.ctx.createGain();
    g2.gain.setValueAtTime(0.1, t + 0.03);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    osc2.connect(g2);
    g2.connect(this.sfxGain);
    osc2.start(t + 0.03);
    osc2.stop(t + 0.12);
  }

  playShieldHit() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(500, t);
    osc.frequency.exponentialRampToValueAtTime(200, t + 0.15);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.15, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  _noiseBurst(volume, duration) {
    const t = this.ctx.currentTime;
    const bufferSize = this.ctx.sampleRate * duration;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    }
    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(volume, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    noise.connect(g);
    g.connect(this.sfxGain);
    noise.start(t);
  }
}
