import { StockView } from './stock';

/** Service draws from the House, so this screen always exists. */
export class HouseStockView extends StockView {
  constructor(container) { super(container, 'HOUSE'); }
}
