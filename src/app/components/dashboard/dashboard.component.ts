import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DailyStat, TradePair } from '../../services/trade-parser.service';

interface DashboardMetrics {
  totalPnL: number;
  netPnL: number;
  charges: number;
  totalTrades: number;
  closedTrades: number;
  openTrades: number;
  winRate: number;
  winningTrades: number;
  losingTrades: number;
  capitalDeployed: number;
  maxWin: number;
  maxLoss: number;
  ceCount: number;
  peCount: number;
  cePnL: number;
  pePnL: number;
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.css']
})
export class DashboardComponent implements OnChanges {
  @Input() stats: Map<string, DailyStat> | null = null;
  @Input() selectedDate: string | null = null;

  availableDates: string[] = [];
  activeDate: string | null = null;
  activeStat: DailyStat | null = null;
  optionPairs: any[] = [];
  metrics: DashboardMetrics | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['stats'] && this.stats) {
      this.updateAvailableDates();

      // If we don't have an active date, or the old active date is not available,
      // select the latest date with option trades.
      if (!this.activeDate || !this.availableDates.includes(this.activeDate)) {
        this.activeDate = this.availableDates.length > 0 ? this.availableDates[0] : null;
      }
      this.loadDashboardData();
    }

    if (changes['selectedDate'] && this.selectedDate) {
      if (this.availableDates.includes(this.selectedDate)) {
        this.activeDate = this.selectedDate;
        this.loadDashboardData();
      }
    }
  }

  onDateChange(newDate: string): void {
    this.activeDate = newDate;
    this.loadDashboardData();
  }

  isOption(symbol: string): boolean {
    const s = symbol.toUpperCase().trim();
    return s.endsWith('CE') || s.endsWith('PE') || s.includes(' CE') || s.includes(' PE');
  }

  getOptionType(symbol: string): 'CE' | 'PE' | 'N/A' {
    const s = symbol.toUpperCase();
    if (s.endsWith('CE') || s.includes(' CE')) return 'CE';
    if (s.endsWith('PE') || s.includes(' PE')) return 'PE';
    return 'N/A';
  }

  private updateAvailableDates(): void {
    if (!this.stats) {
      this.availableDates = [];
      return;
    }

    // Filter to only get dates that actually have option trades
    this.availableDates = Array.from(this.stats.keys())
      .filter(date => {
        const stat = this.stats!.get(date);
        return stat ? stat.tradePairs.some(p => this.isOption(p.symbol)) : false;
      })
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime()); // Descending (latest first)
  }

  private loadDashboardData(): void {
    if (!this.stats || !this.activeDate) {
      this.activeStat = null;
      this.optionPairs = [];
      this.metrics = null;
      return;
    }

    this.activeStat = this.stats.get(this.activeDate) || null;
    if (!this.activeStat) {
      this.optionPairs = [];
      this.metrics = null;
      return;
    }

    let runningTotal = 0;
    // Filter to option pairs and enhance with detailed values
    this.optionPairs = this.activeStat.tradePairs
      .filter(pair => this.isOption(pair.symbol))
      .map(pair => {
        const entryPrice = pair.qty ? pair.capitalUsed / pair.qty : 0;
        let exitPrice = 0;
        if (pair.qty) {
          if (pair.type === 'Long') {
            exitPrice = (pair.pnl / pair.qty) + entryPrice;
          } else {
            exitPrice = entryPrice - (pair.pnl / pair.qty);
          }
        }
        const pct = pair.capitalUsed ? (pair.pnl / pair.capitalUsed) * 100 : 0;
        const optionType = this.getOptionType(pair.symbol);
        runningTotal += pair.pnl;

        return {
          ...pair,
          entryPrice,
          exitPrice,
          pct,
          optionType,
          cumulative: runningTotal
        };
      });

    this.calculateMetrics();
  }

  private calculateMetrics(): void {
    if (this.optionPairs.length === 0) {
      this.metrics = null;
      return;
    }

    let totalPnL = 0;
    let charges = 0;
    let openTrades = 0;
    let closedTrades = 0;
    let winningTrades = 0;
    let losingTrades = 0;
    let capitalDeployed = 0;
    let maxWin = -Infinity;
    let maxLoss = Infinity;

    let ceCount = 0;
    let peCount = 0;
    let cePnL = 0;
    let pePnL = 0;

    for (const pair of this.optionPairs) {
      totalPnL += pair.pnl;
      // Use actual calculated charges from trade parser
      const tradeCharges = pair.actualCharges !== undefined ? pair.actualCharges : (pair.isOpen ? 18 : 36);
      charges += tradeCharges;

      if (pair.isOpen) {
        openTrades++;
      } else {
        closedTrades++;
        if (pair.pnl > 0) {
          winningTrades++;
        } else if (pair.pnl < 0) {
          losingTrades++;
        }
      }

      if (pair.capitalUsed > capitalDeployed) {
        capitalDeployed = pair.capitalUsed;
      }

      if (!pair.isOpen) {
        if (pair.pnl > maxWin) maxWin = pair.pnl;
        if (pair.pnl < maxLoss) maxLoss = pair.pnl;
      }

      if (pair.optionType === 'CE') {
        ceCount++;
        cePnL += pair.pnl;
      } else if (pair.optionType === 'PE') {
        peCount++;
        pePnL += pair.pnl;
      }
    }

    const totalTrades = this.optionPairs.length;
    const winRate = closedTrades > 0 ? (winningTrades / closedTrades) * 100 : 0;
    const netPnL = totalPnL - charges;

    this.metrics = {
      totalPnL,
      netPnL: Math.round(netPnL * 100) / 100,
      charges: Math.round(charges * 100) / 100,
      totalTrades,
      closedTrades,
      openTrades,
      winRate,
      winningTrades,
      losingTrades,
      capitalDeployed,
      maxWin: maxWin === -Infinity ? 0 : maxWin,
      maxLoss: maxLoss === Infinity ? 0 : maxLoss,
      ceCount,
      peCount,
      cePnL,
      pePnL
    };
  }
}
