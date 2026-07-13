import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { FileUploaderComponent } from './components/file-uploader/file-uploader.component';
import { CalendarComponent } from './components/calendar/calendar.component';
import { DashboardComponent } from './components/dashboard/dashboard.component';
import { TradeParserService, DailyStat } from './services/trade-parser.service';
import { ZerodhaService } from './services/zerodha.service';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, FileUploaderComponent, CalendarComponent, DashboardComponent],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent implements OnInit, OnDestroy {
  title = 'Tradebook Analytics';
  dailyStats: Map<string, DailyStat> | null = null;
  error: string | null = null;
  isLoading = false;

  isZerodhaLoggedIn = false;
  isServerConnected = false;
  isTickerConnected = false;
  isWakingUp = false;
  isKeepaliveEnabled = false;
  isKeepaliveSupported = false;
  activePage: 'calendar' | 'dashboard' | 'data-sources' = 'data-sources';
  selectedDashboardDate: string | null = null;
  wakingTimeout: any = null;

  // Period query state (moved from dashboard)
  startDate: string = '';
  endDate: string = '';
  periodError: string | null = null;

  private subs = new Subscription();

  constructor(
    private tradeParser: TradeParserService,
    private zerodhaService: ZerodhaService
  ) {}

  ngOnInit() {
    this.checkAuth();
    this.subs.add(
      this.zerodhaService.serverConnected$.subscribe(status => {
        this.isServerConnected = status;
        if (status) {
          this.isWakingUp = false;
          if (this.wakingTimeout) {
            clearTimeout(this.wakingTimeout);
            this.wakingTimeout = null;
          }
          this.fetchKeepaliveStatus();
        }
      })
    );
    this.subs.add(
      this.zerodhaService.connectionStatus$.subscribe(status => {
        this.isTickerConnected = status;
      })
    );
    this.subs.add(
      this.zerodhaService.tradeUpdate$.subscribe(trade => {
        console.log('Real-time trade update received:', trade);
        this.fetchTrades(true); // Fetch silently in the background
      })
    );

    window.addEventListener('message', this.handleAuthMessage);
  }

  ngOnDestroy() {
    this.subs.unsubscribe();
    window.removeEventListener('message', this.handleAuthMessage);
    if (this.wakingTimeout) {
      clearTimeout(this.wakingTimeout);
    }
  }

  private handleAuthMessage = (event: MessageEvent) => {
    if (event.data === 'zerodha_login_success') {
      this.checkAuth();
    }
  };

  navigateTo(page: 'calendar' | 'dashboard' | 'data-sources') {
    this.activePage = page;
  }

  checkAuth() {
    this.zerodhaService.checkAuthStatus().subscribe({
      next: (res) => {
        this.isZerodhaLoggedIn = res.loggedIn;
        if (res.loggedIn) {
          this.fetchTrades();
        }
      },
      error: (err) => console.error('Error checking auth', err)
    });
  }

  fetchTrades(silent = false) {
    this.error = null;
    if (!silent) {
      this.isLoading = true;
    }
    this.zerodhaService.getHistoricalTrades().subscribe({
      next: (trades) => {
        this.isLoading = false;
        if (trades && trades.length > 0) {
          try {
            this.dailyStats = this.tradeParser.parseZerodhaApiTrades(trades);
            // Auto-navigate to calendar after data loads
            if (this.activePage === 'data-sources') {
              this.activePage = 'calendar';
            }
          } catch (e: any) {
            this.error = 'Failed to parse live trades: ' + (e.message || e);
            this.dailyStats = null;
          }
        } else {
          this.error = "No trades found on this account today.";
          this.dailyStats = null;
        }
      },
      error: (err) => {
        this.isLoading = false;
        console.error('Error fetching trades', err);
        if (err.status === 401 || err.status === 403) {
          this.isZerodhaLoggedIn = false;
          this.error = 'Zerodha session expired or invalid. Please login again.';
        } else {
          this.error = 'Could not fetch trades from Zerodha API.';
        }
      }
    });
  }

  loginZerodha() {
    // Open a blank window immediately (synchronously in user click event context)
    // to bypass browser popup blockers
    const loginWindow = window.open('about:blank', '_blank', 'width=800,height=600');
    
    if (loginWindow) {
      loginWindow.document.write(`
        <div style="font-family: sans-serif; text-align: center; margin-top: 100px; color: #333;">
          <h2>Connecting to Zerodha...</h2>
          <p>Please wait while we redirect you securely.</p>
        </div>
      `);
    }

    this.zerodhaService.getLoginUrl().subscribe({
      next: (res) => {
        if (loginWindow) {
          loginWindow.location.href = res.loginUrl;
        }
      },
      error: (err) => {
        console.error('Error getting login URL', err);
        this.error = 'Could not initiate Zerodha login.';
        if (loginWindow) {
          loginWindow.close();
        }
      }
    });
  }

  wakeBackend() {
    if (this.isServerConnected) {
      this.fetchTrades();
      return;
    }

    this.isWakingUp = true;
    this.error = null;

    // Set a backup timeout of 60s for Render free tier to spin up
    this.wakingTimeout = setTimeout(() => {
      this.isWakingUp = false;
      this.error = 'Wake up request timed out. Please refresh the page or try again.';
    }, 60000);

    this.zerodhaService.ping().subscribe({
      next: (res) => {
        console.log('Backend wake-up ping succeeded:', res);
        // The server is awake, wait for socket to connect naturally
      },
      error: (err) => {
        console.error('Error pinging backend:', err);
        // Even if the HTTP call errors or times out in the client,
        // it has reached Render and triggered the spin-up process.
      }
    });
  }

  fetchKeepaliveStatus() {
    this.zerodhaService.getKeepaliveStatus().subscribe({
      next: (res) => {
        this.isKeepaliveEnabled = res.enabled;
        this.isKeepaliveSupported = res.supported;
      },
      error: (err) => {
        console.error('Error fetching keep-alive status:', err);
      }
    });
  }

  toggleKeepalive() {
    if (!this.isKeepaliveSupported) return;

    this.isLoading = true;
    const req = this.isKeepaliveEnabled
      ? this.zerodhaService.stopKeepalive()
      : this.zerodhaService.startKeepalive();

    req.subscribe({
      next: (res) => {
        this.isLoading = false;
        this.isKeepaliveEnabled = res.enabled;
      },
      error: (err) => {
        this.isLoading = false;
        console.error('Error toggling keep-alive:', err);
      }
    });
  }

  onFileLoaded(buffer: ArrayBuffer) {
    this.error = null;
    this.isLoading = true;

    this.tradeParser.parseTradebook(buffer)
      .then(stats => {
        this.dailyStats = stats;
        this.isLoading = false;
        this.activePage = 'calendar';
      })
      .catch(e => {
        this.isLoading = false;
        this.error = e.message || 'An error occurred while parsing the file.';
        this.dailyStats = null;
      });
  }

  fetchTradesForPeriod() {
    if (!this.startDate && !this.endDate) {
      this.periodError = 'Please select at least a From or To date.';
      return;
    }

    this.isLoading = true;
    this.periodError = null;

    this.zerodhaService.getHistoricalTrades(this.startDate || undefined, this.endDate || undefined).subscribe({
      next: (trades) => {
        this.isLoading = false;
        if (trades && trades.length > 0) {
          try {
            this.dailyStats = this.tradeParser.parseZerodhaApiTrades(trades);
            this.activePage = 'calendar';
          } catch (e: any) {
            this.periodError = 'Failed to parse fetched trades: ' + (e.message || e);
          }
        } else {
          this.periodError = 'No trades found for the selected period.';
        }
      },
      error: (err) => {
        this.isLoading = false;
        console.error('Error fetching period trades', err);
        this.periodError = 'Could not fetch trades from API.';
      }
    });
  }

  onDaySelected(date: string) {
    this.selectedDashboardDate = date;
    this.activePage = 'dashboard';
  }
}
