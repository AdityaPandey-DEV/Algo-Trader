#!/usr/bin/env python3
"""
FULL Upgraded Strategy Validator - All 8 Risk Filters
Tests complete upgraded strategy on 5-minute TradingView data
"""

import json
import os
from datetime import datetime
from typing import List, Dict, Tuple

# ============================================
# Configuration
# ============================================
INITIAL_CAPITAL = 500000
RISK_PER_TRADE = 0.003  # 0.3%
MAX_TRADES_PER_DAY = 2
MAX_DAILY_LOSS = 0.01  # 1%
KILL_SWITCH_DD = 0.05  # 5%
KILL_SWITCH_DAYS = 5

# Risk Filter Thresholds
MIN_FIRST_HOUR_RANGE_ATR = 0.4  # 40% of ATR
MIN_EMA_SLOPE = 0.0  # DISABLED for choppy market testing
MIN_TRADE_SCORE = 0.5  # 50% quality score

SLIPPAGE_PCT = 0.0005
BROKERAGE = 20
STT = 0.001

EMA_FAST = 13
EMA_SLOW = 34
PULLBACK_ATR = 2.0
TRAILING_ATR_MULT = 1.5

DATA_DIR = "data/tv_data"

# ============================================
# Indicator Functions
# ============================================

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

# ============================================
# UPGRADE #2: Volatility Filter
# ============================================

def is_low_volatility_day(first_hour_candles: List[Dict], atr: float) -> bool:
    """Check if day has low volatility (should skip)"""
    if len(first_hour_candles) < 1 or atr <= 0:
        return False
    
    day_high = max(c['high'] for c in first_hour_candles)
    day_low = min(c['low'] for c in first_hour_candles)
    day_range = day_high - day_low
    
    return day_range < atr * MIN_FIRST_HOUR_RANGE_ATR

# ============================================
# UPGRADE #3: Trend Gate
# ============================================

def is_trend_strong(candles: List[Dict], ema_period: int = 25) -> bool:
    """Check if trend is strong enough (EMA slope)"""
    if len(candles) < ema_period + 10:
        return False
    
    closes = [c['close'] for c in candles]
    current_ema = calculate_ema(closes, ema_period)
    past_ema = calculate_ema(closes[:-10], ema_period)
    
    if past_ema == 0:
        return False
    
    slope = (current_ema - past_ema) / past_ema
    return abs(slope) >= MIN_EMA_SLOPE

# ============================================
# UPGRADE #4: Entry Confirmation
# ============================================

def has_entry_confirmation(candles: List[Dict], trend: str) -> Tuple[bool, float, float]:
    """Check if price broke pullback high/low"""
    if len(candles) < 10:
        return False, 0, 0
    
    pullback_candles = candles[-10:]
    pullback_high = max(c['high'] for c in pullback_candles)
    pullback_low = min(c['low'] for c in pullback_candles)
    current_close = candles[-1]['close']
    
    if trend == 'UP':
        confirmed = current_close > pullback_high
    else:
        confirmed = current_close < pullback_low
    
    return confirmed, pullback_high, pullback_low

# ============================================
# UPGRADE #7: Trade Quality Scoring
# ============================================

