#!/usr/bin/env python3
"""
Intraday Strategy Validator - Local Script
Tests upgraded strategy on 5-minute TradingView data without serverless timeout
"""

import json
import os
from datetime import datetime
from typing import List, Dict, Tuple

# Configuration
INITIAL_CAPITAL = 500000
RISK_PER_TRADE = 0.003  # 0.3%
MAX_TRADES_PER_DAY = 2
SLIPPAGE_PCT = 0.0005
BROKERAGE = 20
STT = 0.001

EMA_FAST = 13
EMA_SLOW = 34
PULLBACK_ATR = 2.0
TRAILING_ATR_MULT = 1.5

DATA_DIR = "data/tv_data"

def calculate_ema(prices: List[float], period: int) -> float:
    """Calculate EMA for given period"""
    if len(prices) < period:
        return 0
    
    multiplier = 2 / (period + 1)
    ema = sum(prices[:period]) / period
    
    for price in prices[period:]:
        ema = (price - ema) * multiplier + ema
    
    return ema

def calculate_atr(candles: List[Dict], period: int = 14) -> float:
    """Calculate Average True Range"""
    if len(candles) < 2:
        return 0
    
    true_ranges = []
    for i in range(1, len(candles)):
        high = candles[i]['high']
        low = candles[i]['low']
        prev_close = candles[i-1]['close']
        
        tr = max(
            high - low,
            abs(high - prev_close),
            abs(low - prev_close)
        )
        true_ranges.append(tr)
    
    if len(true_ranges) < period:
        return sum(true_ranges) / len(true_ranges) if true_ranges else 0
    
    return sum(true_ranges[-period:]) / period

def detect_trend(candles: List[Dict]) -> str:
    """Detect trend: UP, DOWN, or NEUTRAL"""
    if len(candles) < EMA_SLOW + 5:
        return 'NEUTRAL'
    
    closes = [c['close'] for c in candles]
    fast_ema = calculate_ema(closes, EMA_FAST)
    slow_ema = calculate_ema(closes, EMA_SLOW)
    current_close = closes[-1]
    
    if fast_ema > slow_ema and current_close > slow_ema:
        return 'UP'
    elif fast_ema < slow_ema and current_close < slow_ema:
        return 'DOWN'
    return 'NEUTRAL'

def process_symbol(symbol: str) -> Dict:
    """Process one symbol and return results"""
    print(f"\nProcessing {symbol}...")
    
    file_path = os.path.join(DATA_DIR, f"{symbol}.json")
    if not os.path.exists(file_path):
        print(f"  ❌ File not found: {file_path}")
        return None
    
    # Load data
    with open(file_path, 'r') as f:
        data = json.load(f)
    
    days_data = data.get('days', {})
    sorted_days = sorted(days_data.keys())
    
    print(f"  📅 {len(sorted_days)} trading days")
    
    # Process each day
    trades = 0
    wins = 0
    pnl = 0
    equity = INITIAL_CAPITAL
    peak = INITIAL_CAPITAL
    max_dd = 0
    daily_returns = {}
    
    for day_key in sorted_days:
        day_candles = days_data[day_key]
        
        if len(day_candles) < 75:
            continue
        
        day_trades = 0
        
        for i in range(EMA_SLOW + 30, len(day_candles) - 5):
            if day_trades >= MAX_TRADES_PER_DAY:
                break
            
            lookback = day_candles[max(0, i - 60):i + 1]
            trend = detect_trend(lookback)
            
            if trend == 'NEUTRAL':
                continue
            
            # Entry
            last_candle = day_candles[i]
            entry = last_candle['close']
            slip = entry * SLIPPAGE_PCT
            entry_price = entry + slip if trend == 'UP' else entry - slip
            
            # Stop loss
            atr = calculate_atr(lookback)
            swing_high = max(c['high'] for c in lookback[-10:])
            swing_low = min(c['low'] for c in lookback[-10:])
            
            stop = swing_low - atr * 0.5 if trend == 'UP' else swing_high + atr * 0.5
            risk = abs(entry_price - stop)
            
            if risk <= 0:
                continue
            
            # Position sizing
            risk_amount = equity * RISK_PER_TRADE
            qty = int(risk_amount / risk)
            
            if qty <= 0:
                continue
            
            # Find exit with trailing stop
            exit_price = day_candles[-1]['close']
            trailing_stop = stop
            trail_dist = atr * TRAILING_ATR_MULT
            
            for j in range(i + 1, min(i + 40, len(day_candles))):
                c = day_candles[j]
                
                if trend == 'UP':
                    if c['high'] > entry_price + trail_dist:
                        trailing_stop = max(trailing_stop, c['high'] - trail_dist)
                    if c['low'] <= trailing_stop:
                        exit_price = max(trailing_stop, c['open']) - slip
                        break
                else:
                    if c['low'] < entry_price - trail_dist:
                        trailing_stop = min(trailing_stop, c['low'] + trail_dist)
                    if c['high'] >= trailing_stop:
                        exit_price = min(trailing_stop, c['open']) + slip
                        break
            
            # Calculate P&L
            trade_pnl = (exit_price - entry_price) * qty if trend == 'UP' else (entry_price - exit_price) * qty
            costs = BROKERAGE * 2 + abs(trade_pnl) * STT
            net = trade_pnl - costs
            
            trades += 1
            day_trades += 1
            pnl += net
            equity += net
            
            if equity > peak:
                peak = equity
            dd = (peak - equity) / peak
            if dd > max_dd:
                max_dd = dd
            
            if net > 0:
                wins += 1
            
            daily_returns[day_key] = daily_returns.get(day_key, 0) + net
    
    # Calculate metrics
    win_rate = (wins / trades * 100) if trades > 0 else 0
    total_return = (pnl / INITIAL_CAPITAL * 100)
    avg_trade = pnl / trades if trades > 0 else 0
    
    print(f"  ✅ Trades: {trades}, Win Rate: {win_rate:.1f}%, PnL: ₹{pnl:,.0f}, Return: {total_return:.1f}%")
    
    return {
        'symbol': symbol,
        'trades': trades,
        'wins': wins,
        'win_rate': win_rate,
        'pnl': pnl,
        'total_return': total_return,
        'max_dd': max_dd * 100,
        'avg_trade': avg_trade,
        'trading_days': len(daily_returns)
    }

