/**
 * Booked-in versus shipped versus warehouse.
 *
 * A kit's order line is the finished product. The shipment of its parts is the component
 * stock-out that was posted, not a quantity on the part's own order. Counting only the
 * part's own order line leaves those parts looking short of the warehouse. The posted
 * stock-out is the shipment when it covers at least as many units as the part's own orders.
 *
 * A dispatched return leaves the building too. Its stock-out reduces what should still be
 * held, the same as a normal shipment.
 */

export interface StockBalance {
  booked: number
  /** Units on this product's own dispatched sale lines. */
  orderShipped: number
  /** Units that left on a dispatched return. They count as shipped. */
  returnShipped?: number
  /** Units taken off this product by posted stock-outs, including kit parts and returns. */
  postedStockOut: number
  wms: number
}

export function shippedQuantity(balance: Pick<StockBalance, 'orderShipped' | 'postedStockOut' | 'returnShipped'>): number {
  const sent = balance.orderShipped + (balance.returnShipped ?? 0)
  return Math.max(0, sent, balance.postedStockOut)
}

export function expectedRemaining(balance: StockBalance): number {
  return balance.booked - shippedQuantity(balance)
}

export function isReconciled(balance: StockBalance): boolean {
  return balance.wms === expectedRemaining(balance)
}
