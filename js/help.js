// help.js - Bestiary / armory overlay built from the live roster tables.
import { ENEMY_TYPES } from './enemies.js';
import { WEAPONS, WEAPON_ORDER } from './weapons.js';

const ENEMY_NOTES = {
  gnat: 'Cannon fodder. Plinks from range, panics and runs when its Warlord dies or it gets hurt.',
  skirmisher: 'Fast flanker. Its arm shield blocks shots from the front — flank it, or throw a grenade.',
  warlord: 'Shielded commander. Plasma strips the shield fastest; it falls back to recharge, then lunges to melee.',
  juggernaut: 'Walking siege engine. The tower shield stops everything head-on; the fuel rod arcs — keep moving.',
  wasp: 'Aerial harasser. Dives to strafe. Track it with the rifle.',
  overseer: 'Boss. Hovers, spawns Gnats and sweeps plasma. Break the shield, then pour rockets in.',
};
const WEAPON_NOTES = {
  rifle: 'Hitscan, 32-round mag, headshots deal double. Right-click to aim.',
  plasmaRifle: 'Looted alien plasma. Melts energy shields (2.4x). Overheats if held down.',
  energySword: 'Lunges to a target within 7.5 m. Right-click for a heavy swing.',
  rocketLauncher: 'Two rockets, 6.5 m splash. Best against Juggernauts and the Overseer.',
};

export class HelpGuide {
  constructor() { this.el = document.getElementById('help-guide'); this.isOpen = false; }
  init() {
    if (!this.el) return;
    const bc = document.getElementById('bestiary-cards');
    const wc = document.getElementById('weapon-cards');
    const order = ['gnat', 'skirmisher', 'warlord', 'juggernaut', 'wasp', 'overseer'];
    if (bc) bc.innerHTML = Object.entries(ENEMY_TYPES).map(([k, e]) => `
      <div class="help-card"><div class="help-portrait" style="background-position:${(order.indexOf(k) % 3) * 50}% ${order.indexOf(k) < 3 ? 0 : 100}%"></div><div class="help-card-title" style="color:#${e.color.toString(16).padStart(6, '0')}">${e.name}</div>
        <div class="help-card-stats">HP ${e.hp}${e.shield ? ' · SHIELD ' + e.shield : ''}${e.frontShield ? ' · ARM SHIELD ' + e.frontShield : ''} · SPEED ${e.speed}</div>
        <div class="help-card-desc">${ENEMY_NOTES[k] || ''}</div></div>`).join('');
    if (wc) wc.innerHTML = WEAPON_ORDER.map((k) => { const w = WEAPONS[k]; return `
      <div class="help-card"><div class="help-card-title">[${w.key}] ${w.name}</div>
        <div class="help-card-stats">DMG ${w.damage}${w.splash ? ' · SPLASH ' + w.splash + 'm' : ''} · RATE ${(1 / w.fireRate).toFixed(1)}/s</div>
        <div class="help-card-desc">${WEAPON_NOTES[k] || ''}</div></div>`; }).join('');
    const close = document.getElementById('help-close');
    if (close) close.addEventListener('click', () => this.close());
  }
  open() { if (this.el) { this.el.style.display = 'block'; this.isOpen = true; } }
  close() { if (this.el) { this.el.style.display = 'none'; this.isOpen = false; } }
  toggle() { this.isOpen ? this.close() : this.open(); }
}
