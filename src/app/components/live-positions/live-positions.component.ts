import { Component, OnInit, OnDestroy, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription, interval } from 'rxjs';
import { ZerodhaService, ZerodhaPosition } from '../../services/zerodha.service';

interface TargetLevel {
  label: string;
  rMultiple: number;
  price: number;
  gain: number;      // rupee gain at this level
  gainPct: number;   // % move on premium from entry
  hit: boolean;
}

export interface LiveTrade {
  symbol: string;
  token: number;
  direction: 'Long' | 'Short';
  qty: number;           // absolute
  entryPrice: number;
  ltp: number;
  hasLivePrice: boolean;

  pnl: number;
  pnlPct: number;
  rNow: number;          // current profit in R units

  slPrice: number;
  slRisk: number;        // rupees lost if SL hits
  slPct: number;
  slBreached: boolean;

  targets: TargetLevel[];
  progressPct: number;   // LTP position between SL (0) and last target (100)
  entryMarkPct: number;  // where entry sits on that same scale
  verdict: string;
  verdictTone: 'good' | 'bad' | 'warn' | 'neutral';
}

@Component({
  selector: 'app-live-positions',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './live-positions.component.html',
  styleUrls: ['./live-positions.component.css']
})
export class LivePositionsComponent implements OnInit, OnDestroy {
  /** Session risk budget left, from the GOAT risk engine. -1 disables the check. */
  @Input() riskRemaining = -1;

  trades: LiveTrade[] = [];
  isFeedLive = false;
  lastTickAt: Date | null = null;

  // Risk plan — a stop as % of premium paid, targets as multiples of that risk
  slPct = 20;
  targetRs = [1, 2, 3];

  private ltp = new Map<number, number>();
  private positions: ZerodhaPosition[] = [];
  private subs = new Subscription();

  constructor(private zerodha: ZerodhaService) {}

  ngOnInit(): void {
    this.restorePlan();

    this.subs.add(this.zerodha.positions$.subscribe(p => {
      this.positions = p || [];
      this.rebuild();
    }));

    this.subs.add(this.zerodha.ticks$.subscribe(ticks => {
      if (ticks.size === 0) return;
      this.ltp = ticks;
      this.lastTickAt = new Date();
      this.rebuild();
    }));

    this.subs.add(this.zerodha.connectionStatus$.subscribe(live => {
      this.isFeedLive = live;
    }));

    this.fetchPositions();
    // Safety net: the socket carries fills, but a REST sweep also catches
    // positions opened outside this app (Kite app, web terminal).
    this.subs.add(interval(30000).subscribe(() => this.fetchPositions()));
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
  }

  private fetchPositions(): void {
    this.zerodha.getPositions().subscribe({
      next: (positions) => this.zerodha.publishPositions(positions || []),
      error: () => { /* offline or logged out — the panel just stays empty */ }
    });
  }

  onPlanChange(): void {
    if (!this.slPct || this.slPct < 1) this.slPct = 1;
    if (this.slPct > 90) this.slPct = 90;
    try { localStorage.setItem('live_sl_pct', String(this.slPct)); } catch {}
    this.rebuild();
  }

  private restorePlan(): void {
    try {
      const saved = Number(localStorage.getItem('live_sl_pct'));
      if (saved >= 1 && saved <= 90) this.slPct = saved;
    } catch {}
  }

  private rebuild(): void {
    this.trades = this.positions
      .filter(p => p.quantity !== 0)
      .map(p => this.buildTrade(p));
  }

