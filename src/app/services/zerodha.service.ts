import { Injectable, NgZone } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, Subject, BehaviorSubject } from 'rxjs';
import { io, Socket } from 'socket.io-client';

export interface ZerodhaTrade {
  trade_id: string;
  order_id: string;
  exchange_order_id: string;
  tradingsymbol: string;
  exchange: string;
  instrument_token: number;
  product: string;
  average_price: number;
  quantity: number;
  fill_timestamp: string;
  exchange_timestamp: string;
  transaction_type: string;
}

@Injectable({
  providedIn: 'root'
})
export class ZerodhaService {
  private apiUrl = window.location.port === '4200'
    ? 'http://localhost:3000/api'
    : '/api';
  private socket: Socket;
  
  private tradeUpdateSubject = new Subject<ZerodhaTrade>();
  tradeUpdate$ = this.tradeUpdateSubject.asObservable();
  
  private connectionStatusSubject = new Subject<boolean>();
  connectionStatus$ = this.connectionStatusSubject.asObservable();

  private serverConnectedSubject = new BehaviorSubject<boolean>(false);
  serverConnected$ = this.serverConnectedSubject.asObservable();

  constructor(private http: HttpClient, private ngZone: NgZone) {
    const socketUrl = window.location.port === '4200'
      ? 'http://localhost:3000'
      : window.location.origin;
    this.socket = io(socketUrl);
    
    this.socket.on('connect', () => {
      console.log('Connected to backend WebSocket');
      this.ngZone.run(() => {
        this.serverConnectedSubject.next(true);
      });
    });

    this.socket.on('disconnect', () => {
      console.log('Disconnected from backend WebSocket');
      this.ngZone.run(() => {
        this.serverConnectedSubject.next(false);
        this.connectionStatusSubject.next(false); // If server is down, ticker is down too
      });
    });
    
    this.socket.on('ticker_status', (status: { connected: boolean }) => {
      this.ngZone.run(() => {
        this.connectionStatusSubject.next(status.connected);
      });
    });

    this.socket.on('trade_update', (order: any) => {
      this.ngZone.run(() => {
        this.tradeUpdateSubject.next(order as ZerodhaTrade);
      });
    });
  }

  ping(): Observable<any> {
    return this.http.get(`${this.apiUrl}/ping`);
  }

  getKeepaliveStatus(): Observable<{ enabled: boolean; supported: boolean }> {
    return this.http.get<{ enabled: boolean; supported: boolean }>(`${this.apiUrl}/keepalive/status`);
  }

  startKeepalive(): Observable<{ enabled: boolean; supported: boolean }> {
    return this.http.post<{ enabled: boolean; supported: boolean }>(`${this.apiUrl}/keepalive/start`, {});
  }

  stopKeepalive(): Observable<{ enabled: boolean; supported: boolean }> {
    return this.http.post<{ enabled: boolean; supported: boolean }>(`${this.apiUrl}/keepalive/stop`, {});
  }

  getLoginUrl(): Observable<{ loginUrl: string }> {
    return this.http.get<{ loginUrl: string }>(`${this.apiUrl}/auth/url`);
  }

  checkAuthStatus(): Observable<{ loggedIn: boolean }> {
    return this.http.get<{ loggedIn: boolean }>(`${this.apiUrl}/auth/status`);
  }

  getHistoricalTrades(startDate?: string, endDate?: string): Observable<ZerodhaTrade[]> {
    let url = `${this.apiUrl}/trades`;
    const params: string[] = [];
    if (startDate) params.push(`startDate=${startDate}`);
    if (endDate) params.push(`endDate=${endDate}`);
    if (params.length > 0) {
      url += `?${params.join('&')}`;
    }
    return this.http.get<ZerodhaTrade[]>(url);
  }
}
