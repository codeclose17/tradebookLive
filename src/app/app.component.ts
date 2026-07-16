import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { FileUploaderComponent } from './components/file-uploader/file-uploader.component';
import { CalendarComponent } from './components/calendar/calendar.component';
import { DashboardComponent } from './components/dashboard/dashboard.component';
import { GoatDashboardComponent } from './components/goat-dashboard/goat-dashboard.component';
import { TradeParserService, DailyStat } from './services/trade-parser.service';
import { ZerodhaService } from './services/zerodha.service';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, FileUploaderComponent, CalendarComponent, DashboardComponent, GoatDashboardComponent],
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
  activePage: 'calendar' | 'dashboard' | 'goat' | 'data-sources' = 'data-sources';
  selectedDashboardDate: string | null = null;
  wakingTimeout: any = null;

  // Period query state (moved from dashboard)
  startDate: string = '';
  endDate: string = '';
  periodError: string | null = null;

  private subs = new Subscription();

  // ---- Live refresh state ----
  private dataSource: 'api' | 'file' | null = null;
  private lastTradeCount = 0;
  private activeQuery: { start?: string; end?: string } | null = null;
  private liveRefreshTimer: any = null;
  private pollIntervalId: any = null;
  // Kite's trade book can lag the websocket postback by several seconds,
  // so a fill is re-fetched on this ladder until the new trade appears.
  private readonly LIVE_RETRY_DELAYS = [1500, 3000, 6000, 12000];
  private readonly FALLBACK_POLL_MS = 60000;

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
          // Catch up on fills that happened while the socket was down
          if (this.isZerodhaLoggedIn) {
            this.refreshTradesSilently();
          }
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
        this.scheduleLiveRefresh();
      })
    );

    // Safety net: catch fills whose socket event was missed entirely
    this.pollIntervalId = setInterval(() => {
      if (this.isZerodhaLoggedIn && this.isServerConnected && !this.isLoading) {
        this.refreshTradesSilently();
      }
    }, this.FALLBACK_POLL_MS);

    window.addEventListener('message', this.handleAuthMessage);
  }

  ngOnDestroy() {
    this.subs.unsubscribe();
    window.removeEventListener('message', this.handleAuthMessage);
    if (this.wakingTimeout) {
      clearTimeout(this.wakingTimeout);
    }
    if (this.liveRefreshTimer) {
      clearTimeout(this.liveRefreshTimer);
    }
    if (this.pollIntervalId) {
      clearInterval(this.pollIntervalId);
    }
  }

  private handleAuthMessage = (event: MessageEvent) => {
    if (event.data === 'zerodha_login_success') {
      this.checkAuth();
    }
  };

  navigateTo(page: 'calendar' | 'dashboard' | 'goat' | 'data-sources') {
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
    if (!silent) {
      this.error = null;
      this.isLoading = true;
      this.activeQuery = null;
    }
    const query = silent ? this.activeQuery : null;
    this.zerodhaService.getHistoricalTrades(query?.start, query?.end).subscribe({
      next: (trades) => {
        this.isLoading = false;
        this.applyTrades(trades, silent);
      },
      error: (err) => this.handleFetchError(err, silent)
    });
  }

  /**
   * Applies fetched trades to the app state.
   * Returns true when the data actually changed.
   * Silent mode never wipes existing data, never shows non-auth errors
   * and never navigates — it only updates in place.
   */
  private applyTrades(trades: any[], silent: boolean): boolean {
    if (!trades || trades.length === 0) {
      if (!silent) {
        this.error = "No trades found on this account today.";
        this.dailyStats = null;
        this.lastTradeCount = 0;
        this.dataSource = null;
      }
      return false;
    }

    if (silent && this.dailyStats && trades.length === this.lastTradeCount) {
      return false; // nothing new yet
    }

    try {
      this.dailyStats = this.tradeParser.parseZerodhaApiTrades(trades);
      this.lastTradeCount = trades.length;
      this.dataSource = 'api';
      // Auto-navigate to calendar after data loads
      if (!silent && this.activePage === 'data-sources') {
        this.activePage = 'calendar';
      }
      return true;
    } catch (e: any) {
      if (!silent) {
        this.error = 'Failed to parse live trades: ' + (e.message || e);
        this.dailyStats = null;
      }
      console.error('Error parsing live trades', e);
      return false;
    }
  }

  private handleFetchError(err: any, silent: boolean) {
    this.isLoading = false;
    console.error('Error fetching trades', err);
    if (err.status === 401 || err.status === 403) {
      this.isZerodhaLoggedIn = false;
      this.error = 'Zerodha session expired or invalid. Please login again.';
    } else if (!silent) {
      this.error = 'Could not fetch trades from Zerodha API.';
    }
  }

  /** One-shot background refresh (reconnect catch-up / fallback poll). */
  private refreshTradesSilently() {
    if (this.dataSource === 'file') return; // don't clobber an uploaded tradebook
    this.fetchTrades(true);
  }

  /**
   * After an order-fill event, re-fetch until the new trade shows up.
   * Kite's trade book often lags the websocket postback, so a single
   * fixed-delay fetch can miss the fill and leave the UI stale.
   */
  private scheduleLiveRefresh() {
    if (this.dataSource === 'file') return;
    if (this.liveRefreshTimer) {
      clearTimeout(this.liveRefreshTimer);
      this.liveRefreshTimer = null;
    }

    let attempt = 0;
    const run = () => {
      this.liveRefreshTimer = null;
      this.zerodhaService.getHistoricalTrades(this.activeQuery?.start, this.activeQuery?.end).subscribe({
        next: (trades) => {
          const changed = this.applyTrades(trades, true);
          attempt++;
          if (!changed && attempt < this.LIVE_RETRY_DELAYS.length) {
            this.liveRefreshTimer = setTimeout(run, this.LIVE_RETRY_DELAYS[attempt]);
          }
        },
        error: (err) => {
          this.handleFetchError(err, true);
          attempt++;
          if (this.isZerodhaLoggedIn && attempt < this.LIVE_RETRY_DELAYS.length) {
            this.liveRefreshTimer = setTimeout(run, this.LIVE_RETRY_DELAYS[attempt]);
          }
        }
      });
    };
    this.liveRefreshTimer = setTimeout(run, this.LIVE_RETRY_DELAYS[0]);
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
        this.dataSource = 'file';
        this.lastTradeCount = 0;
        this.activeQuery = null;
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
            this.dataSource = 'api';
            this.lastTradeCount = trades.length;
            // Remember the query so background refreshes keep the same period view
            this.activeQuery = { start: this.startDate || undefined, end: this.endDate || undefined };
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