  private buildTrade(p: ZerodhaPosition): LiveTrade {
    const isLong = p.quantity > 0;
    const qty = Math.abs(p.quantity);
    const entryPrice = p.average_price;

    // Prefer the live tick; fall back to the price Kite sent with the position
    const streamed = this.ltp.get(p.instrument_token);
    const hasLivePrice = streamed != null;
    const ltp = streamed ?? p.last_price ?? entryPrice;

    const sign = isLong ? 1 : -1;
    const riskPerUnit = entryPrice * (this.slPct / 100);
    const slPrice = entryPrice - sign * riskPerUnit;
    const slRisk = riskPerUnit * qty;

    const pnl = (ltp - entryPrice) * p.quantity;
    const pnlPct = entryPrice ? ((ltp - entryPrice) / entryPrice) * 100 * sign : 0;
    const rNow = slRisk ? pnl / slRisk : 0;

    const targets: TargetLevel[] = this.targetRs.map((r, i) => {
      const price = entryPrice + sign * riskPerUnit * r;
      return {
        label: `T${i + 1}`,
        rMultiple: r,
        price,
        gain: riskPerUnit * r * qty,
        gainPct: this.slPct * r,
        hit: rNow >= r
      };
    });

    const lastTarget = targets[targets.length - 1];
    const span = Math.abs(lastTarget.price - slPrice);
    const progressPct = span
      ? this.clamp(((ltp - slPrice) * sign / span) * 100, 0, 100)
      : 0;
    const entryMarkPct = span
      ? this.clamp(((entryPrice - slPrice) * sign / span) * 100, 0, 100)
      : 0;

    const slBreached = isLong ? ltp <= slPrice : ltp >= slPrice;
    const { verdict, verdictTone } = this.judge(rNow, slBreached, targets, slPrice, slRisk);

    return {
      symbol: p.tradingsymbol,
      token: p.instrument_token,
      direction: isLong ? 'Long' : 'Short',
      qty,
      entryPrice,
      ltp,
      hasLivePrice,
      pnl,
      pnlPct,
      rNow,
      slPrice,
      slRisk,
      slPct: this.slPct,
      slBreached,
      targets,
      progressPct,
      entryMarkPct,
      verdict,
      verdictTone
    };
  }

  private judge(
    rNow: number,
    slBreached: boolean,
    targets: TargetLevel[],
    slPrice: number,
    slRisk: number
  ): { verdict: string; verdictTone: 'good' | 'bad' | 'warn' | 'neutral' } {
    if (slBreached) {
      return {
        verdict: `STOP HIT at ₹${slPrice.toFixed(2)} — exit now. This is the loss you already agreed to take.`,
        verdictTone: 'bad'
      };
    }
    const top = targets[targets.length - 1];
    if (rNow >= top.rMultiple) {
      return {
        verdict: `${top.label} reached (+${rNow.toFixed(1)}R). You planned to be out here — book it or trail tight.`,
        verdictTone: 'good'
      };
    }
    const hit = targets.filter(t => t.hit);
    if (hit.length > 0) {
      const last = hit[hit.length - 1];
      const next = targets[hit.length];
      return {
        verdict: `${last.label} hit (+${rNow.toFixed(1)}R). Book part, move the stop to entry — the rest rides free toward ${next.label} at ₹${next.price.toFixed(2)}.`,
        verdictTone: 'good'
      };
    }
    if (rNow > 0) {
      return {
        verdict: `In profit at +${rNow.toFixed(1)}R. Hold for ${targets[0].label} at ₹${targets[0].price.toFixed(2)} — don't take a scratch out of boredom.`,
        verdictTone: 'neutral'
      };
    }
    if (rNow <= -0.5) {
      return {
        verdict: `Down ${Math.abs(rNow).toFixed(1)}R with ₹${(slRisk + rNow * slRisk).toFixed(0)} left to your stop at ₹${slPrice.toFixed(2)}. Let the stop do its job — do not widen it.`,
        verdictTone: 'warn'
      };
    }
    return {
      verdict: `Working. Stop at ₹${slPrice.toFixed(2)} risks ₹${slRisk.toFixed(0)}; ${targets[0].label} at ₹${targets[0].price.toFixed(2)} pays ₹${targets[0].gain.toFixed(0)}.`,
      verdictTone: 'neutral'
    };
  }

  /** True when this position alone can blow the rest of the session budget. */
  exceedsSessionRisk(t: LiveTrade): boolean {
    return this.riskRemaining >= 0 && t.slRisk > this.riskRemaining;
  }

  get totalOpenPnl(): number {
    return this.trades.reduce((sum, t) => sum + t.pnl, 0);
  }

  get totalRiskAtStop(): number {
    return this.trades.reduce((sum, t) => sum + t.slRisk, 0);
  }

  trackByToken(_: number, t: LiveTrade): number {
    return t.token;
  }

  private clamp(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v));
  }
}
