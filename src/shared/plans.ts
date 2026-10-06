/*
 * Monthly list prices of the subscription plans, to set what the plan costs
 * against what the same usage would cost on the API. Monthly billing, USD,
 * before tax (claude.com/pricing, chatgpt.com/pricing). Plans whose price
 * isn't fixed (Enterprise, Edu) or not known here have none.
 */
import type { PlanInfo } from './types';

const PRICES: [RegExp, number][] = [
  [/^Claude Max 20x/i, 200],
  [/^Claude Max/i, 100],
  [/^Claude Pro/i, 20],
  [/^Claude Team/i, 30],
  [/^Claude Free/i, 0],
  [/^ChatGPT Pro$/i, 200],
  [/^ChatGPT Plus/i, 20],
  [/^ChatGPT (Team|Business)/i, 30],
  [/^ChatGPT Free/i, 0],
];

/** USD a month, or undefined when the plan has no fixed list price. */
export function planMonthlyUsd(plan?: Pick<PlanInfo, 'name'>): number | undefined {
  if (!plan) return undefined;
  return PRICES.find(([re]) => re.test(plan.name.trim()))?.[1];
}

/** an average month, for prorating a monthly fee over a number of days */
export const DAYS_PER_MONTH = 30.44;
