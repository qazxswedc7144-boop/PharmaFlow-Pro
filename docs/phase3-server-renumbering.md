# Phase 3 — Server-side Internal Invoice Number Collision Handling

**Status:** Documentation only — not implemented in Phase 1  
**Scope:** Offline synchronization of internal purchase invoice numbers  
**Related branch:** `feat/invoice-numbering-phase1`

## 1. Problem

Phase 1 generates internal invoice numbers locally without requiring an internet connection:

- Purchase invoices: `PUR-1`, `PUR-2`, ...
- Purchase returns: `RET-1`, `RET-2`, ...

Two devices that are offline at the same time can independently generate the same internal number for the same tenant and document family. This is an expected limitation of local-only numbering, not a reason to introduce reservations or online dependencies in Phase 1.

## 2. Deferred solution

When server synchronization is expanded in Phase 3, the server will detect duplicate internal invoice numbers within the same tenant and document family.

If a collision is found, the server will assign a new available internal number to one of the colliding documents automatically, then persist the canonical number and return it to the originating device.

The future implementation must:

1. Scope collision checks by authenticated `tenantId`.
2. Keep `PUR-` and `RET-` sequences independent.
3. Use a server-side atomic transaction when selecting and saving a replacement number.
4. Preserve the original document identity, idempotency key, items, amounts, supplier, and posting state.
5. Update any references that are explicitly keyed by the internal invoice number.
6. Record the old and new internal numbers in an audit trail.
7. Make retries idempotent so a repeated sync request cannot cause repeated renumbering.
8. Return the canonical number to the client so local records and printed documents can be reconciled.

## 3. Explicit non-goals

Phase 3 collision handling must not introduce per-device range reservations or require a device to be online before saving locally.

Phase 1 does not implement:
- Server-side collision detection.
- Server-side renumbering.
- New Prisma models or migrations.
- New API endpoints.
- Sync processor changes.

## 4. Data preservation requirements

Renumbering is limited to the internal `invoiceNumber`. It must not modify:

- `supplierInvoiceNumber`.
- Supplier identity.
- Invoice date, line items, quantities, prices, discounts, fees, or taxes.
- Journal entries or journal lines.
- Inventory movements, batches, FIFO layers, or balances.
- The document's original business transaction or idempotency identity.

A server-side implementation must first map all persisted references to the internal number and prove that the update is safe. It must not silently rewrite unrelated historical records.

## 5. Acceptance tests for the future phase

- Two offline devices create the same `PUR-N` for one tenant; server sync retains both documents and assigns unique canonical internal numbers.
- Two offline devices create the same `RET-N`; server sync resolves the collision independently from purchases.
- Identical numbers in different tenants do not conflict.
- `PUR-1` and `RET-1` do not conflict.
- Replaying the same idempotent mutation does not renumber the document again.
- The client receives and persists the canonical number.
- Financial and inventory effects are not re-applied or changed by renumbering.
- Audit history contains the old number, new number, document identity, tenant, and resolution timestamp.

**This document records future work only. Do not implement these behaviors as part of Phase 1.**
