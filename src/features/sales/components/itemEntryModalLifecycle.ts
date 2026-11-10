export interface ItemEntryModalSessionData {
  id?: string;
  name?: string;
  qty?: string | number;
  price?: string | number;
  expiryDate?: string;
  note?: string;
  category?: string;
  productId?: string | null;
  product?: { id?: string } | null;
}

/**
 * Creates a value-based key for one modal editing session.
 * It intentionally avoids object identity so parent re-renders cannot retrigger
 * form initialization merely because they allocated a new initialData object.
 */
export const getItemEntryModalSessionKey = (
  data?: ItemEntryModalSessionData | null
): string | null => {
  if (!data) return null;

  return JSON.stringify([
    data.id ?? null,
    data.productId ?? data.product?.id ?? null,
    data.name ?? '',
    data.qty ?? '',
    data.price ?? '',
    data.expiryDate ?? '',
    data.note ?? '',
    data.category ?? ''
  ]);
};

/**
 * Initialize/focus only when a modal is first opened or its item session changes.
 */
export const shouldInitializeItemEntryModal = (
  isOpen: boolean,
  wasOpen: boolean,
  previousSessionKey: string | null,
  nextSessionKey: string | null
): boolean => isOpen && (!wasOpen || previousSessionKey !== nextSessionKey);