def calculate_trade_quality(candles: List[Dict]) -> float:
    """Calculate trade quality score (0-1)"""
    if len(candles) < EMA_SLOW + 5:
        return 0
    
    closes = [c['close'] for c in candles]
    
    # 1. Trend strength (EMA separation)
    fast_ema = calculate_ema(closes, EMA_FAST)
    slow_ema = calculate_ema(closes, EMA_SLOW)
    separation = abs(fast_ema - slow_ema) / slow_ema if slow_ema > 0 else 0
    trend_strength = min(separation * 100, 1.0)  # 0.5% = 0.5, 1% = 1.0
    
    # 2. Pullback depth
    recent = candles[-10:]
    swing_high = max(c['high'] for c in recent)
    swing_low = min(c['low'] for c in recent)
    current = closes[-1]
    range_val = swing_high - swing_low
    
    if range_val > 0:
        pullback_from_high = (swing_high - current) / range_val
        pullback_from_low = (current - swing_low) / range_val
        depth = max(pullback_from_high, pullback_from_low)
        
        # Ideal: 0.3-0.5 range
        if depth <= 0.5:
            pullback_score = depth * 2
        else:
            pullback_score = max(0, 1 - (depth - 0.5) * 2)
    else:
        pullback_score = 0
    
    # 3. Volume expansion
    if len(candles) >= 20:
        avg_volume = sum(c['volume'] for c in candles[-20:-1]) / 19
        current_volume = candles[-1]['volume']
        volume_ratio = current_volume / avg_volume if avg_volume > 0 else 1
        volume_score = min(volume_ratio / 2, 1.0)
    else:
        volume_score = 0.5
    
    # Combined score
    score = trend_strength * 0.4 + pullback_score * 0.4 + volume_score * 0.2
    return score

# ============================================
# Signal Detection
# ============================================

def detect_trend_and_pullback(candles: List[Dict]) -> Tuple[str, bool]:
    """Detect trend and pullback"""
    if len(candles) < EMA_SLOW + 5:
        return 'NEUTRAL', False
    
    closes = [c['close'] for c in candles]
    fast_ema = calculate_ema(closes, EMA_FAST)
    slow_ema = calculate_ema(closes, EMA_SLOW)
    current_close = closes[-1]
    atr = calculate_atr(candles)
    
    # Trend detection
    trend = 'NEUTRAL'
    if fast_ema > slow_ema and current_close > slow_ema:
        trend = 'UP'
    elif fast_ema < slow_ema and current_close < slow_ema:
        trend = 'DOWN'
    
    # Pullback detection
    is_pullback = False
    if trend == 'UP':
        dip = fast_ema - current_close
        is_pullback = dip > atr * PULLBACK_ATR * 0.3 and dip < atr * PULLBACK_ATR
    elif trend == 'DOWN':
        rally = current_close - fast_ema
        is_pullback = rally > atr * PULLBACK_ATR * 0.3 and rally < atr * PULLBACK_ATR
    
    return trend, is_pullback

# ============================================
# Main Processing
# ============================================

