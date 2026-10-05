// Ressort amorti : une valeur qui rejoint sa cible avec l'inertie d'un objet physique.
// Intégré à chaque image avec le temps réel écoulé (indépendant de la fréquence d'écran).

import GLib from "gi://GLib?version=2.0";

export interface SpringConfig {
  /** Raideur : plus elle est haute, plus le mouvement est rapide. */
  stiffness: number;
  /** 1 = sans rebond ; un peu moins = léger dépassement, plus vivant. */
  dampingRatio: number;
}

/** Ralenti pour observer les animations (NOKO_SLOWDOWN=5 : cinq fois plus lent). */
const SLOWDOWN = (() => {
  const value = Number(GLib.getenv("NOKO_SLOWDOWN") ?? "1");
  return Number.isFinite(value) && value >= 1 && value <= 20 ? value : 1;
})();

/** Pas d'intégration maximal (stabilité, même si une image est en retard). */
const MAX_STEP = 1 / 240;

export class Spring {
  value: number;
  target: number;
  private velocity = 0;
  private config: SpringConfig;

  constructor(value: number, config: SpringConfig) {
    this.value = value;
    this.target = value;
    this.config = config;
  }

  setTarget(target: number, config?: SpringConfig): void {
    this.target = target;
    if (config !== undefined) this.config = config;
  }

  /** Saut direct, sans animation. */
  jump(value: number): void {
    this.value = value;
    this.target = value;
    this.velocity = 0;
  }

  /** Avance de `seconds` secondes (temps réel). */
  step(seconds: number): void {
    const dt = Math.min(seconds, 0.1) / SLOWDOWN;
    const k = this.config.stiffness;
    const c = 2 * this.config.dampingRatio * Math.sqrt(k);
    const steps = Math.max(1, Math.ceil(dt / MAX_STEP));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const acceleration = -k * (this.value - this.target) - c * this.velocity;
      this.velocity += acceleration * h;
      this.value += this.velocity * h;
    }
    if (this.settled()) this.jump(this.target);
  }

  settled(): boolean {
    return Math.abs(this.value - this.target) < 0.3 && Math.abs(this.velocity) < 3;
  }
}
