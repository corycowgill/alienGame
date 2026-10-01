// player.js - Player state, health, score, perks
export const PERKS = [
  { id: 'rapidFire',    name: 'RAPID FIRE',    desc: 'Fire 20% faster' },
  { id: 'toughSkin',    name: 'TOUGH SKIN',    desc: '+25 max HP' },
  { id: 'quickFeet',    name: 'QUICK FEET',    desc: '15% faster movement' },
  { id: 'vampire',      name: 'VAMPIRE',       desc: 'Kills restore 5 HP' },
  { id: 'blastRadius',  name: 'BLAST RADIUS',  desc: '+40% explosion radius' },
  { id: 'sharpshooter', name: 'SHARPSHOOTER',  desc: '+15% weapon damage' },
  { id: 'comboMaster',  name: 'COMBO MASTER',  desc: '+1.5s combo window' },
  { id: 'scavenger',    name: 'SCAVENGER',     desc: '+25% pickup drop rate' },
];

export class Player {
  constructor() {
    this.maxHp = 100;
    this.hp = this.maxHp;
    this.score = 0;
    this.kills = 0;
    this.dead = false;
    this.damageFlashTimer = 0;
    this.regenTimer = 0;
    this.regenDelay = 4;
    this.regenRate = 6;

    this.combo = 0;
    this.comboTimer = 0;
    this.comboWindow = 3.0;
    this.bestCombo = 0;

    this.shield = 0;
    this.maxShield = 50;

    this.perks = [];
  }

  takeDamage(amount, audio) {
    if (this.dead) return;
    let remaining = amount;
    if (this.shield > 0) {
      const absorbed = Math.min(this.shield, remaining);
      this.shield -= absorbed;
      remaining -= absorbed;
      if (audio.playShieldHit) audio.playShieldHit();
    }
    if (remaining > 0) {
      this.hp -= remaining;
      audio.playPlayerHit();
    }
    this.damageFlashTimer = 0.2;
    this.regenTimer = this.regenDelay;

    const flash = document.getElementById('damage-flash');
    if (flash) {
      flash.style.background = this.shield > 0 && remaining <= 0 ? 'rgba(0, 150, 255, 0.3)' : '';
      flash.style.opacity = '1';
      setTimeout(() => { flash.style.opacity = '0'; }, 150);
    }

    if (this.hp <= 0) {
      this.hp = 0;
      this.dead = true;
    }
  }

  addShield(amount) {
    this.shield = Math.min(this.maxShield, this.shield + amount);
  }

  heal(amount) {
    if (this.dead) return;
    this.hp = Math.min(this.maxHp, this.hp + amount);
  }

  addScore(points) {
    const multiplier = Math.max(1, this.combo);
    this.score += points * multiplier;
  }

  addKill() {
    this.kills++;
    this.combo++;
    this.comboTimer = this.comboWindow;
    if (this.combo > this.bestCombo) this.bestCombo = this.combo;
  }

  addPerk(perkId) {
    this.perks.push(perkId);
    if (perkId === 'toughSkin') {
      this.maxHp += 25;
      this.hp += 25;
    }
    if (perkId === 'comboMaster') {
      this.comboWindow += 1.5;
    }
  }

  perkCount(id) {
    let n = 0;
    for (let i = 0; i < this.perks.length; i++) if (this.perks[i] === id) n++;
    return n;
  }

  get fireRateMultiplier() { return Math.pow(0.8, this.perkCount('rapidFire')); }
  get damageMultiplier() { return 1 + this.perkCount('sharpshooter') * 0.15; }
  get speedMultiplier() { return 1 + this.perkCount('quickFeet') * 0.15; }
  get explosionRadiusMultiplier() { return 1 + this.perkCount('blastRadius') * 0.4; }
  get vampireHeal() { return this.perkCount('vampire') * 5; }
  get dropRateBonus() { return this.perkCount('scavenger') * 0.25; }

  update(delta) {
    if (this.regenTimer > 0) {
      this.regenTimer -= delta;
    } else if (this.hp < this.maxHp && !this.dead) {
      this.hp = Math.min(this.maxHp, this.hp + this.regenRate * delta);
    }

    if (this.damageFlashTimer > 0) {
      this.damageFlashTimer -= delta;
    }

    if (this.comboTimer > 0) {
      this.comboTimer -= delta;
      if (this.comboTimer <= 0) {
        this.combo = 0;
      }
    }
  }

  reset() {
    this.maxHp = 100;
    this.hp = this.maxHp;
    this.score = 0;
    this.kills = 0;
    this.dead = false;
    this.damageFlashTimer = 0;
    this.regenTimer = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.comboWindow = 3.0;
    this.bestCombo = 0;
    this.shield = 0;
    this.perks = [];
  }
}
