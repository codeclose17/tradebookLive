import { Component, EventEmitter, Input, Output, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule, DatePipe, CurrencyPipe } from '@angular/common';
import { DailyStat, TradePair } from '../../services/trade-parser.service';

@Component({
  selector: 'app-trade-dialog',
  standalone: true,
  imports: [CommonModule],
  providers: [DatePipe, CurrencyPipe],
  template: `
    <div class="modal-overlay" (click)="close()">
      <div class="modal-content" (click)="$event.stopPropagation()">
        <div class="modal-header">
          <div>
            <h2>Trades for {{ stat.date }}</h2>
            <p class="modal-subtitle">
              Net P&L: <span [class.is-loss]="stat.netPnL < 0" [class.is-profit]="stat.netPnL > 0">₹{{ stat.netPnL | number:'1.2-2' }}</span>
              • {{ stat.numberOfTrades }} trades
            </p>
          </div>
          <button class="close-btn" (click)="close()">×</button>
        </div>

        <div class="modal-body">
          <table class="trades-table" *ngIf="stat.tradePairs.length > 0">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Type</th>
                <th>Qty & Price</th>
                <th>Entry Time</th>
                <th>Exit Time</th>
                <th>Capital Used / Ret</th>
                <th>P&L</th>
              </tr>
            </thead>
            <tbody>
              <tr *ngFor="let pair of enhancedPairs">
                <td class="symbol-cell" data-label="Symbol">{{ pair.symbol }}</td>
                <td data-label="Type">
                  <span class="badge" [class.badge-long]="pair.type === 'Long'" [class.badge-short]="pair.type === 'Short'">
                    {{ pair.type }}
                  </span>
                </td>
                <td data-label="Qty & Price">
                  <div>{{ pair.qty }}</div>
                  <div class="text-muted" style="font-size: 0.85em; margin-top: 4px;">
                    ₹{{ pair.entryPrice | number:'1.2-2' }} <span *ngIf="!pair.isOpen">→ ₹{{ pair.exitPrice | number:'1.2-2' }}</span>
                  </div>
                </td>
                <td class="time-cell" data-label="Entry Time">
                  <span *ngIf="pair.isTimeExact !== false">{{ pair.entryTime | date:'HH:mm:ss' }}</span>
                  <span *ngIf="pair.isTimeExact === false">{{ pair.entryTime | date:'dd MMM yy' }}</span>
                </td>
                <td class="time-cell" data-label="Exit Time">
                  <span *ngIf="pair.isTimeExact !== false">{{ pair.exitTime ? (pair.exitTime | date:'HH:mm:ss') : 'Open' }}</span>
                  <span *ngIf="pair.isTimeExact === false">{{ pair.exitTime ? (pair.exitTime | date:'dd MMM yy') : 'Open' }}</span>
                </td>
                <td data-label="Capital Used / Ret">
                  <div>₹{{ pair.capitalUsed | number:'1.0-2' }}</div>
                  <div *ngIf="!pair.isOpen" class="text-muted" style="font-size: 0.85em; margin-top: 4px;" [class.is-profit]="pair.pnl > 0" [class.is-loss]="pair.pnl < 0">
                    Ret: ₹{{ (pair.capitalUsed + pair.pnl) | number:'1.0-2' }}
                  </div>
                </td>
                <td class="pnl-cell" data-label="P&L" [class.is-loss]="pair.pnl < 0" [class.is-profit]="pair.pnl > 0">
                  <div style="display: flex; flex-direction: column; align-items: flex-end;">
                    <span *ngIf="!pair.isOpen">
                      {{ pair.pnl > 0 ? '+' : '' }}₹{{ pair.pnl | number:'1.0-2' }} ({{ pair.pnl > 0 ? '+' : '' }}{{ pair.pct | number:'1.2-2' }}%)
                    </span>
                    <span *ngIf="pair.isOpen" class="text-muted">-</span>
                    <span class="text-muted" style="font-size: 0.85em; font-weight: normal; margin-top: 4px; color: #a0a0a0;">
                      Cum: {{ pair.cumulative > 0 ? '+' : '' }}₹{{ pair.cumulative | number:'1.0-2' }}
                    </span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          <div *ngIf="stat.tradePairs.length === 0" class="empty-state">
            No trades found for this day.
          </div>
        </div>
      </div>
    </div>
  `,
  styleUrls: ['./trade-dialog.component.css']
})
export class TradeDialogComponent implements OnChanges {
  @Input() stat!: DailyStat;
  @Output() onClose = new EventEmitter<void>();
  
  enhancedPairs: any[] = [];

  ngOnChanges(changes: SimpleChanges) {
    if (this.stat && this.stat.tradePairs) {
      let runningTotal = 0;
      this.enhancedPairs = this.stat.tradePairs.map(pair => {
        runningTotal += pair.pnl;
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
        
        return {
          ...pair,
          entryPrice,
          exitPrice,
          pct,
          cumulative: runningTotal
        };
      });
    }
  }

  close() {
    this.onClose.emit();
  }
}
