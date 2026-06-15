const round = (value, digits = 4) => Number.isFinite(value)
  ? Number(value.toFixed(digits))
  : null;

function preferredEntryPrice(signal) {
  const { technical = {}, quote = {} } = signal.snapshot;
  return technical.triggerPrice
    ?? technical.breakoutTrigger
    ?? technical.stabilizationConfirmationHigh
    ?? quote.close
    ?? technical.close
    ?? null;
}

function plannedStop(signal, entryPrice) {
  const { technical = {} } = signal.snapshot;
  const rule = signal.strategy.riskRules;
  const atr = technical.atr ?? entryPrice * (technical.atrPct ?? 4) / 100;
  const candidates = [
    technical.support,
    technical.stabilizationLow,
    technical.swingLow,
    technical.ma20,
    technical.ma60,
    Number.isFinite(atr) ? entryPrice - atr * (rule.atrMultiple ?? 1.5) : null,
    entryPrice * (1 - (rule.maximumStopPct ?? 8) / 100)
  ].filter(value => Number.isFinite(value) && value < entryPrice);
  if (!candidates.length) return null;
  const nearest = Math.max(...candidates);
  const maximumLossStop = entryPrice * (1 - (rule.maximumStopPct ?? 8) / 100);
  return Math.max(nearest, maximumLossStop);
}

function buildPlans(signal, account) {
  const entryPrice = preferredEntryPrice(signal);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return { valid: false, warning: '缺少可用進場價格' };
  }
  const stopPrice = plannedStop(signal, entryPrice);
  if (!Number.isFinite(stopPrice) || stopPrice >= entryPrice) {
    return { valid: false, warning: '缺少合理停損價格' };
  }
  const riskPerShare = entryPrice - stopPrice;
  const minimumRiskRewardRatio = signal.strategy.riskRules.minimumRiskRewardRatio ?? 2;
  const targetPrice = entryPrice + riskPerShare * minimumRiskRewardRatio;
  const accountRiskPct = Math.min(
    signal.strategy.riskRules.maxAccountRiskPct ?? 0.5,
    0.5
  );
  const maxPositionPct = Math.min(
    signal.strategy.riskRules.maxPositionPct ?? 10,
    10
  );
  const equity = Number(account.equity || account.availableCash || 0);
  const riskBudget = equity * accountRiskPct / 100;
  const positionBudget = Math.min(
    Number(account.availableCash || 0),
    equity * maxPositionPct / 100
  );
  return {
    valid: true,
    entryPlan: {
      referencePrice: round(entryPrice),
      maximumAcceptablePrice: round(entryPrice * 1.005),
      orderType: signal.strategy.orderIntentTemplate.orderType,
      timeInForce: signal.strategy.orderIntentTemplate.timeInForce,
      session: signal.strategy.orderIntentTemplate.session,
      priceSource: signal.strategy.orderIntentTemplate.priceSource
    },
    riskPlan: {
      stopPrice: round(stopPrice),
      targetPrice: round(targetPrice),
      riskPerShare: round(riskPerShare),
      rewardPerShare: round(targetPrice - entryPrice),
      riskRewardRatio: round((targetPrice - entryPrice) / riskPerShare),
      accountRiskPct,
      riskBudget: round(riskBudget, 0),
      maxPositionPct,
      positionBudget: round(positionBudget, 0),
      allowLeverage: false,
      allowShortSelling: false
    }
  };
}

