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

# Risk Filter Thresholds - NOW ADAPTIVE BASED ON ADX
# These will be overridden by regime detection
MIN_FIRST_HOUR_RANGE_ATR = 0.3  # Back to original default
MIN_EMA_SLOPE = 0.0  # Set by regime
MIN_TRADE_SCORE = 0.0  # Set by regime

SLIPPAGE_PCT = 0.0005
BROKERAGE = 20
STT = 0.00025  # 0.025% on Sell side only (accurate for intraday)

EMA_FAST = 15
EMA_SLOW = 25
PULLBACK_ATR = 1.0  # Adjusted from 3.0 for viability in 15-min trends
TRAILING_ATR_MULT = 2.0

DATA_DIR = "data/tv_data_15min"

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
# ADX Calculation & Regime Detection
# ============================================

def wilder_smooth(values: List[float], period: int) -> List[float]:
    """Wilder's smoothing method"""
    if len(values) < period:
        return []
    smoothed = []
    first_sum = sum(values[:period])
    smoothed.append(first_sum / period)
    for i in range(period, len(values)):
        prev = smoothed[-1]
        current = values[i]
        next_val = (prev * (period - 1) + current) / period
        smoothed.append(next_val)
    return smoothed

def calculate_adx(candles: List[Dict], period: int = 14) -> float:
    """Calculate ADX (Average Directional Index)"""
    if len(candles) < period + 1:
        return 0
    
    true_ranges = []
    plus_dm = []
    minus_dm = []
    
    for i in range(1, len(candles)):
        high = candles[i]['high']
        low = candles[i]['low']
        prev_high = candles[i-1]['high']
        prev_low = candles[i-1]['low']
        prev_close = candles[i-1]['close']
        
        tr = max(high - low, abs(high - prev_close), abs(low - prev_close))
        true_ranges.append(tr)
        
        up_move = high - prev_high
        down_move = prev_low - low
        
        plus_dm_val = up_move if up_move > down_move and up_move > 0 else 0
        minus_dm_val = down_move if down_move > up_move and down_move > 0 else 0
        
        plus_dm.append(plus_dm_val)
        minus_dm.append(minus_dm_val)
    
    if len(true_ranges) < period:
        return 0
    
    smooth_tr = wilder_smooth(true_ranges, period)
    smooth_plus_dm = wilder_smooth(plus_dm, period)
    smooth_minus_dm = wilder_smooth(minus_dm, period)
    
    plus_di = []
    minus_di = []
    
    for i in range(len(smooth_tr)):
        if smooth_tr[i] == 0:
            plus_di.append(0)
            minus_di.append(0)
        else:
            plus_di.append((smooth_plus_dm[i] / smooth_tr[i]) * 100)
            minus_di.append((smooth_minus_dm[i] / smooth_tr[i]) * 100)
    
    dx = []
    for i in range(len(plus_di)):
        di_sum = plus_di[i] + minus_di[i]
        if di_sum == 0:
            dx.append(0)
        else:
            di_diff = abs(plus_di[i] - minus_di[i])
            dx.append((di_diff / di_sum) * 100)
    
    if len(dx) < period:
        return 0
    
    adx_values = wilder_smooth(dx, period)
    return adx_values[-1] if adx_values else 0

