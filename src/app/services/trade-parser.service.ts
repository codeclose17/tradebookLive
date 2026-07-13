import { Injectable } from '@angular/core';
import * as xlsx from 'xlsx';

export interface RawTrade {
  symbol: string;
  tradeType: 'buy' | 'sell';
  qty: number;
  price: number;
  time: string;
}

export interface TradePair {
  symbol: string;
  entryTime: string;
  exitTime: string | null;
  type: 'Long' | 'Short';
  qty: number;
  capitalUsed: number;
  pnl: number;
  isOpen: boolean;
  isTimeExact?: boolean;
}

export interface DailyStat {
  date: string; // ISO date format like '2026-04-02'
  numberOfTrades: number;
  totalCharges: number;
  grossPnL: number;
  netPnL: number;
  tradePairs: TradePair[];
}

@Injectable({
  providedIn: 'root'
})
export class TradeParserService {
  private readonly CHARGE_PER_TRADE = 18;

  constructor() { }

  parseZerodhaApiTrades(trades: any[]): Map<string, DailyStat> {
    const stats = new Map<string, DailyStat>();
    const rawTradesPerDay = new Map<string, RawTrade[]>();

    for (const t of trades) {
      if (!t.fill_timestamp && !t.exchange_timestamp) continue;
      
      const timestamp = t.fill_timestamp || t.exchange_timestamp;
      let dateKey: string;
      let timeStr: string;

      // kiteconnect SDK returns Date objects, not strings
      if (timestamp instanceof Date) {
        const year = timestamp.getFullYear();
        const month = String(timestamp.getMonth() + 1).padStart(2, '0');
        const day = String(timestamp.getDate()).padStart(2, '0');
        dateKey = `${year}-${month}-${day}`;
        timeStr = timestamp.toISOString();
      } else {
        timeStr = String(timestamp);
        // Handle "YYYY-MM-DD HH:mm:ss" or ISO "YYYY-MM-DDTHH:mm:ss"
        dateKey = timeStr.split(' ')[0].split('T')[0];
      }

      if (!dateKey || dateKey.length < 8) continue;

      const symbol = t.tradingsymbol;
      if (!this.isOption(symbol)) continue;

      const tradeType = String(t.transaction_type).toLowerCase().trim();
      const qty = Number(t.quantity);
      const price = Number(t.average_price);

      if (isNaN(qty) || isNaN(price)) continue;
      if (tradeType !== 'buy' && tradeType !== 'sell') continue;

      const tradeValue = qty * price;
      
      let stat = this.getOrCreateDailyStat(stats, dateKey);
      stat.numberOfTrades += 1;

      if (tradeType === 'buy') {
        stat.grossPnL -= tradeValue;
      } else if (tradeType === 'sell') {
        stat.grossPnL += tradeValue;
      }

      if (!rawTradesPerDay.has(dateKey)) {
        rawTradesPerDay.set(dateKey, []);
      }
      
      rawTradesPerDay.get(dateKey)!.push({
        symbol,
        tradeType: tradeType as 'buy' | 'sell',
        qty,
        price,
        time: timeStr
      });
    }

    stats.forEach((stat, dateKey) => {
      const dayTrades = rawTradesPerDay.get(dateKey) || [];
      stat.tradePairs = this.matchTradePairs(dayTrades);
      
      let dayCharges = 0;
      stat.tradePairs.forEach(pair => {
        const entryPrice = pair.qty ? pair.capitalUsed / pair.qty : 0;
        let exitPrice = 0;
        if (pair.qty) {
          if (pair.type === 'Long') {
             exitPrice = (pair.pnl / pair.qty) + entryPrice;
          } else {
             exitPrice = entryPrice - (pair.pnl / pair.qty);
          }
        }
        
        const calculatedCharge = this.calculateActualCharges({
          symbol: pair.symbol,
          type: pair.type,
          qty: pair.qty,
          entryPrice,
          exitPrice: pair.isOpen ? null : exitPrice,
          isOpen: pair.isOpen
        });
        
        (pair as any).actualCharges = calculatedCharge;
        dayCharges += calculatedCharge;
      });
      
      stat.totalCharges = Math.round(dayCharges * 100) / 100;
      stat.netPnL = stat.grossPnL - stat.totalCharges;
    });

    return stats;
  }

