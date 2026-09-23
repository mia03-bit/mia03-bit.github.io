export function binaryClassificationMetrics(rows) {
  const totals = rows.reduce((result, row) => {
    const actual = Boolean(row.actual);
    const predicted = Boolean(row.predicted);
    if (actual && predicted) result.truePositive += 1;
    else if (!actual && !predicted) result.trueNegative += 1;
    else if (!actual && predicted) result.falsePositive += 1;
    else result.falseNegative += 1;
    return result;
  }, { truePositive: 0, trueNegative: 0, falsePositive: 0, falseNegative: 0 });
  const { truePositive: tp, trueNegative: tn, falsePositive: fp, falseNegative: fn } = totals;
  const safeDivide = (left, right) => right ? left / right : 0;
  const precision = safeDivide(tp, tp + fp);
  const recall = safeDivide(tp, tp + fn);
  return {
    ...totals,
    sampleSize: rows.length,
    accuracy: safeDivide(tp + tn, rows.length),
    precision,
    recall,
    f1: safeDivide(2 * precision * recall, precision + recall),
    falseAcceptanceRate: safeDivide(fp, fp + tn),
    falseRejectionRate: safeDivide(fn, fn + tp),
  };
}

export function regressionMetrics(rows) {
  if (!rows.length) return { sampleSize: 0, mae: 0, mse: 0, rmse: 0 };
  const errors = rows.map(({ actual, predicted }) => Number(predicted) - Number(actual));
  const mae = errors.reduce((sum, error) => sum + Math.abs(error), 0) / errors.length;
  const mse = errors.reduce((sum, error) => sum + error ** 2, 0) / errors.length;
  return { sampleSize: rows.length, mae, mse, rmse: Math.sqrt(mse) };
}
