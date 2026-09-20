export interface CatalogItem {
  sku: string;
  title: string;
  price: string;
}

export const CATALOG: CatalogItem[] = [
  { sku: 'PS-001', title: 'Merino Crew Neck Sweater', price: '129.95' },
  { sku: 'PS-002', title: 'Waxed Canvas Field Jacket', price: '249.00' },
  { sku: 'PS-003', title: 'Selvedge Denim Jeans', price: '189.50' },
  { sku: 'PS-004', title: 'Leather Chelsea Boots', price: '299.00' },
  { sku: 'PS-005', title: 'Oxford Cotton Shirt', price: '89.95' },
  { sku: 'PS-006', title: 'Cashmere Scarf', price: '79.00' },
  { sku: 'PS-007', title: 'Linen Summer Shorts', price: '69.95' },
  { sku: 'PS-008', title: 'Wool Blend Overcoat', price: '399.00' },
  { sku: 'PS-009', title: 'Suede Desert Boots', price: '219.50' },
  { sku: 'PS-010', title: 'Organic Cotton Tee', price: '39.95' },
];

export const CATALOG_BY_SKU = new Map(CATALOG.map((item) => [item.sku, item]));