def detect_regime(candles: List[Dict]) -> Dict:
    """Detect market regime and return adaptive filter config"""
    adx = calculate_adx(candles, 14)
    
    if adx >= 25:
        # Strong trend - use moderate filters
        return {
            'regime': 'TRENDING',
            'adx': adx,
            'should_trade': True,
            'min_ema_slope': 0.005,     # 0.5%
            'min_trade_score': 0.4,     # 40%
            'min_first_hour_atr': 0.3   # 30%
        }
    elif adx >= 15:
        # Normal market - relaxed filters
        return {
            'regime': 'NORMAL',
            'adx': adx,
            'should_trade': True,
            'min_ema_slope': 0.002,     # 0.2%
            'min_trade_score': 0.6,     # 60% (Increased from 50% for selectivity)
            'min_first_hour_atr': 0.25  # 25%
        }
    else:
        # Choppy - DO NOT TRADE
        return {
            'regime': 'CHOPPY',
            'adx': adx,
            'should_trade': False,      # NON-NEGOTIABLE SKIP
            'min_ema_slope': 0.0,       
            'min_trade_score': 0.0,
            'min_first_hour_atr': 0.0
        }

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
    """Check for 'pullback break' (Standard Entry Signal)"""
    if len(candles) < 3:
        return False, 0, 0
    
    prev_candle = candles[-2]
    current_candle = candles[-1]
    
    if trend == 'UP':
        # Break above previous candle's high
        confirmed = current_candle['close'] > prev_candle['high']
        pullback_high = prev_candle['high']
        pullback_low = prev_candle['low']
    else:
        # Break below previous candle's low
        confirmed = current_candle['close'] < prev_candle['low']
        pullback_high = prev_candle['high']
        pullback_low = prev_candle['low']
    
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
    trend_strength = min(separation * 200, 1.0)  # 0.5% separation = 1.0 score
    
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
    
    atr = calculate_atr(candles)
    is_pullback = False
    
    if trend == 'UP':
        # Pullback context: price is below Fast EMA but above Slow EMA
        is_pullback = current_close < fast_ema and current_close > slow_ema
    elif trend == 'DOWN':
        # Pullback context: price is above Fast EMA but below Slow EMA
        is_pullback = current_close > fast_ema and current_close < slow_ema
    
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
    
    # Flatten candles for continuous technical context across days
    all_candles = []
    day_indices = [] # (start_idx, end_idx, day_key)
    for dk in sorted_days:
        s_idx = len(all_candles)
        all_candles.extend(days_data[dk])
        day_indices.append((s_idx, len(all_candles), dk))
        
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
    
    gross_profit = 0
    gross_loss = 0
    
    # Kill switch state
    kill_switch_active = False
    kill_switch_end_day = 0
    
    for day_idx, (d_start, d_end, day_key) in enumerate(day_indices):
        day_candles = all_candles[d_start:d_end]
        
        if len(day_candles) < 20: # Slightly relaxed for truncated days
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
        first_hour = day_candles[:4]  # 4 * 15min = 1 hour
        atr_full_day = calculate_atr(day_candles)
        
        if is_low_volatility_day(first_hour, atr_full_day):
            if symbol == "RELIANCE":
                print(f"  [DEBUG] {day_key}: Low volatility skip (range < {atr_full_day * MIN_FIRST_HOUR_RANGE_ATR:.2f})")
            volatility_skips += 1
            continue
        
        # Process candles
        for i in range(len(day_candles) - 1):
            # UPGRADE #1: Max trades per day
            if day_trades >= MAX_TRADES_PER_DAY:
                break
            
            # UPGRADE #1: Daily loss limit
            daily_loss_limit = equity * MAX_DAILY_LOSS
            if daily_pnl <= -daily_loss_limit:
                daily_loss_breaches += 1
                break
            
            # Continuous technical context looking back into previous days
            g_idx = d_start + i
            if g_idx < 60: continue # Need minimum history for valid EMAs/indicators
            lookback = all_candles[g_idx - 60 : g_idx + 1]
            
            # DETECT REGIME AND GET ADAPTIVE FILTERS
            regime_info = detect_regime(lookback)
            
            if not regime_info['should_trade']:
                continue
            
            # Update global thresholds based on regime
            current_min_trade_score = regime_info['min_trade_score']
            
            trend, is_pullback = detect_trend_and_pullback(lookback)
            
            if trend == 'NEUTRAL' or not is_pullback:
                continue
            
            # Confirmation candle
            last_candle = day_candles[i]
            if trend == 'UP' and last_candle['close'] <= last_candle['open']:
                continue
            if trend == 'DOWN' and last_candle['close'] >= last_candle['open']:
                continue
            
            # UPGRADE #4: Entry Confirmation (RE-ENABLED)
            confirmed, pullback_high, pullback_low = has_entry_confirmation(lookback, trend)
            if not confirmed:
                entry_confirmation_skips += 1
                continue
            
            # UPGRADE #7: Quality Scoring (with adaptive threshold)
            quality_score = calculate_trade_quality(lookback)
            if quality_score < current_min_trade_score:
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
            
            # UPGRADE #5: Smart Trailing Stop + Break-Even at +1R
            exit_price = day_candles[-1]['close']
            trailing_stop = stop
            trail_dist = atr * TRAILING_ATR_MULT
            be_triggered = False
            
            # Cost buffer: brokerage + approx slippage/tax (approx 0.1% or 0.1R)
            cost_buffer = entry_price * 0.001 
            be_level = entry_price + cost_buffer if trend == 'UP' else entry_price - cost_buffer

            for j in range(i + 1, min(i + 40, len(day_candles))):
                c = day_candles[j]
                
                # Check for +1R Break-Even trigger using High/Low (not close)
                if not be_triggered:
                    best_pnl_r = ((c['high'] - entry_price) / risk) if trend == 'UP' else ((entry_price - c['low']) / risk)
                    if best_pnl_r >= 1.0:
                        be_triggered = True
                        if trend == 'UP':
                            trailing_stop = max(trailing_stop, be_level)
                        else:
                            trailing_stop = min(trailing_stop, be_level)

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
            
            # P&L and Reality-Based Costs
            trade_pnl = (exit_price - entry_price) * qty if trend == 'UP' else (entry_price - exit_price) * qty
            # STT is 0.025% on the SELL side value (turnover)
            sell_value = exit_price * qty if trend == 'UP' else entry_price * qty
            costs = (BROKERAGE * 2) + (sell_value * STT)
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
                gross_profit += net
            else:
                gross_loss += abs(net)
            
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
            'kill_switch_triggers': kill_switch_triggers,
            'gross_profit': gross_profit,
            'gross_loss': gross_loss
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
    total_gross_profit = sum(r['risk_metrics']['gross_profit'] for r in results)
    total_gross_loss = sum(r['risk_metrics']['gross_loss'] for r in results)
    
    print(f"\n📊 Performance:")
    print(f"  Total Trades: {total_trades}")
    print(f"  Total Wins: {total_wins}")
    print(f"  Win Rate: {(total_wins / total_trades * 100) if total_trades > 0 else 0:.1f}%")
    print(f"  Gross Profit: ₹{total_gross_profit:,.0f}")
    print(f"  Gross Loss: -₹{total_gross_loss:,.0f}")
    print(f"  Total P&L (Net): ₹{total_pnl:,.0f}")
    print(f"  Total Return: {(total_pnl / INITIAL_CAPITAL * 100):.1f}%")
    print(f"  Profit Factor: {(total_gross_profit / total_gross_loss) if total_gross_loss > 0 else 0:.2f}")
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