export function buildTradingDecisions({
  signals,
  account = {},
  positions = []
}) {
  const positionsBySymbol = new Map(positions.map(position => [position.symbol, position]));
  return signals.map(signal => {
    const position = positionsBySymbol.get(signal.symbol);
    const warnings = [];
    if (signal.missingData.length) warnings.push(`缺少資料：${signal.missingData.join('、')}`);
    if (signal.activationStatus !== 'ACTIVE') {
      warnings.push(`策略狀態：${signal.activationStatus}`);
    }
    if (signal.simulationOnly) warnings.push('此決策只允許 mock 或紙上交易');

    if (position?.strategyId && position.strategyId !== signal.strategyId) {
      return {
        date: signal.date,
        symbol: signal.symbol,
        action: 'SKIP',
        strategyId: signal.strategyId,
        setup: signal.setupReasons,
        trigger: signal.triggerReasons,
        invalidation: signal.invalidationReasons,
        entryPlan: null,
        riskPlan: null,
        reason: `已有 ${position.strategyId} 策略持倉，避免同一股票重複下單`,
        warnings,
        signalStatus: signal.status
      };
    }

    if (position && (signal.invalidated || signal.blocked)) {
      return {
        date: signal.date,
        symbol: signal.symbol,
        action: 'SELL',
        strategyId: signal.strategyId,
        setup: signal.setupReasons,
        trigger: signal.triggerReasons,
        invalidation: [...signal.invalidationReasons, ...signal.blockedReasons],
        entryPlan: null,
        riskPlan: {
          currentQuantity: position.quantity,
          currentStopPrice: position.stopPrice ?? null
        },
        reason: signal.invalidationReasons[0]
          || signal.blockedReasons[0]
          || '策略失效，退出持倉',
        warnings,
        signalStatus: signal.status
      };
    }

    if (position) {
      return {
        date: signal.date,
        symbol: signal.symbol,
        action: 'HOLD',
        strategyId: signal.strategyId,
        setup: signal.setupReasons,
        trigger: signal.triggerReasons,
        invalidation: signal.invalidationReasons,
        entryPlan: null,
        riskPlan: {
          currentQuantity: position.quantity,
          currentStopPrice: position.stopPrice ?? null,
          currentTargetPrice: position.targetPrice ?? null
        },
        reason: '持倉仍未觸發失效或出場條件',
        warnings,
        signalStatus: signal.status
      };
    }

    if (!signal.executable) {
      return {
        date: signal.date,
        symbol: signal.symbol,
        action: 'SKIP',
        strategyId: signal.strategyId,
        setup: signal.setupReasons,
        trigger: signal.triggerReasons,
        invalidation: signal.invalidationReasons,
        entryPlan: null,
        riskPlan: null,
        reason: {
          DATA_GAP: '必要資料尚未備齊',
          NOT_VALIDATED: '策略尚未通過 Validation',
          BLOCKED: signal.blockedReasons[0] || '風控條件禁止進場',
          INVALIDATED: signal.invalidationReasons[0] || '策略假設已失效',
          WAIT_TRIGGER: 'Setup 成立，但 Trigger 尚未成立',
          NO_SETUP: 'Setup 尚未成立'
        }[signal.status] || '目前不進場',
        warnings,
        signalStatus: signal.status
      };
    }

    const plans = buildPlans(signal, account);
    if (!plans.valid) {
      return {
        date: signal.date,
        symbol: signal.symbol,
        action: 'SKIP',
        strategyId: signal.strategyId,
        setup: signal.setupReasons,
        trigger: signal.triggerReasons,
        invalidation: signal.invalidationReasons,
        entryPlan: null,
        riskPlan: null,
        reason: plans.warning,
        warnings: [...warnings, plans.warning],
        signalStatus: signal.status
      };
    }
    return {
      date: signal.date,
      symbol: signal.symbol,
      action: 'BUY',
      strategyId: signal.strategyId,
      setup: signal.setupReasons,
      trigger: signal.triggerReasons,
      invalidation: signal.strategy.invalidationRules.map(rule => rule.reason).filter(Boolean),
      entryPlan: plans.entryPlan,
      riskPlan: plans.riskPlan,
      reason: `${signal.strategyName} 的 Setup 與 Trigger 均成立`,
      warnings,
      signalStatus: signal.status
    };
  });
}

export function summarizeDecisions(decisions) {
  return decisions.reduce((summary, decision) => {
    summary[decision.action] = (summary[decision.action] || 0) + 1;
    return summary;
  }, {});
}
