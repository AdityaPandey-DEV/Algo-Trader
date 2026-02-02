
import os
import json
from typing import List, Dict, Tuple
from datetime import datetime

# ============================================
# BASE CONFIG (Before Upgrades)
# ============================================
INITIAL_CAPITAL = 500000
RISK_PER_TRADE = 0.003
DATA_DIR = "data/tv_data_15min"
STT = 0.00025
BROKERAGE = 20
SLIPPAGE_PCT = 0.0005
EMA_FAST = 13
EMA_SLOW = 34

def calculate_ema(prices: List[float], period: int) -> float:
    if not prices or len(prices) < period: return 0
    k = 2 / (period + 1)
    ema = prices[0]
    for p in prices[1:]:
        ema = (p * k) + (ema * (1 - k))
    return ema

def calculate_atr(candles: List[Dict], period: int = 14) -> float:
    if len(candles) < period + 1: return 0
    tr_sum = 0
    for i in range(1, len(candles)):
        h, l, pc = candles[i]['high'], candles[i]['low'], candles[i-1]['close']
        tr = max(h - l, abs(h - pc), abs(l - pc))
        tr_sum += tr
    return tr_sum / (len(candles) - 1)

def process_symbol_base(symbol: str) -> Dict:
    file_path = os.path.join(DATA_DIR, f"{symbol}.json")
    if not os.path.exists(file_path): return None
    with open(file_path, 'r') as f:
        data = json.load(f)
    
    days_data = data.get('days', {})
    sorted_days = sorted(days_data.keys())
    
    all_candles = []
    day_indices = []
    for dk in sorted_days:
        s = len(all_candles)
        all_candles.extend(days_data[dk])
        day_indices.append((s, len(all_candles), dk))
    
    trades, wins = 0, 0
    pnl, gross_profit, gross_loss = 0, 0, 0
    equity = INITIAL_CAPITAL
    
    for d_start, d_end, dk in day_indices:
        day_candles = all_candles[d_start:d_end]
        if len(day_candles) < 20: continue
        
        for i in range(len(day_candles) - 1):
            g_idx = d_start + i
            if g_idx < 40: continue
            
            lookback = all_candles[g_idx-40:g_idx+1]
            closes = [c['close'] for c in lookback]
            fast_ema = calculate_ema(closes, EMA_FAST)
            slow_ema = calculate_ema(closes, EMA_SLOW)
            last_close = closes[-1]
            
            # Simple Entry - NO FILTERS
            trend = 'UP' if fast_ema > slow_ema else 'DOWN'
            entry_price = last_close
            
            # Simple Stop - 1.5 ATR
            atr = calculate_atr(lookback)
            if atr <= 0: continue
            stop = entry_price - atr * 2.0 if trend == 'UP' else entry_price + atr * 2.0
            risk = abs(entry_price - stop)
            if risk <= 0: continue
            
            # Position
            qty = int((equity * RISK_PER_TRADE) / risk)
            if qty <= 0: continue
            
            # Exit at EOD (Simple)
            exit_price = day_candles[-1]['close']
            
            # PnL
            trade_pnl = (exit_price - entry_price) * qty if trend == 'UP' else (entry_price - exit_price) * qty
            sell_val = exit_price * qty if trend == 'UP' else entry_price * qty
            costs = (BROKERAGE * 2) + (sell_val * STT) + (entry_price * qty * SLIPPAGE_PCT)
            net = trade_pnl - costs
            
            trades += 1
            pnl += net
            equity += net
            if net > 0:
                wins += 1
                gross_profit += net
            else:
                gross_loss += abs(net)
            
            break # One trade per day per symbol for base test
            
    return {
        'trades': trades, 'wins': wins, 'pnl': pnl, 
        'gross_profit': gross_profit, 'gross_loss': gross_loss
    }

def main():
    symbols = [f.replace('.json', '') for f in os.listdir(DATA_DIR) if f.endswith('.json')]
    results = []
    print(f"Benchmarking {len(symbols)} symbols...")
    for s in sorted(symbols):
        res = process_symbol_base(s)
        if res: results.append(res)
    
    tp = sum(r['pnl'] for r in results)
    tw = sum(r['wins'] for r in results)
    tt = sum(r['trades'] for r in results)
    tgp = sum(r['gross_profit'] for r in results)
    tgl = sum(r['gross_loss'] for r in results)
    
    print("\n" + "="*30)
    print("BASE STRATEGY (BEFORE 8 FILTERS)")
    print("="*30)
    print(f"Total Trades: {tt}")
    print(f"Gross Profit: ₹{tgp:,.0f}")
    print(f"Gross Loss:  -₹{tgl:,.0f}")
    print(f"Net P&L:      ₹{tp:,.0f}")
    print(f"Profit Factor: {(tgp/tgl) if tgl > 0 else 0:.2f}")

if __name__ == "__main__":
    main()
