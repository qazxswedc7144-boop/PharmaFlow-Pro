import { describe, expect, it } from 'vitest';
import {
  getItemEntryModalSessionKey,
  shouldInitializeItemEntryModal
} from './itemEntryModalLifecycle';

describe('ItemEntryModal edit-session lifecycle', () => {
  const editData = {
    id: 'purchase-line-1',
    productId: 'product-1',
    name: 'Amoxicillin',
    qty: 4,
    price: 125,
    expiryDate: '2027-12-31',
    note: 'Keep refrigerated',
    category: 'أدوية'
  };

  it('creates the same session key for equivalent initialData objects', () => {
    expect(getItemEntryModalSessionKey(editData)).toBe(
      getItemEntryModalSessionKey({ ...editData })
    );
  });

  it('does not reinitialize or reschedule initial focus on parent re-renders during editing', () => {
    let wasOpen = false;
    let previousSessionKey: string | null = null;
    let focusSchedules = 0;

    const render = (isOpen: boolean, data: typeof editData) => {
      const nextSessionKey = getItemEntryModalSessionKey(data);
      const initialize = shouldInitializeItemEntryModal(
        isOpen,
        wasOpen,
        previousSessionKey,
        nextSessionKey
      );

      if (!isOpen) {
        wasOpen = false;
        return;
      }

      wasOpen = true;
      if (initialize) {
        previousSessionKey = nextSessionKey;
        focusSchedules += 1;
      }
    };

    render(true, editData);
    expect(focusSchedules).toBe(1);

    // Simulate PurchasesInvoice creating a new object on each parent render.
    render(true, { ...editData });
    render(true, { ...editData });
    expect(focusSchedules).toBe(1);

    // A different item/session must initialize and receive its initial focus.
    render(true, { ...editData, id: 'purchase-line-2' });
    expect(focusSchedules).toBe(2);

    // Closing and reopening the same item is a new modal session.
    render(false, editData);
    render(true, editData);
    expect(focusSchedules).toBe(3);
  });

  it('does not initialize while closed', () => {
    expect(shouldInitializeItemEntryModal(false, false, null, null)).toBe(false);
  });
});