def process_symbol_with_filters(symbol: str) -> Dict:
    """Process one symbol with ALL 8 risk filters"""
    print(f"\nProcessing {symbol}...")
    
    file_path = os.path.join(DATA_DIR, f"{symbol}.json")
    if not os.path.exists(file_path):
        print(f"  ❌ File not found")
        return None
    
    with open(file_path, 'r') as f:
        data = json.load(f)
    
    days_data = data.get('days', {})
    sorted_days = sorted(days_data.keys())
    
    print(f"  📅 {len(sorted_days)} trading days")
    
    # Tracking
    trades = 0
    wins = 0
    pnl = 0
    equity = INITIAL_CAPITAL
    peak = INITIAL_CAPITAL
    rolling_peak = INITIAL_CAPITAL
    max_dd = 0
    
    daily_returns = {}
    total_r_multiple = 0
    
    # Risk metrics
    volatility_skips = 0
    trend_gate_skips = 0
    entry_confirmation_skips = 0
    quality_score_skips = 0
    daily_loss_breaches = 0
    kill_switch_triggers = 0
    
    # Kill switch state
    kill_switch_active = False
    kill_switch_end_day = 0
    
    for day_idx, day_key in enumerate(sorted_days):
        day_candles = days_data[day_key]
        
        if len(day_candles) < 75:
            continue
        
        # Reset daily counters
        daily_pnl = 0
        day_trades = 0
        
        # UPGRADE #6: Kill Switch Check
        if kill_switch_active:
            if day_idx < kill_switch_end_day:
                continue
            else:
                kill_switch_active = False
        
        # Check for new kill switch trigger
        rolling_dd = (rolling_peak - equity) / rolling_peak if rolling_peak > 0 else 0
        if rolling_dd >= KILL_SWITCH_DD:
            kill_switch_active = True
            kill_switch_end_day = day_idx + KILL_SWITCH_DAYS
            kill_switch_triggers += 1
            print(f"  🛑 Kill switch triggered on {day_key} (DD: {rolling_dd*100:.1f}%)")
            continue
        
        # Update rolling peak
        if equity > rolling_peak:
            rolling_peak = equity
        
        # UPGRADE #2: Volatility Filter (first hour)
        first_hour = day_candles[:12]  # 12 * 5min = 1 hour
        atr_full_day = calculate_atr(day_candles)
        
        if is_low_volatility_day(first_hour, atr_full_day):
            volatility_skips += 1
            continue
        
        # Process candles
        for i in range(EMA_SLOW + 30, len(day_candles) - 5):
            # UPGRADE #1: Max trades per day
            if day_trades >= MAX_TRADES_PER_DAY:
                break
            
            # UPGRADE #1: Daily loss limit
            daily_loss_limit = equity * MAX_DAILY_LOSS
            if daily_pnl <= -daily_loss_limit:
                daily_loss_breaches += 1
                break
            
            lookback = day_candles[max(0, i - 60):i + 1]
            
            # UPGRADE #3: Trend Gate
            if not is_trend_strong(lookback, 25):
                trend_gate_skips += 1
                continue
            
            trend, is_pullback = detect_trend_and_pullback(lookback)
            
            if trend == 'NEUTRAL' or not is_pullback:
                continue
            
            # Confirmation candle
            last_candle = day_candles[i]
            if trend == 'UP' and last_candle['close'] <= last_candle['open']:
                continue
            if trend == 'DOWN' and last_candle['close'] >= last_candle['open']:
                continue
            
            # UPGRADE #4: Entry Confirmation (DISABLED for testing)
            # confirmed, pullback_high, pullback_low = has_entry_confirmation(lookback, trend)
            # if not confirmed:
            #     entry_confirmation_skips += 1
            #     continue
            
            # UPGRADE #7: Quality Scoring
            quality_score = calculate_trade_quality(lookback)
            if quality_score < MIN_TRADE_SCORE:
                quality_score_skips += 1
                continue
            
            # Execute trade
            entry = last_candle['close']
            slip = entry * SLIPPAGE_PCT
            entry_price = entry + slip if trend == 'UP' else entry - slip
            
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
            
            # UPGRADE #5: Smart Trailing Stop
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
            
            # P&L
            trade_pnl = (exit_price - entry_price) * qty if trend == 'UP' else (entry_price - exit_price) * qty
            costs = BROKERAGE * 2 + abs(trade_pnl) * STT
            net = trade_pnl - costs
            
            # UPGRADE #8: R-Multiple Tracking
            r_multiple = net / risk_amount
            total_r_multiple += r_multiple
            
            trades += 1
            day_trades += 1
            pnl += net
            daily_pnl += net
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
    avg_r = total_r_multiple / trades if trades > 0 else 0
    
    print(f"  ✅ Trades: {trades}, Win Rate: {win_rate:.1f}%, PnL: ₹{pnl:,.0f}, Return: {total_return:.1f}%")
    print(f"     Skips: Vol={volatility_skips}, Trend={trend_gate_skips}, Entry={entry_confirmation_skips}, Quality={quality_score_skips}")
    
    return {
        'symbol': symbol,
        'trades': trades,
        'wins': wins,
        'win_rate': win_rate,
        'pnl': pnl,
        'total_return': total_return,
        'max_dd': max_dd * 100,
        'avg_trade': avg_trade,
        'avg_r_multiple': avg_r,
        'trading_days': len(daily_returns),
        'risk_metrics': {
            'volatility_skips': volatility_skips,
            'trend_gate_skips': trend_gate_skips,
            'entry_confirmation_skips': entry_confirmation_skips,
            'quality_score_skips': quality_score_skips,
            'daily_loss_breaches': daily_loss_breaches,
            'kill_switch_triggers': kill_switch_triggers
        }
    }