  parseTradebook(buffer: ArrayBuffer): Map<string, DailyStat> {
    const workbook = xlsx.read(buffer, { type: 'array' });
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    
    const rawData: any[][] = xlsx.utils.sheet_to_json(worksheet, { header: 1 });
    
    // Detect Broker Format
    let format: 'zerodha' | 'groww' | 'unknown' = 'unknown';
    let headerRowIndex = -1;

    for (let i = 0; i < Math.min(50, rawData.length); i++) {
      const row = rawData[i];
      if (!row) continue;
      
      const rowStr = row.map(cell => String(cell).trim()).join(',');
      if (rowStr.includes('Symbol') && rowStr.includes('Trade Date') && rowStr.includes('Trade Type')) {
        format = 'zerodha';
        headerRowIndex = i;
        break;
      }
      // Groww headers could be under 'Futures' or 'Options' blocks
      if (rowStr.includes('Scrip Name') && rowStr.includes('Buy Date') && rowStr.includes('Sell Date') && rowStr.includes('Realized P&L')) {
        format = 'groww';
        // For groww we just parse the whole file for these blocks, so we just break
        break;
      }
    }

    if (format === 'zerodha') {
      return this.parseZerodhaTradebook(rawData, headerRowIndex);
    } else if (format === 'groww') {
      return this.parseGrowwTradebook(rawData);
    } else {
      throw new Error('Could not detect the tradebook format. Please make sure the uploaded file is a valid Zerodha or Groww F&O report.');
    }
  }

  private parseZerodhaTradebook(rawData: any[][], headerRowIndex: number): Map<string, DailyStat> {
    const headers = rawData[headerRowIndex];
    const symbolIndex = headers.indexOf('Symbol');
    const dateIndex = headers.indexOf('Trade Date');
    const typeIndex = headers.indexOf('Trade Type');
    const qtyIndex = headers.indexOf('Quantity');
    const priceIndex = headers.indexOf('Price');
    const timeIndex = headers.indexOf('Order Execution Time');

    const stats = new Map<string, DailyStat>();
    const rawTradesPerDay = new Map<string, RawTrade[]>();

    for (let i = headerRowIndex + 1; i < rawData.length; i++) {
      const row = rawData[i];
      if (!row || row.length === 0 || !row[dateIndex]) continue;

      const tradeDateStr = row[dateIndex];
      const dateKey = String(tradeDateStr).trim();
      if (!dateKey) continue;

      const symbol = String(row[symbolIndex]).trim();
      if (!this.isOption(symbol)) continue;

      const tradeType = String(row[typeIndex]).toLowerCase().trim();
      const qty = Number(row[qtyIndex]);
      const price = Number(row[priceIndex]);
      const time = String(row[timeIndex]).trim();

      if (isNaN(qty) || isNaN(price)) continue;
      if (tradeType !== 'buy' && tradeType !== 'sell') continue;

      const tradeValue = qty * price;
      
      let stat = this.getOrCreateDailyStat(stats, dateKey);
      stat.numberOfTrades += 1;

      if (tradeType === 'buy') {
        stat.grossPnL -= tradeValue;
      } else if (tradeType === 'sell') {
        stat.grossPnL += tradeValue;
      }

      if (!rawTradesPerDay.has(dateKey)) {
        rawTradesPerDay.set(dateKey, []);
      }
      
      rawTradesPerDay.get(dateKey)!.push({
        symbol,
        tradeType: tradeType as 'buy' | 'sell',
        qty,
        price,
        time
      });
    }

    stats.forEach((stat, dateKey) => {
      const dayTrades = rawTradesPerDay.get(dateKey) || [];
      stat.tradePairs = this.matchTradePairs(dayTrades);
      
      let dayCharges = 0;
      stat.tradePairs.forEach(pair => {
        const entryPrice = pair.qty ? pair.capitalUsed / pair.qty : 0;
        let exitPrice = 0;
        if (pair.qty) {
          if (pair.type === 'Long') {
             exitPrice = (pair.pnl / pair.qty) + entryPrice;
          } else {
             exitPrice = entryPrice - (pair.pnl / pair.qty);
          }
        }
        
        const calculatedCharge = this.calculateActualCharges({
          symbol: pair.symbol,
          type: pair.type,
          qty: pair.qty,
          entryPrice,
          exitPrice: pair.isOpen ? null : exitPrice,
          isOpen: pair.isOpen
        });
        
        (pair as any).actualCharges = calculatedCharge;
        dayCharges += calculatedCharge;
      });
      
      stat.totalCharges = Math.round(dayCharges * 100) / 100;
      stat.netPnL = stat.grossPnL - stat.totalCharges;
    });

    return stats;
  }

