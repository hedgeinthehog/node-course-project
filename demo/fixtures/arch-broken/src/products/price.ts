import { orderDiscountPercent } from '../orders/discount.js';

export const discounted = (cents: number) =>
  Math.round((cents * (100 - orderDiscountPercent)) / 100);
