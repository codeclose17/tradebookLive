import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DailyStat } from '../../services/trade-parser.service';
import { TradeDialogComponent } from '../trade-dialog/trade-dialog.component';

interface MonthData {
  name: string;
  year: number;
  days: (DailyStat | null)[]; // null for padding days
  totalNetPnL: number;
}

@Component({
  selector: 'app-calendar',
  standalone: true,
  imports: [CommonModule, TradeDialogComponent],
  template: `
    <div class="calendar-header-actions" *ngIf="months.length > 0">
      <button class="toggle-view-btn" (click)="toggleViewMode()">
        {{ viewMode === 'detailed' ? 'Switch to Minimised View (12 Months)' : 'Switch to Detailed View' }}
      </button>
    </div>

    <div class="calendar-container" [class.minimized-view]="viewMode === 'minimized'">
      <div *ngIf="months.length === 0" class="empty-state">
        No trading data available for the selected file.
      </div>

      <div class="month-block" *ngFor="let month of months">
        <div class="month-header">
          <h2>{{ month.name }} {{ month.year }}</h2>
          <div class="month-summary" [ngClass]="{'positive': month.totalNetPnL > 0, 'negative': month.totalNetPnL < 0}">
            Monthly Net: ₹{{ month.totalNetPnL | number:'1.2-2' }}
          </div>
        </div>

        <div class="weekdays">
          <div class="weekday">Sun</div>
          <div class="weekday">Mon</div>
          <div class="weekday">Tue</div>
          <div class="weekday">Wed</div>
          <div class="weekday">Thu</div>
          <div class="weekday">Fri</div>
          <div class="weekday">Sat</div>
        </div>

        <div class="days-grid">
          <div 
            class="day-cell" 
            *ngFor="let day of month.days"
            (click)="openDayDetails(day)"
            [ngClass]="{
              'empty': !day,
              'clickable': day && day.numberOfTrades > 0 && viewMode === 'detailed',
              'positive-day': day && day.netPnL > 0,
              'negative-day': day && day.netPnL < 0,
              'neutral-day': day && day.netPnL === 0
            }">
            
            <ng-container *ngIf="day">
              <div class="date-number">{{ getDateNumber(day.date) }}</div>
              <div class="pnl-amount" [class.is-loss]="day.netPnL < 0">
                ₹{{ day.netPnL > 0 ? '+' : '' }}{{ day.netPnL | number:'1.0-0' }}
              </div>
              <div class="trade-stats">
                <span>{{ day.numberOfTrades }} trades</span>
                <span class="charges">Charges: ₹{{ day.totalCharges }}</span>
              </div>
            </ng-container>
            
          </div>
        </div>
      </div>
    </div>

    <app-trade-dialog 
      *ngIf="selectedDay" 
      [stat]="selectedDay" 
      (onClose)="selectedDay = null">
    </app-trade-dialog>
  `,
  styleUrls: ['./calendar.component.css']
})
export class CalendarComponent implements OnChanges {
  @Input() stats: Map<string, DailyStat> | null = null;
  @Output() daySelected = new EventEmitter<string>();

  months: MonthData[] = [];
  viewMode: 'detailed' | 'minimized' = 'detailed';
  selectedDay: DailyStat | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['stats'] && this.stats) {
      this.buildCalendar(this.stats);
    }
  }

  toggleViewMode() {
    this.viewMode = this.viewMode === 'detailed' ? 'minimized' : 'detailed';
  }

  openDayDetails(day: DailyStat | null) {
    if (day && day.numberOfTrades > 0 && this.viewMode === 'detailed') {
      this.selectedDay = day;
      this.daySelected.emit(day.date);
    }
  }

  getDateNumber(dateStr: string): number {
    return new Date(dateStr).getDate();
  }

  private buildCalendar(stats: Map<string, DailyStat>) {
    if (stats.size === 0) {
      this.months = [];
      return;
    }

    // Sort all dates
    const allDates = Array.from(stats.keys()).sort();
    
    const start = new Date(allDates[0]);
    const end = new Date(allDates[allDates.length - 1]);

    const monthsData: MonthData[] = [];

    // Iterate month by month from start to end
    let currentMonth = new Date(start.getFullYear(), start.getMonth(), 1);
    const endMonth = new Date(end.getFullYear(), end.getMonth(), 1);

    while (currentMonth <= endMonth) {
      const year = currentMonth.getFullYear();
      const monthIndex = currentMonth.getMonth();
      const monthName = currentMonth.toLocaleString('default', { month: 'long' });

      // Find first day of the week for this month
      const firstDayOfWeek = new Date(year, monthIndex, 1).getDay();
      
      // Find number of days in this month
      const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();

      const days: (DailyStat | null)[] = Array(firstDayOfWeek).fill(null);
      let totalNetPnL = 0;

      for (let i = 1; i <= daysInMonth; i++) {
        // Format date string as YYYY-MM-DD to match the keys (assuming local timezone formatting roughly matches)
        // A safer way is to pad zeroes
        const m = String(monthIndex + 1).padStart(2, '0');
        const d = String(i).padStart(2, '0');
        const dateKey = `${year}-${m}-${d}`;

        const stat = stats.get(dateKey);
        
        if (stat) {
          totalNetPnL += stat.netPnL;
          days.push(stat);
        } else {
          // If no trade on this day, we still want to show the empty day square
          // so the calendar aligns properly
          days.push({
            date: dateKey,
            numberOfTrades: 0,
            totalCharges: 0,
            grossPnL: 0,
            netPnL: 0,
            tradePairs: []
          });
        }
      }

      monthsData.push({
        name: monthName,
        year,
        days,
        totalNetPnL
      });

      currentMonth.setMonth(currentMonth.getMonth() + 1);
    }

    this.months = monthsData;
  }
}