  private parseGrowwTradebook(rawData: any[][]): Map<string, DailyStat> {
    const stats = new Map<string, DailyStat>();

    let scripIndex = -1, qtyIndex = -1, buyDateIndex = -1, buyPriceIndex = -1, buyValueIndex = -1;
    let sellDateIndex = -1, sellPriceIndex = -1, sellValueIndex = -1, pnlIndex = -1;
    let inDataBlock = false;

    // Helper to format '28 Jul 2025' to '2025-07-28' for dateKey
    const formatGrowwDate = (dateStr: string) => {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return null;
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    for (let i = 0; i < rawData.length; i++) {
      const row = rawData[i];
      if (!row || row.length === 0) continue;

      const rowStr = row.map(cell => String(cell).trim()).join(',');

      // Detect header row for a block of trades
      if (rowStr.includes('Scrip Name') && rowStr.includes('Buy Date') && rowStr.includes('Sell Date') && rowStr.includes('Realized P&L')) {
        inDataBlock = true;
        scripIndex = row.indexOf('Scrip Name');
        qtyIndex = row.indexOf('Quantity');
        buyDateIndex = row.indexOf('Buy Date');
        buyPriceIndex = row.indexOf('Buy Price');
        buyValueIndex = row.indexOf('Buy Value');
        sellDateIndex = row.indexOf('Sell Date');
        sellPriceIndex = row.indexOf('Sell Price');
        sellValueIndex = row.indexOf('Sell Value');
        pnlIndex = row.indexOf('Realized P&L');
        continue;
      }

      // If we hit an empty row or a row that starts with total/summary, stop the block
      if (inDataBlock && (!row[scripIndex] || String(row[scripIndex]).trim() === '')) {
        inDataBlock = false;
        continue;
      }

      if (inDataBlock) {
        const symbol = String(row[scripIndex]).trim();
        if (!this.isOption(symbol)) continue;

        const qty = Number(row[qtyIndex]);
        const buyDateRaw = String(row[buyDateIndex]).trim();
        const buyPrice = Number(row[buyPriceIndex]);
        const sellDateRaw = String(row[sellDateIndex]).trim();
        const sellPrice = Number(row[sellPriceIndex]);
        const realizedPnL = Number(row[pnlIndex]);

        if (isNaN(qty)) continue;

        // Determine which date is the exit date (later date)
        const buyTime = new Date(buyDateRaw).getTime();
        const sellTime = new Date(sellDateRaw).getTime();
        
        const exitDateRaw = sellTime >= buyTime ? sellDateRaw : buyDateRaw;
        const dateKey = formatGrowwDate(exitDateRaw);
        if (!dateKey) continue;

        const isShort = sellTime < buyTime;
        const entryDateRaw = isShort ? sellDateRaw : buyDateRaw;

        let stat = this.getOrCreateDailyStat(stats, dateKey);

        // Treat 1 pair as 2 trades (buy + sell) for charges
        stat.numberOfTrades += 2;
        const charges = this.CHARGE_PER_TRADE * 2;
        stat.totalCharges += charges;

        // Groww gives us Realized P&L directly
        stat.grossPnL += realizedPnL;
        stat.netPnL += (realizedPnL - charges); // Apply charges to net

        // Add to trade pairs
        stat.tradePairs.push({
          symbol,
          entryTime: entryDateRaw,
          exitTime: exitDateRaw,
          type: isShort ? 'Short' : 'Long',
          qty,
          capitalUsed: isShort ? (sellPrice * qty) : (buyPrice * qty),
          pnl: realizedPnL,
          isOpen: false,
          isTimeExact: false // Flag to let UI know time is not exact
        });
      }
    }

    // Sort pairs by date within each day
    stats.forEach(stat => {
      stat.tradePairs.sort((a, b) => new Date(a.entryTime).getTime() - new Date(b.entryTime).getTime());
    });

    return stats;
  }

  private getOrCreateDailyStat(stats: Map<string, DailyStat>, dateKey: string): DailyStat {
    let stat = stats.get(dateKey);
    if (!stat) {
      stat = {
        date: dateKey,
        numberOfTrades: 0,
        totalCharges: 0,
        grossPnL: 0,
        netPnL: 0,
        tradePairs: []
      };
      stats.set(dateKey, stat);
    }
    return stat;
  }

  private matchTradePairs(trades: RawTrade[]): TradePair[] {
    const pairs: TradePair[] = [];
    const tradesBySymbol = new Map<string, RawTrade[]>();

    trades.forEach(t => {
      if (!tradesBySymbol.has(t.symbol)) {
        tradesBySymbol.set(t.symbol, []);
      }
      tradesBySymbol.get(t.symbol)!.push({ ...t });
    });

    tradesBySymbol.forEach((symbolTrades, symbol) => {
      symbolTrades.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

      const buys = symbolTrades.filter(t => t.tradeType === 'buy');
      const sells = symbolTrades.filter(t => t.tradeType === 'sell');

      while (buys.length > 0 && sells.length > 0) {
        const buy = buys[0];
        const sell = sells[0];

        const matchedQty = Math.min(buy.qty, sell.qty);
        const isLong = new Date(buy.time).getTime() <= new Date(sell.time).getTime();
        const entryPrice = isLong ? buy.price : sell.price;
        const capitalUsed = entryPrice * matchedQty;
        const pnl = isLong 
          ? (sell.price - buy.price) * matchedQty
          : (buy.price - sell.price) * matchedQty;

        pairs.push({
          symbol,
          entryTime: isLong ? buy.time : sell.time,
          exitTime: isLong ? sell.time : buy.time,
          type: isLong ? 'Long' : 'Short',
          qty: matchedQty,
          capitalUsed,
          pnl,
          isOpen: false,
          isTimeExact: true
        });

        buy.qty -= matchedQty;
        sell.qty -= matchedQty;

        if (buy.qty === 0) buys.shift();
        if (sell.qty === 0) sells.shift();
      }

      const remaining = [...buys, ...sells];
      remaining.forEach(t => {
        pairs.push({
          symbol,
          entryTime: t.time,
          exitTime: null,
          type: t.tradeType === 'buy' ? 'Long' : 'Short',
          qty: t.qty,
          capitalUsed: t.price * t.qty,
          pnl: 0,
          isOpen: true,
          isTimeExact: true
        });
      });
    });

    const groupedPairs = new Map<string, TradePair>();
    
    for (const pair of pairs) {
      const key = `${pair.symbol}_${pair.entryTime}_${pair.type}`;
      if (groupedPairs.has(key)) {
        const existing = groupedPairs.get(key)!;
        existing.qty += pair.qty;
        existing.capitalUsed += pair.capitalUsed;
        existing.pnl += pair.pnl;
        
        if (pair.exitTime) {
          if (!existing.exitTime || new Date(pair.exitTime).getTime() > new Date(existing.exitTime).getTime()) {
            existing.exitTime = pair.exitTime;
          }
        }
        
        existing.isOpen = existing.isOpen || pair.isOpen;
      } else {
        groupedPairs.set(key, { ...pair });
      }
    }

    const consolidatedPairs = Array.from(groupedPairs.values());
    consolidatedPairs.sort((a, b) => new Date(a.entryTime).getTime() - new Date(b.entryTime).getTime());
    
    return consolidatedPairs;
  }

  isOption(symbol: string): boolean {
    const s = symbol.toUpperCase().trim();
    return s.endsWith('CE') || s.endsWith('PE') || s.includes(' CE') || s.includes(' PE');
  }

  calculateActualCharges(pair: {
    symbol: string;
    type: 'Long' | 'Short';
    qty: number;
    entryPrice: number;
    exitPrice: number | null;
    isOpen: boolean;
  }): number {
    const isOpt = this.isOption(pair.symbol);
    if (!isOpt) {
      // For non-options (like Futures), fall back to flat charge estimation
      return (pair.isOpen ? 18 : 36);
    }

    const buyPrice = pair.type === 'Long' ? pair.entryPrice : (pair.exitPrice || 0);
    const sellPrice = pair.type === 'Short' ? pair.entryPrice : (pair.exitPrice || 0);

    const buyPremium = buyPrice * pair.qty;
    const sellPremium = sellPrice * pair.qty;

    // 1. Brokerage: ₹20 per executed order (buy or sell)
    let brokerage = 20; 
    if (!pair.isOpen) {
      brokerage += 20;
    }

    // 2. STT (Securities Transaction Tax): 0.15% on sell side premium
    let stt = 0;
    if (sellPremium > 0) {
      stt = Math.round(0.0015 * sellPremium);
    }

    // 3. Exchange Transaction Charges (NSE Options: 0.03503%)
    let txnCharges = 0;
    if (buyPremium > 0) {
      txnCharges += 0.0003503 * buyPremium;
    }
    if (sellPremium > 0) {
      txnCharges += 0.0003503 * sellPremium;
    }

    // 4. SEBI Charges (₹10 per crore, i.e., 0.0001%)
    const sebi = 0.000001 * (buyPremium + sellPremium);

    // 5. Stamp Duty (0.003% on buy side only)
    let stampDuty = 0;
    if (buyPremium > 0) {
      stampDuty = 0.00003 * buyPremium;
    }

    // 6. GST (18% on Brokerage + Txn Charges + SEBI)
    const gst = 0.18 * (brokerage + txnCharges + sebi);

    const totalCharges = brokerage + stt + txnCharges + sebi + stampDuty + gst;
    return Math.round(totalCharges * 100) / 100;
  }
}