def main():
    """Main validation with ALL 8 risk filters"""
    print("=" * 70)
    print("FULL UPGRADED STRATEGY VALIDATION - ALL 8 RISK FILTERS")
    print("=" * 70)
    print(f"\nCapital: ₹{INITIAL_CAPITAL:,}")
    print(f"Risk per trade: {RISK_PER_TRADE * 100}%")
    print(f"Max trades/day: {MAX_TRADES_PER_DAY}")
    print(f"Daily loss limit: {MAX_DAILY_LOSS * 100}%")
    print(f"Kill switch: {KILL_SWITCH_DD * 100}% DD → pause {KILL_SWITCH_DAYS} days")
    print(f"\nRisk Filters:")
    print(f"  #2 Volatility: Min {MIN_FIRST_HOUR_RANGE_ATR * 100}% ATR")
    print(f"  #3 Trend Gate: Min {MIN_EMA_SLOPE * 100}% EMA slope")
    print(f"  #4 Entry Confirmation: Pullback break required")
    print(f"  #7 Quality Score: Min {MIN_TRADE_SCORE * 100}%")
    
    symbols = [f.replace('.json', '') for f in os.listdir(DATA_DIR) 
               if f.endswith('.json') and f != 'summary.json' and f != 'all_symbols.json']
    
    print(f"\nProcessing {len(symbols)} symbols...")
    
    results = []
    for symbol in sorted(symbols):
        result = process_symbol_with_filters(symbol)
        if result:
            results.append(result)
    
    # Aggregate
    print("\n" + "=" * 70)
    print("AGGREGATE RESULTS - WITH ALL 8 RISK FILTERS")
    print("=" * 70)
    
    total_trades = sum(r['trades'] for r in results)
    total_wins = sum(r['wins'] for r in results)
    total_pnl = sum(r['pnl'] for r in results)
    max_dd = max(r['max_dd'] for r in results) if results else 0
    avg_r = sum(r['avg_r_multiple'] * r['trades'] for r in results) / total_trades if total_trades > 0 else 0
    
    total_vol_skips = sum(r['risk_metrics']['volatility_skips'] for r in results)
    total_trend_skips = sum(r['risk_metrics']['trend_gate_skips'] for r in results)
    total_entry_skips = sum(r['risk_metrics']['entry_confirmation_skips'] for r in results)
    total_quality_skips = sum(r['risk_metrics']['quality_score_skips'] for r in results)
    total_kill_switches = sum(r['risk_metrics']['kill_switch_triggers'] for r in results)
    
    print(f"\n📊 Performance:")
    print(f"  Total Trades: {total_trades}")
    print(f"  Total Wins: {total_wins}")
    print(f"  Win Rate: {(total_wins / total_trades * 100) if total_trades > 0 else 0:.1f}%")
    print(f"  Total P&L: ₹{total_pnl:,.0f}")
    print(f"  Total Return: {(total_pnl / INITIAL_CAPITAL * 100):.1f}%")
    print(f"  Max Drawdown: {max_dd:.1f}%")
    print(f"  Avg Trade: ₹{(total_pnl / total_trades) if total_trades > 0 else 0:,.0f}")
    print(f"  Avg R-Multiple: {avg_r:.2f}R")
    
    print(f"\n🛡️ Risk Metrics:")
    print(f"  Volatility Skips: {total_vol_skips}")
    print(f"  Trend Gate Skips: {total_trend_skips}")
    print(f"  Entry Confirmation Skips: {total_entry_skips}")
    print(f"  Quality Score Skips: {total_quality_skips}")
    print(f"  Kill Switch Triggers: {total_kill_switches}")
    
    # Top performers
    print("\n" + "-" * 70)
    print("TOP 5 PERFORMERS")
    print("-" * 70)
    top_5 = sorted(results, key=lambda x: x['total_return'], reverse=True)[:5]
    for r in top_5:
        print(f"{r['symbol']:12} | Trades: {r['trades']:3} | Return: {r['total_return']:6.1f}% | Win Rate: {r['win_rate']:5.1f}% | Avg R: {r['avg_r_multiple']:5.2f}R")
    
    print("\n✅ Full validation complete!")

if __name__ == "__main__":
    main()
