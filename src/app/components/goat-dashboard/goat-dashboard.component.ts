import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DailyStat } from '../../services/trade-parser.service';

interface HourBucket {
  label: string;
  count: number;
  pnl: number;
  barPct: number;      // 0..100 height of bar
  isBest: boolean;
  isWorst: boolean;
}

interface Insight {
  tag: string;
  text: string;
  tone: 'good' | 'bad' | 'warn' | 'neutral';
}

interface GoatPair {
  symbol: string;
  optionType: 'CE' | 'PE' | 'N/A';
  type: 'Long' | 'Short';
  qty: number;
  pnl: number;
  netPnl: number;
  netPct: number;
  charges: number;
  capitalUsed: number;
  remaining: number;
  entryPrice: number;
  exitPrice: number;
  isOpen: boolean;
  entryLabel: string;
  exitLabel: string;
  holdSeconds: number;
  gapSeconds: number;
  isImpulseGap: boolean;
  cumulative: number;
  isRevenge: boolean;
}

type RiskLevel = 'SAFE' | 'CAUTION' | 'DANGER' | 'BREACH';

@Component({
  selector: 'app-goat-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './goat-dashboard.component.html',
  styleUrls: ['./goat-dashboard.component.css']
})
export class GoatDashboardComponent implements OnChanges {
  @Input() stats: Map<string, DailyStat> | null = null;
  @Input() selectedDate: string | null = null;

  availableDates: string[] = [];
  activeDate: string | null = null;

  // ---- Capital / risk configuration ----
  startingCapital = 100000;
  capitalIsAuto = true; // auto = derived from first trade of the day; manual = user-entered
  private readonly STOP_PCT = 0.10;      // 10% of starting capital, charges included
  private readonly REVENGE_WINDOW_S = 300; // re-entry within 5 min of a losing exit
  private readonly IMPULSE_GAP_S = 60;     // re-entry within 1 min of previous trade

  // ---- Day metrics ----
  pairs: GoatPair[] = [];
  recentPairs: GoatPair[] = []; // last 3 trades, latest first
  dayGross = 0;
  dayCharges = 0;
  dayNet = 0;
  totalTrades = 0;
  closedTrades = 0;
  openTrades = 0;
  wins = 0;
  losses = 0;
  winRate = 0;
  avgWin = 0;
  avgLoss = 0;
  profitFactor = 0;
  expectancy = 0;
  maxDrawdown = 0;
  peakEquity = 0;
  giveback = 0;
  peakTradeNo = 0;
  currentLossStreak = 0;
  maxLossStreak = 0;
  maxWinStreak = 0;
  revengeCount = 0;
  revengePnl = 0;
  avgHoldWin = 0;
  avgHoldLoss = 0;
  peakCapital = 0;
  chargesPctOfGrossWins = 0;
  ceCount = 0; cePnl = 0;
  peCount = 0; pePnl = 0;
  longCount = 0; longPnl = 0;
  shortCount = 0; shortPnl = 0;
  maxTradesInHour = 0;
  hourBuckets: HourBucket[] = [];

  // ---- Equity curve (SVG) ----
  equityPoints = '';
  equityArea = '';
  zeroLineY = 85;
  equityEndX = 0;
  equityEndY = 0;
  curveIsUp = true;
  hasCurve = false;

  // ---- Overall (all loaded days) ----
  overallNet = 0;
  totalDays = 0;
  greenDays = 0;
  redDays = 0;

  // ---- Risk engine ----
  riskBudget = 0;
  lossSoFar = 0;
  riskUsedPct = 0;
  riskRemaining = 0;
  riskLevel: RiskLevel = 'SAFE';
  dayRiskPct = 0;

  // ---- Overtrading engine ----
  overtradeLevel = 0; // 0 calm, 1 elevated, 2 high, 3 severe
  overtradeLabel = 'CALM';
  overtradePct = 0;

  // ---- Coach / flow state ----
  flowCode = 'OBSERVER';
  flowLabel = 'OBSERVER';
  flowMessage = '';
  flowMessagePoints: string[] = [];
  flowTips: string[] = [];
  flowSeverity = 0; // 0 green, 1 amber, 2 red, 3 critical

