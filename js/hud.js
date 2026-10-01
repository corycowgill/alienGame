// hud.js - HUD rendering and minimap
const _MINIMAP_COLORS = {
  grunt: '#0c4', swarmer: '#90f', bloater: '#f40',
  stalker: '#088', spitter: '#8c0', drone: '#48f', boss: '#f60',
};

export class HUD {
  constructor() {
    this.elements = {
      waveNum: document.getElementById('wave-num'),
      enemyCount: document.getElementById('enemy-count'),
      score: document.getElementById('score'),
      levelName: document.getElementById('level-name'),
      healthBar: document.getElementById('health-bar'),
      healthText: document.getElementById('health-text'),
      weaponName: document.getElementById('weapon-name'),
      ammoDisplay: document.getElementById('ammo-display'),
      cooldownFill: document.getElementById('cooldown-fill'),
      waveAnnounce: document.getElementById('wave-announce'),
      waveAnnounceText: document.getElementById('wave-announce-text'),
      waveAnnounceSub: document.getElementById('wave-announce-sub'),
    };
    this.minimapCanvas = document.getElementById('minimap');
    this.minimapCtx = this.minimapCanvas ? this.minimapCanvas.getContext('2d') : null;
    this._minimapGridCache = null;
    this.announceTimer = 0;
    this.comboEl = document.getElementById('combo-display');
    this._last = {
      wave: -1, enemyCount: -1, score: -1, levelName: '',
      hpBucket: -2, hpText: '', hpBarColor: '',
      weaponName: '', cooldownBucket: -1, ammoText: '',
      combo: 0, dashPct: -1,
    };
    this.dashEl = document.getElementById('dash-indicator');
    this.dashFillEl = document.getElementById('dash-fill');
    this.perksEl = document.getElementById('active-perks');
  }