def main():
    """Main validation function"""
    print("=" * 60)
    print("UPGRADED STRATEGY VALIDATION - INTRADAY DATA")
    print("=" * 60)
    print(f"\nCapital: ₹{INITIAL_CAPITAL:,}")
    print(f"Risk per trade: {RISK_PER_TRADE * 100}%")
    print(f"Max trades/day: {MAX_TRADES_PER_DAY}")
    print(f"Strategy: EMA {EMA_FAST}/{EMA_SLOW} with trailing stops")
    
    # Get all symbols
    symbols = [f.replace('.json', '') for f in os.listdir(DATA_DIR) 
               if f.endswith('.json') and f != 'summary.json']
    
    print(f"\nProcessing {len(symbols)} symbols...")
    
    # Process all symbols
    results = []
    for symbol in sorted(symbols):
        result = process_symbol(symbol)
        if result:
            results.append(result)
    
    # Aggregate results
    print("\n" + "=" * 60)
    print("AGGREGATE RESULTS")
    print("=" * 60)
    
    total_trades = sum(r['trades'] for r in results)
    total_wins = sum(r['wins'] for r in results)
    total_pnl = sum(r['pnl'] for r in results)
    avg_win_rate = sum(r['win_rate'] for r in results) / len(results) if results else 0
    max_dd = max(r['max_dd'] for r in results) if results else 0
    
    print(f"\nTotal Trades: {total_trades}")
    print(f"Total Wins: {total_wins}")
    print(f"Win Rate: {(total_wins / total_trades * 100) if total_trades > 0 else 0:.1f}%")
    print(f"Total P&L: ₹{total_pnl:,.0f}")
    print(f"Total Return: {(total_pnl / INITIAL_CAPITAL * 100):.1f}%")
    print(f"Max Drawdown: {max_dd:.1f}%")
    print(f"Avg Trade: ₹{(total_pnl / total_trades) if total_trades > 0 else 0:,.0f}")
    
    # Top performers
    print("\n" + "-" * 60)
    print("TOP 5 PERFORMERS")
    print("-" * 60)
    top_5 = sorted(results, key=lambda x: x['total_return'], reverse=True)[:5]
    for r in top_5:
        print(f"{r['symbol']:12} | Trades: {r['trades']:3} | Return: {r['total_return']:6.1f}% | Win Rate: {r['win_rate']:5.1f}%")
    
    print("\n✅ Validation complete!")

if __name__ == "__main__":
    main()
