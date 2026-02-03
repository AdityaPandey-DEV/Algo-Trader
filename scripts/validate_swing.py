
import os
import json
from typing import List, Dict, Tuple
from datetime import datetime

# ============================================
# SWING TRADING CONFIG (Daily Bars)
# ============================================
INITIAL_CAPITAL = 500000
RISK_PER_TRADE = 0.01  # Increased for Swing
DATA_DIR = "data/tv_data_daily"
STT = 0.001  # 0.1% for Delivery
BROKERAGE = 0  # Zero for delivery on many brokers
SLIPPAGE_PCT = 0.002 # 0.2% for larger delivery spreads
EMA_FAST = 20
EMA_SLOW = 50
TRAILING_ATR_MULT = 2.5 # Wider for swing

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

def process_symbol_swing(symbol: str) -> Dict:
    file_path = os.path.join(DATA_DIR, f"{symbol}.json")
    if not os.path.exists(file_path): return None
    with open(file_path, 'r') as f:
        data = json.load(f)
    
    # Daily data is usually a simple list, not nested by day
    candles = data if isinstance(data, list) else data.get('candles', [])
    if not candles: return None
    
    trades, wins = 0, 0
    pnl, gross_profit, gross_loss = 0, 0, 0
    equity = INITIAL_CAPITAL
    
    in_position = False
    entry_price = 0
    stop_loss = 0
    qty = 0
    trend = ""
    
    for i in range(EMA_SLOW + 5, len(candles)):
        curr = candles[i]
        
        if not in_position:
            # Entry Logic (8-Filter Logic Simplified for Daily)
            lookback = candles[i-EMA_SLOW:i+1]
            closes = [c['close'] for c in lookback]
            fast_ema = calculate_ema(closes, EMA_FAST)
            slow_ema = calculate_ema(closes, EMA_SLOW)
            atr = calculate_atr(lookback)
            
            # Trend Check
            if fast_ema > slow_ema and curr['close'] > fast_ema:
                # UP Trend Potential
                # Pullback: price dipped near fast EMA in last 3 days
                recent_low = min(c['low'] for c in candles[i-3:i])
                if recent_low < fast_ema:
                    in_position = True
                    trend = "UP"
                    entry_price = curr['close'] * (1 + SLIPPAGE_PCT)
                    stop_loss = entry_price - atr * 2.0
                    risk = entry_price - stop_loss
                    qty = int((equity * RISK_PER_TRADE) / risk) if risk > 0 else 0
                    if qty <= 0: in_position = False
            
            elif fast_ema < slow_ema and curr['close'] < fast_ema:
                # DOWN Trend Potential (Shorting - if allowed)
                pass 

        else:
            # Management Logic
            lookback = candles[i-14:i+1]
            atr = calculate_atr(lookback)
            
            # Trail Stop
            if trend == "UP":
                if curr['high'] > entry_price + atr * TRAILING_ATR_MULT:
                    stop_loss = max(stop_loss, curr['high'] - atr * TRAILING_ATR_MULT)
                
                # Check Exit
                if curr['low'] <= stop_loss:
                    exit_price = min(stop_loss, curr['open'])
                    net_pnl = (exit_price - entry_price) * qty
                    costs = (entry_price + exit_price) * qty * STT
                    net = net_pnl - costs
                    
                    trades += 1
                    pnl += net
                    equity += net
                    if net > 0:
                        wins += 1
                        gross_profit += net
                    else:
                        gross_loss += abs(net)
                    in_position = False
            
    return {
        'symbol': symbol, 'trades': trades, 'wins': wins, 'pnl': pnl, 
        'gross_profit': gross_profit, 'gross_loss': gross_loss, 'equity': equity
    }

def main():
    symbols = [f.replace('.json', '') for f in os.listdir(DATA_DIR) if f.endswith('.json')]
    results = []
    print(f"Testing SWING Strategy on {len(symbols)} symbols...")
    for s in sorted(symbols):
        res = process_symbol_swing(s)
        if res: results.append(res)
    
    total_pnl = sum(r['pnl'] for r in results)
    total_trades = sum(r['trades'] for r in results)
    total_wins = sum(r['wins'] for r in results)
    total_gp = sum(r['gross_profit'] for r in results)
    total_gl = sum(r['gross_loss'] for r in results)
    
    print("\n" + "="*40)
    print("SWING TRADING PERFORMANCE (DAILY BARS)")
    print("="*40)
    print(f"Total Trades:  {total_trades}")
    print(f"Win Rate:      {(total_wins/total_trades*100) if total_trades > 0 else 0:.1f}%")
    print(f"Gross Profit:  ₹{total_gp:,.0f}")
    print(f"Gross Loss:   -₹{total_gl:,.0f}")
    print(f"Net P&L:       ₹{total_pnl:,.0f}")
    print(f"Profit Factor: {(total_gp/total_gl) if total_gl > 0 else 0:.2f}")

if __name__ == "__main__":
    main()