  update(player, waveManager, weaponData, levelName, controls) {
    const els = this.elements;
    const last = this._last;

    // Wave info — only write when the underlying value changes.
    const wave = waveManager.wave;
    if (wave !== last.wave) { els.waveNum.textContent = wave; last.wave = wave; }
    const enemyCount = waveManager.getAliveCount();
    if (enemyCount !== last.enemyCount) {
      els.enemyCount.textContent = enemyCount;
      last.enemyCount = enemyCount;
    }
    const score = player.score;
    if (score !== last.score) { els.score.textContent = score; last.score = score; }
    if (levelName !== last.levelName) {
      els.levelName.textContent = levelName;
      last.levelName = levelName;
    }

    // Health — bucket the percentage to 1% so sub-pixel jitter doesn't
    // churn the style attribute, and the bar color only flips at boundaries.
    const hpPct = Math.max(0, player.hp / player.maxHp * 100);
    const hpBucket = Math.round(hpPct);
    if (hpBucket !== last.hpBucket) {
      els.healthBar.style.width = hpBucket + '%';
      last.hpBucket = hpBucket;
    }
    const hpText = `HP: ${Math.ceil(player.hp)}/${player.maxHp}`;
    if (hpText !== last.hpText) {
      els.healthText.textContent = hpText;
      last.hpText = hpText;
    }
    const hpBarColor = hpPct < 25 ? '#f00'
      : hpPct < 50 ? 'linear-gradient(90deg, #f00, #ff0)'
      : 'linear-gradient(90deg, #f00, #0f0)';
    if (hpBarColor !== last.hpBarColor) {
      els.healthBar.style.background = hpBarColor;
      last.hpBarColor = hpBarColor;
    }

    // Weapon
    if (weaponData.name !== last.weaponName) {
      els.weaponName.textContent = weaponData.name;
      last.weaponName = weaponData.name;
      const icon = document.getElementById('weapon-icon');
      if (icon && weaponData.iconIndex != null) icon.className = 'w' + weaponData.iconIndex;
    }
    // Cooldown fill — bucket to integer percent
    const cdBucket = Math.round((1 - weaponData.cooldownPct) * 100);
    if (cdBucket !== last.cooldownBucket) {
      els.cooldownFill.style.width = cdBucket + '%';
      last.cooldownBucket = cdBucket;
    }
    let ammoText;
    if (weaponData.ammoText != null) {
      ammoText = weaponData.ammoText;
    } else if (weaponData.currentKey === 'laserSword') {
      ammoText = 'MELEE';
    } else if (weaponData.isReloading) {
      const pct = Math.round(weaponData.reloadPct * 100);
      ammoText = `RELOADING ${pct}%`;
    } else if (weaponData.maxAmmo !== Infinity) {
      ammoText = `${weaponData.ammo} / ${weaponData.maxAmmo}`;
    } else {
      ammoText = weaponData.cooldownPct > 0 ? 'CHARGING...' : 'READY';
    }
    if (ammoText !== last.ammoText) {
      els.ammoDisplay.textContent = ammoText;
      last.ammoText = ammoText;
    }

    // Grenade counter
    const grenadeEl = document.getElementById('grenade-count');
    if (grenadeEl) {
      const gt = weaponData.grenadeCount;
      if (gt !== last.grenadeCount) {
        grenadeEl.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="#4f4" style="filter:drop-shadow(0 0 3px rgba(68,255,68,0.5))"><circle cx="12" cy="14" r="8"/><path d="M10 6h4v2h-4z"/><path d="M12 2v4" stroke="#4f4" stroke-width="2" fill="none"/><path d="M9 2h6" stroke="#4f4" stroke-width="2" fill="none"/></svg> ${gt}`;
        grenadeEl.style.opacity = gt > 0 ? '1' : '0.4';
        last.grenadeCount = gt;
      }
    }

    // Shield bar
    const shieldEl = document.getElementById('shield-bar');
    if (shieldEl && player.shield !== undefined) {
      const sPct = Math.round(player.shield / player.maxShield * 100);
      if (sPct !== last.shieldPct) {
        shieldEl.style.width = sPct + '%';
        shieldEl.parentElement.style.display = sPct > 0 ? 'block' : 'none';
        last.shieldPct = sPct;
      }
    }

    // Dash cooldown
    if (this.dashFillEl && controls) {
      const cd = controls.dashCooldown;
      const max = controls.dashCooldownMax;
      const pct = cd > 0 ? Math.round((1 - cd / max) * 100) : 100;
      if (pct !== last.dashPct) {
        this.dashFillEl.style.width = pct + '%';
        this.dashFillEl.style.background = pct >= 100 ? '#0ff' : '#088';
        last.dashPct = pct;
      }
    }

    // Combo display
    const combo = player.combo;
    if (combo !== last.combo) {
      if (this.comboEl) {
        if (combo >= 2) {
          this.comboEl.textContent = `${combo}x COMBO`;
          this.comboEl.style.opacity = '1';
          this.comboEl.style.transform = 'scale(1.2)';
          setTimeout(() => { if (this.comboEl) this.comboEl.style.transform = 'scale(1)'; }, 100);
          if (combo >= 10) {
            this.comboEl.style.color = '#ff00aa';
            this.comboEl.style.textShadow = '0 0 12px #ff00aa, 0 0 24px rgba(255,0,170,0.4)';
          } else if (combo >= 5) {
            this.comboEl.style.color = '#ff6600';
            this.comboEl.style.textShadow = '0 0 12px #ff6600, 0 0 24px rgba(255,102,0,0.4)';
          } else {
            this.comboEl.style.color = '#ffcc00';
            this.comboEl.style.textShadow = '0 0 12px #ffcc00, 0 0 24px rgba(255,200,0,0.4)';
          }
        } else {
          this.comboEl.style.opacity = '0';
        }
      }
      last.combo = combo;
    }
  }

  showWaveAnnouncement(wave, levelName, isNewLevel, theme) {
    const els = this.elements;
    if (isNewLevel) {
      els.waveAnnounceText.textContent = levelName;
      els.waveAnnounceSub.textContent = `Wave ${wave} incoming...`;
    } else {
      els.waveAnnounceText.textContent = `WAVE ${wave}`;
      els.waveAnnounceSub.textContent = theme ? `// ${theme}` : 'Get ready!';
    }
    els.waveAnnounce.style.display = 'block';
    this.announceTimer = 3;
  }

  updatePerks(perkIds) {
    if (!this.perksEl) return;
    const counts = {};
    for (const id of perkIds) counts[id] = (counts[id] || 0) + 1;
    const perkData = {
      rapidFire:    { name: 'RAPID',  icon: '⚡' },
      toughSkin:    { name: 'TOUGH',  icon: '🛡' },
      quickFeet:    { name: 'SPEED',  icon: '💨' },
      vampire:      { name: 'VAMP',   icon: '🩸' },
      blastRadius:  { name: 'BLAST',  icon: '💥' },
      sharpshooter: { name: 'SHARP',  icon: '🎯' },
      comboMaster:  { name: 'COMBO',  icon: '🔥' },
      scavenger:    { name: 'SCAV',   icon: '🔧' },
    };
    this.perksEl.innerHTML = Object.entries(counts)
      .map(([id, n]) => {
        const p = perkData[id] || { name: id, icon: '◆' };
        return `<span class="perk-tag">${p.icon} ${p.name}${n > 1 ? ' x' + n : ''}</span>`;
      })
      .join('');
  }

  showWaveComplete(wave) {
    const els = this.elements;
    els.waveAnnounceText.textContent = `WAVE ${wave} COMPLETE`;
    els.waveAnnounceSub.textContent = 'Regroup!';
    els.waveAnnounce.style.display = 'block';
    this.announceTimer = 2;
  }

  updateAnnouncement(delta) {
    if (this.announceTimer > 0) {
      this.announceTimer -= delta;
      if (this.announceTimer <= 0) {
        this.elements.waveAnnounce.style.display = 'none';
      }
    }
  }

  drawMinimap(playerPos, playerDir, enemies, mapSize = 100) {
    if (!this.minimapCtx) return;
    const ctx = this.minimapCtx;
    const w = 150, h = 150;
    const scale = w / (mapSize * 2);

    // Build static grid + border once as an offscreen image
    if (!this._minimapGridCache) {
      const off = document.createElement('canvas');
      off.width = w; off.height = h;
      const oc = off.getContext('2d');
      oc.fillStyle = 'rgba(0, 0, 0, 0.8)';
      oc.fillRect(0, 0, w, h);
      oc.strokeStyle = 'rgba(0, 255, 0, 0.1)';
      oc.lineWidth = 0.5;
      for (let i = 0; i <= w; i += 15) {
        oc.beginPath(); oc.moveTo(i, 0); oc.lineTo(i, h); oc.stroke();
        oc.beginPath(); oc.moveTo(0, i); oc.lineTo(w, i); oc.stroke();
      }
      oc.strokeStyle = '#0f0';
      oc.lineWidth = 1;
      oc.strokeRect(0, 0, w, h);
      this._minimapGridCache = off;
    }
    ctx.drawImage(this._minimapGridCache, 0, 0);

    const cx = w / 2;
    const cy = h / 2;

    // Player dot
    ctx.fillStyle = '#0f0';
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fill();

    // Player direction
    ctx.strokeStyle = '#0f0';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + playerDir.x * 10, cy - playerDir.z * 10);
    ctx.stroke();

    // Enemies
    const time = performance.now() * 0.001;
    for (const enemy of enemies) {
      if (enemy.dead) continue;
      const dx = (enemy.mesh.position.x - playerPos.x) * scale;
      const dz = (enemy.mesh.position.z - playerPos.z) * scale;
      const ex = cx + dx;
      const ey = cy - dz;

      if (ex < 0 || ex > w || ey < 0 || ey > h) continue;

      if (enemy.isBoss) {
        const pulse = 4 + Math.sin(time * 4) * 1.5;
        ctx.fillStyle = '#f60';
        ctx.beginPath();
        ctx.arc(ex, ey, pulse, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ff0';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(ex, ey, pulse + 2, 0, Math.PI * 2);
        ctx.stroke();
      } else if (enemy.isElite) {
        ctx.fillStyle = _MINIMAP_COLORS[enemy.type] || '#f22';
        ctx.beginPath();
        ctx.arc(ex, ey, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ff0';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.arc(ex, ey, 4, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = _MINIMAP_COLORS[enemy.type] || '#f22';
        ctx.beginPath();
        ctx.arc(ex, ey, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
