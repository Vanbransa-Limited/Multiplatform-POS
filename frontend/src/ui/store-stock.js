import { StockView } from './stock';

/** The optional back room. Hidden entirely when the business has no Store. */
export class StoreStockView extends StockView {
  constructor(container) { super(container, 'STORE'); }
}
