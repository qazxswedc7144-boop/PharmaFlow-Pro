// server/modules/replication/replication.types.ts

export type BusinessEventType =
  | "InventoryUpdated"
  | "InvoicePosted"
  | "PurchasePosted"
  | "TransferCreated"
  | "TransferShipped"
  | "TransferReceived"
  | "ReservationCreated"
  | "ReservationReleased";

export type AuditReplicationAction =
  | "REPLICATION_PUBLISHED"
  | "REPLICATION_RECEIVED"
  | "REPLICATION_REPLAYED"
  | "REPLICATION_RECOVERED";

export interface ReplicationEvent {
  id: string; // unique UUID
  type: BusinessEventType;
  branchId: string; // branch that originated the event
  timestamp: string; // ISO date string
  payload: any; // payload details (e.g. qty changes, invoice details, etc.)
  sequence: number; // local monotonic counter for sequencing
  vectorClock: { [branchId: string]: number }; // vector clock for causality
  checksum?: string; // checksum for telemetry verification

  // ⬇️ ⬇️ الحقلين الجديدين ⬇️ ⬇️

  /**
   * sessionId للعميل اللي أنتج الـ event.
   * لو موجود، الـ Gateway يستبعد الـ client هذا بس (مش كل عملاء الفرع)
   * وده اللي يمنع الـ loopback بدون ما يكسر الـ multi-tab sync.
   */
  originSessionId?: string;

  /**
   * نطاق النشر:
   *  - "SAME_BRANCH": يوصل لعملاء نفس الفرع بس (تعديل مخزون، فاتورة...).
   *  - "ALL_BRANCHES" أو ما شي قيمة: يوصل للكل (تحويلات، تحديثات عامة).
   */
  scope?: "SAME_BRANCH" | "ALL_BRANCHES";
}

export interface ClientConnectionInfo {
  sessionId: string;
  userId: string;
  branchId: string;
  role: string;
  connectedAt: string;
}

export interface ReplicationStatus {
  activeSessions: ClientConnectionInfo[];
  redisConnected: boolean;
  totalEventsPublished: number;
  totalEventsReceived: number;
}

export interface SyncRecoveryRequest {
  branchId: string;
  lastKnownSequence: number;
  vectorClock: { [branchId: string]: number };
}

export interface SyncRecoveryResponse {
  recoveredEvents: ReplicationEvent[];
  isFullySynced: boolean;
}