  insights: Insight[] = [];

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['stats'] && this.stats) {
      this.restoreCapital();
      this.updateAvailableDates();
      if (!this.activeDate || !this.availableDates.includes(this.activeDate)) {
        this.activeDate = this.availableDates.length > 0 ? this.availableDates[0] : null;
      }
      this.recompute();
    }
    if (changes['selectedDate'] && this.selectedDate && this.availableDates.includes(this.selectedDate)) {
      this.activeDate = this.selectedDate;
      this.recompute();
    }
  }

  onDateChange(date: string): void {
    this.activeDate = date;
    this.recompute();
  }

  onCapitalChange(): void {
    if (!this.startingCapital || this.startingCapital < 100) {
      this.startingCapital = 100;
    }
    this.capitalIsAuto = false;
    try { localStorage.setItem('goat_capital_manual', String(this.startingCapital)); } catch {}
    this.recompute();
  }

  resetCapitalAuto(): void {
    this.capitalIsAuto = true;
    try { localStorage.removeItem('goat_capital_manual'); } catch {}
    this.recompute();
  }

  private restoreCapital(): void {
    try {
      const saved = localStorage.getItem('goat_capital_manual');
      if (saved && !isNaN(Number(saved)) && Number(saved) > 0) {
        this.startingCapital = Number(saved);
        this.capitalIsAuto = false;
      } else {
        this.capitalIsAuto = true;
      }
    } catch {}
  }

  isOption(symbol: string): boolean {
    const s = symbol.toUpperCase().trim();
    return s.endsWith('CE') || s.endsWith('PE') || s.includes(' CE') || s.includes(' PE');
  }

  private optionType(symbol: string): 'CE' | 'PE' | 'N/A' {
    const s = symbol.toUpperCase();
    if (s.endsWith('CE') || s.includes(' CE')) return 'CE';
    if (s.endsWith('PE') || s.includes(' PE')) return 'PE';
    return 'N/A';
  }

  private timeLabel(timeStr: string | null): string {
    if (!timeStr) return '--:--:--';
    const m = timeStr.match(/(\d{2}):(\d{2}):(\d{2})/);
    return m ? `${m[1]}:${m[2]}:${m[3]}` : timeStr;
  }

  private hourOf(timeStr: string): number {
    const m = timeStr.match(/(\d{2}):(\d{2}):(\d{2})/);
    return m ? Number(m[1]) : -1;
  }

  formatHold(seconds: number): string {
    if (seconds <= 0) return '--';
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    if (mins >= 60) {
      const h = Math.floor(mins / 60);
      return `${h}h ${mins % 60}m`;
    }
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  }

  private updateAvailableDates(): void {
    if (!this.stats) { this.availableDates = []; return; }
    this.availableDates = Array.from(this.stats.keys())
      .filter(d => {
        const s = this.stats!.get(d);
        return s ? s.tradePairs.some(p => this.isOption(p.symbol)) : false;
      })
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
  }

  // =========================================================
  // MASTER RECOMPUTE
  // =========================================================
  private recompute(): void {
    this.computeOverall();
    this.computeDay();
    this.computeRisk();
    this.computeOvertrading();
    this.computeFlowState();
    this.computeInsights();
  }

  private computeOverall(): void {
    this.overallNet = 0; this.totalDays = 0; this.greenDays = 0; this.redDays = 0;
    if (!this.stats) return;
    this.stats.forEach(stat => {
      const hasOptions = stat.tradePairs.some(p => this.isOption(p.symbol));
      if (!hasOptions) return;
      this.totalDays++;
      this.overallNet += stat.netPnL;
      if (stat.netPnL > 0) this.greenDays++;
      else if (stat.netPnL < 0) this.redDays++;
    });
    this.overallNet = Math.round(this.overallNet * 100) / 100;
  }

  private computeDay(): void {
    this.pairs = [];
    this.dayGross = 0; this.dayCharges = 0; this.dayNet = 0;
    this.totalTrades = 0; this.closedTrades = 0; this.openTrades = 0;
    this.wins = 0; this.losses = 0; this.winRate = 0;
    this.avgWin = 0; this.avgLoss = 0; this.profitFactor = 0; this.expectancy = 0;
    this.maxDrawdown = 0; this.peakEquity = 0; this.giveback = 0; this.peakTradeNo = 0;
    this.currentLossStreak = 0; this.maxLossStreak = 0; this.maxWinStreak = 0;
    this.revengeCount = 0; this.revengePnl = 0;
    this.avgHoldWin = 0; this.avgHoldLoss = 0;
    this.peakCapital = 0; this.chargesPctOfGrossWins = 0;
    this.ceCount = 0; this.cePnl = 0; this.peCount = 0; this.pePnl = 0;
    this.longCount = 0; this.longPnl = 0; this.shortCount = 0; this.shortPnl = 0;
    this.maxTradesInHour = 0;
    this.hourBuckets = [];
    this.hasCurve = false; this.equityPoints = ''; this.equityArea = '';

    if (!this.stats || !this.activeDate) return;
    const stat = this.stats.get(this.activeDate);
    if (!stat) return;

    const raw = stat.tradePairs
      .filter(p => this.isOption(p.symbol))
      .slice()
      .sort((a, b) => new Date(a.entryTime).getTime() - new Date(b.entryTime).getTime());

    // Auto starting capital: capital deployed on the first trade of the day
    if (this.capitalIsAuto && raw.length > 0 && raw[0].capitalUsed > 0) {
      this.startingCapital = Math.round(raw[0].capitalUsed);
    }

    let cumulative = 0;
    let grossWins = 0, grossLosses = 0;
    let winStreak = 0, lossStreak = 0;
    let holdWinTotal = 0, holdLossTotal = 0;
    let lastLosingExitMs = -1;
    let prevTradeEndMs = -1;
    const hourMap = new Map<number, { count: number; pnl: number }>();

    for (const p of raw) {
      const charges = (p as any).actualCharges !== undefined ? (p as any).actualCharges : (p.isOpen ? 18 : 36);
      const netPnl = p.pnl - charges;
      const optType = this.optionType(p.symbol);
      const entryMs = new Date(p.entryTime).getTime();
      const exitMs = p.exitTime ? new Date(p.exitTime).getTime() : 0;
      const holdSeconds = p.exitTime ? Math.max(0, (exitMs - entryMs) / 1000) : 0;

      // Gap since the previous trade ended (impulse-pacing signal)
      const gapSeconds = prevTradeEndMs > 0 ? Math.max(0, (entryMs - prevTradeEndMs) / 1000) : -1;
      const isImpulseGap = gapSeconds >= 0 && gapSeconds < this.IMPULSE_GAP_S;

      const entryPrice = p.qty ? p.capitalUsed / p.qty : 0;
      let exitPrice = 0;
      if (p.qty && !p.isOpen) {
        exitPrice = p.type === 'Long'
          ? (p.pnl / p.qty) + entryPrice
          : entryPrice - (p.pnl / p.qty);
      }

      // Revenge detection: entered within window after a losing exit
      const isRevenge = lastLosingExitMs > 0 && (entryMs - lastLosingExitMs) / 1000 <= this.REVENGE_WINDOW_S && (entryMs - lastLosingExitMs) >= 0;
      if (isRevenge) {
        this.revengeCount++;
        if (!p.isOpen) this.revengePnl += netPnl;
      }

      this.totalTrades++;
      this.dayGross += p.pnl;
      this.dayCharges += charges;
      if (p.capitalUsed > this.peakCapital) this.peakCapital = p.capitalUsed;

      if (optType === 'CE') { this.ceCount++; this.cePnl += p.pnl; }
      else if (optType === 'PE') { this.peCount++; this.pePnl += p.pnl; }
      if (p.type === 'Long') { this.longCount++; this.longPnl += p.pnl; }
      else { this.shortCount++; this.shortPnl += p.pnl; }

      const hr = this.hourOf(p.entryTime);
      if (hr >= 0) {
        const b = hourMap.get(hr) || { count: 0, pnl: 0 };
        b.count++; b.pnl += p.pnl;
        hourMap.set(hr, b);
      }

      if (p.isOpen) {
        this.openTrades++;
      } else {
        this.closedTrades++;
        cumulative += netPnl;

        if (p.pnl > 0) {
          this.wins++;
          grossWins += p.pnl;
          winStreak++; lossStreak = 0;
          holdWinTotal += holdSeconds;
          if (winStreak > this.maxWinStreak) this.maxWinStreak = winStreak;
        } else if (p.pnl < 0) {
          this.losses++;
          grossLosses += Math.abs(p.pnl);
          lossStreak++; winStreak = 0;
          holdLossTotal += holdSeconds;
          if (lossStreak > this.maxLossStreak) this.maxLossStreak = lossStreak;
          lastLosingExitMs = exitMs;
        }

        if (cumulative > this.peakEquity) {
          this.peakEquity = cumulative;
          this.peakTradeNo = this.closedTrades;
        }
        const dd = this.peakEquity - cumulative;
        if (dd > this.maxDrawdown) this.maxDrawdown = dd;
      }

      this.pairs.push({
        symbol: p.symbol,
        optionType: optType,
        type: p.type,
        qty: p.qty,
        pnl: p.pnl,
        netPnl,
        netPct: p.capitalUsed ? (netPnl / p.capitalUsed) * 100 : 0,
        charges,
        capitalUsed: p.capitalUsed,
        remaining: p.isOpen ? 0 : p.capitalUsed + p.pnl,
        entryPrice,
        exitPrice,
        isOpen: p.isOpen,
        entryLabel: this.timeLabel(p.entryTime),
        exitLabel: this.timeLabel(p.exitTime),
        holdSeconds,
        gapSeconds,
        isImpulseGap,
        cumulative,
        isRevenge
      });

      prevTradeEndMs = p.isOpen ? entryMs : exitMs;
    }

    this.recentPairs = this.pairs.slice(-3).reverse();
    this.currentLossStreak = lossStreak;
    this.dayNet = Math.round((this.dayGross - this.dayCharges) * 100) / 100;
    this.winRate = this.closedTrades > 0 ? (this.wins / this.closedTrades) * 100 : 0;
    this.avgWin = this.wins > 0 ? grossWins / this.wins : 0;
    this.avgLoss = this.losses > 0 ? grossLosses / this.losses : 0;
    this.profitFactor = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? 99 : 0);
    const wr = this.winRate / 100;
    this.expectancy = this.avgWin * wr - this.avgLoss * (1 - wr);
    this.giveback = this.peakEquity - cumulative;
    this.avgHoldWin = this.wins > 0 ? holdWinTotal / this.wins : 0;
    this.avgHoldLoss = this.losses > 0 ? holdLossTotal / this.losses : 0;
    this.chargesPctOfGrossWins = grossWins > 0 ? (this.dayCharges / grossWins) * 100 : 0;

    // Hour buckets 9..15 (market hours)
    let bestHr = -1, worstHr = -1, bestPnl = -Infinity, worstPnl = Infinity, maxCount = 0;
    hourMap.forEach((b, hr) => {
      if (b.count > maxCount) maxCount = b.count;
      if (b.pnl > bestPnl) { bestPnl = b.pnl; bestHr = hr; }
      if (b.pnl < worstPnl) { worstPnl = b.pnl; worstHr = hr; }
    });
    this.maxTradesInHour = maxCount;
    for (let hr = 9; hr <= 15; hr++) {
      const b = hourMap.get(hr) || { count: 0, pnl: 0 };
      this.hourBuckets.push({
        label: `${String(hr).padStart(2, '0')}h`,
        count: b.count,
        pnl: Math.round(b.pnl * 100) / 100,
        barPct: maxCount > 0 ? (b.count / maxCount) * 100 : 0,
        isBest: hr === bestHr && b.count > 0 && b.pnl > 0,
        isWorst: hr === worstHr && b.count > 0 && b.pnl < 0
      });
    }

    this.buildEquityCurve();
  }

  private buildEquityCurve(): void {
    const closed = this.pairs.filter(p => !p.isOpen);
    if (closed.length < 2) { this.hasCurve = false; return; }

    const W = 600, H = 170, PAD = 8;
    const values = [0, ...closed.map(p => p.cumulative)];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const stepX = (W - PAD * 2) / (values.length - 1);
    const yOf = (v: number) => PAD + (max - v) / span * (H - PAD * 2);

    const pts: string[] = [];
    for (let i = 0; i < values.length; i++) {
      const x = PAD + i * stepX;
      pts.push(`${x.toFixed(1)},${yOf(values[i]).toFixed(1)}`);
    }
    this.equityPoints = pts.join(' ');
    this.zeroLineY = yOf(0);
    const lastX = PAD + (values.length - 1) * stepX;
    this.equityEndX = lastX;
    this.equityEndY = yOf(values[values.length - 1]);
    this.equityArea = `${PAD},${this.zeroLineY.toFixed(1)} ${this.equityPoints} ${lastX.toFixed(1)},${this.zeroLineY.toFixed(1)}`;
    this.curveIsUp = values[values.length - 1] >= 0;
    this.hasCurve = true;
  }

  private computeRisk(): void {
    // Risk is judged per session: today's net loss (charges included) vs 10% of starting capital.
    this.riskBudget = this.startingCapital * this.STOP_PCT;
    this.lossSoFar = Math.max(0, -this.dayNet);
    this.riskUsedPct = this.riskBudget > 0 ? Math.min(150, (this.lossSoFar / this.riskBudget) * 100) : 0;
    this.riskRemaining = Math.max(0, this.riskBudget - this.lossSoFar);
    this.dayRiskPct = this.riskUsedPct;

    if (this.riskUsedPct >= 100) this.riskLevel = 'BREACH';
    else if (this.riskUsedPct >= 75) this.riskLevel = 'DANGER';
    else if (this.riskUsedPct >= 50) this.riskLevel = 'CAUTION';
    else this.riskLevel = 'SAFE';
  }

  private computeOvertrading(): void {
    const t = this.totalTrades;
    if (t > 15) { this.overtradeLevel = 3; this.overtradeLabel = 'SEVERE'; }
    else if (t > 10) { this.overtradeLevel = 2; this.overtradeLabel = 'HIGH'; }
    else if (t > 6) { this.overtradeLevel = 1; this.overtradeLabel = 'ELEVATED'; }
    else { this.overtradeLevel = 0; this.overtradeLabel = 'CALM'; }
    this.overtradePct = Math.min(100, (t / 20) * 100);
  }

  private computeFlowState(): void {
    const tips: string[] = [];

    if (this.riskLevel === 'BREACH') {
      this.flowCode = 'HARD_STOP';
      this.flowLabel = '⛔ HARD STOP — SESSION OVER';
      this.flowSeverity = 3;
      this.flowMessage = `You've crossed the 10% stop-loss on your starting capital — charges included. The session is over, and that's not up for negotiation. This is NOT a failure: honoring a hard stop is the single most professional act in trading. Close the terminal. Write 3 lines about today. Tomorrow needs you calm and funded — not broke and ashamed.`;
      tips.push('Do not "win it back" today. That trade does not exist.');
      tips.push('Journal: what was the FIRST trade that broke your plan?');
      tips.push('Reset your capital number tomorrow and treat it as day 1.');
    } else if (this.riskLevel === 'DANGER') {
      this.flowCode = 'GUARD';
      this.flowLabel = '🛑 CAPITAL GUARD';
      this.flowSeverity = 2;
      this.flowMessage = `You're at ${this.riskUsedPct.toFixed(0)}% of your 10% stop-loss line. Only ₹${this.riskRemaining.toFixed(0)} of risk budget remains. This exact moment separates traders from gamblers. Cut position size to a quarter — or better, stop for the day. Surviving IS the win here.`;
      tips.push(`Max risk left: ₹${this.riskRemaining.toFixed(0)}. One bad trade can end the account's month.`);
      tips.push('Quarter size or flat. Nothing in between.');
      tips.push('If your heart rate is up, your edge is gone. Breathe first.');
    } else if (this.revengeCount >= 2 || this.currentLossStreak >= 3) {
      this.flowCode = 'TILT';
      this.flowLabel = '🌀 TILT WARNING';
      this.flowSeverity = 2;
      this.flowMessage = `That urge to win it back RIGHT NOW? That's dopamine talking, not analysis. Your brain is treating the terminal like a slot machine — it happens to everyone, and ADHD brains feel it twice as hard. Stand up. Get water. 10 minutes away from the screen. The market will still be here when you're back; your capital might not be if you keep swinging.`;
      if (this.revengeCount > 0) tips.push(`${this.revengeCount} revenge re-entries (<5 min after a loss) netted ₹${this.revengePnl.toFixed(0)}.`);
      if (this.currentLossStreak >= 3) tips.push(`${this.currentLossStreak} losses in a row — the next trade is statistically NOT "due" to win.`);
      tips.push('Rule: after 2 straight losses, mandatory 15-minute break. Set a timer.');
    } else if (this.overtradeLevel >= 2) {
      this.flowCode = 'OVERDRIVE';
      this.flowLabel = '⚡ OVERTRADING';
      this.flowSeverity = 2;
      this.flowMessage = `${this.totalTrades} trades today. Every extra trade is a tax — you've paid ₹${this.dayCharges.toFixed(0)} in charges already. The ADHD brain loves the click; but the click isn't the profit, the WAIT is. Pick ONE setup you actually trust and refuse everything else for the rest of the day.`;
      tips.push(`Charges so far: ₹${this.dayCharges.toFixed(0)} — that's money gone regardless of direction.`);
      tips.push('Write your next setup down BEFORE entering. No note, no trade.');
      tips.push('Try: close the order window, keep only the chart open for 20 minutes.');
    } else if (this.overtradeLevel === 1) {
      this.flowCode = 'BUSY';
      this.flowLabel = '📈 GETTING BUSY';
      this.flowSeverity = 1;
      this.flowMessage = `Trade count is creeping up (${this.totalTrades} today). You're still in control — this is just a friendly tap on the shoulder. Quality over quantity from here: your next trade should be one you'd be proud to screenshot.`;
      tips.push('Ask before each entry: "Would I take this exact trade tomorrow morning?"');
      tips.push(`Charges are at ₹${this.dayCharges.toFixed(0)}. Keep them below 20% of gross wins.`);
    } else if (this.closedTrades >= 3 && this.winRate >= 60 && this.dayNet > 0) {
      this.flowCode = 'FLOW';
      this.flowLabel = '🔥 IN THE ZONE';
      this.flowSeverity = 0;
      this.flowMessage = `You're reading the market well right now — ${this.winRate.toFixed(0)}% win rate and green on the day. Enjoy it, AND remember: the zone always ends quietly, without an announcement. Lock in a stopping point NOW — a time or a profit number — so the market doesn't choose it for you.`;
      tips.push(`You're +₹${this.dayNet.toFixed(0)} net. Decide right now what number makes you walk away.`);
      tips.push('Winners quit while ahead more often than you think.');
      tips.push('Keep size constant — the zone tempts you to double up right before it ends.');
    } else if (this.totalTrades > 0 && this.totalTrades <= 5 && this.dayNet >= 0) {
      this.flowCode = 'ZEN';
      this.flowLabel = '🧘 ZEN MODE';
      this.flowSeverity = 0;
      this.flowMessage = `Few trades, clear head, no chasing. This is the version of you that wins long-term — most people never find this gear. Protect the calm; it's worth more than any single trade today.`;
      tips.push('Nothing to fix. Selectivity IS the edge.');
      tips.push('If boredom kicks in, that\'s the danger moment — boredom trades are donations.');
    } else if (this.closedTrades >= 6 && Math.abs(this.dayNet) < this.dayCharges * 2) {
      this.flowCode = 'CHOP';
      this.flowLabel = '🌫 CHOP DETECTED';
      this.flowSeverity = 1;
      this.flowMessage = `Lots of trades, little progress — the market is noise right now, and noise is expensive (₹${this.dayCharges.toFixed(0)} in charges says hello). No shame in it; everyone gets chopped. The single best trade available right now: sit on your hands for 30 minutes.`;
      tips.push('Chop devours scalpers. Wider timeframe or no trade.');
      tips.push(`Net after charges: ₹${this.dayNet.toFixed(0)}. The market is renting your attention for free.`);
    } else if (this.totalTrades === 0) {
      this.flowCode = 'OBSERVER';
      this.flowLabel = '👁 OBSERVER';
      this.flowSeverity = 0;
      this.flowMessage = `No trades on this day. Sometimes the best position is no position — and watching without clicking is a skill most traders never build.`;
      tips.push('Review the tape of past days while you wait. Pattern-spotting compounds.');
    } else {
      this.flowCode = 'STEADY';
      this.flowLabel = '⚖ STEADY';
      this.flowSeverity = this.dayNet < 0 ? 1 : 0;
      this.flowMessage = this.dayNet < 0
        ? `Down ₹${Math.abs(this.dayNet).toFixed(0)} on the day, but nothing here looks reckless. Losses inside a plan are just business expenses. Stay mechanical: same size, same setups, no sudden hero trades to "fix" the number.`
        : `A controlled session. Not spectacular, not sloppy — and that's exactly how accounts grow. Consistency is boring right up until you look at the yearly curve.`;
      tips.push('Grade today by process, not P&L. Did you follow your rules?');
    }

    // Universal data-driven tips
    const worst = this.hourBuckets.find(b => b.isWorst);
    if (worst && worst.pnl < 0) {
      tips.push(`Your bleed hour today: ${worst.label} (₹${worst.pnl.toFixed(0)} across ${worst.count} trades). Consider sitting that hour out.`);
    }
    this.flowTips = tips.slice(0, 5);

    // Coach message rendered as digestible bullet points, one sentence each
    this.flowMessagePoints = this.flowMessage
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }

  private computeInsights(): void {
    const out: Insight[] = [];

    if (this.peakEquity > 0 && this.giveback > this.peakEquity * 0.3 && this.closedTrades > this.peakTradeNo) {
      out.push({
        tag: 'GIVEBACK',
        tone: 'bad',
        text: `You were +₹${this.peakEquity.toFixed(0)} at your peak (trade #${this.peakTradeNo}) and gave back ₹${this.giveback.toFixed(0)} after it. A "stop after new-high + 2 losers" rule would have kept most of it.`
      });
    }

    const best = this.hourBuckets.find(b => b.isBest);
    if (best && best.pnl > 0) {
      out.push({ tag: 'EDGE HOUR', tone: 'good', text: `${best.label} was your money hour: +₹${best.pnl.toFixed(0)} in ${best.count} trades. Your focus window is real — schedule around it.` });
    }

    if (this.ceCount > 0 && this.peCount > 0) {
      const ceBetter = this.cePnl >= this.pePnl;
      const diff = Math.abs(this.cePnl - this.pePnl);
      if (diff > Math.max(500, this.dayCharges)) {
        out.push({
          tag: 'CE vs PE',
          tone: 'neutral',
          text: `${ceBetter ? 'Calls' : 'Puts'} outperformed by ₹${diff.toFixed(0)} today (CE ₹${this.cePnl.toFixed(0)} vs PE ₹${this.pePnl.toFixed(0)}). You read ${ceBetter ? 'upside' : 'downside'} moves better in this session.`
        });
      }
    }

    if (this.wins > 0 && this.losses > 0 && this.avgHoldLoss > this.avgHoldWin * 1.5) {
      out.push({
        tag: 'HOLD BIAS',
        tone: 'warn',
        text: `Winners held ${this.formatHold(this.avgHoldWin)} on average, losers ${this.formatHold(this.avgHoldLoss)}. You're cutting flowers and watering weeds — flip it.`
      });
    }

    if (this.chargesPctOfGrossWins > 25 && this.wins > 0) {
      out.push({
        tag: 'FEE BURN',
        tone: 'warn',
        text: `Charges consumed ${this.chargesPctOfGrossWins.toFixed(0)}% of your gross wins (₹${this.dayCharges.toFixed(0)}). Below 20% is sustainable; above 30% the broker is your best-paid partner.`
      });
    }

    if (this.revengeCount > 0) {
      out.push({
        tag: 'REVENGE',
        tone: this.revengePnl < 0 ? 'bad' : 'warn',
        text: `${this.revengeCount} entr${this.revengeCount === 1 ? 'y' : 'ies'} within 5 minutes of a losing exit, netting ₹${this.revengePnl.toFixed(0)}. Impulse re-entries have a name for a reason.`
      });
    }

    if (this.maxWinStreak >= 3) {
      out.push({ tag: 'STREAK', tone: 'good', text: `Best win streak: ${this.maxWinStreak} in a row. Study those entries — that's your A+ setup showing itself.` });
    }

    if (this.longCount > 0 && this.shortCount > 0) {
      const longBetter = this.longPnl >= this.shortPnl;
      out.push({
        tag: 'DIRECTION',
        tone: 'neutral',
        text: `Long trades: ₹${this.longPnl.toFixed(0)} (${this.longCount}) · Short trades: ₹${this.shortPnl.toFixed(0)} (${this.shortCount}). Your ${longBetter ? 'long' : 'short'} side carried today.`
      });
    }

    if (out.length === 0 && this.totalTrades > 0) {
      out.push({ tag: 'CLEAN', tone: 'good', text: 'No behavioral red flags detected in this session. Boring is beautiful.' });
    }

    this.insights = out;
  }
}
